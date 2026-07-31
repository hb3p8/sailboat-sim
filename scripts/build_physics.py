#!/usr/bin/env python3
"""Пакет физики для симулятора: всё, что нельзя посчитать в реальном времени.

    python3 scripts/build_physics.py

Разделение простое. Здесь считается то, что вытекает из геометрии и требует
интегрирования по корпусу: диаграмма остойчивости, гидростатика по осадке,
массы и моменты инерции, площади и удлинения крыльев. В симулятор это попадает
таблицами, и на каждом шаге он их только интерполирует.

Модели сил (паруса, крылья, сопротивление) живут в самом симуляторе: они
настраиваются на ходу, и держать их здесь незачем. Сюда попадают только их
геометрические входы плюс одна калибровочная кривая остаточного сопротивления,
про которую честно сказано, что она не выведена, а подобрана под ожидаемую
скорость.

Пишет out/export/physics.json и out/export/sim_mesh.json.
"""

import json
import math
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

from sv20 import (appendages, calibrate, hullmodel, hydro, meshops,  # noqa: E402
                  righting, stability)

RHO_WATER = 1025.0
RHO_AIR = 1.225
NU_WATER = 1.19e-6      # кинематическая вязкость морской воды, м²/с
G = 9.80665

# Остаточное сопротивление в долях веса как функция числа Фруда. Это
# единственная величина во всём пакете, которая **не выведена из геометрии**:
# для лёгкого глиссирующего корпуса надёжной серии моделей нет, а Delft за
# своими пределами врёт. Кривая подобрана так, чтобы лодка выходила на
# правдоподобные скорости — около шести узлов в лавировку и выход на глиссер
# на полных курсах. Её место здесь, отдельной строкой, чтобы было видно, что
# это калибровка, а не расчёт.
RESIDUARY = [
    (0.15, 0.0009), (0.25, 0.0058), (0.35, 0.0225), (0.45, 0.0555),
    (0.55, 0.0900), (0.70, 0.1160), (0.85, 0.1250), (1.00, 0.1280),
    (1.20, 0.1255), (1.50, 0.1245), (2.00, 0.1300),
]

FORM_FACTOR = 1.12      # (1+k): надбавка на форму к трению плоской пластины


def resistance_curve(lwl_mm, wetted_m2, mass_kg, v_max=9.0, n=45):
    """Сопротивление корпуса по скорости: трение по ITTC плюс остаточное."""
    lwl = lwl_mm / 1000.0
    out = []
    for i in range(n + 1):
        v = v_max * i / float(n)
        if v <= 0:
            out.append({"v_ms": 0.0, "rt_n": 0.0, "rf_n": 0.0, "rr_n": 0.0,
                        "froude": 0.0})
            continue
        re = v * lwl / NU_WATER
        cf = 0.075 / (math.log10(re) - 2.0) ** 2
        rf = 0.5 * RHO_WATER * cf * FORM_FACTOR * wetted_m2 * v * v
        fn = v / math.sqrt(G * lwl)
        rr = _interp(RESIDUARY, fn) * mass_kg * G
        out.append({"v_ms": v, "rf_n": rf, "rr_n": rr, "rt_n": rf + rr,
                    "froude": fn})
    return out


def _interp(table, x):
    if x <= table[0][0]:
        return table[0][1] * (x / table[0][0]) ** 2 if table[0][0] else 0.0
    if x >= table[-1][0]:
        return table[-1][1]
    for i in range(len(table) - 1):
        a, b = table[i], table[i + 1]
        if a[0] <= x <= b[0]:
            u = (x - a[0]) / (b[0] - a[0])
            return a[1] + u * (b[1] - a[1])
    return table[-1][1]


def sim_mesh(bodies):
    """Лёгкие сетки для отрисовки: метры, ось Y вверх, округление до миллиметра."""
    out = {}
    for name, b in bodies:
        pos, idx = [], []
        for v in b["verts"]:
            pos += [round(v[0] / 1000.0, 4), round(v[2] / 1000.0, 4),
                    round(-v[1] / 1000.0, 4)]
        for t in b["tris"]:
            idx += [t[0], t[1], t[2]]
        out[name] = {"positions": pos, "indices": idx}
    return out


