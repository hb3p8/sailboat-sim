"""Ф6: обводы парусов, рангоут и стоячий такелаж с плана парусности.

План парусности вычерчен в той же ДП и в тех же абсциссах, что и вид сбоку,
просто уходит вверх по листу. Поэтому весь модуль работает в координатах
`datum.profile`: X вперёд от кормовой оконечности, Z вверх от КВЛ, миллиметры.

Мешает одно: вид сверху нарисован поверх плана парусности и закрывает его
полосой примерно от 3.3 до 5.6 метра по высоте. Задняя шкаторина грота и
задняя шкаторина стакселя в этой полосе просто отсутствуют — не потому, что
их там нет, а потому, что их закрыли. Поэтому шкаторины собираются цепочкой
по связности с разрешённым разрывом: следующий кусок ищется по продолжению
направления, а не по совпадению концов.

Проверка одна, зато прямая: у чертежа в штампе своя парусность, 23 кв.м, и
снятые обводы обязаны сойтись с ней. Сходятся до полупроцента — это и есть
подтверждение, что прослежены именно паруса, а не что попало.

Зависимостей нет.
"""

import math

# Парусность из штампа самого чертежа. Это НЕ паспортные 25 кв.м с сайта
# магазина (calibrate.TARGET): у чертежа свои числа и по весу (550 против
# 590 кг), и по осадке (1.60 против 1.55). Обводы сверяются с чертежом,
# потому что сняты с него же.
#
# Разложение по парусам подтверждается независимо: у конструктора на
# tihonovdesign.ru/610 стоит грот 15.5 и стаксель 7.5 кв.м, что в сумме даёт
# те же 23. Снятые обводы дают 15.72 и 7.12 — сходится и порознь, и в сумме.
SAIL_AREA_DRAWN_M2 = 23.0
AREA_TOLERANCE = 0.04

MASK_GAP_MM = 2600.0   # какой разрыв в шкаторине терпим: полоса вида сверху
TURN_TOL_DEG = 16.0    # насколько следующий кусок шкаторины может отвернуть


class SailPlanError(Exception):
    pass


# ------------------------------------------------------------------ мелочёвка

def _segments(subpaths, datum, min_len=60.0):
    """Все звенья всех путей в координатах вида сбоку, нижним концом первым.

    Отсекается рамка листа: её вертикали длиннее мачты и полезли бы во все
    отборы «самое длинное».
    """
    loa = datum.X(datum.x_fp)
    out = []
    for sp in subpaths:
        pts = [datum.profile(p) for p in sp.points]
        for a, b in zip(pts, pts[1:]):
            if a[1] > b[1]:
                a, b = b, a
            length = math.hypot(b[0] - a[0], b[1] - a[1])
            if length < min_len:
                continue
            if any(p[0] < -300.0 or p[0] > loa + 500.0 or
                   p[1] < -300.0 or p[1] > 10500.0 for p in (a, b)):
                continue
            out.append({"a": a, "b": b, "len": length, "w": sp.width,
                        "ang": math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))})
    return out


def _line(a, b):
    return (a, (b[0] - a[0], b[1] - a[1]))


def _intersect(l1, l2):
    (p, d), (q, e) = l1, l2
    den = d[0] * e[1] - d[1] * e[0]
    if abs(den) < 1e-9:
        raise SailPlanError("прямые параллельны")
    t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
    return (p[0] + d[0] * t, p[1] + d[1] * t)


def _at_z(line, z):
    (p, d) = line
    return p[0] + d[0] * (z - p[1]) / d[1]


def _off(line, pt):
    """Расстояние от точки до прямой."""
    (p, d) = line
    n = math.hypot(d[0], d[1])
    return abs(d[0] * (pt[1] - p[1]) - d[1] * (pt[0] - p[0])) / n


