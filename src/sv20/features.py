"""Ф5, часть первая: что про киль и руль всё-таки есть на чертеже.

Подводной части на листе нет, но приложения оставили следы выше КВЛ:

    колодец киля на виде сверху — а внутри него вычерчен **профиль пера**
    в натуральную величину. Это прямой обмер: хорда, толщина и всё
    распределение толщины по хорде;

    навеска руля на транце — два гудгенса и щёки баллера. Отсюда ось
    вращения пера и её высоты.

Всё, что здесь возвращается, помечается как `measured`: это снято, а не
придумано. Форма пера киля ниже корпуса и перо руля — уже проектирование,
и живут они в `appendages.py`.

Зависимостей нет.
"""

import math


class FeatureError(Exception):
    pass


def find_keel_section(subpaths, datum, plan_box,
                      min_points=40, chord_range=(150.0, 800.0), tol=0.6):
    """Профиль пера киля: зеркальная пара полилиний в ДП внутри вида сверху.

    Признак жёсткий — две половины одной длины по X, симметричные относительно
    ДП, обе начинаются и кончаются на самой ДП. Ничего другого на чертеже так
    не выглядит.
    """
    px0, py0, px1, py1 = plan_box
    cand = []
    for s in subpaths:
        if len(s.points) < min_points:
            continue
        bx0, by0, bx1, by1 = s.bbox
        if not (px0 <= bx0 and bx1 <= px1 and py0 <= by0 and by1 <= py1):
            continue
        chord = datum.X(bx1) - datum.X(bx0)
        if not (chord_range[0] <= chord <= chord_range[1]):
            continue
        ys = [abs(datum.Y(p[1])) for p in s.points]
        if min(ys) > tol * 4 or max(ys) > 120.0:
            continue
        cand.append(s)

    # Половины смыкаются на ДП, поэтому сторону определяем по средней
    # ординате, а не по крайней: у обеих есть точки с Y около нуля.
    def side(s):
        ys = [datum.Y(p[1]) for p in s.points]
        return sum(ys) / len(ys)

    best = None
    for i in range(len(cand)):
        for j in range(i + 1, len(cand)):
            a, b = cand[i], cand[j]
            if abs(a.bbox[0] - b.bbox[0]) > tol or abs(a.bbox[2] - b.bbox[2]) > tol:
                continue
            sa, sb = side(a), side(b)
            if sa * sb > 0:
                continue
            upper = a if sa > 0 else b
            lower = b if sa > 0 else a
            err = _mirror_error(upper, lower, datum)
            if err > 3.0:
                continue
            if best is None or err < best[0]:
                best = (err, upper)
    if best is None:
        raise FeatureError("профиль пера киля не найден на виде сверху")
    prof = _profile(best[1], datum)
    prof["mirror_error_mm"] = best[0]
    return prof


def _mirror_error(upper, lower, datum):
    """Насколько половины зеркальны: сравниваем полутолщину по общей сетке."""
    def curve(s):
        pts = sorted((datum.X(p[0]), abs(datum.Y(p[1]))) for p in s.points)
        return pts

    a, b = curve(upper), curve(lower)

    def at(pts, x):
        if x <= pts[0][0] or x >= pts[-1][0]:
            return 0.0
        for i in range(len(pts) - 1):
            if pts[i][0] <= x <= pts[i + 1][0]:
                dx = pts[i + 1][0] - pts[i][0]
                u = 0.0 if dx == 0 else (x - pts[i][0]) / dx
                return pts[i][1] + u * (pts[i + 1][1] - pts[i][1])
        return 0.0

    x0, x1 = a[0][0], a[-1][0]
    return max(abs(at(a, x0 + (x1 - x0) * k / 40.0) - at(b, x0 + (x1 - x0) * k / 40.0))
               for k in range(1, 40))


def _profile(subpath, datum):
    """Нормировать половину профиля: (доля хорды от передней кромки, полутолщина/хорда)."""
    pts = sorted(datum.plan(p) for p in subpath.points)
    x_te = pts[0][0]
    x_le = pts[-1][0]
    chord = x_le - x_te
    half = [((x_le - x) / chord, abs(y) / chord) for x, y in pts]
    half.sort()
    t_half = max(t for _, t in half)
    x_t = [s for s, t in half if abs(t - t_half) < 1e-12][0]

    # площадь сечения по правилу трапеций, обе половины
    area = 0.0
    for i in range(len(half) - 1):
        area += 0.5 * (half[i][1] + half[i + 1][1]) * (half[i + 1][0] - half[i][0])
    area *= 2.0 * chord * chord

    return {
        "chord_mm": chord,
        "x_le_mm": x_le,
        "x_te_mm": x_te,
        "thickness_mm": 2.0 * t_half * chord,
        "thickness_ratio": 2.0 * t_half,
        "max_thickness_at_pct_chord": 100.0 * x_t,
        "section_area_mm2": area,
        "area_ratio": area / (chord * 2.0 * t_half * chord),
        "half_profile": [[round(s, 5), round(t, 5)] for s, t in half],
        "points": len(half),
    }