def main():
    out = os.path.join(ROOT, "out")
    dst = os.path.join(out, "export")
    os.makedirs(dst, exist_ok=True)

    frame_doc = json.load(open(os.path.join(out, "frame.json")))
    boundary = hullmodel.Boundary(frame_doc)
    params = hullmodel.HullParams.from_vector(
        json.load(open(os.path.join(out, "params.json")))["vector"])
    hull = hullmodel.Hull(boundary, params)
    feats = frame_doc["features"]

    x_keel = 0.5 * (feats["keel_section"]["x_le_mm"] + feats["keel_section"]["x_te_mm"])
    keel = appendages.build_keel(feats, hull.z_keel(x_keel),
                                 calibrate.TARGET["draft_max_mm"],
                                 calibrate.TARGET["ballast_kg"])
    rudder = appendages.build_rudder(feats, calibrate.TARGET["sail_area_upwind_m2"])
    case = appendages.build_keel_case(feats, hull.z_keel(x_keel) - 5.0,
                                      appendages.TRUNK_TOP_MM)

    mass = calibrate.TARGET["displacement_kg"]
    h = hydro.hydrostatics(hull, 0.0, n=200)

    # тела и их свойства
    def prep(mesh, density=None):
        v, t, rep = meshops.prepare(mesh["verts"], mesh["tris"])
        return {"verts": v, "tris": t, "check": rep,
                "props": meshops.solid_properties(v, t, density or 1.0)}

    hull_body = prep(hull.closed_mesh(n_station=70, n_girth=18))
    fin_body = prep(keel["fin_full"].mesh(), keel["fin_density"])
    bulb_body = prep(keel["bulb"].mesh(keel["bulb_x_nose_mm"],
                                       -keel["draft_mm"] + keel["bulb"].radius),
                     appendages.LEAD_DENSITY)
    rud_body = prep(rudder["blade"].mesh(), 1200.0)
    case_body = prep(case["mesh"]) if case else None

    shell = meshops.shell_properties(hull_body["verts"], hull_body["tris"])
    items, opts = stability.budget(keel, fin_body["props"], bulb_body["props"],
                                   shell, mass)
    ref = stability.evaluate(items, h, opts)
    total = stability.combine(items)

    gz = righting.curve(hull, mass, ref["kg_mm"],
                        angles=[0, 2] + list(range(5, 96, 5)))
    gz_sum = righting.summarise(gz, ref["gm_mm"])

    table = []
    for dz in range(-150, 351, 25):
        hh = hydro.hydrostatics(hull, float(dz), n=110)
        if hh:
            table.append({"wl_mm": dz, "disp_kg": hh["displacement_kg"],
                          "awp_m2": hh["waterplane_area_m2"],
                          "wetted_m2": hh["wetted_area_m2"],
                          "lcb_mm": hh["lcb_mm"], "lcf_mm": hh["lcf_mm"],
                          "vcb_mm": hh["vcb_mm"], "bm_mm": hh["bm_mm"]})

    fin = keel["fin"]
    blade = rudder["blade"]
    doc = {
        "generator": "sv20, пакет физики для симулятора",
        "units": "СИ: метры, килограммы, секунды. X в нос, Y на правый борт, Z вверх",
        "environment": {"rho_water": RHO_WATER, "rho_air": RHO_AIR, "g": G,
                        "nu_water": NU_WATER},
        "mass": {
            "total_kg": mass,
            "cg_m": [total["cg_mm"][0] / 1000.0, 0.0, ref["kg_mm"] / 1000.0],
            "ixx_kg_m2": ref["ixx_kg_m2"],
            "iyy_kg_m2": total["iyy_kg_m2"],
            "izz_kg_m2": total["izz_kg_m2"],
            "added_roll": opts["added_inertia"],
            "added_sway": 0.85, "added_yaw": 0.55, "added_surge": 0.06,
            "budget": [{"name": i["name"], "mass_kg": i["mass_kg"],
                        "com_m": [c / 1000.0 for c in i["com_mm"]],
                        "note": i["note"]} for i in items],
        },
        "hydrostatics": {
            "lwl_m": h["lwl_mm"] / 1000.0, "bwl_m": h["bwl_mm"] / 1000.0,
            "lwl_aft_x_m": h["lwl_aft_x_mm"] / 1000.0,
            "lwl_fwd_x_m": h["lwl_fwd_x_mm"] / 1000.0,
            "draft_canoe_m": h["draft_canoe_mm"] / 1000.0,
            "wetted_m2": h["wetted_area_m2"], "volume_m3": h["volume_m3"],
            "gm_m": ref["gm_mm"] / 1000.0,
            "table": table,
        },
        "righting": {
            "gz": [{"heel_deg": r["heel_deg"], "gz_m": r["gz_mm"] / 1000.0,
                    "moment_nm": r["righting_moment_nm"]} for r in gz],
            "summary": gz_sum,
            "note": ("Палуба считается водонепроницаемой: заливание кокпита и "
                     "подтопление через сходной люк не моделируются, поэтому "
                     "за семьюдесятью градусами кривая оптимистична."),
        },
        "resistance": {
            "curve": resistance_curve(h["lwl_mm"], h["wetted_area_m2"], mass),
            "form_factor": FORM_FACTOR,
            "residuary_table": [list(p) for p in RESIDUARY],
            "note": ("Трение — ITTC-57 с надбавкой на форму, это расчёт. "
                     "Остаточное сопротивление — подобранная кривая, а не "
                     "вывод: для лёгкого глиссирующего корпуса надёжной серии "
                     "нет. Правьте RESIDUARY, если поведение не совпадёт."),
        },
        "foils": {
            # Точка приложения — четверть хорды от передней кромки, а не
            # середина: там сидит центр давления крыла.
            "keel": _foil(fin, keel["area_m2"], keel["aspect_ratio"],
                          feats["keel_section"]["thickness_ratio"], 1.5,
                          (feats["keel_section"]["x_le_mm"]
                           - 0.25 * feats["keel_section"]["chord_mm"]) / 1000.0),
            "rudder": _foil(blade, rudder["area_m2"], rudder["aspect_ratio"],
                            rudder["thickness_ratio"], 1.25,
                            rudder["x_stock_mm"] / 1000.0),
        },
        "rig": _rig(),
    }

    with open(os.path.join(dst, "physics.json"), "w") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    parts = [("hull", hull_body), ("keel_fin", fin_body),
             ("bulb", bulb_body), ("rudder", rud_body)]
    if case_body:
        parts.append(("keel_case", case_body))
    meshes = sim_mesh(parts)
    with open(os.path.join(dst, "sim_mesh.json"), "w") as f:
        json.dump(meshes, f, separators=(",", ":"))

    print("GZ: максимум %.0f мм на %.0f°, закат %s"
          % (gz_sum["gz_max_mm"], gz_sum["heel_at_gz_max_deg"],
             ("%.0f°" % gz_sum["vanishing_angle_deg"])
             if gz_sum["vanishing_angle_deg"] else "за 90°"))
    g = gz_sum["gm_check"]
    print("сверка с GM на %.0f°: %.1f против %.1f мм, %+.1f%%"
          % (g["heel_deg"], g["gz_mm"], g["gm_sin_theta_mm"], g["deviation_pct"]))
    print("моменты инерции: качка %.0f, киль %.0f, рыскание %.0f кг·м²"
          % (doc["mass"]["ixx_kg_m2"], doc["mass"]["iyy_kg_m2"],
             doc["mass"]["izz_kg_m2"]))
    r = doc["resistance"]["curve"]
    for v in (2.0, 3.0, 4.0, 6.0):
        row = min(r, key=lambda q: abs(q["v_ms"] - v))
        print("  %.1f м/с (%.1f уз): Rf %.0f + Rr %.0f = %.0f Н"
              % (row["v_ms"], row["v_ms"] * 1.94384, row["rf_n"], row["rr_n"],
                 row["rt_n"]))
    print("сетки для симулятора: " + ", ".join(
        "%s %d тр." % (k, len(v["indices"]) // 3) for k, v in meshes.items()))


def _rig(mast_x=3.55, mast_h=9.0, boom=2.85, main=16.5, jib=8.5):
    """Центр парусности как центр тяжести двух треугольников.

    Раньше он брался в мачте, и это была ошибка: грот стоит позади мачты,
    стаксель впереди, и их общий центр оказывается почти на полметра в корму
    от неё. Полметра плеча на шестиметровой лодке — разница между валкостью
    и приводливостью, что на воде и вылезло.
    """
    def centroid(pts, area):
        return (sum(p[0] for p in pts) / 3.0, sum(p[1] for p in pts) / 3.0, area)

    m = centroid([(mast_x, 1.0), (mast_x, mast_h * 0.95),
                  (mast_x - boom, 1.05)], main)
    j = centroid([(mast_x + 2.4, 0.9), (mast_x + 0.12, mast_h * 0.76),
                  (mast_x + 0.85 - 2.05, 1.05)], jib)
    total = main + jib
    return {
        "main_area_m2": main, "jib_area_m2": jib,
        "spinnaker_area_m2": calibrate.TARGET["sail_area_downwind_m2"] - 25.0,
        "mast_x_m": mast_x, "mast_height_m": mast_h, "boom_m": boom,
        "ce_x_m": (m[0] * main + j[0] * jib) / total,
        "ce_height_m": (m[1] * main + j[1] * jib) / total,
        "windage_area_m2": 1.15,     # корпус, рангоут и экипаж в потоке
        "windage_cd": 0.85,
        "windage_height_m": 1.1,
        "note": ("Площади парусов из ТТХ конструктора, положение мачты снято "
                 "с чертежа. Центр парусности посчитан как центр тяжести "
                 "треугольников грота и стакселя, а не взят в мачте."),
    }


def _foil(foil, area_m2, ar, tc, end_plate, x_m):
    """Геометрия крыла плюс эффективное удлинение.

    Корпус и бульб работают концевыми шайбами, но не идеальными: удвоение
    удлинения, как для крыла у сплошной стенки, здесь завышено. Свободная
    поверхность рядом с корпусом пропускает вихрь, и выигрыш выходит скромнее —
    порядка полутора раз у киля с бульбом и четверти у руля, который вдобавок
    работает у самой поверхности.
    """
    return {
        "area_m2": area_m2,
        "span_m": foil.span / 1000.0,
        "chord_m": 0.5 * (foil.root_chord + foil.tip_chord) / 1000.0,
        "aspect_ratio": ar,
        "effective_ar": ar * end_plate,
        "thickness_ratio": tc,
        "x_m": x_m,
        "z_centre_m": 0.5 * (foil.z_root + foil.z_tip) / 1000.0,
        "stall_deg": 16.0 if end_plate > 1.4 else 20.0,
    }


if __name__ == "__main__":
    main()
