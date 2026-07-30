"""Ф5: киль, бульб и руль.

Данных здесь неровно. Про киль их неожиданно много: на виде сверху вычерчен
колодец, а внутри него — **профиль пера в натуральную величину**. Оттуда
берутся хорда, толщина и всё распределение толщины, то есть форма сечения не
подбирается, а снимается (`features.py`). Колодец при этом длиннее хорды всего
на шесть сантиметров — значит перо не откидывается, а ходит вертикально, и
сечение по всей длине подъёма обязано быть постоянным.

Про бульб и руль не известно ничего, кроме массы балласта, максимальной осадки
и положения навески на транце. Поэтому они проектируются под ограничения, и
каждое допущение здесь названо вслух — см. `ASSUMPTIONS`.

Зависимостей нет.
"""

import math

LEAD_DENSITY = 11340.0     # кг/м³
STEEL_DENSITY = 7850.0

# Приведённая плотность пера. Диапазон 2600–3600 назвал владелец лодки,
# исходя из того, как перо ощущается при подъёме; берём середину.
FIN_DENSITY = 3100.0
FIN_DENSITY_RANGE = (2600.0, 3600.0)
MM3_PER_M3 = 1.0e9

ASSUMPTIONS = [
    "Заявленные 250 кг балласта — это вся подъёмная конструкция целиком: "
    "перо плюс бульб. Другого прочтения у цифры из обзора нет.",
    "Перо — стальной сердечник в композитной обшивке; приведённая плотность "
    "3100 кг/м³. Сплошная сталь оставила бы бульбу три десятка килограммов, "
    "что бессмысленно. Диапазон 2600–3600 указан владельцем лодки по тому, "
    "как перо ощущается при подъёме; 3100 — середина этого диапазона.",
    "Бульб — свинцовая торпеда с удлинением 6, максимальный диаметр совмещён "
    "с наибольшей толщиной пера.",
    "Площадь пера руля принята в 1.0% обмерной парусности в бейдевинд — "
    "по этому отношению держатся спортботы близкого размера.",
    "Профиль руля — NACA 0012: тоньше килевого, как обычно и делают, чтобы "
    "перо не срывалось на больших углах перекладки.",
]


# --------------------------------------------------------------------- профиль

def naca_symmetric(tc):
    """Половина симметричного четырёхзначного профиля NACA: (доля хорды, полутолщина/хорда)."""
    out = []
    n = 60
    for i in range(n + 1):
        s = (1.0 - math.cos(math.pi * i / n)) / 2.0      # сгущение к кромкам
        t = 5.0 * tc * (0.2969 * math.sqrt(s) - 0.1260 * s - 0.3516 * s * s
                        + 0.2843 * s ** 3 - 0.1015 * s ** 4)
        out.append((s, max(0.0, t)))
    out[-1] = (1.0, 0.0)
    return out


def section_area_ratio(half):
    """Отношение площади сечения к произведению хорды на толщину."""
    area = 0.0
    for i in range(len(half) - 1):
        area += 0.5 * (half[i][1] + half[i + 1][1]) * (half[i + 1][0] - half[i][0])
    tmax = max(t for _, t in half)
    return (2.0 * area) / (2.0 * tmax) if tmax > 0 else 0.0


def resample_half(half, n):
    """Пересчитать половину профиля на n точек со сгущением к кромкам."""
    if n >= len(half):
        return half
    src = sorted(half)
    out = []
    for i in range(n):
        s = (1.0 - math.cos(math.pi * i / (n - 1))) / 2.0
        t = 0.0
        for k in range(len(src) - 1):
            if src[k][0] <= s <= src[k + 1][0]:
                dx = src[k + 1][0] - src[k][0]
                u = 0.0 if dx == 0 else (s - src[k][0]) / dx
                t = src[k][1] + u * (src[k + 1][1] - src[k][1])
                break
        out.append((s, t))
    out[-1] = (1.0, 0.0)
    return out


