"""Ф2: гидростатика параметрического корпуса.

Считается прямо по шпангоутам модели, без сторонних библиотек: при такой
параметризации сечения интегрируются аналитически по контуру, и своя
реализация оказывается и точнее, и быстрее универсальной.

Всё внутри в миллиметрах, наружу — в метрах и килограммах.
"""

RHO_SEA = 1025.0     # кг/м³
RHO_FRESH = 1000.0

MM3_PER_M3 = 1.0e9
MM2_PER_M2 = 1.0e6


def _simpson(xs, ys):
    """Интеграл по равномерной сетке; при чётном числе интервалов — Симпсон."""
    n = len(xs) - 1
    if n < 1:
        return 0.0
    h = (xs[-1] - xs[0]) / n
    if n % 2 == 0:
        total = ys[0] + ys[-1]
        for i in range(1, n):
            total += ys[i] * (4.0 if i % 2 else 2.0)
        return total * h / 3.0
    return sum(0.5 * (ys[i] + ys[i + 1]) * (xs[i + 1] - xs[i]) for i in range(n))


def immersed_span(hull, z_wl=0.0, n=400):
    """Отрезок по X, на котором корпус вообще касается воды."""
    b = hull.b
    x0, x1 = 0.0, b.x_stem
    xs = [x0 + (x1 - x0) * i / float(n) for i in range(n + 1)]
    wet = [x for x in xs if hull.z_keel(x) < z_wl]
    if not wet:
        return None
    lo, hi = min(wet), max(wet)
    # уточняем концы делением пополам
    lo = _root(lambda x: hull.z_keel(x) - z_wl, max(x0, lo - (x1 - x0) / n), lo)
    hi = _root(lambda x: hull.z_keel(x) - z_wl, hi, min(x1, hi + (x1 - x0) / n))
    # корма не может начинаться раньше транца
    lo = max(lo, b.transom_x(z_wl))
    return lo, hi


def _root(f, a, b, iters=40):
    fa, fb = f(a), f(b)
    if fa == 0:
        return a
    if fb == 0:
        return b
    if fa * fb > 0:
        return a if abs(fa) < abs(fb) else b
    for _ in range(iters):
        m = 0.5 * (a + b)
        fm = f(m)
        if fa * fm <= 0:
            b, fb = m, fm
        else:
            a, fa = m, fm
    return 0.5 * (a + b)


def hydrostatics(hull, z_wl=0.0, n=160, rho=RHO_SEA):
    """Полный набор гидростатических характеристик на уровне `z_wl`."""
    span = immersed_span(hull, z_wl)
    if span is None:
        return None
    xa, xf = span
    lwl = xf - xa

    xs = [xa + lwl * i / float(n) for i in range(n + 1)]
    secs = [hull.section(x) for x in xs]

    area = [2.0 * s.half_area_below(z_wl) for s in secs]          # мм²
    halfb = [s.half_beam_at(z_wl) for s in secs]                  # мм
    girth = [2.0 * s.girth_below(z_wl) for s in secs]             # мм

    vol = _simpson(xs, area)                                      # мм³
    if vol <= 0:
        return None
    lcb = _simpson(xs, [a * x for a, x in zip(area, xs)]) / vol
    awp = _simpson(xs, [2.0 * y for y in halfb])                  # мм²
    lcf = (_simpson(xs, [2.0 * y * x for y, x in zip(halfb, xs)]) / awp
           if awp > 0 else 0.0)
    wetted = _simpson(xs, girth)                                  # мм²

    am = max(area)
    x_am = xs[area.index(am)]
    bwl = max(halfb) * 2.0
    x_bwl = xs[halfb.index(max(halfb))]
    draft = z_wl - min(hull.z_keel(x) for x in xs)

    denom = lwl * bwl * draft
    return {
        "z_wl_mm": z_wl,
        "volume_m3": vol / MM3_PER_M3,
        "displacement_kg": rho * vol / MM3_PER_M3,
        "lwl_mm": lwl,
        "lwl_aft_x_mm": xa,
        "lwl_fwd_x_mm": xf,
        "bwl_mm": bwl,
        "bwl_x_mm": x_bwl,
        "draft_canoe_mm": draft,
        "midship_area_m2": am / MM2_PER_M2,
        "midship_x_mm": x_am,
        "waterplane_area_m2": awp / MM2_PER_M2,
        "wetted_area_m2": wetted / MM2_PER_M2,
        "lcb_mm": lcb,
        "lcb_pct_lwl_from_aft": 100.0 * (lcb - xa) / lwl,
        "lcf_mm": lcf,
        "lcf_pct_lwl_from_aft": 100.0 * (lcf - xa) / lwl,
        "Cb": vol / denom if denom > 0 else 0.0,
        "Cm": am / (bwl * draft) if bwl * draft > 0 else 0.0,
        "Cp": vol / (am * lwl) if am * lwl > 0 else 0.0,
        "Cwp": awp / (lwl * bwl) if lwl * bwl > 0 else 0.0,
        "section_areas": [[x, a / MM2_PER_M2] for x, a in zip(xs, area)],
        "half_beams": [[x, y] for x, y in zip(xs, halfb)],
    }


def sinkage_for(hull, target_kg, rho=RHO_SEA, lo=-400.0, hi=600.0, iters=48):
    """Уровень воды, при котором корпус вытесняет заданную массу, мм от КВЛ.

    Ноль означает, что модель садится ровно на снятую с чертежа КВЛ. Отличие
    от нуля — это и есть невязка, которую закрывает подгонка на Ф3.
    """
    def f(z):
        h = hydrostatics(hull, z, n=80, rho=rho)
        return (h["displacement_kg"] if h else 0.0) - target_kg

    a, b = lo, hi
    fa, fb = f(a), f(b)
    if fa * fb > 0:
        return None
    for _ in range(iters):
        m = 0.5 * (a + b)
        fm = f(m)
        if fa * fm <= 0:
            b, fb = m, fm
        else:
            a, fa = m, fm
    return 0.5 * (a + b)
