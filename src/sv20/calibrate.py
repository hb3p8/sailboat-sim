"""Ф0, шаг 2: привязка чертежа к судостроительной системе координат.

Ничего не хардкодится «по месту»: опорные элементы ищутся по геометрической
сигнатуре и связности, а найденный масштаб проверяется независимыми
паспортными величинами. Если чертёж подменят, проверки упадут, а не выдадут
тихо неверный масштаб.

Важная тонкость: у 610 обратный наклон транца — нижняя кромка транца уходит
в корму дальше, чем кормовой конец линии борта. Поэтому габаритную длину
нельзя брать по линии борта: масштаб надо привязывать к контуру корпуса на
виде сбоку. Эта поправка (426.36 вместо 420.72 пункта) убирает систематическую
ошибку в 1.3%: ширина и надводный борт после неё сходятся с паспортом
практически точно.

Судостроительная система координат, мм:
    X — от кормовой оконечности в нос (транец внизу = 0)
    Y — полуширота, вправо от ДП
    Z — вверх от КВЛ
"""

# Паспортные величины проекта «610» (tihonovdesign.ru/610/mid_610_r.html).
# LOA принята за эталон масштаба, остальные — независимые проверки.
SPEC = {
    "loa_mm": 6100.0,
    "beam_mm": 2200.0,
    "freeboard_fwd_mm": 750.0,
    "freeboard_aft_mm": 560.0,
    "draft_hull_mm": 150.0,
    "draft_max_mm": 1600.0,
    "displacement_kg": 550.0,
}

TOLERANCE = 0.03   # паспорт округлён до сантиметров, 3% — это про округление
JOIN_TOL = 0.2     # пункты; координаты в файле лежат на сетке 0.06 пт


class CalibrationError(Exception):
    pass


def _dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


class Datum(object):
    """Привязка: где на листе ДП, КВЛ, оконечности, и сколько мм в пункте."""

    def __init__(self, x_ap, x_fp, y_cl, y_dwl, scale):
        self.x_ap = x_ap      # кормовая оконечность корпуса, пункты PDF
        self.x_fp = x_fp      # носовая оконечность корпуса, пункты PDF
        self.y_cl = y_cl      # ДП на виде сверху, пункты PDF
        self.y_dwl = y_dwl    # КВЛ на виде сбоку, пункты PDF
        self.scale = scale    # мм на пункт

    def X(self, x_pt):
        return (x_pt - self.x_ap) * self.scale

    def Y(self, y_pt):
        return (y_pt - self.y_cl) * self.scale

    def Z(self, y_pt):
        return (y_pt - self.y_dwl) * self.scale

    def plan(self, pt):
        """Точка вида сверху -> (X, Y) мм."""
        return (self.X(pt[0]), self.Y(pt[1]))

    def profile(self, pt):
        """Точка вида сбоку -> (X, Z) мм."""
        return (self.X(pt[0]), self.Z(pt[1]))

    def to_dict(self):
        return {
            "x_ap_pt": self.x_ap, "x_fp_pt": self.x_fp,
            "y_cl_pt": self.y_cl, "y_dwl_pt": self.y_dwl,
            "mm_per_pt": self.scale,
            "loa_mm": (self.x_fp - self.x_ap) * self.scale,
        }


# --------------------------------------------------------------------------
# поиск опорных элементов
# --------------------------------------------------------------------------