def outline(half, chord, x_le, sign_axis="y"):
    """Замкнутый контур сечения в местных координатах: список (вдоль хорды, поперёк)."""
    up = [(x_le - s * chord, t * chord) for s, t in half]
    dn = [(x_le - s * chord, -t * chord) for s, t in reversed(half[:-1])]
    return up + dn[:-1]


# ------------------------------------------------------------------------ перо

class Foil(object):
    """Крыло постоянного профиля с линейной круткой хорды по размаху."""

    def __init__(self, half, root_chord, tip_chord, x_le_root, x_le_tip,
                 z_root, z_tip):
        self.half = half
        self.root_chord = root_chord
        self.tip_chord = tip_chord
        self.x_le_root = x_le_root
        self.x_le_tip = x_le_tip
        self.z_root = z_root
        self.z_tip = z_tip

    def at(self, v):
        """Хорда, абсцисса передней кромки и высота на доле размаха v."""
        c = self.root_chord + (self.tip_chord - self.root_chord) * v
        x = self.x_le_root + (self.x_le_tip - self.x_le_root) * v
        z = self.z_root + (self.z_tip - self.z_root) * v
        return c, x, z

    @property
    def span(self):
        return abs(self.z_root - self.z_tip)

    @property
    def area_mm2(self):
        return 0.5 * (self.root_chord + self.tip_chord) * self.span

    @property
    def aspect_ratio(self):
        return self.span ** 2 / self.area_mm2 if self.area_mm2 else 0.0

    @property
    def volume_mm3(self):
        k = section_area_ratio(self.half) * 2.0 * max(t for _, t in self.half)
        # площадь сечения пропорциональна квадрату хорды
        c0, c1 = self.root_chord, self.tip_chord
        mean_sq = (c0 * c0 + c0 * c1 + c1 * c1) / 3.0
        return k * mean_sq * self.span

    def mesh(self, n_span=20, n_chord=32):
        """Замкнутая оболочка: кольца сечений плюс крышки на корне и конце.

        Профиль пересчитывается на n_chord точек: снятый с чертежа контур
        описан сотней вершин, и в сетке это лишний вес без пользы для формы.
        """
        half = resample_half(self.half, n_chord)
        rings = []
        for i in range(n_span + 1):
            v = i / float(n_span)
            c, x_le, z = self.at(v)
            rings.append([(px, py, z) for px, py in outline(half, c, x_le)])
        return _loft(rings, cap_first=True, cap_last=True)


def _loft(rings, cap_first=False, cap_last=False):
    """Сшить кольца одинаковой длины в треугольную оболочку."""
    verts, tris = [], []
    m = len(rings[0])
    for ring in rings:
        for p in ring:
            verts.append(list(p))
    for i in range(len(rings) - 1):
        a, b = i * m, (i + 1) * m
        for j in range(m):
            k = (j + 1) % m
            tris.append([a + j, a + k, b + k])
            tris.append([a + j, b + k, b + j])
    for cap, base in ((cap_first, 0), (cap_last, (len(rings) - 1) * m)):
        if not cap:
            continue
        cx = sum(verts[base + j][0] for j in range(m)) / m
        cy = sum(verts[base + j][1] for j in range(m)) / m
        cz = sum(verts[base + j][2] for j in range(m)) / m
        c = len(verts)
        verts.append([cx, cy, cz])
        for j in range(m):
            k = (j + 1) % m
            if base == 0:
                tris.append([c, base + k, base + j])
            else:
                tris.append([c, base + j, base + k])
    return {"verts": verts, "tris": tris}


# ----------------------------------------------------------------------- бульб

