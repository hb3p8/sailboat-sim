"""Период бортовой качки: где реконструкция впервые встречается с памятью.

Период — единственная величина в этом проекте, которую можно проверить не
чертежом, а собственным ощущением от лодки. Он считается по

    T = 2π · sqrt( I_xx · k / (Δ · g · GM) )

и складывается из трёх слагаемых разного происхождения:

    GM = KB + BM − KG. KB и BM выходят прямо из обводов и подгонки Ф3 —
         это уже проверенная геометрия. KG — из весовой сводки, и вот она
         почти целиком предположение.
    I_xx — момент инерции относительно продольной оси через ЦТ. Балласт и
         обшивку считает `meshops` по настоящим телам, рангоут и экипаж
         входят как сосредоточенные массы.
    k    — присоединённая инерция воды при качке. Для килевой яхты обычно
         прибавляет от 15 до 30 процентов.

Отсюда практический вывод: если период в симуляции разойдётся с памятью,
виновата почти наверняка весовая сводка, а не обводы. Поэтому она вынесена в
явный список, а во вьювере — под ползунки.

Зависимостей нет.
"""

import math

G = 9.80665

# Весовая сводка. Балласт и обшивка считаются по геометрии; остальное —
# оценки для лодки этого размера, и они названы, чтобы их можно было
# оспорить числом, а не ощущением.
BUDGET_DEFAULTS = {
    "rig_mass_kg": 45.0,        # мачта, гик, стоячий такелаж, паруса
    "rig_vcg_mm": 3600.0,       # ЦТ рангоута над КВЛ
    "rig_length_mm": 9000.0,    # для собственного момента инерции мачты
    "gear_mass_kg": 25.0,       # палубное железо, руль, шкоты, конец
    "gear_vcg_mm": 250.0,
    "crew_mass_kg": 80.0,
    "crew_vcg_mm": 620.0,       # сидя на борту
    "crew_half_beam_mm": 900.0,
    "added_inertia": 1.25,      # присоединённая инерция воды при качке
}


def point_item(name, mass, x, y, z, own=(0.0, 0.0, 0.0), note=""):
    """Статья сводки. `own` — собственные моменты инерции (Ixx, Iyy, Izz).

    Для рыскания и киля собственные моменты обязательны: масса корпуса
    размазана по шести метрам длины, и без них момент инерции по вертикальной
    оси занижается на порядок.
    """
    if isinstance(own, (int, float)):
        own = (own, 0.0, 0.0)
    return {"name": name, "mass_kg": mass, "com_mm": [x, y, z],
            "ixx_own_kg_m2": own[0], "iyy_own_kg_m2": own[1],
            "izz_own_kg_m2": own[2], "note": note}


def budget(keel, keel_props, bulb_props, shell_props, total_kg, opts=None):
    """Собрать статьи весовой сводки. Обшивка добирает до полного веса."""
    o = dict(BUDGET_DEFAULTS)
    o.update(opts or {})

    def solid_own(props, mass):
        k = mass / max(1e-9, props["mass_kg"])
        return tuple(props["inertia_kg_m2"][i][i] * k for i in range(3))

    rod = o["rig_mass_kg"] * (o["rig_length_mm"] / 1000.0) ** 2 / 12.0
    items = [
        point_item("Перо киля", keel["fin_mass_kg"],
                   keel_props["com_mm"][0], 0.0, keel_props["com_mm"][2],
                   solid_own(keel_props, keel["fin_mass_kg"]),
                   "геометрия, плотность пера — допущение"),
        point_item("Бульб", keel["bulb_mass_kg"],
                   bulb_props["com_mm"][0], 0.0, bulb_props["com_mm"][2],
                   solid_own(bulb_props, keel["bulb_mass_kg"]),
                   "геометрия, свинец"),
        # мачта — тонкий вертикальный стержень: вокруг своей оси инерции нет
        point_item("Рангоут и паруса", o["rig_mass_kg"],
                   3550.0, 0.0, o["rig_vcg_mm"], (rod, rod, 0.0),
                   "оценка: мачта как тонкий стержень"),
        point_item("Палубное железо и руль", o["gear_mass_kg"],
                   2000.0, 0.0, o["gear_vcg_mm"], (0.0, 0.0, 0.0), "оценка"),
    ]
    rest = total_kg - sum(i["mass_kg"] for i in items)
    items.insert(0, point_item(
        "Корпус и палуба", rest,
        shell_props["com_mm"][0], 0.0, shell_props["com_mm"][2],
        (shell_props["ixx_per_kg_kg_m2"] * rest,
         shell_props["iyy_per_kg_kg_m2"] * rest,
         shell_props["izz_per_kg_kg_m2"] * rest),
        "оболочка постоянной поверхностной плотности, масса — остаток"))
    return items, o


