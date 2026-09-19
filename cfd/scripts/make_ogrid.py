#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Построить O-сетку вокруг сечения паруса и записать её в cfd/grids/.

    .venv/bin/python cfd/scripts/make_ogrid.py --camber 0.185 --out gen-og-c185.p3dfmt

Скрипта не было: файл сетки лежал в репозитории, а чем он сделан — нигде. Из-за
этого его нельзя было ни перестроить с другими параметрами, ни проверить. А
проверить было что: в том файле 33 вывернутые ячейки, и случай на нём ни разу
не считался.

Здесь же стоит и ПРОВЕРКА: сетка с вывернутыми ячейками не пишется вовсе.
Считается она прямо по точкам (площадь четырёхугольника со знаком), потому что
ответ нужен за секунду, а не за прогон `checkMesh` через конвертер.
"""

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

from cfd.lib import geometry as geo          # noqa: E402
from cfd.lib.ogrid import ogrid, write_plot3d  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def section_loop(camber, draft, chord, thickness):
    """Замкнутый контур сечения: верх от носка к торцу, низ обратно.

    `sail_section` отдаёт две поверхности, обе от НОСКА (он у неё в плюс X
    после разворота к потоку) к торцу. Торец между их концами — прямой отрезок
    в толщину листа; замыкается он сам, когда низ идёт в обратном порядке.
    """
    up, lo = geo.sail_section(camber, draft, chord, thickness)
    pts = list(map(tuple, up)) + list(map(tuple, lo))[::-1]
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 1e-12 or abs(p[1] - out[-1][1]) > 1e-12:
            out.append(p)
    if abs(out[0][0] - out[-1][0]) < 1e-12 and abs(out[0][1] - out[-1][1]) < 1e-12:
        out.pop()
    return np.array(out)


def quality(pts):
    """Вывернутые ячейки и наибольшая неортогональность — по самим точкам."""
    nr1, nt, _ = pts.shape
    idx = (np.arange(nt) + 1) % nt
    a, b = pts[:-1], pts[:-1][:, idx]
    c, d = pts[1:][:, idx], pts[1:]
    area = 0.5 * ((a[..., 0] * b[..., 1] - b[..., 0] * a[..., 1])
                  + (b[..., 0] * c[..., 1] - c[..., 0] * b[..., 1])
                  + (c[..., 0] * d[..., 1] - d[..., 0] * c[..., 1])
                  + (d[..., 0] * a[..., 1] - a[..., 0] * d[..., 1]))
    s = np.roll(pts, -1, axis=1) - np.roll(pts, 1, axis=1)
    t = np.empty_like(pts)
    t[1:-1], t[0], t[-1] = pts[2:] - pts[:-2], pts[1] - pts[0], pts[-1] - pts[-2]
    sn = s / np.maximum(np.linalg.norm(s, axis=2, keepdims=True), 1e-30)
    tn = t / np.maximum(np.linalg.norm(t, axis=2, keepdims=True), 1e-30)
    cosang = np.abs((sn * tn).sum(axis=2))
    nonortho = np.degrees(np.arccos(np.clip(np.sqrt(1.0 - cosang ** 2), 0, 1)))
    step = np.linalg.norm(np.diff(np.vstack([pts[0], pts[0][:1]]), axis=0), axis=1)
    return {"negative": int((area <= 0).sum()),
            "nonortho_max": float(nonortho.max()),
            "cells": (nr1 - 1) * nt,
            "wall_step_min": float(step.min()),
            "wall_step_med": float(np.median(step)),
            "first_layer": float(np.median(np.linalg.norm(pts[1] - pts[0], axis=1)))}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--camber", type=float, default=0.185)
    ap.add_argument("--draft", type=float, default=0.5)
    ap.add_argument("--chord", type=float, default=3.9)
    ap.add_argument("--thickness", type=float, default=0.015)
    ap.add_argument("--span", type=float, default=0.2)
    ap.add_argument("--r-far", type=float, default=1950.0, help="дальняя граница, м")
    ap.add_argument("--n-theta", type=int, default=300)
    ap.add_argument("--n-radial", type=int, default=100)
    ap.add_argument("--first-layer", type=float, default=None, help="первый слой, м")
    ap.add_argument("--max-ratio", type=float, default=30.0,
                    help="во сколько раз точки могут сгущаться против медианы")
    ap.add_argument("--out", default="gen-og-c185.p3dfmt")
    a = ap.parse_args()

    loop = section_loop(a.camber, a.draft, a.chord, a.thickness)
    pts = ogrid(loop, r_far=a.r_far, n_theta=a.n_theta, n_radial=a.n_radial,
                first_layer=a.first_layer, max_ratio=a.max_ratio)
    q = quality(pts)
    print("сечение: пузо %.3f, горб %.2f, хорда %.2f м, толщина %.1f%%"
          % (a.camber, a.draft, a.chord, 100 * a.thickness))
    print("сетка %d × %d = %d ячеек, дальняя граница %.0f м (%.0f хорд)"
          % (a.n_theta, a.n_radial, q["cells"], a.r_far, a.r_far / a.chord))
    print("первый слой %.3e м, шаг по обшивке %.4f…%.4f м"
          % (q["first_layer"], q["wall_step_min"], q["wall_step_med"]))
    print("вывернутых ячеек %d, неортогональность до %.1f°"
          % (q["negative"], q["nonortho_max"]))
    if q["negative"]:
        raise SystemExit("сетка с вывернутыми ячейками не пишется: считать по ней нельзя")
    path = os.path.join(ROOT, "cfd", "grids", a.out)
    write_plot3d(path, pts, span=a.span, chord=a.chord)
    print("записана %s" % os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
