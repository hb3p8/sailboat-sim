"""Ф2: параметрическая модель корпуса.

Поверхность строится продольным протягиванием шпангоутов из `sections.py`.
Границы, снятые на Ф1, входят как жёсткие условия и не подлежат подгонке:

    линия борта  Y_s(X), Z_s(X)  — снята с двух видов, ошибка на уровне масштаба
    днище в корме Z_k(X), X ≤ 554 — снято с вида сбоку
    форштевень   Z_k(X), X ≥ 6023 — снято с вида сбоку
    транец                        — плоскость по силуэту

Подгоняются только пять продольных законов:

    z_keel — линия киля в ДП между известными концами (главная неизвестная)
    beta, phi, k0, k1 — форма шпангоута по длине

Каждый закон — сплайн по горстке контрольных точек. Их немного нарочно: чем
меньше степеней свободы, тем меньше шансов, что подгонка под объём вылепит
формально верную, но бугристую поверхность.

Зависимостей нет.
"""

import math

from . import curves, sections

# Продольные станции, на которых заданы контрольные значения законов формы.
SHAPE_STATIONS = [0.0, 900.0, 1900.0, 2900.0, 3900.0, 4800.0, 5500.0, 6100.0]

# Контрольные абсциссы линии киля между известными концами.
KEEL_STATIONS = [900.0, 1500.0, 2200.0, 3000.0, 3800.0, 4600.0, 5300.0, 5750.0]

# Палуба. Плановая раскладка снята с чертежа, высоты — свободная
# интерпретация: на виде сбоку они не разобраны, а для плавучести и инерции
# важны слабо. Уровень пайола выбран выше подошвы транца (+65 мм), чтобы
# кокпит был самоотливным.
DECK = {
    "crown_frac": 0.045,        # погибь палубы в долях полушироты
    "crown_ramp_mm": 500.0,     # к транцу погибь сходит на нет: кромка прямая
    "coaming_height_mm": 55.0,
    "sole_z_mm": 180.0,         # пайол кокпита над КВЛ
    "cabin_height_mm": 110.0,
    "blend_mm": 220.0,          # на этой длине кокпит сходит к переборке
}


SHAPE_LAWS = ("beta", "w", "b0", "b1", "r")


class HullParams(object):
    """Вектор подгоняемых величин: линия киля плюс пять законов формы."""

    def __init__(self, keel_z, beta, w, b0, b1, r):
        self.keel_z = list(keel_z)
        self.beta, self.w, self.b0, self.b1, self.r = (
            list(beta), list(w), list(b0), list(b1), list(r))
        n, m = len(KEEL_STATIONS), len(SHAPE_STATIONS)
        if len(self.keel_z) != n:
            raise ValueError("keel_z: ожидалось %d значений, получено %d"
                             % (n, len(self.keel_z)))
        for name in SHAPE_LAWS:
            v = getattr(self, name)
            if len(v) != m:
                raise ValueError("%s: ожидалось %d значений, получено %d"
                                 % (name, m, len(v)))

    def to_vector(self):
        out = list(self.keel_z)
        for name in SHAPE_LAWS:
            out += getattr(self, name)
        return out

    @classmethod
    def from_vector(cls, v):
        n, m = len(KEEL_STATIONS), len(SHAPE_STATIONS)
        i = n
        laws = []
        for _ in SHAPE_LAWS:
            laws.append(list(v[i:i + m]))
            i += m
        return cls(list(v[:n]), *laws)

    def bounds(self):
        """Пределы для каждой компоненты вектора — вход для оптимизатора Ф3."""
        out = [(-400.0, 40.0)] * len(KEEL_STATIONS)
        for name in SHAPE_LAWS:
            out += [sections.BOUNDS[name]] * len(SHAPE_STATIONS)
        return out

    def to_dict(self):
        d = {"keel_stations": KEEL_STATIONS, "keel_z": self.keel_z,
             "shape_stations": SHAPE_STATIONS}
        for name in SHAPE_LAWS:
            d[name] = getattr(self, name)
        return d