def find_deck_outline(subpaths, min_points=20, tol=0.05):
    """Две зеркальные половины линии борта на виде сверху.

    Признак: одинаковое число точек, совпадающие пределы по X и зеркальное
    совпадение по Y относительно общей оси. Возвращает (правая, левая, ось, невязка).
    """
    cand = [s for s in subpaths if len(s.points) >= min_points]
    best = None
    for i in range(len(cand)):
        a = cand[i]
        ax0, _, ax1, _ = a.bbox
        pa = sorted(a.points)
        for j in range(i + 1, len(cand)):
            b = cand[j]
            if len(a.points) != len(b.points):
                continue
            bx0, _, bx1, _ = b.bbox
            if abs(ax0 - bx0) > tol or abs(ax1 - bx1) > tol:
                continue
            pb = sorted(b.points)
            if max(abs(p[0] - q[0]) for p, q in zip(pa, pb)) > tol:
                continue
            axis = sum(p[1] + q[1] for p, q in zip(pa, pb)) / (2.0 * len(pa))
            err = max(abs(p[1] + q[1] - 2 * axis) for p, q in zip(pa, pb))
            if err > tol:
                continue
            if best is None or (ax1 - ax0) > best[0]:
                upper, lower = (a, b) if pa[0][1] > pb[0][1] else (b, a)
                best = (ax1 - ax0, upper, lower, axis, err)
    if best is None:
        raise CalibrationError("не найдена зеркальная пара — линия борта в плане")
    return best[1], best[2], best[3], best[4]


def find_dwl(subpaths, y_below):
    """КВЛ: самая длинная строго горизонтальная линия ниже вида сверху."""
    best = None
    for s in subpaths:
        ys = set(round(p[1], 4) for p in s.points)
        if len(ys) != 1:
            continue
        y = ys.pop()
        if y >= y_below:
            continue
        x0, _, x1, _ = s.bbox
        if best is None or (x1 - x0) > best[0]:
            best = (x1 - x0, y)
    if best is None:
        raise CalibrationError("не найдена горизонтальная опорная линия — КВЛ")
    return best[1]


def find_profile_sheer(subpaths, x_aft, x_fwd, y_dwl, y_below_plan, tol=0.05):
    """Линия борта на виде сбоку: тот же пролёт по X, что и на виде сверху.

    `y_below_plan` отсекает сам вид сверху, у которого пролёт по X тот же самый.
    """
    hits = [s for s in subpaths
            if abs(s.bbox[0] - x_aft) <= tol and abs(s.bbox[2] - x_fwd) <= tol
            and s.bbox[1] > y_dwl and s.bbox[3] < y_below_plan]
    if not hits:
        raise CalibrationError("не найдена линия борта на виде сбоку")
    hits.sort(key=lambda s: -s.length())
    return hits[0]


def _touching(subpaths, point, exclude, y_lo, y_hi):
    """Пути в полосе [y_lo, y_hi], у которых есть вершина в `point`.

    Совпадение ищется по всем вершинам, а не только по концам: в этом чертеже
    полилинии местами возвращаются назад, и стыковая точка контура оказывается
    внутренней вершиной (так у транца).
    """
    out = []
    for s in subpaths:
        if s in exclude or len(s.points) < 2:
            continue
        if not (y_lo - JOIN_TOL <= s.bbox[1] and s.bbox[3] <= y_hi + JOIN_TOL):
            continue
        if any(_dist(p, point) <= JOIN_TOL for p in s.points):
            out.append(s)
    return out


def _slice_between(points, a, b):
    """Кусок полилинии между ближайшими к a и b вершинами, в направлении a->b."""
    ia = min(range(len(points)), key=lambda i: _dist(points[i], a))
    ib = min(range(len(points)), key=lambda i: _dist(points[i], b))
    if ia <= ib:
        return points[ia:ib + 1]
    return list(reversed(points[ib:ia + 1]))


