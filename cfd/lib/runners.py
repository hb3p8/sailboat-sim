# -*- coding: utf-8 -*-
"""Запуск случая: local, ssh, slurm (§3.6).

Физическое содержание случая от места запуска не меняется — это требование
§3.6, и здесь оно держится одним приёмом: запускатель не знает про физику
вовсе. Он получает готовый каталог и строку команд `Allrun`, переносит каталог
куда надо, выполняет и забирает обратно. Всё, что решает, ЧТО считать, лежит в
манифесте и уже развёрнуто в каталог.

Отсюда же и то, чего здесь нет: ни один запускатель не правит словари
решателя. Понадобилось другое число процессов — оно приходит из манифеста
через шаблон `decomposeParDict`, а не подставляется в командную строку.
"""

import json
import os
import shlex
import subprocess


class RunError(RuntimeError):
    pass


def run_id(case_id, stamp):
    """Имя запуска. Время передаётся снаружи: модуль не должен зависеть от часов."""
    return "%s-%s" % (case_id, stamp)


def _exec(args, cwd=None, log=None, env=None):
    if log:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a", encoding="utf-8") as f:
            f.write("\n$ " + " ".join(shlex.quote(a) for a in args) + "\n")
            f.flush()
            p = subprocess.run(args, cwd=cwd, stdout=f, stderr=subprocess.STDOUT,
                               env=env)
    else:
        p = subprocess.run(args, cwd=cwd, env=env)
    if p.returncode != 0:
        raise RunError("команда вернула %d: %s" % (p.returncode, " ".join(args)))
    return p.returncode


def container_cmd(image, workdir, inner):
    """Обёртка запуска в контейнере.

    Образ обязателен и обязан быть с digest (проверяется в манифесте): без
    закреплённого образа «тот же расчёт» через полгода считается другой версией
    решателя, и расхождение с эталоном спишут на физику.
    """
    runtime = os.environ.get("CFD_CONTAINER", "docker")
    if runtime == "none":
        return inner
    if runtime in ("apptainer", "singularity"):
        return [runtime, "exec", "--pwd", "/case",
                "--bind", "%s:/case" % workdir, image] + inner
    return [runtime, "run", "--rm", "-v", "%s:/case" % workdir, "-w", "/case",
            image] + inner


class LocalRunner:
    """Запуск на этой машине. Годится для 2D, грубых 3D и отладки постановки."""

    name = "local"

    def __init__(self, image=None):
        self.image = image

    def run(self, run_dir, script="Allrun", log=None):
        log = log or os.path.join(run_dir, "log", "run.log")
        inner = ["./" + script]
        cmd = container_cmd(self.image, os.path.abspath(run_dir), inner) \
            if self.image else inner
        _exec(cmd, cwd=run_dir, log=log)
        return {"runner": "local", "log": log}