# Стартовая точка: спортбот с плоским кормовым днищем, острым входом
# и заметным развалом борта в носу. Числа взяты как правдоподобные, а не
# подобранные — подгонка под гидростатику это работа Ф3.
DEFAULT = HullParams(
    keel_z=[-88.0, -126.0, -148.0, -152.0, -146.0, -124.0, -80.0, -42.0],
    beta=[7.0, 8.0, 10.0, 13.0, 18.0, 27.0, 38.0, 46.0],
    w=[0.78, 0.80, 0.80, 0.78, 0.72, 0.62, 0.48, 0.34],
    b0=[0.005, 0.008, 0.012, 0.016, 0.020, 0.022, 0.020, 0.015],
    b1=[0.010, 0.012, 0.015, 0.018, 0.022, 0.026, 0.028, 0.030],
    r=[0.30, 0.32, 0.34, 0.36, 0.40, 0.44, 0.48, 0.52],
)


def calibrate_deadrise(boundary, params, target_kg, hydro_mod,
                       lo=0.25, hi=2.0, iters=32):
    """Свести водоизмещение к цели одним числом — общим множителем килеватости.

    Это не подгонка Ф3, а проверка достижимости: если единственный скаляр
    выводит модель на цель, значит параметризация в принципе накрывает нужную
    форму и оптимизатору будет что искать. Килеватость выбрана рычагом потому,
    что при заданной осадке именно она определяет полноту подводного шпангоута,
    почти не трогая ни линию борта, ни линию киля.

    Возвращает (множитель, новые параметры) или (None, params), если цель
    недостижима в разумных пределах.
    """
    lim = sections.BOUNDS["beta"]

    def scaled(f):
        return HullParams(
            keel_z=params.keel_z,
            beta=[max(lim[0], min(lim[1], v * f)) for v in params.beta],
            w=params.w, b0=params.b0, b1=params.b1, r=params.r)

    def disp(f):
        h = hydro_mod.hydrostatics(Hull(boundary, scaled(f)), 0.0, n=80)
        return (h["displacement_kg"] if h else 0.0) - target_kg

    flo, fhi = disp(lo), disp(hi)
    if flo * fhi > 0:
        return None, params
    a, b = lo, hi
    for _ in range(iters):
        m = 0.5 * (a + b)
        if flo * disp(m) <= 0:
            b = m
        else:
            a, flo = m, disp(m)
    f = 0.5 * (a + b)
    return f, scaled(f)


class Boundary(object):
    """Жёсткие условия, снятые на Ф1."""

    def __init__(self, frame_doc):
        cur = dict((c["name"], c["points"]) for c in frame_doc["curves"])
        m = frame_doc["metrics"]

        sheer = sorted(cur["sheer_stbd"])
        self.sheer_y = curves.Polyline([(p[0], p[1]) for p in sheer])
        self.sheer_z = curves.Polyline([(p[0], p[2]) for p in sheer])
        self.x_deck_aft = sheer[0][0]
        self.x_stem = sheer[-1][0]

        self.run_aft = curves.Polyline([(p[0], p[2]) for p in cur["run_aft"]])
        self.x_run_end = max(p[0] for p in cur["run_aft"])

        fore = sorted((p[0], p[2]) for p in cur["stem"])
        self.forefoot = curves.Polyline(fore)
        self.x_forefoot = fore[0][0]

        self.transom_a, self.transom_b, self.transom_rms = fit_transom(cur["transom"])
        self.metrics = m

        # Раскладка палубы: комингс кокпита, кромка рецесса и рубка сняты
        # с вида сверху (features.py). Высоты и погибь — свободная
        # интерпретация, см. DECK.
        f = frame_doc.get("features") or {}
        d = f.get("deck_layout")
        self.deck = None
        if d:
            self.deck = {
                "coaming_outer": curves.Polyline([(p[0], p[1]) for p in d["coaming_outer"]]),
                "coaming_inner": curves.Polyline([(p[0], p[1]) for p in d["coaming_inner"]]),
                "recess_edge": curves.Polyline([(p[0], p[1]) for p in d["recess_edge"]]),
                "x_fwd": d["x_fwd_mm"],
                "cabin": f.get("cabin"),
            }

    def transom_x(self, z):
        """Абсцисса плоскости транца на высоте z."""
        return self.transom_a + self.transom_b * z