def trace_profile_outline(subpaths, sheer, y_dwl):
    """Контур корпуса на виде сбоку, разобранный по ролям.

    Обход идёт от кормового конца линии борта вниз по транцу, вперёд по днищу
    до пересечения с КВЛ; отдельно — от носового конца вниз по форштевню и
    назад по скуловому закруглению до КВЛ. Участок днища между этими точками
    на чертеже не проведён: всё, что ниже КВЛ, конструктор не показывал.
    """
    pts = sorted(sheer.points)
    aft_top, fwd_top = pts[0], pts[-1]
    y_hi = max(p[1] for p in sheer.points) + JOIN_TOL
    used = {sheer}
    out = {"sheer": [aft_top, fwd_top]}

    def descend(top, role_edge, role_foot):
        # кромка оконечности: из путей, приходящих в верхнюю точку, берём тот,
        # что реально уходит вниз, и притом дальше всех
        cand = [s for s in _touching(subpaths, top, used, y_dwl, y_hi)
                if s.bbox[1] < top[1] - 5.0]
        if not cand:
            raise CalibrationError("от точки %r вниз не отходит ни один контур" % (top,))
        cand.sort(key=lambda s: s.bbox[1])
        edge = cand[0]
        used.add(edge)
        foot = min(edge.points, key=lambda p: p[1])
        out[role_edge] = _slice_between(edge.points, top, foot)

        # от подошвы — участок, выходящий на КВЛ
        cand2 = [s for s in _touching(subpaths, foot, used, y_dwl, y_hi)
                 if abs(s.bbox[1] - y_dwl) <= JOIN_TOL]
        if not cand2:
            raise CalibrationError("от подошвы %r нет выхода на КВЛ" % (foot,))
        cand2.sort(key=lambda s: -s.length())
        run = cand2[0]
        used.add(run)
        end = min(run.points, key=lambda p: abs(p[1] - y_dwl))
        out[role_foot] = _slice_between(run.points, foot, end)

    descend(aft_top, "transom", "run_aft")
    descend(fwd_top, "stem", "forefoot")
    return out


# --------------------------------------------------------------------------

def calibrate(subpaths, spec=None):
    """Найти привязку и проверить её независимыми паспортными величинами."""
    spec = spec or SPEC

    upper, lower, y_cl, mirror_err = find_deck_outline(subpaths)
    x_deck_aft, _, x_deck_fwd, _ = upper.bbox
    y_plan_bottom = min(p[1] for p in lower.points)
    y_dwl = find_dwl(subpaths, y_below=y_plan_bottom)
    sheer = find_profile_sheer(subpaths, x_deck_aft, x_deck_fwd, y_dwl, y_plan_bottom)
    outline = trace_profile_outline(subpaths, sheer, y_dwl)

    all_pts = [p for chain in outline.values() for p in chain]
    x_ap = min(p[0] for p in all_pts)
    x_fp = max(p[0] for p in all_pts)
    scale = spec["loa_mm"] / (x_fp - x_ap)
    datum = Datum(x_ap, x_fp, y_cl, y_dwl, scale)

    sheer_pts = sorted(sheer.points)
    checks = [
        ("зеркальность линии борта, пт", mirror_err, 0.0, 0.05),
        ("ширина по палубе, мм", 2.0 * max(datum.Y(p[1]) for p in upper.points),
         spec["beam_mm"], None),
        ("надводный борт в носу, мм", datum.Z(sheer_pts[-1][1]),
         spec["freeboard_fwd_mm"], None),
        ("надводный борт в корме, мм", datum.Z(sheer_pts[0][1]),
         spec["freeboard_aft_mm"], None),
    ]

    report = []
    for name, got, want, abs_tol in checks:
        if abs_tol is not None:
            ok, dev = abs(got - want) <= abs_tol, None
        else:
            dev = (got - want) / want
            ok = abs(dev) <= TOLERANCE
        report.append({"name": name, "value": got, "expected": want,
                       "deviation": dev, "ok": ok})

    failed = [r for r in report if not r["ok"]]
    if failed:
        raise CalibrationError(
            "привязка не сошлась с паспортом: "
            + "; ".join("%s = %.3f (ожидалось %.3f)" % (r["name"], r["value"], r["expected"])
                        for r in failed))

    key = {"deck_starboard": upper, "deck_port": lower,
           "sheer_profile": sheer, "profile_outline": outline}
    return datum, key, report
