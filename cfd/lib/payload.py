# -*- coding: utf-8 -*-
"""Сбор данных для HTML-отчёта.

Отделено от самой страницы нарочно. Страница — это разметка и рисование; здесь
только выборка чисел из сводок, историй сил, логов и срезов. Пока это лежало
вместе, любая правка подписи на графике заставляла перечитывать код, который
считает окно усреднения.

Всё, что уходит в страницу, уже посчитано: браузер ничего не выводит и ничего
не усредняет. Иначе в отчёте появилось бы второе место, где считается среднее,
и однажды оно разошлось бы со сводкой.
"""

import json
import math
import os

import numpy as np

from . import forces as fx


def _thin(t, y, n=360):
    """Проредить историю до n точек, СОХРАНЯЯ размах.

    Простое прореживание каждой k-й точки съедает пики колебания, и на графике
    сошедшийся случай выглядит гладким там, где он на самом деле дрожит.
    Поэтому берётся не значение, а минимум и максимум по окну.
    """
    t = np.asarray(t, dtype=float)
    y = np.asarray(y, dtype=float)
    if len(t) <= n:
        return ([round(float(v), 6) for v in t],
                [round(float(v), 6) for v in y],
                [round(float(v), 6) for v in y])
    edges = np.linspace(0, len(t), n + 1).astype(int)
    tt, lo, hi = [], [], []
    for a, b in zip(edges[:-1], edges[1:]):
        if b <= a:
            continue
        tt.append(round(float(t[a:b].mean()), 6))
        lo.append(round(float(y[a:b].min()), 6))
        hi.append(round(float(y[a:b].max()), 6))
    return tt, lo, hi


def force_history(run_dir, drag_sign=-1.0):
    """История сил запуска: время, сопротивление, боковая, вертикальная."""
    post = os.path.join(run_dir, "postProcessing")
    try:
        run = fx.read_run(post, "forces")
    except (ValueError, OSError):
        return None
    t = run["force"]["t"]
    total = run["force"]["total"]
    out = {"t": None, "series": {}}
    labels = (("Rt", drag_sign * total[:, 0]), ("Fy", total[:, 1]),
              ("Fz", total[:, 2]))
    for name, y in labels:
        tt, lo, hi = _thin(t, y)
        out["t"] = tt
        out["series"][name] = {"lo": lo, "hi": hi}
    if run["force"]["pressure"] is not None:
        for name, arr in (("Rp", run["force"]["pressure"]),
                          ("Rv", run["force"]["viscous"])):
            _tt, lo, hi = _thin(t, drag_sign * np.asarray(arr)[:, 0])
            out["series"][name] = {"lo": lo, "hi": hi}
    return out


def residual_history(run_dir, application):
    """Начальные невязки по итерациям — для полулогарифмического графика."""
    log = os.path.join(run_dir, "log", application + ".log")
    if not os.path.exists(log):
        return None
    hist = {}
    steps = 0
    with open(log, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("Time = "):
                steps += 1
            m = fx._RES.search(line)
            if m:
                hist.setdefault(m.group(1), []).append(float(m.group(2)))
    out = {}
    for k, v in hist.items():
        if k not in ("Ux", "Uy", "Uz", "p", "k", "omega"):
            continue
        # Давление решается по нескольку раз за итерацию (неортогональные
        # поправки), скорость — один. Если отложить по горизонтали НОМЕР
        # ВЫЗОВА, кривая давления окажется вдвое длиннее остальных и уедет за
        # правый край графика — что и было видно на первом снимке. Поэтому
        # каждая величина растягивается на общее число итераций.
        n = len(v)
        span = steps or n
        idx = [(i + 1) * span / float(n) for i in range(n)]
        tt, lo, _hi = _thin(idx, v, 240)
        out[k] = {"i": tt, "v": lo}
    return out or None


def slices(run_dir):
    p = os.path.join(run_dir, "slices.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def case_block(summary, run_dir):
    """Всё, что отчёт знает об одном случае."""
    m = summary["manifest"]
    app = m["solver"]["application"]
    blk = {
        "case_id": summary["case_id"],
        "family": summary["family"],
        "group": summary["convergence_group"],
        "level": summary["mesh_level"],
        "template": m["template"],
        "condition": m["condition"],
        "reference": m["reference"],
        "fluid": m["fluid"],
        "turbulence": m["solver"]["turbulence"],
        "derived": summary["derived"],
        "force": {k: {kk: summary["force"][k][kk]
                      for kk in ("mean", "std", "range", "drift", "window",
                                 "samples")}
                  for k in ("Fx", "Fy", "Fz") if k in summary["force"]},
        "cells": (summary.get("mesh") or {}).get("cells"),
        "mesh_quality": summary.get("mesh"),
        "yplus": summary.get("yplus"),
        "continuity": summary.get("continuity"),
        "clean": summary.get("clean"),
        "history": force_history(run_dir),
        "residuals": residual_history(run_dir, app),
        "slices": slices(run_dir),
    }
    # Разложение сопротивления на давление и трение — то, ради чего вообще
    # имеет смысл считать корпус двойным телом: полная таблица симулятора
    # такого разделения не даёт, а причина расхождения видна именно в нём.
    f = summary["force"]
    if f.get("Fx", {}).get("pressure") is not None:
        blk["decomposition"] = {
            "pressure_n": -f["Fx"]["pressure"],
            "viscous_n": -f["Fx"]["viscous"],
        }
    return blk


def sanitise(o):
    """NaN и бесконечности в JSON недопустимы — заменяются на null."""
    if isinstance(o, dict):
        return {k: sanitise(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [sanitise(v) for v in o]
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, (np.floating, np.integer)):
        return sanitise(float(o))
    return o