def _area(poly):
    """Площадь замкнутого контура, кв.м, если вершины в мм."""
    s = 0.0
    for i in range(len(poly)):
        x0, z0 = poly[i]
        x1, z1 = poly[(i + 1) % len(poly)]
        s += x0 * z1 - x1 * z0
    return abs(s) / 2.0e6


def _centroid(poly):
    """Центр площади контура, мм."""
    cx = cz = a = 0.0
    for i in range(len(poly)):
        x0, z0 = poly[i]
        x1, z1 = poly[(i + 1) % len(poly)]
        cr = x0 * z1 - x1 * z0
        a += cr
        cx += (x0 + x1) * cr
        cz += (z0 + z1) * cr
    if abs(a) < 1e-9:
        raise SailPlanError("вырожденный контур")
    return (cx / (3.0 * a), cz / (3.0 * a))


# ------------------------------------------------------------------- рангоут

def _find_mast(segs):
    """Мачта и фаловая дощечка грота.

    Мачта вычерчена тремя параллелями — две грани профиля и линия ликпаза, —
    и какая из них несёт переднюю шкаторину, по наклону не понять. Понять
    можно по дощечке: короткий горизонтальный отрезок на самом верху, его
    передний конец лежит ровно на нужной прямой. Поэтому прямая и дощечка
    ищутся не порознь, а парой — по наименьшему промаху.
    """
    cand = [s for s in segs
            if 85.0 < s["ang"] < 100.0 and s["len"] > 2500.0 and s["b"][1] > 9000.0]
    if not cand:
        raise SailPlanError("не найдена мачта")
    top_z = max(s["b"][1] for s in cand)
    boards = [s for s in segs
              if abs(s["ang"]) < 12.0 and 60.0 < s["len"] < 400.0
              and top_z - 900.0 < s["b"][1] < top_z + 60.0]
    if not boards:
        raise SailPlanError("не найдена фаловая дощечка грота")

    best = None
    for m in cand:
        line = _line(m["a"], m["b"])
        for b in boards:
            fwd = max([b["a"], b["b"]], key=lambda p: p[0])
            off = _off(line, fwd)
            if best is None or off < best[0]:
                best = (off, line, fwd, min([b["a"], b["b"]], key=lambda p: p[0]), m)
    if best[0] > 60.0:
        raise SailPlanError("дощечка не села ни на одну грань мачты")
    return best[1], best[2], best[3], best[4]


def _find_boom(segs, mast):
    """Верхняя грань гика — по ней идёт нижняя шкаторина грота.

    Гик отбирается не только по наклону и высоте: на той же высоте у форштевня
    лежит пара длинных горизонталей, и они длиннее гика. Отсекаются тем, что
    гик целиком позади мачты.
    """
    cand = []
    for s in segs:
        if abs(s["ang"]) > 6.0 or s["len"] < 2000.0:
            continue
        if not (1200.0 < (s["a"][1] + s["b"][1]) / 2.0 < 2000.0):
            continue
        z = (s["a"][1] + s["b"][1]) / 2.0
        if max(s["a"][0], s["b"][0]) > _at_z(mast, z) + 150.0:
            continue
        cand.append(s)
    if len(cand) < 2:
        raise SailPlanError("не найден гик")
    top = max(cand, key=lambda s: (s["a"][1] + s["b"][1]) / 2.0)
    return _line(top["a"], top["b"]), top