class SshRunner:
    """Перенести каталог на удалённую машину, посчитать, забрать результат.

    Забирается не всё: поля решателя — это гигабайты, а в сводку идут силы,
    логи и постобработка. Что именно забирать, задаётся `fetch`; поля остаются
    на счётной машине и достаются по `run_id`, если понадобятся (§3.4).
    """

    name = "ssh"
    FETCH = ("postProcessing", "log", "case.json", "constant/polyMesh/blockMeshDict")

    def __init__(self, host, remote_root, image=None, fetch=None):
        self.host = host
        self.remote_root = remote_root
        self.image = image
        self.fetch = tuple(fetch) if fetch else self.FETCH

    def run(self, run_dir, script="Allrun", log=None):
        log = log or os.path.join(run_dir, "log", "run.log")
        name = os.path.basename(os.path.abspath(run_dir))
        remote = os.path.join(self.remote_root, name)
        _exec(["ssh", self.host, "mkdir", "-p", shlex.quote(remote)], log=log)
        _exec(["rsync", "-a", "--delete", os.path.abspath(run_dir) + "/",
               "%s:%s/" % (self.host, remote)], log=log)
        inner = ["./" + script]
        cmd = container_cmd(self.image, remote, inner) if self.image else inner
        remote_cmd = "cd %s && %s" % (shlex.quote(remote),
                                      " ".join(shlex.quote(a) for a in cmd))
        _exec(["ssh", self.host, remote_cmd], log=log)
        for rel in self.fetch:
            src = "%s:%s/%s" % (self.host, remote, rel)
            dst = os.path.join(run_dir, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            subprocess.run(["rsync", "-a", src, dst], check=False)
        return {"runner": "ssh", "host": self.host, "remote": remote, "log": log}


SBATCH = """#!/bin/bash
#SBATCH --job-name={name}
#SBATCH --nodes={nodes}
#SBATCH --ntasks={tasks}
#SBATCH --time={time}
#SBATCH --output=log/slurm-%j.out
{extra}
cd "$SLURM_SUBMIT_DIR"
{command}
"""


class SlurmRunner(SshRunner):
    """То же, что ssh, но через очередь. Запуск асинхронный: возвращает job id.

    Забирать результат сразу нечем — задача только поставлена в очередь.
    `collect_case.py` вызывается отдельно, когда задача досчитает; это и
    удобнее, потому что тяжёлые случаи считаются часами.
    """

    name = "slurm"

    def __init__(self, host, remote_root, image=None, nodes=1, tasks=16,
                 time="12:00:00", extra="", fetch=None):
        SshRunner.__init__(self, host, remote_root, image, fetch)
        self.nodes, self.tasks, self.time, self.extra = nodes, tasks, time, extra

    def run(self, run_dir, script="Allrun", log=None):
        log = log or os.path.join(run_dir, "log", "run.log")
        name = os.path.basename(os.path.abspath(run_dir))
        remote = os.path.join(self.remote_root, name)
        inner = ["./" + script]
        cmd = container_cmd(self.image, remote, inner) if self.image else inner
        job = SBATCH.format(name=name, nodes=self.nodes, tasks=self.tasks,
                            time=self.time, extra=self.extra,
                            command=" ".join(shlex.quote(a) for a in cmd))
        with open(os.path.join(run_dir, "job.sbatch"), "w", encoding="utf-8") as f:
            f.write(job)
        _exec(["ssh", self.host, "mkdir", "-p", shlex.quote(remote)], log=log)
        _exec(["rsync", "-a", "--delete", os.path.abspath(run_dir) + "/",
               "%s:%s/" % (self.host, remote)], log=log)
        out = subprocess.run(
            ["ssh", self.host, "cd %s && sbatch --parsable job.sbatch"
             % shlex.quote(remote)], capture_output=True, text=True)
        if out.returncode != 0:
            raise RunError("sbatch: " + out.stderr.strip())
        return {"runner": "slurm", "host": self.host, "remote": remote,
                "job_id": out.stdout.strip(), "log": log, "async": True}


def from_config(spec, image=None):
    """Запускатель из строки или словаря.

        local
        ssh:user@host:/scratch/cfd
        slurm:user@host:/scratch/cfd
    """
    if isinstance(spec, dict):
        kind = spec.get("kind", "local")
        args = {k: v for k, v in spec.items() if k != "kind"}
        args.setdefault("image", image)
        return {"local": LocalRunner, "ssh": SshRunner,
                "slurm": SlurmRunner}[kind](**args)
    parts = str(spec).split(":")
    if parts[0] == "local":
        return LocalRunner(image)
    if len(parts) < 3:
        raise RunError("запускатель %r: нужен вид ssh:host:/путь" % spec)
    cls = {"ssh": SshRunner, "slurm": SlurmRunner}[parts[0]]
    return cls(parts[1], ":".join(parts[2:]), image)


def write_run_record(run_dir, record):
    with open(os.path.join(run_dir, "run.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=1, sort_keys=True)