class Bulb(object):
    """Торпеда вращения: полуэллипс в носу, степенной сход в корме."""

    def __init__(self, volume_mm3, fineness=6.0, nose_frac=0.38, tail_power=2.4):
        self.fineness = fineness
        self.nose_frac = nose_frac
        self.tail_power = tail_power
        shape = self._shape_volume(1.0, 1.0)          # при R=1, L=1
        # V = shape * R² * L, L = fineness * 2R  ->  V = 2*shape*fineness*R³
        self.radius = (volume_mm3 / (2.0 * shape * fineness)) ** (1.0 / 3.0)
        self.length = 2.0 * self.radius * fineness
        self.volume_mm3 = volume_mm3

    def _shape_volume(self, r, L, n=400):
        total = 0.0
        prev = 0.0
        for i in range(1, n + 1):
            u = i / float(n)
            cur = self.radius_at(u, r) ** 2
            total += 0.5 * (prev + cur) * (L / n)
            prev = cur
        return math.pi * total

    def radius_at(self, u, r=None):
        """Радиус на доле длины u от носа."""
        r = self.radius if r is None else r
        a = self.nose_frac
        if u <= a:
            return r * math.sqrt(max(0.0, 1.0 - ((a - u) / a) ** 2))
        return r * max(0.0, 1.0 - ((u - a) / (1.0 - a)) ** self.tail_power)

    def mass_kg(self, density=LEAD_DENSITY):
        return density * self.volume_mm3 / MM3_PER_M3

    def mesh(self, x_nose, z_axis, n_len=40, n_rad=20):
        rings = []
        for i in range(n_len + 1):
            u = i / float(n_len)
            r = self.radius_at(u)
            x = x_nose - u * self.length
            ring = []
            for j in range(n_rad):
                a = 2.0 * math.pi * j / n_rad
                ring.append((x, r * math.cos(a), z_axis + r * math.sin(a)))
            rings.append(ring)
        return _loft(rings, cap_first=True, cap_last=True)


# ------------------------------------------------------------------ сборка

def build_keel(features, z_hull_bottom, draft_max_mm, ballast_kg,
               fin_density=FIN_DENSITY, fineness=6.0):
    """Киль по обмеренному сечению и заявленным осадке с балластом."""
    sec = features["keel_section"]
    half = [(s, t) for s, t in sec["half_profile"]]
    chord = sec["chord_mm"]
    x_le = sec["x_le_mm"]
    x_tmax = x_le - chord * sec["max_thickness_at_pct_chord"] / 100.0

    # Первое приближение: конец пера на максимальной осадке, потом опустим
    # его на радиус бульба, чтобы нижняя точка сошлась с паспортной.
    fin = Foil(half, chord, chord, x_le, x_le, z_hull_bottom, -draft_max_mm)
    for _ in range(12):
        v_fin = fin.volume_mm3 * _fin_length_factor(fin, z_hull_bottom)
        fin_kg = fin_density * v_fin / MM3_PER_M3
        bulb_kg = max(0.0, ballast_kg - fin_kg)
        bulb = Bulb(bulb_kg / LEAD_DENSITY * MM3_PER_M3, fineness=fineness)
        z_tip = -draft_max_mm + bulb.radius
        if abs(z_tip - fin.z_tip) < 0.5:
            break
        fin = Foil(half, chord, chord, x_le, x_le, z_hull_bottom, z_tip)

    # Смоченное перо задаёт площадь и размах для гидродинамики; полное —
    # то, что выгружается и весит, включая уходящую в колодец часть.
    fin_full = Foil(half, chord, chord, x_le, x_le, TRUNK_TOP_MM, fin.z_tip)

    return {
        "section": sec,
        "fin": fin,
        "fin_full": fin_full,
        "bulb": bulb,
        "bulb_x_nose_mm": x_tmax + bulb.nose_frac * bulb.length,
        "fin_mass_kg": fin_kg,
        "bulb_mass_kg": bulb_kg,
        "fin_density": fin_density,
        "wetted_span_mm": fin.span,
        "area_m2": fin.area_mm2 / 1.0e6,
        "aspect_ratio": fin.aspect_ratio,
        "draft_mm": draft_max_mm,
    }