def find_keel_trunk(subpaths, datum, section, pad=200.0):
    """Габарит колодца: что охватывает профиль на виде сверху."""
    x0, x1 = section["x_te_mm"], section["x_le_mm"]
    best = None
    for s in subpaths:
        bx0, by0, bx1, by1 = s.bbox
        X0, X1 = datum.X(bx0), datum.X(bx1)
        Y0, Y1 = datum.Y(by0), datum.Y(by1)
        if not (X0 < x0 and X1 > x1 and X0 > x0 - pad and X1 < x1 + pad):
            continue
        if abs(Y0) > 200 or abs(Y1) > 200:
            continue
        span = X1 - X0
        if best is None or span < best[0]:
            best = (span, X0, X1, Y0, Y1)
    if best is None:
        return None
    _, X0, X1, Y0, Y1 = best
    return {"x_aft_mm": X0, "x_fwd_mm": X1, "length_mm": X1 - X0,
            "half_width_mm": max(abs(Y0), abs(Y1))}


def find_rudder_pintles(subpaths, datum, x_max=30.0, min_len=100.0):
    """Гудгенсы: горизонтальные отрезки в корму от транца, попарно по высоте."""
    horiz = []
    for s in subpaths:
        if len(s.points) != 2:
            continue
        (x0, y0), (x1, y1) = s.points
        if abs(y0 - y1) > 1e-6:
            continue
        Z = datum.Z(y0)
        if not (0.0 < Z < 700.0):
            continue
        Xa, Xb = sorted((datum.X(x0), datum.X(x1)))
        if Xb > x_max or (Xb - Xa) < min_len:
            continue
        horiz.append((Z, Xa, Xb))
    if len(horiz) < 2:
        return None

    horiz.sort()
    groups = []
    for Z, Xa, Xb in horiz:
        if groups and Z - groups[-1][-1][0] < 60.0:
            groups[-1].append((Z, Xa, Xb))
        else:
            groups.append([(Z, Xa, Xb)])
    groups = [g for g in groups if len(g) >= 2]
    if len(groups) < 2:
        return None

    out = []
    for g in groups[:2]:
        zs = [z for z, _, _ in g]
        out.append({"z_mid_mm": 0.5 * (min(zs) + max(zs)),
                    "z_lo_mm": min(zs), "z_hi_mm": max(zs),
                    "x_aft_mm": min(a for _, a, _ in g),
                    "x_fwd_mm": max(b for _, _, b in g)})
    return {"lower": out[0], "upper": out[1],
            "stock_z_lo_mm": out[0]["z_mid_mm"],
            "stock_z_hi_mm": out[1]["z_mid_mm"]}


def find_rudder_stock_x(subpaths, datum, z_lo, z_hi, x_range=(-120.0, 40.0)):
    """Ось баллера: вертикальные отрезки между гудгенсами."""
    xs = []
    for s in subpaths:
        if len(s.points) != 2:
            continue
        (x0, y0), (x1, y1) = s.points
        if abs(x0 - x1) > 1e-6:
            continue
        X = datum.X(x0)
        if not (x_range[0] <= X <= x_range[1]):
            continue
        Za, Zb = sorted((datum.Z(y0), datum.Z(y1)))
        if Za > z_lo + 40.0 or Zb < z_hi - 40.0:
            continue
        xs.append(X)
    if not xs:
        return None
    return {"x_mm": sum(xs) / len(xs), "x_min_mm": min(xs), "x_max_mm": max(xs),
            "plates": len(xs), "rake_deg": 0.0}


def naca_match(profile, families=None):
    """Ближайшая по распределению толщины симметричная серия NACA.

    Смысл не в том, чтобы подменить обмер формулой, а в том, чтобы назвать
    семейство: положение максимума толщины сразу говорит, ламинарный это
    профиль или классическая четырёхзначная серия.
    """
    xt = profile["max_thickness_at_pct_chord"]
    families = families or [
        (30.0, "NACA 4-значная (0015 и родня), максимум толщины на 30%"),
        (35.0, "NACA 63-серия, ламинарная, максимум на 35%"),
        (40.0, "NACA 64/65-серия, ламинарная, максимум на 40%"),
        (45.0, "NACA 66-серия, ламинарная, максимум на 45%"),
    ]
    best = min(families, key=lambda f: abs(f[0] - xt))
    return {"nearest": best[1], "delta_pct": xt - best[0],
            "thickness_ratio": profile["thickness_ratio"]}


def extract(subpaths, datum, plan_box):
    """Все следы приложений, какие есть на чертеже."""
    section = find_keel_section(subpaths, datum, plan_box)
    trunk = find_keel_trunk(subpaths, datum, section)
    pintles = find_rudder_pintles(subpaths, datum)
    stock = None
    if pintles:
        stock = find_rudder_stock_x(subpaths, datum,
                                    pintles["stock_z_lo_mm"],
                                    pintles["stock_z_hi_mm"])
    return {
        "keel_section": section,
        "keel_section_family": naca_match(section),
        "keel_trunk": trunk,
        "rudder_pintles": pintles,
        "rudder_stock": stock,
        "lifts_vertically": bool(
            trunk and trunk["length_mm"] - section["chord_mm"] < 0.35 * section["chord_mm"]),
    }
