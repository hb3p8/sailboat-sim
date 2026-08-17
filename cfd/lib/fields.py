# -*- coding: utf-8 -*-
"""Выемка полей на плоскости — для картинок в отчёте.

Сделано отдельной командой ПОСЛЕ расчёта, а не функцией-объектом внутри него.
Причина простая: функция-объект пишет только то, о чём её попросили заранее, и
для уже посчитанного случая она бесполезна. `postProcess` же читает
сохранённые поля и режет их когда угодно — в том числе через неделю, когда
станет ясно, какое сечение на самом деле хотелось посмотреть.

Красивое поле скоростей без сошедшихся сил валидацией не является (§2.4).
Поэтому картинки здесь — диагностика: по ним видно, куда ушёл отрыв, где сетка
не разрешает след и почему сила ведёт себя так, а не иначе. В сводку они не
входят и ни на один вердикт не влияют.
"""

import json
import os
import subprocess

import numpy as np

from . import runners

SAMPLE_DICT = """FoamFile
{{
    version 2.0; format ascii; class dictionary; object {name};
}}

type            surfaces;
libs            (sampling);
interpolate     true;
surfaceFormat   raw;
fields          (U p);

surfaces
{{
    {name}
    {{
        type            cuttingPlane;
        point           ({px} {py} {pz});
        normal          ({nx} {ny} {nz});
        interpolate     true;
    }}
}}
"""


def write_dict(run_dir, name, point, normal):
    d = os.path.join(run_dir, "system")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(SAMPLE_DICT.format(name=name, px=point[0], py=point[1],
                                   pz=point[2], nx=normal[0], ny=normal[1],
                                   nz=normal[2]))
    return path


def run_postprocess(run_dir, name, image, latest=True):
    """Позвать `postProcess -func <name>` в окружении решателя."""
    inner = ["postProcess", "-func", name]
    if latest:
        inner.append("-latestTime")
    cmd = runners.solver_cmd(image, os.path.abspath(run_dir), inner)
    log = os.path.join(run_dir, "log", "postProcess-%s.log" % name)
    os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, "w", encoding="utf-8") as f:
        p = subprocess.run(cmd, cwd=run_dir, stdout=f, stderr=subprocess.STDOUT)
    return p.returncode


def read_raw(path):
    """Файл `raw` из `surfaces`: x y z затем компоненты поля."""
    rows = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.lstrip().startswith("#"):
                continue
            v = line.split()
            if len(v) >= 4:
                rows.append([float(x) for x in v])
    if not rows:
        raise ValueError("%s: пусто" % path)
    n = min(len(r) for r in rows)
    return np.asarray([r[:n] for r in rows], dtype=np.float64)


def find_raw(run_dir, name):
    """Последний по времени каталог выемки: {U,p}_<name>.raw."""
    root = os.path.join(run_dir, "postProcessing", name)
    if not os.path.isdir(root):
        return None
    times = sorted(os.listdir(root), key=lambda s: float(s)
                   if s.replace(".", "").isdigit() else -1)
    for t in reversed(times):
        d = os.path.join(root, t)
        if not os.path.isdir(d):
            continue
        got = {}
        for f in os.listdir(d):
            if f.startswith("U_"):
                got["U"] = os.path.join(d, f)
            elif f.startswith("p_"):
                got["p"] = os.path.join(d, f)
        if "U" in got:
            got["time"] = float(t)
            return got
    return None


def _grid(points, values, axes, nx, ny, box=None):
    """Разложить нерегулярную выемку на равномерную сетку.

    `surfaces` отдаёт значения в вершинах триангуляции разреза — они
    неравномерны, и рисовать по ним нельзя. Пересадка идёт линейной
    интерполяцией по Делоне; за выпуклой оболочкой и внутри тела значений нет, и
    там честно остаётся пусто, а не нуль. Нуль в дырке от тела на картинке
    выглядит как область покоя, и это ровно то враньё, которого не должно быть.
    """
    from scipy.interpolate import griddata
    i, j = axes
    xy = points[:, [i, j]]
    if box is None:
        lo, hi = xy.min(axis=0), xy.max(axis=0)
    else:
        lo, hi = np.asarray(box[0]), np.asarray(box[1])
    gx = np.linspace(lo[0], hi[0], nx)
    gy = np.linspace(lo[1], hi[1], ny)
    GX, GY = np.meshgrid(gx, gy)
    out = []
    for k in range(values.shape[1]):
        z = griddata(xy, values[:, k], (GX, GY), method="linear")
        out.append(z)
    return gx, gy, np.stack(out, axis=-1)


def _quantise(a):
    """Поле в uint16 с записанным диапазоном.

    Отчёт открывается в браузере, и float64 в JSON раздувает его в разы.
    Шестнадцати бит на величину, у которой и трёх значащих цифр много, хватает
    с запасом; дырки (NaN) кодируются отдельным значением, а не нулём.
    """
    good = np.isfinite(a)
    if not good.any():
        return {"lo": 0.0, "hi": 0.0, "data": [0] * a.size}
    lo, hi = float(np.nanmin(a)), float(np.nanmax(a))
    span = (hi - lo) or 1.0
    q = np.zeros(a.shape, dtype=np.uint16)
    q[good] = 1 + np.round((a[good] - lo) / span * 65534).astype(np.uint16)
    return {"lo": lo, "hi": hi, "data": q.ravel().tolist()}


def slice_json(run_dir, name, axes, nx=200, ny=130, box=None):
    """Готовый к рисованию срез: скорость, давление, габариты, дырки."""
    got = find_raw(run_dir, name)
    if not got:
        return None
    U = read_raw(got["U"])
    pts, vel = U[:, 0:3], U[:, 3:6]
    gx, gy, gvel = _grid(pts, vel, axes, nx, ny, box)
    out = {"name": name, "time": got["time"],
           "axes": list(axes), "nx": nx, "ny": ny,
           "x0": float(gx[0]), "x1": float(gx[-1]),
           "y0": float(gy[0]), "y1": float(gy[-1])}
    i, j = axes
    out["u"] = _quantise(gvel[:, :, i])
    out["v"] = _quantise(gvel[:, :, j])
    out["speed"] = _quantise(np.linalg.norm(gvel, axis=-1))
    if "p" in got:
        P = read_raw(got["p"])
        _gx, _gy, gp = _grid(P[:, 0:3], P[:, 3:4], axes, nx, ny, box)
        out["p"] = _quantise(gp[:, :, 0])
    return out


def extract(run_dir, image, planes, nx=200, ny=130):
    """Снять все запрошенные срезы и сложить в `slices.json` рядом с запуском.

    `planes` — список словарей: имя, точка, нормаль, пара осей рисования и
    (необязательно) рамка. Рамка нужна для крыла: разрез идёт на весь домен в
    сорок хорд, а смотреть надо на профиль.
    """
    out = {}
    for pl in planes:
        write_dict(run_dir, pl["name"], pl["point"], pl["normal"])
        rc = run_postprocess(run_dir, pl["name"], image)
        if rc != 0:
            out[pl["name"]] = {"error": "postProcess вернул %d" % rc}
            continue
        s = slice_json(run_dir, pl["name"], pl["axes"], nx, ny, pl.get("box"))
        out[pl["name"]] = s or {"error": "выемка пуста"}
    path = os.path.join(run_dir, "slices.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    return path, out