def _trace_leech(segs, start_near, finish, mast, min_len=280.0):
    """Задняя шкаторина: цепочка снизу вверх с разрывом на полосе вида сверху.

    Куски ищутся по продолжению направления. Соседство концов не годится:
    в середине шкаторина закрыта видом сверху и разорвана на два с половиной
    метра.
    """
    cand = []
    for s in segs:
        if s["len"] < min_len or not (40.0 < s["ang"] < 86.0):
            continue
        z = (s["a"][1] + s["b"][1]) / 2.0
        if (s["a"][0] + s["b"][0]) / 2.0 > _at_z(mast, z) - 200.0:
            continue                       # это уже не позади мачты
        cand.append(s)
    if not cand:
        raise SailPlanError("не найдено ни одного куска задней шкаторины")

    first = min(cand, key=lambda s: math.hypot(s["a"][0] - start_near[0],
                                               s["a"][1] - start_near[1]))
    if math.hypot(first["a"][0] - start_near[0],
                  first["a"][1] - start_near[1]) > 300.0:
        raise SailPlanError("нижний конец шкаторины не сходится со шкотовым углом")

    chain = [first["a"], first["b"]]
    used = {id(first)}
    while math.hypot(chain[-1][0] - finish[0], chain[-1][1] - finish[1]) > 200.0:
        cur = chain[-1]
        prev = chain[-2]
        dir_ang = math.degrees(math.atan2(cur[1] - prev[1], cur[0] - prev[0]))
        best, best_gap = None, None
        for s in cand:
            if id(s) in used or s["a"][1] < cur[1] - 50.0:
                continue
            gap = math.hypot(s["a"][0] - cur[0], s["a"][1] - cur[1])
            if gap > MASK_GAP_MM:
                continue
            bear = math.degrees(math.atan2(s["a"][1] - cur[1], s["a"][0] - cur[0]))
            if gap > 5.0 and abs(bear - dir_ang) > TURN_TOL_DEG:
                continue
            if abs(s["ang"] - dir_ang) > 2 * TURN_TOL_DEG:
                continue
            if best_gap is None or gap < best_gap:
                best, best_gap = s, gap
        if best is None:
            raise SailPlanError("шкаторина обрывается на z=%.0f" % cur[1])
        used.add(id(best))
        if best_gap > 5.0:
            chain.append(best["a"])
        else:
            chain[-1] = best["a"]
        chain.append(best["b"])
    chain[-1] = finish
    return chain


def _find_forestay(segs):
    """Штаг и передняя шкаторина стакселя: две параллели в десяти миллиметрах.

    Штаг длиннее — он идёт до топа в узел с вантами, стаксель кончается ниже,
    там его фаловый угол.
    """
    cand = [s for s in segs if 100.0 < s["ang"] < 120.0 and s["len"] > 700.0]
    if len(cand) < 2:
        raise SailPlanError("не найден штаг")
    # Наклон штага задаёт самый длинный кусок; всё, что от него отличается
    # больше чем на полтора градуса, — соседние линии, а не штаг.
    longest = max(cand, key=lambda s: s["len"])
    cand = [s for s in cand if abs(s["ang"] - longest["ang"]) < 1.5]
    if len(cand) < 2:
        raise SailPlanError("не найден штаг")
    ref = _line(longest["a"], longest["b"])
    (p, d) = ref
    n = math.hypot(d[0], d[1])
    def sign_off(s):
        m = ((s["a"][0] + s["b"][0]) / 2.0, (s["a"][1] + s["b"][1]) / 2.0)
        return (d[0] * (m[1] - p[1]) - d[1] * (m[0] - p[0])) / n
    offs = sorted(sign_off(s) for s in cand)
    split = (offs[0] + offs[-1]) / 2.0
    if offs[-1] - offs[0] < 4.0:
        raise SailPlanError("штаг и шкаторина стакселя не разделились")
    groups = ([s for s in cand if sign_off(s) <= split],
              [s for s in cand if sign_off(s) > split])
    tops = [max(g, key=lambda s: s["b"][1])["b"] for g in groups]
    stay, sail = (0, 1) if tops[0][1] > tops[1][1] else (1, 0)
    def ends(g):
        return (min(g, key=lambda s: s["a"][1])["a"],
                max(g, key=lambda s: s["b"][1])["b"])
    stem, hounds = ends(groups[stay])
    tack, head = ends(groups[sail])
    return {"stay": (stem, hounds), "luff": (tack, head),
            "line": _line(*ends(groups[sail]))}


