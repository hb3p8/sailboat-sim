"""Остойчивость на больших углах: плечо восстанавливающего момента GZ(θ).

Для симулятора одной метацентрической высоты мало. GM верна только у нуля, а
спортбот с широким плоским днищем и развалистым бортом ведёт себя сильно
нелинейно: до двадцати градусов форма набирает плечо быстрее, чем предсказывает
GM, потом кромка палубы уходит в воду и плечо валится.

Считается честно: корпус поворачивается на угол крена, горизонтальная
плоскость воды опускается до заданного водоизмещения, площадь и центр тяжести
погружённой части берутся отсечением замкнутого контура шпангоута. Контур
замыкается настоящей палубой из `deck_ring`, поэтому заливание кокпита и уход
кромки борта под воду учитываются сами собой.

Зависимостей нет.
"""

import math

MM3_PER_M3 = 1.0e9


def section_polygon(hull, x):
    """Замкнутый контур шпангоута: обшивка от борта до борта плюс палуба.

    Замыкание именно палубой, а не хордой по линии борта, — принципиально:
    на больших углах крена под воду уходит палуба, и объём должен считаться
    по ней.
    """
    b = hull.b
    ys, zs = b.sheer_y(x), b.sheer_z(x)
    sec = hull.section(x).by_arclength(40)
    starboard = [(y, z) for y, z in sec]
    port = [(-y, z) for y, z in reversed(sec[:-1])]
    deck = hull.deck_ring(x, ys, zs, n_camber=5)
    # обход: левый борт вниз к килю, правый борт вверх, палуба обратно налево
    return port + starboard + list(reversed(deck[:-1]))


def _clip_below(poly, z_w):
    """Отсечь часть многоугольника ниже горизонтали z_w (Сазерленд–Ходжман)."""
    out = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ain, bin_ = a[1] <= z_w, b[1] <= z_w
        if ain:
            out.append(a)
        if ain != bin_:
            t = (z_w - a[1]) / (b[1] - a[1])
            out.append((a[0] + t * (b[0] - a[0]), z_w))
    return out


def _area_centroid(poly):
    """Площадь со знаком и центр тяжести многоугольника."""
    if len(poly) < 3:
        return 0.0, 0.0, 0.0
    a = cx = cy = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    a *= 0.5
    if abs(a) < 1e-9:
        return 0.0, 0.0, 0.0
    return abs(a), cx / (6.0 * a), cy / (6.0 * a)


class HeeledHull(object):
    """Шпангоуты, повёрнутые на угол крена; вода остаётся горизонтальной."""

    def __init__(self, hull, n_station=40):
        self.hull = hull
        b = hull.b
        self.xs = [b.x_deck_aft + (b.x_stem - b.x_deck_aft) * i / float(n_station)
                   for i in range(n_station + 1)]
        self.polys = [section_polygon(hull, x) for x in self.xs]

    def properties(self, heel_deg, z_w):
        """Объём и центр величины при крене и заданном уровне воды."""
        th = math.radians(heel_deg)
        c, s = math.cos(th), math.sin(th)
        areas, cys, czs = [], [], []
        for poly in self.polys:
            rot = [(y * c - z * s, y * s + z * c) for y, z in poly]
            a, cy, cz = _area_centroid(_clip_below(rot, z_w))
            areas.append(a)
            cys.append(cy)
            czs.append(cz)
        vol = _trapz(self.xs, areas)
        if vol <= 0:
            return None
        my = _trapz(self.xs, [a * y for a, y in zip(areas, cys)])
        mz = _trapz(self.xs, [a * z for a, z in zip(areas, czs)])
        return {"volume_mm3": vol, "cb_y_mm": my / vol, "cb_z_mm": mz / vol}

    def float_at(self, heel_deg, volume_mm3, lo=-3000.0, hi=3000.0, iters=44):
        """Уровень воды, при котором вытесняется заданный объём."""
        def f(z):
            p = self.properties(heel_deg, z)
            return (p["volume_mm3"] if p else 0.0) - volume_mm3

        if f(lo) > 0 or f(hi) < 0:
            return None
        for _ in range(iters):
            m = 0.5 * (lo + hi)
            if f(m) < 0:
                lo = m
            else:
                hi = m
        return 0.5 * (lo + hi)

    def gz(self, heel_deg, volume_mm3, kg_mm):
        """Плечо восстанавливающего момента, мм. Плюс — момент выпрямляет."""
        z_w = self.float_at(heel_deg, volume_mm3)
        if z_w is None:
            return None
        p = self.properties(heel_deg, z_w)
        if p is None:
            return None
        th = math.radians(heel_deg)
        # ЦТ поворачивается вместе с корпусом; плечо — горизонтальный разнос
        # между ним и центром величины в неподвижной системе. Знак выбран так,
        # чтобы положительное GZ означало выпрямляющий момент: при этом повороте
        # центр величины уходит на погружённый борт, то есть в минус по Y.
        y_g = -kg_mm * math.sin(th)
        return {"heel_deg": heel_deg, "gz_mm": y_g - p["cb_y_mm"],
                "waterline_mm": z_w, "cb_y_mm": p["cb_y_mm"],
                "cb_z_mm": p["cb_z_mm"]}


def _trapz(xs, ys):
    return sum(0.5 * (ys[i] + ys[i + 1]) * (xs[i + 1] - xs[i])
               for i in range(len(xs) - 1))


def curve(hull, displacement_kg, kg_mm, rho=1025.0, angles=None, n_station=40):
    """Диаграмма статической остойчивости: GZ по углам крена."""
    angles = angles or list(range(0, 91, 5))
    hh = HeeledHull(hull, n_station)
    vol = displacement_kg / rho * MM3_PER_M3
    out = []
    for a in angles:
        r = hh.gz(float(a), vol, kg_mm)
        if r is None:
            continue
        r["righting_moment_nm"] = displacement_kg * 9.80665 * r["gz_mm"] / 1000.0
        out.append(r)
    return out


def summarise(rows, gm_mm=None):
    """Ключевые точки диаграммы: максимум плеча и угол заката."""
    if not rows:
        return None
    best = max(rows, key=lambda r: r["gz_mm"])
    vanishing = None
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        if a["gz_mm"] > 0 >= b["gz_mm"]:
            t = a["gz_mm"] / (a["gz_mm"] - b["gz_mm"])
            vanishing = a["heel_deg"] + t * (b["heel_deg"] - a["heel_deg"])
            break
    # площадь под кривой до 30° — запас динамической остойчивости
    area30 = 0.0
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        if b["heel_deg"] > 30:
            break
        area30 += 0.5 * (a["gz_mm"] + b["gz_mm"]) * \
            math.radians(b["heel_deg"] - a["heel_deg"]) / 1000.0
    out = {"gz_max_mm": best["gz_mm"], "heel_at_gz_max_deg": best["heel_deg"],
           "vanishing_angle_deg": vanishing, "area_to_30deg_m_rad": area30}
    if gm_mm:
        small = [r for r in rows if 0 < r["heel_deg"] <= 10]
        if small:
            r = small[0]
            pred = gm_mm * math.sin(math.radians(r["heel_deg"]))
            out["gm_check"] = {"heel_deg": r["heel_deg"], "gz_mm": r["gz_mm"],
                               "gm_sin_theta_mm": pred,
                               "deviation_pct": 100.0 * (r["gz_mm"] - pred) / pred}
    return out
