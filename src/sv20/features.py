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


def find_deck_layout(subpaths, datum, plan_box, min_span=2000.0, tol=0.6):
    """Кокпит на виде сверху: комингс, кромка сидений, носовая переборка.

    Три зеркальные пары длинных кривых идут от транца вперёд и обрываются в
    одном и том же месте — это наружная и внутренняя грани комингса и кромка
    рецесса. Поперечная линия там же, где они обрываются, — переборка.
    """
    px0, py0, px1, py1 = plan_box
    runs = []
    for s in subpaths:
        bx0, by0, bx1, by1 = s.bbox
        # Комингс дочерчен до самой кромки транца и на несколько пунктов
        # вылезает за габарит линии борта — отсюда запас по корме.
        if not (px0 - 12.0 <= bx0 and bx1 <= px1 and py0 <= by0 and by1 <= py1):
            continue
        if len(s.points) < 4 or abs(s.width - 0.84) > 1e-6:
            continue
        pts = sorted(datum.plan(p) for p in s.points)
        if pts[-1][0] - pts[0][0] < min_span:
            continue
        if pts[0][0] > 200.0:            # должна начинаться у транца
            continue
        if pts[-1][0] > 5000.0:          # это сама линия борта, а не комингс
            continue
        ys = [p[1] for p in pts]
        if min(ys) * max(ys) < 0:
            continue
        runs.append(pts)

    right = [r for r in runs if sum(p[1] for p in r) > 0]
    if len(right) < 3:
        return None
    # чем дальше от ДП, тем наружнее: комингс снаружи, рецесс внутри
    right.sort(key=lambda r: -sum(p[1] for p in r) / len(r))
    outer, inner, seat = right[0], right[1], right[2]
    x_fwd = min(max(p[0] for p in r) for r in (outer, inner, seat))

    bulkhead = None
    for s in subpaths:
        bx0, by0, bx1, by1 = s.bbox
        if not (px0 - 12.0 <= bx0 and bx1 <= px1 and py0 <= by0 and by1 <= py1):
            continue
        if len(s.points) < 2 or abs(s.width - 0.84) > 1e-6:
            continue
        pts = [datum.plan(p) for p in s.points]
        xs = [p[0] for p in pts]
        if max(xs) - min(xs) > 20.0 or abs(min(xs) - x_fwd) > 120.0:
            continue
        ys = [abs(p[1]) for p in pts]
        if not (250.0 <= max(ys) <= 900.0):
            continue
        if bulkhead is None or max(ys) > bulkhead["half_width_mm"]:
            bulkhead = {"x_mm": sum(xs) / len(xs), "half_width_mm": max(ys)}

    def curve(pts):
        return [[round(p[0], 1), round(abs(p[1]), 1)] for p in pts]

    return {
        "coaming_outer": curve(outer),
        "coaming_inner": curve(inner),
        "recess_edge": curve(seat),
        "x_fwd_mm": x_fwd,
        "bulkhead": bulkhead,
        "coaming_width_mm": (sum(p[1] for p in outer) / len(outer)
                             - sum(p[1] for p in inner) / len(inner)),
    }


def find_cabin(subpaths, datum, x_from, x_to=4200.0, tol=0.84):
    """Рубка-гараж впереди переборки: прямоугольник с закруглениями."""
    best = None
    for s in subpaths:
        if abs(s.width - tol) > 1e-6:
            continue
        pts = [datum.plan(p) for p in s.points]
        xs = [p[0] for p in pts]
        ys = [abs(p[1]) for p in pts]
        if min(xs) < x_from - 60.0 or max(xs) > x_to:
            continue
        if max(xs) - min(xs) < 200.0 or max(ys) < 150.0 or max(ys) > 600.0:
            continue
        if best is None or max(xs) > best["x_fwd_mm"]:
            best = {"x_aft_mm": min(xs), "x_fwd_mm": max(xs),
                    "half_width_mm": max(ys)}
    return best


def find_deck_profile(subpaths, datum, sheer_pts, min_span=300.0):
    """Высоты палубы с вида сбоку: верх комингса и погибь бака.

    Силуэт показывает самую высокую линию на каждой абсциссе. В корме это верх
    комингса кокпита, в носу — линия палубы в ДП, то есть её погибь. Обе идут
    выше линии борта, обе длинные и обведены контурной толщиной — по этому и
    отбираются.

    Раньше обе высоты назначались от балды (комингс 55 мм, погибь 4.5% от
    полушироты); теперь они снимаются.
    """
    pts = sorted(sheer_pts)
    (x0, z0), (x1, z1) = pts[0], pts[-1]

    def sheer_z(x):
        return z0 + (z1 - z0) * (x - x0) / (x1 - x0)

    found = []
    for s in subpaths:
        if abs(s.width - 0.84) > 1e-6 or len(s.points) < 3:
            continue
        a = sorted(datum.profile(p) for p in s.points)
        span = a[-1][0] - a[0][0]
        if span < min_span or a[0][0] < -50 or a[-1][0] > 6150:
            continue
        over = [p[1] - sheer_z(p[0]) for p in a]
        if min(over) < -5 or max(over) > 200:
            continue
        found.append((a[0][0], [[round(p[0], 1), round(o, 1)]
                                for p, o in zip(a, over)]))
    if not found:
        return None
    found.sort()
    aft = found[0][1]
    fwd = None
    for x_start, curve in found:
        if x_start > 3000 and (fwd is None or len(curve) > len(fwd)):
            fwd = curve
    return {"coaming_top": aft, "foredeck_crown": fwd,
            "note": "смещения над линией борта, мм"}


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


def extract(subpaths, datum, plan_box, sheer_pts=None):
    """Все следы приложений, какие есть на чертеже."""
    section = find_keel_section(subpaths, datum, plan_box)
    trunk = find_keel_trunk(subpaths, datum, section)
    deck = find_deck_layout(subpaths, datum, plan_box)
    profile = (find_deck_profile(subpaths, datum, sheer_pts)
               if sheer_pts else None)
    cabin = find_cabin(subpaths, datum, deck["x_fwd_mm"]) if deck else None
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
        "deck_layout": deck,
        "deck_profile": profile,
        "cabin": cabin,
        "rudder_pintles": pintles,
        "rudder_stock": stock,
        "lifts_vertically": bool(
            trunk and trunk["length_mm"] - section["chord_mm"] < 0.35 * section["chord_mm"]),
    }