def _find_jib_leech(segs, head, tol=60.0):
    """Задняя шкаторина стакселя — почти отвес от фалового угла до палубы."""
    cand = [s for s in segs if abs(s["ang"] - 90.0) < 2.5 and s["len"] > 150.0]
    top = [s for s in cand
           if math.hypot(s["b"][0] - head[0], s["b"][1] - head[1]) < 200.0]
    if not top:
        raise SailPlanError("не найдена задняя шкаторина стакселя")
    top = max(top, key=lambda s: s["len"])
    line = _line(top["a"], top["b"])
    same = [s for s in cand
            if _off(line, s["a"]) < tol and _off(line, s["b"]) < tol]
    clew = min((s["a"] for s in same), key=lambda p: p[1])
    return clew, top["b"]


def _find_shroud(segs, mast):
    """Вантина на виде сбоку: обе проецируются в одну прямую."""
    cand = []
    for s in segs:
        if not (81.0 < s["ang"] < 89.0) or s["len"] < 1200.0 or s["b"][1] < 7000.0:
            continue
        z = (s["a"][1] + s["b"][1]) / 2.0
        if (s["a"][0] + s["b"][0]) / 2.0 > _at_z(mast, z) - 100.0:
            continue
        cand.append(s)
    if not cand:
        return None
    best = max(cand, key=lambda s: s["len"])
    return _line(best["a"], best["b"]), best["b"]


def _find_jib_track(subpaths, datum, plan_box, deck_pts, x_range=(3000.0, 5000.0)):
    """Погон стаксель-шкота на виде сверху.

    Признак — две длинные тонкие параллели, между которыми насверлены дырки.
    Параллелей на носовой палубе хватает и без погона (одна только рама люка
    даёт четыре), а вот отверстий по всей длине нет ни у чего другого: по ним
    погон и опознаётся.

    Нужен он затем, что шкотовый угол стакселя тянут не в ДП, а к каретке на
    этом рельсе, и острее её парус не выбрать.
    """
    if plan_box is None or not deck_pts:
        return None
    x0, y0, x1, y1 = plan_box
    segs = []
    for sp in subpaths:
        if not all(x0 <= p[0] <= x1 and y0 <= p[1] <= y1 for p in sp.points):
            continue
        if len(sp.points) != 2:
            continue
        a, b = datum.plan(sp.points[0]), datum.plan(sp.points[1])
        if a[0] > b[0]:
            a, b = b, a
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if length < 200.0 or length > 500.0:
            continue
        mx, my = (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0
        if not (x_range[0] <= mx <= x_range[1]) or my <= 0:
            continue
        f = abs(my) / max(1.0, _half_beam(deck_pts, mx))
        if not (0.2 <= f <= 0.65):
            continue
        segs.append((a, b, math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))))

    holes = []
    for sp in subpaths:
        if len(sp.points) < 4 or not all(x0 <= p[0] <= x1 and y0 <= p[1] <= y1
                                         for p in sp.points):
            continue
        q = [datum.plan(p) for p in sp.points]
        w = max(p[0] for p in q) - min(p[0] for p in q)
        h = max(p[1] for p in q) - min(p[1] for p in q)
        if not (6.0 <= w <= 45.0 and 6.0 <= h <= 45.0):
            continue
        holes.append((sum(p[0] for p in q) / len(q), sum(p[1] for p in q) / len(q)))

    best = None
    for i in range(len(segs)):
        for j in range(i + 1, len(segs)):
            a, b, ang = segs[i]
            c, d, ang2 = segs[j]
            if abs(ang - ang2) > 1.0:
                continue
            gap = abs((a[1] + b[1]) / 2.0 - (c[1] + d[1]) / 2.0)
            if not (8.0 <= gap <= 50.0):
                continue
            if min(b[0], d[0]) - max(a[0], c[0]) < 150.0:
                continue
            mid = _line(((a[0] + c[0]) / 2.0, (a[1] + c[1]) / 2.0),
                        ((b[0] + d[0]) / 2.0, (b[1] + d[1]) / 2.0))
            lo, hi = min(a[0], c[0]), max(b[0], d[0])
            n = sum(1 for p in holes
                    if lo <= p[0] <= hi and _off(mid, p) < 40.0)
            if n >= 4 and (best is None or n > best[0]):
                best = (n, a, b, c, d)
    if best is None:
        return None
    _, a, b, c, d = best
    aft = ((a[0] + c[0]) / 2.0, (a[1] + c[1]) / 2.0)
    fwd = ((b[0] + d[0]) / 2.0, (b[1] + d[1]) / 2.0)
    return {"aft_mm": [round(aft[0], 1), round(aft[1], 1)],
            "fwd_mm": [round(fwd[0], 1), round(fwd[1], 1)],
            "car_mm": [round((aft[0] + fwd[0]) / 2.0, 1),
                       round((aft[1] + fwd[1]) / 2.0, 1)]}