def _same(a, b, tol=0.02):
    return all(abs(a[k] - b[k]) <= tol for k in range(3))


def fit_transom(points):
    """Плоскость транца: X = a + b·Z методом наименьших квадратов.

    Реальная кромка отклоняется от плоскости на единицы миллиметров — величина
    возвращается, чтобы упрощение было видно, а не подразумевалось.
    """
    zs = [p[2] for p in points]
    xs = [p[0] for p in points]
    n = float(len(zs))
    mz, mx = sum(zs) / n, sum(xs) / n
    sz = sum((z - mz) ** 2 for z in zs)
    b = 0.0 if sz == 0 else sum((z - mz) * (x - mx) for z, x in zip(zs, xs)) / sz
    a = mx - b * mz
    rms = math.sqrt(sum((x - (a + b * z)) ** 2 for x, z in zip(xs, zs)) / n)
    return a, b, rms


class Hull(object):
    """Поверхность корпуса: параметры + граничные условия -> шпангоуты и сетка."""

    def __init__(self, boundary, params=None):
        self.b = boundary
        self.p = params or DEFAULT
        self._build_laws()

    def _build_laws(self):
        b, p = self.b, self.p
        # линия киля: концы прибиты к снятому с чертежа, середина свободна
        xs = [0.0, b.x_run_end * 0.5, b.x_run_end] + list(KEEL_STATIONS) + [b.x_forefoot]
        zs = ([b.run_aft(0.0), b.run_aft(b.x_run_end * 0.5), b.run_aft(b.x_run_end)]
              + list(p.keel_z) + [b.forefoot(b.x_forefoot)])
        self.keel = curves.Spline(xs, zs)
        self.law = dict((name, curves.Pchip(SHAPE_STATIONS, getattr(p, name)))
                        for name in SHAPE_LAWS)

    def z_keel(self, x):
        # впереди подошвы форштевня работает снятая с чертежа скула
        if x >= self.b.x_forefoot:
            return self.b.forefoot(x)
        return self.keel(x)

    def section(self, x):
        b = self.b
        ys = max(1.0, b.sheer_y(x))
        zs = b.sheer_z(x)
        zk = min(self.z_keel(x), zs - 1.0)
        L = self.law
        return sections.Section(zk, ys, zs, L["beta"](x), L["w"](x),
                                L["b0"](x), L["b1"](x), L["r"](x))

    # ------------------------------------------------------------ сетка

    def _x_aft(self, j, n_girth):
        """Где линия сетки номер j упирается в плоскость транца.

        Простая итерация вместо деления пополам: высота точки почти не зависит
        от абсциссы на этих восьмидесяти миллиметрах, и всё сходится за два-три
        шага вместо сорока.
        """
        b = self.b
        x = 0.0
        for _ in range(8):
            z = self.section(max(x, -60.0)).by_arclength(n_girth)[j][1]
            nx = b.transom_x(z)
            if abs(nx - x) < 0.02:
                return nx
            x = nx
        return x

    def mesh(self, n_station=110, n_girth=26):
        """Структурированная сетка: кормовая граница ложится ровно на транец,
        поэтому транец получается плоским многоугольником без обрезки треугольников."""
        b = self.b
        x_fwd = b.x_stem
        rows = []
        transom_edge = []
        for j in range(n_girth + 1):
            xa = self._x_aft(j, n_girth)
            row = []
            for i in range(n_station + 1):
                t = i / float(n_station)
                x = xa + (x_fwd - xa) * (t ** 1.15)   # сгущение к корме
                pts = self.section(x).by_arclength(n_girth)
                y, z = pts[j]
                row.append((x, y, z))
            rows.append(row)
            transom_edge.append(row[0])

        verts, quads = [], []
        idx = {}
        for j, row in enumerate(rows):
            for i, pt in enumerate(row):
                idx[(j, i)] = len(verts)
                verts.append(pt)
        for j in range(n_girth):
            for i in range(n_station):
                quads.append([idx[(j, i)], idx[(j, i + 1)],
                              idx[(j + 1, i + 1)], idx[(j + 1, i)]])
        return {"verts": verts, "quads": quads, "rows": rows,
                "transom_edge": transom_edge}

    def deck_ring(self, x, ys, zs, n_camber=7):
        """Поперечный профиль палубы на абсциссе x: от левого борта к правому.

        Комингс кокпита, его внутренняя грань и кромка рецесса сняты с чертежа.
        Высоты — свободная интерпретация в пределах DECK: погибь палубы, высота
        комингса, уровень пайола. У переборки ширины и глубина рецесса сходят
        на нет за DECK["blend_mm"], чтобы поверхность осталась непрерывной.
        """
        d = self.b.deck
        crown_ramp = min(1.0, max(0.0, (x - self.b.x_deck_aft) / DECK["crown_ramp_mm"]))
        crown = DECK["crown_frac"] * ys * crown_ramp

        def z_deck(y):
            u = 0.0 if ys <= 0 else y / ys
            z = zs + crown * (1.0 - u * u)
            cab = d and d.get("cabin")
            if cab and cab["x_aft_mm"] <= x <= cab["x_fwd_mm"]:
                fy = max(0.0, 1.0 - (abs(y) / cab["half_width_mm"]) ** 2)
                span = cab["x_fwd_mm"] - cab["x_aft_mm"]
                t = min(x - cab["x_aft_mm"], cab["x_fwd_mm"] - x) / (0.25 * span)
                z += DECK["cabin_height_mm"] * fy * min(1.0, max(0.0, t))
            return z

        half = []
        if d and x <= d["x_fwd"]:
            k = min(1.0, max(0.0, (d["x_fwd"] - x) / DECK["blend_mm"]))
            y_co = min(d["coaming_outer"](x), 0.96 * ys) * k
            y_ci = min(d["coaming_inner"](x), y_co) * k
            y_re = min(d["recess_edge"](x), y_ci) * k
            z_seat = z_deck(y_ci)
            z_top = z_seat + DECK["coaming_height_mm"] * k
            z_sole = z_seat + (DECK["sole_z_mm"] - z_seat) * k
            half = [(0.0, z_sole), (y_re, z_sole), (y_re, z_seat),
                    (y_ci, z_seat), (y_ci, z_top), (y_co, z_top),
                    (y_co, z_deck(y_co))]
        else:
            z0 = z_deck(0.0)
            half = [(0.0, z0)] * 7
            y_co = 0.0

        for i in range(1, n_camber + 1):
            y = y_co + (ys - y_co) * i / float(n_camber)
            half.append((y, z_deck(y)))

        ring = [(-y, z) for y, z in reversed(half[1:])] + half
        return ring

    def closed_mesh(self, n_station=120, n_girth=28, ramp_mm=500.0):
        """Замкнутое тело корпуса: обшивка, палуба и крышки на транце и в носу.

        Для расчёта плавучести оболочки мало — нужен объём, а значит замкнутая
        поверхность. Палуба строится по `deck_ring`: раскладка кокпита снята
        с чертежа, высоты назначены.
        """
        m = self.mesh(n_station, n_girth)
        rows = m["rows"]                      # rows[j][i], j снизу вверх
        ns, ng = n_station, n_girth

        verts, tris = [], []

        def push(p):
            verts.append([p[0], p[1], p[2]])
            return len(verts) - 1

        stbd = [[push(rows[j][i]) for i in range(ns + 1)] for j in range(ng + 1)]
        port = [[push((rows[j][i][0], -rows[j][i][1], rows[j][i][2]))
                 for i in range(ns + 1)] for j in range(ng + 1)]

        for j in range(ng):
            for i in range(ns):
                a, b = stbd[j][i], stbd[j][i + 1]
                c, d = stbd[j + 1][i + 1], stbd[j + 1][i]
                tris += [[d, c, b], [d, b, a]]
                a, b = port[j][i], port[j][i + 1]
                c, d = port[j + 1][i + 1], port[j + 1][i]
                tris += [[a, b, c], [a, c, d]]

        # --- палуба: поперечные профили между линиями борта
        rings = [self.deck_ring(*rows[ng][i]) for i in range(ns + 1)]
        nd = len(rings[0]) - 1
        deck = [[push((rows[ng][i][0], rings[i][k][0], rings[i][k][1]))
                 for i in range(ns + 1)] for k in range(nd + 1)]

        for k in range(nd):
            for i in range(ns):
                a, b = deck[k][i], deck[k][i + 1]
                c, d = deck[k + 1][i + 1], deck[k + 1][i]
                tris += [[a, b, c], [a, c, d]]

        # --- крышки: транец в корме и клин в носу
        aft = ([stbd[j][0] for j in range(ng + 1)]
               + [deck[k][0] for k in range(nd, -1, -1)]
               + [port[j][0] for j in range(ng, -1, -1)])
        fwd = ([stbd[j][ns] for j in range(ng + 1)]
               + [deck[k][ns] for k in range(nd, -1, -1)]
               + [port[j][ns] for j in range(ng, -1, -1)])
        def dedupe(loop):
            """Убрать соседние совпадающие точки.

            Углы палубы и обшивки описаны дважды — линией борта и краем
            палубного настила. После склейки это одна вершина, и веер по
            такому контуру выдал бы пару рёбер, пройденных дважды в одну
            сторону: формально дыр нет, а ориентация ломается.
            """
            out = []
            for i in loop:
                if out and _same(verts[out[-1]], verts[i]):
                    continue
                out.append(i)
            while len(out) > 1 and _same(verts[out[0]], verts[out[-1]]):
                out.pop()
            return out

        # Ориентацию крышек не задаём руками, а выводим: нормаль веера должна
        # смотреть прочь от середины корпуса. Иначе крышка оказывается вывернутой
        # относительно обшивки, и это не ловится проверкой на дыры — только на
        # согласованность обхода.
        mid_x = 0.5 * (rows[0][0][0] + rows[0][ns][0])
        aft, fwd = dedupe(aft), dedupe(fwd)
        for loop in (aft, fwd):
            cx = sum(verts[i][0] for i in loop) / len(loop)
            cy = sum(verts[i][1] for i in loop) / len(loop)
            cz = sum(verts[i][2] for i in loop) / len(loop)
            nx = 0.0
            for n in range(len(loop)):
                p, q = verts[loop[n]], verts[loop[(n + 1) % len(loop)]]
                nx += (p[1] - cy) * (q[2] - cz) - (p[2] - cz) * (q[1] - cy)
            outward = 1.0 if cx > mid_x else -1.0
            flip = nx * outward < 0
            c = push((cx, cy, cz))
            for n in range(len(loop)):
                a, b = loop[n], loop[(n + 1) % len(loop)]
                tris.append([c, b, a] if flip else [c, a, b])

        return {"verts": verts, "tris": tris}

    def station_curves(self, xs, n_girth=48):
        """Настоящие шпангоуты в плоскостях X = const — для чертежа и проверки."""
        out = []
        for x in xs:
            if x < self.b.transom_x(self.z_keel(x)) - 1.0:
                continue
            s = self.section(x)
            pts = [(x, y, z) for y, z in s.by_arclength(n_girth)]
            out.append({"x": x, "points": pts, "sane": s.is_sane()})
        return out