TRUNK_TOP_MM = 650.0   # верх колодца над КВЛ, примерно уровень палубы там


def _fin_length_factor(fin, z_hull_bottom):
    """Перо длиннее смоченной части: оно уходит в колодец до палубы.

    Долю считаем по высоте: конструктивная длина от конца пера до верха
    колодца, смоченная — от конца до днища.
    """
    total = TRUNK_TOP_MM - fin.z_tip
    wet = z_hull_bottom - fin.z_tip
    return total / wet if wet > 0 else 1.0


def build_rudder(features, sail_area_m2, area_frac=0.010, z_top=50.0,
                 z_tip=-1000.0, taper=0.65, thickness_ratio=0.12):
    """Навесной руль по снятой с чертежа оси и площади от парусности."""
    stock = features["rudder_stock"]
    pintles = features["rudder_pintles"]
    x_stock = stock["x_mm"] if stock else 0.0

    area_mm2 = sail_area_m2 * area_frac * 1.0e6
    span = z_top - z_tip
    root = 2.0 * area_mm2 / (span * (1.0 + taper))
    tip = root * taper
    half = naca_symmetric(thickness_ratio)

    # ось баллера на четверти хорды — так руль почти сбалансирован
    blade = Foil(half, root, tip,
                 x_stock + 0.25 * root, x_stock + 0.25 * tip, z_top, z_tip)
    return {
        "blade": blade,
        "x_stock_mm": x_stock,
        "pintles": pintles,
        "area_m2": blade.area_mm2 / 1.0e6,
        "aspect_ratio": blade.aspect_ratio,
        "root_chord_mm": root,
        "tip_chord_mm": tip,
        "thickness_ratio": thickness_ratio,
    }


def ballast_vcg_mm(keel):
    """Высота центра тяжести балласта над КВЛ (отрицательная — ниже)."""
    fin = keel["fin"]
    z_fin = 0.5 * (TRUNK_TOP_MM + fin.z_tip)
    z_bulb = -keel["draft_mm"] + keel["bulb"].radius
    m = keel["fin_mass_kg"] + keel["bulb_mass_kg"]
    if m <= 0:
        return 0.0
    return (keel["fin_mass_kg"] * z_fin + keel["bulb_mass_kg"] * z_bulb) / m


def sensitivity(features, z_hull_bottom, draft_mm, ballast_kg, densities,
                meshops=None):
    """Как меняется бульб и центр тяжести балласта от плотности пера.

    Если передан `meshops`, к каждой строке добавляются настоящие центры
    тяжести и моменты инерции тел — их потом двигает ползунок во вьювере.
    """
    out = []
    for rho in densities:
        k = build_keel(features, z_hull_bottom, draft_mm, ballast_kg,
                       fin_density=rho)
        row = {
            "fin_density": rho,
            "fin_mass_kg": k["fin_mass_kg"],
            "bulb_mass_kg": k["bulb_mass_kg"],
            "bulb_diameter_mm": 2.0 * k["bulb"].radius,
            "bulb_length_mm": k["bulb"].length,
            "ballast_vcg_mm": ballast_vcg_mm(k),
        }
        if meshops is not None:
            for name, mesh, mass in (
                    ("fin", k["fin_full"].mesh(n_span=8, n_chord=20),
                     k["fin_mass_kg"]),
                    ("bulb", k["bulb"].mesh(k["bulb_x_nose_mm"],
                                            -k["draft_mm"] + k["bulb"].radius,
                                            n_len=18, n_rad=12),
                     k["bulb_mass_kg"])):
                v, t, _ = meshops.prepare(mesh["verts"], mesh["tris"])
                pr = meshops.solid_properties(v, t, 1.0)
                scale = mass / max(1e-9, pr["mass_kg"])
                row[name + "_com_mm"] = pr["com_mm"]
                row[name + "_ixx_kg_m2"] = pr["inertia_kg_m2"][0][0] * scale
        out.append(row)
    return out
