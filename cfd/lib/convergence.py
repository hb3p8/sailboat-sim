# -*- coding: utf-8 -*-
"""Сеточная сходимость: тройка сеток, порядок, GCI, ворота §4.2.

Считается по методу Роуча в редакции ASME V&V 20 — том же, которым пользуется
разбор NASA для NACA 0012 (ссылка в §11 документа). Смысл не в самой оценке, а
в том, что тонкий расчёт без неё запрещён: одна очень мелкая сетка не надёжнее
трёх согласованных, если для неё неизвестна погрешность.

Отдаётся не «прошло/не прошло», а сами разности и сама оценка. Пороги 2% и 5% —
начальные инженерные, и §4.2 прямо требует хранить величины, чтобы их можно
было пересмотреть, не перезапуская расчёты.
"""

import math

# Ворота из §4.2. Ключ — характер течения, а не семейство: отрывной аэродинамике
# и двухфазной гидродинамике позволено одно и то же, и по одной причине —
# в обоих случаях сила не постоянна, а колеблется.
GATES = {"attached": 0.02, "separated": 0.05, "two-phase": 0.05}


def representative_size(cells, volume_m3=None, area_m2=None, dim=3):
    """Характерный размер ячейки h. Без объёма домена — по числу ячеек.

    В GCI нужен не сам h, а отношение h соседних сеток, и оно определяется
    только числом ячеек при одинаковом домене. Поэтому объём необязателен: без
    него h выходит в условных единицах, а все отношения — верными.
    """
    if dim == 2:
        return math.sqrt((area_m2 if area_m2 else 1.0) / cells)
    return ((volume_m3 if volume_m3 else 1.0) / cells) ** (1.0 / 3.0)


def observed_order(eps21, eps32, r21, r32, max_iter=200, tol=1e-10):
    """Наблюдаемый порядок p из трёх решений. Уравнение неявное, решается итерацией.

    При почти совпавших решениях (eps21 ~ 0) порядок не определён: делить на
    ноль незачем, возвращается None, и дальше в отчёт идёт оговорка, а не
    красивое число.
    """
    if abs(eps21) < 1e-30 or abs(eps32) < 1e-30:
        return None
    s = math.copysign(1.0, eps32 / eps21)
    p = 2.0
    for _ in range(max_iter):
        q = math.log((r21 ** p - s) / (r32 ** p - s)) if r21 != 1 and r32 != 1 else 0.0
        try:
            new = abs(math.log(abs(eps32 / eps21)) + q) / math.log(r21)
        except (ValueError, ZeroDivisionError):
            return None
        if not math.isfinite(new):
            return None
        if abs(new - p) < tol:
            return new
        p = new
    return p


def gci(fine, medium, coarse, cells_fine, cells_medium, cells_coarse,
        dim=3, factor=1.25):
    """Оценка погрешности тонкой сетки.

    `fine/medium/coarse` — одна и та же интегральная величина на трёх сетках.
    Возвращает порядок, экстраполяцию Ричардсона, GCI и относительные разности.
    """
    h1 = representative_size(cells_fine, dim=dim)
    h2 = representative_size(cells_medium, dim=dim)
    h3 = representative_size(cells_coarse, dim=dim)
    r21, r32 = h2 / h1, h3 / h2
    eps21, eps32 = medium - fine, coarse - medium
    p = observed_order(eps21, eps32, r21, r32)
    out = {
        "refinement": {"r21": r21, "r32": r32,
                       "cells": [cells_coarse, cells_medium, cells_fine]},
        "values": {"coarse": coarse, "medium": medium, "fine": fine},
        "diff_medium_fine": eps21,
        "diff_coarse_medium": eps32,
        "rel_medium_fine": abs(eps21) / max(abs(fine), 1e-30),
        "rel_coarse_medium": abs(eps32) / max(abs(medium), 1e-30),
        "order": p,
        "extrapolated": None,
        "gci_fine": None,
        "gci_medium": None,
        "monotonic": (eps21 * eps32) > 0,
    }
    if p and r21 > 1:
        rp = r21 ** p
        if abs(rp - 1.0) > 1e-12:
            out["extrapolated"] = (rp * fine - medium) / (rp - 1.0)
            ea = abs(eps21) / max(abs(fine), 1e-30)
            out["gci_fine"] = factor * ea / (rp - 1.0)
        rp32 = r32 ** p
        if abs(rp32 - 1.0) > 1e-12:
            ea32 = abs(eps32) / max(abs(medium), 1e-30)
            out["gci_medium"] = factor * ea32 / (rp32 - 1.0)
    return out


def gate(result, regime="attached", drift=None, drift_limit=1.0):
    """Приложить ворота §4.2 к готовой оценке.

    Ворота две, и обе обязательны. Первая — по разности medium→fine. Вторая —
    по дрейфу на окне усреднения: сошедшаяся по сетке величина, которая при
    этом монотонно ползёт во времени, сеточную проверку не проходит, потому что
    сравнивать её просто не с чем.
    """
    limit = GATES[regime]
    rel = result["rel_medium_fine"]
    problems = []
    if rel > limit:
        problems.append("medium→fine %.2f%% > %.0f%%" % (rel * 100, limit * 100))
    if drift is not None and drift > drift_limit:
        problems.append("дрейф на окне %.2f от разброса" % drift)
    if result["order"] is not None and not (0.5 <= result["order"] <= 4.0):
        # Порядок вне разумного означает не «схема такая», а сетки вне
        # асимптотической области: экстраполяция по ним ничего не оценивает.
        problems.append("порядок %.2f вне 0.5…4" % result["order"])
    if not result["monotonic"]:
        problems.append("сходимость немонотонная")
    return {"regime": regime, "limit": limit, "passed": not problems,
            "problems": problems}


def triple(values, cells, regime="attached", dim=3, drift=None):
    """Удобный вход: словари вида {'coarse': ..., 'medium': ..., 'fine': ...}."""
    missing = [k for k in MESH_ORDER if k not in values or k not in cells]
    if missing:
        raise ValueError("для сеточной проверки не хватает: %s"
                         % ", ".join(missing))
    r = gci(values["fine"], values["medium"], values["coarse"],
            cells["fine"], cells["medium"], cells["coarse"], dim=dim)
    r["gate"] = gate(r, regime, drift)
    return r


MESH_ORDER = ("coarse", "medium", "fine")