def crew_items(n, o):
    """Экипаж на наветренном борту. Ноль — лодка без людей."""
    out = []
    for i in range(int(n)):
        out.append(point_item(
            "Экипаж %d" % (i + 1), o["crew_mass_kg"],
            1800.0 + 400.0 * i, o["crew_half_beam_mm"], o["crew_vcg_mm"],
            (0.0, 0.0, 0.0), "сидит на борту"))
    return out


def combine(items):
    """Суммарная масса, ЦТ и моменты инерции по всем трём осям."""
    m = sum(i["mass_kg"] for i in items)
    if m <= 0:
        return None
    cy = sum(i["mass_kg"] * i["com_mm"][1] for i in items) / m
    cz = sum(i["mass_kg"] * i["com_mm"][2] for i in items) / m
    cx = sum(i["mass_kg"] * i["com_mm"][0] for i in items) / m
    ixx = iyy = izz = 0.0
    for i in items:
        dx = (i["com_mm"][0] - cx) / 1000.0
        dy = (i["com_mm"][1] - cy) / 1000.0
        dz = (i["com_mm"][2] - cz) / 1000.0
        ixx += i["ixx_own_kg_m2"] + i["mass_kg"] * (dy * dy + dz * dz)
        iyy += i.get("iyy_own_kg_m2", 0.0) + i["mass_kg"] * (dx * dx + dz * dz)
        izz += i.get("izz_own_kg_m2", 0.0) + i["mass_kg"] * (dx * dx + dy * dy)
    return {"mass_kg": m, "cg_mm": [cx, cy, cz],
            "ixx_kg_m2": ixx, "iyy_kg_m2": iyy, "izz_kg_m2": izz}


def roll_period(mass_kg, ixx_kg_m2, gm_mm, added=1.25):
    """Период свободной бортовой качки, секунды. None, если лодка неостойчива."""
    gm = gm_mm / 1000.0
    if gm <= 0:
        return None
    return 2.0 * math.pi * math.sqrt(ixx_kg_m2 * added / (mass_kg * G * gm))


def evaluate(items, hydro_row, o):
    """Свести весовую сводку с гидростатикой в GM и период."""
    tot = combine(items)
    if tot is None:
        return None
    gm = hydro_row["vcb_mm"] + hydro_row["bm_mm"] - tot["cg_mm"][2]
    return {
        "mass_kg": tot["mass_kg"],
        "kg_mm": tot["cg_mm"][2],
        "kb_mm": hydro_row["vcb_mm"],
        "bm_mm": hydro_row["bm_mm"],
        "gm_mm": gm,
        "ixx_kg_m2": tot["ixx_kg_m2"],
        "added_inertia": o["added_inertia"],
        "roll_period_s": roll_period(tot["mass_kg"], tot["ixx_kg_m2"], gm,
                                     o["added_inertia"]),
        "gyradius_mm": 1000.0 * math.sqrt(tot["ixx_kg_m2"] / tot["mass_kg"]),
    }
