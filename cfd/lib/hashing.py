# -*- coding: utf-8 -*-
"""Отпечатки входов: без них сводка не даёт восстановить расчёт (§3.4).

Правило одно: в результате хранится не «имя файла», а `sha256:` его
содержимого. Имя переживает правку геометрии молча, отпечаток — нет.
"""

import hashlib
import os
import subprocess


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return "sha256:" + h.hexdigest()


def sha256_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha256_tree(root, suffixes=None):
    """Отпечатки всех файлов каталога, отсортированные по относительному пути."""
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in sorted(files):
            if suffixes and not name.endswith(tuple(suffixes)):
                continue
            p = os.path.join(base, name)
            out[os.path.relpath(p, root)] = sha256_file(p)
    return out


def git_revision(root):
    """SHA рабочего дерева и признак незакоммиченных правок.

    Грязное дерево не запрещается — на нём как раз и ведётся работа, — но в
    манифесте оно помечается. Принимать в `golden/` результат с `dirty: true`
    не следует: восстановить по нему исходники нельзя.
    """
    def run(args):
        return subprocess.run(args, cwd=root, capture_output=True,
                              text=True, check=True).stdout.strip()
    try:
        sha = run(["git", "rev-parse", "HEAD"])
        dirty = bool(run(["git", "status", "--porcelain"]))
        return {"sha": sha, "dirty": dirty}
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return {"sha": None, "dirty": None}