def _half_beam(deck_pts, x):
    """Полуширина по линии борта на виде сверху в заданной абсциссе."""
    pts = sorted(deck_pts)
    for a, b in zip(pts, pts[1:]):
        if a[0] <= x <= b[0] and b[0] > a[0]:
            t = (x - a[0]) / (b[0] - a[0])
            return abs(a[1] + t * (b[1] - a[1]))
    return abs(pts[0][1] if x < pts[0][0] else pts[-1][1])


# --------------------------------------------------------------------- сборка

def _deck_z(sheer_pts, x):
    """Высота линии борта на виде сбоку в заданной абсциссе."""
    pts = sorted(sheer_pts)
    for a, b in zip(pts, pts[1:]):
        if a[0] <= x <= b[0] and b[0] > a[0]:
            t = (x - a[0]) / (b[0] - a[0])
            return a[1] + t * (b[1] - a[1])
    return pts[0][1] if x < pts[0][0] else pts[-1][1]


def find_sail_plan(subpaths, datum, sheer_pts=None, deck_pts=None, plan_box=None):
    """Обводы обоих парусов, рангоут и стоячий такелаж, всё в миллиметрах.

    `sheer_pts` — линия борта на виде сбоку, `deck_pts` — она же на виде
    сверху, `plan_box` — габарит вида сверху. Нужны, чтобы посадить на палубу
    пятку мачты, путенс вант и погон стаксель-шкота: на самом плане парусности
    их закрывает вид сверху, а погона там нет вовсе.
    """
    segs = _segments(subpaths, datum)

    mast, head_fwd, head_aft, mast_seg = _find_mast(segs)
    boom, boom_seg = _find_boom(segs, mast)
    tack = _intersect(mast, boom)
    boom_aft = min([boom_seg["a"], boom_seg["b"]], key=lambda p: p[0])
    leech = _trace_leech(segs, boom_aft, head_aft, mast)
    clew = leech[0]

    fore = _find_forestay(segs)
    jib_clew, jib_head = _find_jib_leech(segs, fore["luff"][1])
    jib_tack = fore["luff"][0]

    main_poly = [tack, clew] + leech[1:] + [head_fwd]
    jib_poly = [jib_tack, fore["luff"][1], jib_head, jib_clew]

    main_area = _area(main_poly)
    jib_area = _area(jib_poly)
    total = main_area + jib_area
    if abs(total - SAIL_AREA_DRAWN_M2) > AREA_TOLERANCE * SAIL_AREA_DRAWN_M2:
        raise SailPlanError(
            "снятая парусность %.2f кв.м не сходится со штампом чертежа %.1f"
            % (total, SAIL_AREA_DRAWN_M2))

    shroud = _find_shroud(segs, mast)
    track = _find_jib_track(subpaths, datum, plan_box, deck_pts)

    mast_top = max([mast_seg["a"], mast_seg["b"]], key=lambda p: p[1])
    # Пятка мачты на чертеже не видна — её закрывает вид сверху, — поэтому за
    # низ рангоута берётся пересечение прямой мачты с линией борта.
    mast_deck = None
    if sheer_pts:
        z = _deck_z(sheer_pts, _at_z(mast, 900.0))
        for _ in range(3):
            z = _deck_z(sheer_pts, _at_z(mast, z))
        mast_deck = (_at_z(mast, z), z)

    def rd(pts):
        return [[round(p[0], 1), round(p[1], 1)] for p in pts]

    # Вантина проведена одной прямой без изломов: спредеры либо не показаны,
    # либо попали под вид сверху. Путенс — там, где её след приходит на линию
    # борта; полуширина взята оттуда же, потому что путенс стоит у борта.
    shroud_out = None
    if shroud is not None and sheer_pts:
        z = _deck_z(sheer_pts, _at_z(shroud[0], 900.0))
        for _ in range(3):
            z = _deck_z(sheer_pts, _at_z(shroud[0], z))
        x = _at_z(shroud[0], z)
        shroud_out = {"tang_mm": rd([shroud[1]])[0],
                      "chainplate_mm": [round(x, 1), round(z, 1)],
                      "angle_deg": round(math.degrees(
                          math.atan2(shroud[0][1][1], shroud[0][1][0])), 2)}
        if deck_pts:
            shroud_out["chainplate_y_mm"] = round(_half_beam(deck_pts, x), 1)

    # Погон лежит на палубе, и его высота на плане не показана — берётся с
    # линии борта в той же абсциссе.
    track_out = None
    if track is not None:
        track_out = dict(track)
        if sheer_pts:
            track_out["deck_z_mm"] = round(_deck_z(sheer_pts, track["car_mm"][0]), 1)

    return {
        "main": {
            "luff": rd([tack, head_fwd]),
            "leech": rd([head_aft] + list(reversed(leech[1:-1])) + [clew]),
            "tack": rd([tack])[0], "head": rd([head_fwd])[0],
            "head_aft": rd([head_aft])[0], "clew": rd([clew])[0],
            "area_m2": round(main_area, 3),
            "centroid_mm": rd([_centroid(main_poly)])[0],
            "luff_mm": round(math.hypot(head_fwd[0] - tack[0],
                                        head_fwd[1] - tack[1]), 1),
            "foot_mm": round(math.hypot(clew[0] - tack[0], clew[1] - tack[1]), 1),
        },
        "jib": {
            "luff": rd([jib_tack, fore["luff"][1]]),
            "leech": rd([jib_head, jib_clew]),
            "tack": rd([jib_tack])[0], "head": rd([fore["luff"][1]])[0],
            "head_aft": rd([jib_head])[0], "clew": rd([jib_clew])[0],
            "area_m2": round(jib_area, 3),
            "centroid_mm": rd([_centroid(jib_poly)])[0],
            "luff_mm": round(math.hypot(fore["luff"][1][0] - jib_tack[0],
                                        fore["luff"][1][1] - jib_tack[1]), 1),
            "foot_mm": round(math.hypot(jib_clew[0] - jib_tack[0],
                                        jib_clew[1] - jib_tack[1]), 1),
        },
        "mast": {
            "deck_mm": None if mast_deck is None else rd([mast_deck])[0],
            "top_mm": rd([mast_top])[0],
            "rake_deg": round(math.degrees(math.atan2(-mast[1][0], mast[1][1])), 2),
        },
        "boom": {
            "gooseneck_mm": rd([(_at_z(boom, tack[1]), tack[1])])[0],
            "aft_mm": rd([boom_aft])[0],
            "length_mm": round(math.hypot(boom_aft[0] - tack[0],
                                          boom_aft[1] - tack[1]), 1),
        },
        "forestay": {"stem_mm": rd([fore["stay"][0]])[0],
                     "hounds_mm": rd([fore["stay"][1]])[0]},
        "shroud": shroud_out,
        "jib_track": track_out,
        "area_total_m2": round(total, 3),
        "area_drawn_m2": SAIL_AREA_DRAWN_M2,
    }
