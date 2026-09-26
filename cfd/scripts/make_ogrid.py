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
from cfd.lib.ogrid import ogrid, remap_radial, write_plot3d  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def section_loop(camber, draft, chord, thickness, nose_resolved=False):
    """Замкнутый контур сечения: верх от носка к торцу, низ обратно.

    `sail_section` отдаёт две поверхности, обе от НОСКА (он у неё в плюс X
    после разворота к потоку) к торцу. Торец между их концами — прямой отрезок
    в толщину листа; замыкается он сам, когда низ идёт в обратном порядке.
    """
    up, lo = geo.sail_section(camber, draft, chord, thickness,
                              nose_resolved=nose_resolved)
    pts = list(map(tuple, up)) + list(map(tuple, lo))[::-1]
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 1e-12 or abs(p[1] - out[-1][1]) > 1e-12:
            out.append(p)
    if abs(out[0][0] - out[-1][0]) < 1e-12 and abs(out[0][1] - out[-1][1]) < 1e-12:
        out.pop()
    return np.array(out)


def quality(pts, chord=None):
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
    # ШАГ У НОСКА И У ТОРЦА — ПООТДЕЛЬНОСТИ, И ЭТО НЕ УКРАШЕНИЕ ВЫВОДА.
    #
    # `sail_section` отдаёт сечение НОСКОМ В ПЛЮС X (разворот к потоку), то
    # есть носок стоит при x = хорда, а торец при x = 0. Догадаться об этом по
    # числам нельзя, и я дважды прочитал контур задом наперёд: сперва при
    # разборе выворота, потом при разборе шага по времени — и во второй раз
    # объявил носок нехватающим точек, тогда как он самое густое место обвода,
    # а редкое — торец. Теперь обе величины выводятся С ИМЕНАМИ, и перепутать
    # их нельзя, не прочитав подпись.
    wall = pts[0]
    # Camber may put the upper shoulder a little farther in +X than the
    # actual shared tip. max(X) then reports shoulder curvature as "nose".
    j_nose = (int(np.argmin(np.linalg.norm(wall - [chord, 0.0], axis=1)))
              if chord is not None else int(np.argmax(wall[:, 0])))
    j_tail = int(np.argmin(wall[:, 0]))
    prev, nxt = wall[(j_nose - 1) % nt], wall[(j_nose + 1) % nt]
    ab = np.linalg.norm(wall[j_nose] - prev)
    bc = np.linalg.norm(nxt - wall[j_nose])
    ca = np.linalg.norm(nxt - prev)
    cross = abs((wall[j_nose, 0] - prev[0]) * (nxt[1] - prev[1])
                - (wall[j_nose, 1] - prev[1]) * (nxt[0] - prev[0])) / 2
    r_nose = ab * bc * ca / (4 * cross) if cross > 1e-18 else float("inf")
    return {"negative": int((area <= 0).sum()),
            "nonortho_max": float(nonortho.max()),
            "cells": (nr1 - 1) * nt,
            "wall_step_min": float(step.min()),
            "wall_step_med": float(np.median(step)),
            "wall_step_max": float(step.max()),
            "step_nose": float(step[j_nose]),
            "step_tail": float(step[j_tail]),
            "r_nose": float(r_nose),
            "on_tail": int((np.abs(wall[:, 0] - wall[j_tail, 0]) < 2e-3).sum()),
            "first_layer": float(np.median(np.linalg.norm(pts[1] - pts[0], axis=1)))}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--camber", type=float, default=0.185)
    ap.add_argument("--draft", type=float, default=0.5)
    ap.add_argument("--chord", type=float, default=3.9)
    ap.add_argument("--thickness", type=float, default=0.015)
    ap.add_argument("--nose-resolved", action="store_true",
                    help="новая геометрия без полигонального излома носка")
    ap.add_argument("--span", type=float, default=0.2)
    ap.add_argument("--r-far", type=float, default=1950.0, help="дальняя граница, м")
    ap.add_argument("--n-theta", type=int, default=300)
    ap.add_argument("--n-radial", type=int, default=100)
    ap.add_argument("--first-layer", type=float, default=None, help="первый слой, м")
    ap.add_argument("--remap-first-layer", type=float, default=None,
                    help="первый слой после радиального переразбиения, м")
    ap.add_argument("--remap-radial", type=int, default=None,
                    help="число радиальных ячеек после переразбиения")
    ap.add_argument("--max-ratio", type=float, default=30.0,
                    help="во сколько раз точки могут сгущаться против медианы")
    ap.add_argument("--out", default="gen-og-c185.p3dfmt")
    a = ap.parse_args()

    loop = section_loop(a.camber, a.draft, a.chord, a.thickness,
                        nose_resolved=a.nose_resolved)
    pts = ogrid(loop, r_far=a.r_far, n_theta=a.n_theta, n_radial=a.n_radial,
                first_layer=a.first_layer, max_ratio=a.max_ratio)
    if (a.remap_first_layer is None) != (a.remap_radial is None):
        ap.error("--remap-first-layer and --remap-radial must be given together")
    if a.remap_first_layer is not None:
        if a.out == "gen-og-c185.p3dfmt":
            ap.error("choose a distinct --out for a remapped experimental grid")
        base_q = quality(pts, chord=a.chord)
        if base_q["negative"] or base_q["nonortho_max"] > 70:
            raise SystemExit("исходная сетка не проходит геометрическую проверку")
        pts = remap_radial(pts, a.remap_radial, a.remap_first_layer)
    q = quality(pts, chord=a.chord)
    print("сечение: пузо %.3f, горб %.2f, хорда %.2f м, толщина %.1f%%"
          % (a.camber, a.draft, a.chord, 100 * a.thickness))
    print("сетка %d × %d = %d ячеек, дальняя граница %.0f м (%.0f хорд)"
          % (a.n_theta, a.n_radial, q["cells"], a.r_far, a.r_far / a.chord))
    print("первый слой %.1f мм, шаг по обшивке %.1f…%.1f мм (медиана %.1f)"
          % (1e3 * q["first_layer"], 1e3 * q["wall_step_min"],
             1e3 * q["wall_step_max"], 1e3 * q["wall_step_med"]))
    print("  у НОСКА (x = %.2f м): шаг %.1f мм, радиус по соседям %.1f мм"
          % (a.chord, 1e3 * q["step_nose"], 1e3 * q["r_nose"]))
    print("  у ТОРЦА (x = 0): шаг %.1f мм, точек на грани %d из %.1f мм высоты"
          % (1e3 * q["step_tail"], q["on_tail"], 1e3 * a.thickness * a.chord))
    print("вывернутых ячеек %d, неортогональность до %.1f°"
          % (q["negative"], q["nonortho_max"]))
    if q["negative"]:
        raise SystemExit("сетка с вывернутыми ячейками не пишется: считать по ней нельзя")
    if a.remap_first_layer is not None and q["nonortho_max"] > 70:
        raise SystemExit("переразбитая сетка превысила ориентир неортогональности 70°")
    path = os.path.join(ROOT, "cfd", "grids", a.out)
    write_plot3d(path, pts, span=a.span, chord=a.chord)
    print("записана %s" % os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
