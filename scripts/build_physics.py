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
                  righting, sailplan, stability, wavemaking)

RHO_WATER = 1025.0
RHO_AIR = 1.225
NU_WATER = 1.19e-6      # кинематическая вязкость морской воды, м²/с
G = 9.80665

# Сопротивление корпуса больше не содержит ни одного числа из головы.
#
# Волновое сопротивление тихой воды считается по обводам интегралом Мичелла
# (src/sv20/wavemaking.py), добавочное сопротивление на волнении — по спектру
# и частоте встречи (sim/waves.js). Подгоняемых величин осталось две, и обе
# привязаны к своему наблюдению:
#
#   WAVE_SCALE — насколько Мичелл завышает. Теория тонкого судна знает форму
#     кривой, но не её величину для такого корпуса: у 610 ширина к длине около
#     трети и широкий погружённый транец. Подбирается по наблюдению владельца —
#     галфвинд в 11.7 узлах ветра у рига, экипаж на борту, парус настроен,
#     около 8.5 узла. Выходит 0.55, то есть Мичелл завышает почти вдвое; для
#     таких обводов это в пределах ожидаемого.
#
#   WAVE_PEAK — величина резонансного пика добавочного сопротивления, в
#     безразмерном виде R·L/(ρ·g·ζ²·B²). Подбирается по лавировочному углу:
#     около 82 градусов. Выходит 9 — выше опубликованных для резонанса 3…8,
#     и это плата за то, что качка здесь не считается, а сводится к одной
#     собственной частоте: узкий колокол приходится делать выше.
#
# Почему двух наблюдений понадобилось два числа. Прежняя таблица из одиннадцати
# нарисованных от руки величин держала оба наблюдения сразу — и держала потому,
# что несла в себе волнение, слитое с волновым сопротивлением тихой воды. Стоило
# подставить вместо неё честный расчёт для гладкой воды, как лодка стала
# лавировать через 72° вместо 82°: на гладкой воде она и должна идти круче.
# Волна штрафует приведение сильнее уваливания — на малом ходу сквозь неё нечем
# проталкиваться, — и именно этот перекос держит настоящий лавировочный угол.
#
# Проверялось это разбором лавировочного баланса: углы качества вдоль курса
# относительно воды у рига 9.5…11.9° и у подводной части 15.5…21.9° — оба в
# коридорах продувок и буксировок. Ошибки в риге или в киле не было.
WAVE_SCALE = 0.56

FORM_FACTOR = 1.12      # (1+k): надбавка на форму к трению плоской пластины

# Величина резонансного пика добавочного сопротивления на волнении, в
# безразмерном виде R·L/(ρ·g·ζ²·B²). Подбирается по лавировочному углу; форму
# кривой по частоте и зависимость от курса задаёт кинематика встречи с волной,
# а не подгонка (sim/waves.js).
WAVE_PEAK = 12.0

# Площадь спинакера из ТТХ конструктора (tihonovdesign.ru/610). Оттуда же —
# грот 15.5 и стаксель 7.5 м², и эти две цифры обмер чертежа подтвердил.
SPINNAKER_M2 = 27.0


# Углы крена, на которых пересчитываются обводы. Дальше тридцати смысла нет:
# лавировочный крен у этой лодки упирается в двадцать с небольшим, а что
# делается на пятидесяти, решает уже не сопротивление.
HEELS = [0.0, 10.0, 20.0, 30.0]


def _curve_from(speeds, lwl, wetted_m2, wave):
    out = []
    for v, rw in zip(speeds, wave):
        if v <= 0:
            out.append({"v_ms": 0.0, "rt_n": 0.0, "rf_n": 0.0, "rr_n": 0.0,
                        "froude": 0.0})
            continue
        re = v * lwl / NU_WATER
        cf = 0.075 / (math.log10(re) - 2.0) ** 2
        rf = 0.5 * RHO_WATER * cf * FORM_FACTOR * wetted_m2 * v * v
        out.append({"v_ms": v, "rf_n": rf, "rr_n": WAVE_SCALE * rw,
                    "rt_n": rf + WAVE_SCALE * rw,
                    "froude": v / math.sqrt(G * lwl)})
    return out


def resistance_curve(hull, lwl_mm, wetted_m2, mass_kg, v_max=9.0, n=45):
    """Сопротивление корпуса по скорости и КРЕНУ: трение по ITTC плюс волновое.

    Волновое — интеграл Мичелла по обводам, умноженный на WAVE_SCALE.
    Добавочное на волнении здесь не считается: оно зависит от ветра и курса и
    живёт в симуляторе (sim/waves.js).

    Крен меняет обводы, и у этой лодки сильно. Днище плоское и мелкое — осадка
    корпусом полтора десятка сантиметров при ширине больше двух метров, — и
    наветренная скула выходит из воды уже на десяти градусах:

        крен    смоченная   длина по КВЛ
          0°     6.80 м²      5.47 м
         10°     6.19          5.85
         20°     5.27          5.28
         30°     4.76          5.02

    Это чистая геометрия: корпус поворачивается, вода остаётся горизонтальной,
    уровень подбирается под то же водоизмещение (righting.HeeledGeometry). Объём
    по накренённой сетке сходится с водоизмещением на всех углах до сотых долей
    процента, а на нуле смоченная сходится с независимым расчётом гидростатики
    до третьего знака. Отсюда трение по крену и берётся — без единого допущения.

    А вот волновое по крену НЕ считается, и это осознанный отказ. Интеграл
    Мичелла на накренённых обводах даёт −44% на двадцати градусах, и верить
    этому нельзя по двум причинам. Теория тонкого корабля предполагает малое
    возмущение вертикальной ДП; накренённый широкий плоский корпус — не оно, и
    замена его эквивалентным симметричным телом точна лишь в том же порядке,
    который на ровном киле уже приходится править множителем 0.56. И главное:
    ответ Мичелла идёт как квадрат ширины, а крен эту самую ширину по ватерлинии
    и уполовинивает — хуже инструмента для такого сравнения не придумать.

    Так что крен здесь входит только трением. Направление у волнового,
    вероятно, тоже вниз — швертботы кренят в слабый ветер именно за этим, — но
    величину нужно брать не отсюда.
    """
    lwl = lwl_mm / 1000.0
    speeds = [v_max * i / float(n) for i in range(n + 1)]
    wave = wavemaking.resistance(hull, speeds)

    geom = righting.HeeledGeometry(hull)
    vol_mm3 = mass_kg / RHO_WATER * 1.0e9                 # кг -> мм³
    base, heeled = None, []
    for deg in HEELS:
        g = geom.at(deg, vol_mm3)
        if g is None:
            continue
        if base is None:
            base = g
        kw = g["wetted_mm2"] / base["wetted_mm2"]
        kl = g["lwl_mm"] / base["lwl_mm"]
        heeled.append({
            "heel_deg": deg,
            "wetted_m2": round(wetted_m2 * kw, 5),
            "lwl_m": round(lwl * kl, 5),
            "curve": _curve_from(speeds, lwl * kl, wetted_m2 * kw, wave),
        })
    return heeled


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
    rudder = appendages.build_rudder(feats, sailplan.upwind_area_m2(feats))
    case = appendages.build_keel_case(feats, hull.z_keel(x_keel) - 5.0,
                                      appendages.TRUNK_TOP_MM)

    mass = calibrate.TARGET["displacement_kg"]
    h = hydro.hydrostatics(hull, 0.0, n=200)
    heel_curves = resistance_curve(hull, h["lwl_mm"], h["wetted_area_m2"], mass)

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
            # Присоединённые массы и моменты. Для корпуса с глубоким килем и
            # бульбом вода увлекается заметнее, чем закладывалось сначала.
            # От них зависит не установившаяся циркуляция, а задержка отклика
            # на руль — та самая задумчивость.
            "added_sway": 1.0, "added_yaw": 0.7, "added_surge": 0.06,
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
        # Мореходность: то, что нужно добавочному сопротивлению на волнении.
        # Собственная частота вертикальной качки — из площади ватерлинии и
        # водоизмещения, присоединённая масса принята равной вытесненной (для
        # мелкосидящего корпуса это обычная величина). У шестиметровой лодки
        # период выходит около 0.84 с, и в лавировку по короткой волне частота
        # встречи попадает как раз туда — оттого и провал хода.
        "seakeeping": {
            "heave_period_s": round(2 * math.pi * math.sqrt(
                2.0 * mass / (RHO_WATER * G * h["waterplane_area_m2"])), 4),
            "pitch_period_s": round(2 * math.pi * math.sqrt(
                1.6 * total["iyy_kg_m2"] / (RHO_WATER * G * h["volume_m3"] * (
                    h["vcb_mm"] + h["bml_mm"] - ref["kg_mm"]) / 1000.0)), 4),
            "wave_peak": WAVE_PEAK,
            "note": ("Периоды собственных колебаний на тихой воде. Нужны для "
                     "добавочного сопротивления на волнении: оно живёт у "
                     "резонанса, и где резонанс — задаёт геометрия, а не "
                     "подгонка."),
        },
        "resistance": {
            "curve": heel_curves[0]["curve"],
            "heel": [{k: c[k] for k in ("heel_deg", "wetted_m2", "lwl_m", "curve")}
                     for c in heel_curves],
            "form_factor": FORM_FACTOR,
            "wave_scale": WAVE_SCALE,
            "note": ("Трение — ITTC-57 с надбавкой на форму. Волновое — "
                     "интеграл Мичелла по обводам (sv20/wavemaking.py) на "
                     "множителе wave_scale; это тихая вода. Добавочное на "
                     "волнении считает симулятор, оно зависит от ветра и "
                     "курса."),
        },
        "foils": {
            # Точка приложения — четверть хорды от передней кромки, а не
            # середина: там сидит центр давления крыла.
            "keel": dict(_foil(fin, keel["area_m2"], keel["aspect_ratio"],
                               feats["keel_section"]["thickness_ratio"], 1.5,
                               (feats["keel_section"]["x_le_mm"]
                                - 0.25 * feats["keel_section"]["chord_mm"]) / 1000.0),
                         junction_cda_m2=round(_junction_cda(
                             feats["keel_section"]["chord_mm"] / 1000.0,
                             feats["keel_section"]["thickness_ratio"]), 6)),
            "rudder": _foil(blade, rudder["area_m2"], rudder["aspect_ratio"],
                            rudder["thickness_ratio"], 1.25,
                            rudder["x_stock_mm"] / 1000.0),
        },
        "rig": _rig(feats["sail_plan"], hull),
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
    print("интеграл Мичелла, сверки:")
    for name, val, tol, ok in wavemaking.selftest(hull):
        print("  %-6s %-44s %.2e (допуск %.0e)"
              % ("ok" if ok else "ПЛОХО", name, val, tol))
    print("  крен  смоченная      LWL   волновое на 3 м/с   всего на 3 м/с")
    for c in heel_curves:
        row = [r for r in c["curve"] if abs(r["v_ms"] - 3.0) < 0.11][0]
        print("  %3.0f°  %7.3f м² %7.3f м %14.0f Н %14.0f Н"
              % (c["heel_deg"], c["wetted_m2"], c["lwl_m"], row["rr_n"], row["rt_n"]))
    print("  скорость          Fn      Rf   волновое   всего     R/W")
    for v in (2.0, 3.0, 4.0, 6.0, 8.0):
        row = min(r, key=lambda q: abs(q["v_ms"] - v))
        print("  %.1f м/с (%4.1f уз)  %.2f %7.0f %10.0f %7.0f  %6.3f"
              % (row["v_ms"], row["v_ms"] * 1.94384, row["froude"],
                 row["rf_n"], row["rr_n"], row["rt_n"], row["rt_n"] / (mass * G)))
    w = doc["rig"]["windage"]
    print("парусность в потоке (cx·площадь, кв.м):")
    print("           корпус  такелаж  экипаж втроём   всего")
    for name, cx, cy in (("в нос", 1.0, 0.0), ("лагом", 0.0, 1.0),
                         ("бейдевинд", 0.82, 0.18)):
        hull = w["hull"]["cd"] * (w["hull"]["front_m2"] * cx + w["hull"]["side_m2"] * cy)
        wire = w["rigging"]["cd"] * w["rigging"]["area_m2"]
        crew = (w["crew"]["cd"] * w["crew"]["area_each_m2"]
                * (w["crew"]["front_frac"] * cx + 3.0 * cy))
        print("  %-9s %6.2f %8.2f %13.2f %7.2f"
              % (name, hull, wire, crew, hull + wire + crew))
    print("сетки для симулятора: " + ", ".join(
        "%s %d тр." % (k, len(v["indices"]) // 3) for k, v in meshes.items()))


def _jib_sheeting(jib, track):
    """Насколько остро вообще можно выбрать стаксель.

    Шкотовый угол держат две шкаторины — нижняя и задняя, — а концы у них
    закреплены: галсовый угол на форштевне, фаловый на штаге. Значит шкотовый
    ходит не как попало, а по окружности вокруг штага. Шкот тянет его к
    каретке на погоне, и ближе к ДП, чем ближайшая к каретке точка этой
    окружности, парус не выбрать никаким усилием.

    Отсюда и берётся наименьший вынос. Раньше его не было вовсе: шкот в модели
    был просто углом, и добранный стаксель ложился в диаметральную плоскость —
    чего на настоящей лодке не бывает.
    """
    if track is None:
        return None
    tack = (jib["tack"][0], 0.0, jib["tack"][1])
    head = (jib["head_aft"][0], 0.0, jib["head_aft"][1])
    clew = (jib["clew"][0], 0.0, jib["clew"][1])
    lead = (track["car_mm"][0], track["car_mm"][1], track["deck_z_mm"])

    def sub(a, b):
        return tuple(p - q for p, q in zip(a, b))

    def dot(a, b):
        return sum(p * q for p, q in zip(a, b))

    def nrm(a):
        return math.sqrt(dot(a, a))

    foot = nrm(sub(clew, tack))
    axis = sub(head, tack)
    axis = tuple(c / nrm(axis) for c in axis)
    mid = tuple(tack[i] + dot(sub(clew, tack), axis) * axis[i] for i in range(3))
    e1 = sub(clew, mid)
    radius = nrm(e1)
    e1 = tuple(c / radius for c in e1)
    e2 = (axis[1] * e1[2] - axis[2] * e1[1],
          axis[2] * e1[0] - axis[0] * e1[2],
          axis[0] * e1[1] - axis[1] * e1[0])

    best = None
    for k in range(0, 9001):
        a = -k * 0.01 * math.pi / 180.0        # шкотовый уходит на подветренный борт
        c = tuple(mid[i] + radius * (math.cos(a) * e1[i] + math.sin(a) * e2[i])
                  for i in range(3))
        d = nrm(sub(c, lead))
        if best is None or d < best[0]:
            best = (d, c)
    d, c = best
    return {"lead_m": [round(v / 1000.0, 4) for v in lead],
            "track_m": [[round(track["aft_mm"][0] / 1000.0, 4),
                         round(track["aft_mm"][1] / 1000.0, 4)],
                        [round(track["fwd_mm"][0] / 1000.0, 4),
                         round(track["fwd_mm"][1] / 1000.0, 4)]],
            "min_set_deg": round(math.degrees(math.asin(abs(c[1]) / foot)), 2),
            "clew_hard_m": [round(v / 1000.0, 4) for v in c],
            "sheet_m": round(d / 1000.0, 4)}


def _rig(sp, hull):
    """Риг по обводам, снятым с плана парусности (`sv20/sailplan.py`).

    До обмера паруса задавались треугольниками из головы: площади брались из
    ТТХ магазина (16.5 и 8.5 м²), а углы ставились «примерно там». Сходилось
    плохо. Чертёж говорит другое: у грота большой серп, фаловый угол на
    восемьдесят сантиметров выше, чем предполагалось, а стаксель заметно
    меньше — 7.1 м² вместо 8.5. Сумма 22.85 м² сходится со штампом самого
    чертежа (23 м²) до полупроцента, так что верить нужно ей, а не круглым
    двадцати пяти с сайта магазина.

    Центр парусности теперь считается по настоящим контурам, а не по
    треугольникам, и от этого поднимается на восемьдесят сантиметров: серп
    грота — это площадь наверху, и кренящий момент она даёт соответствующий.
    """
    def m(p):
        return [round(p[0] / 1000.0, 4), round(p[1] / 1000.0, 4)]

    def poly(s):
        return {"tack": m(s["tack"]), "head": m(s["head"]),
                "head_aft": m(s["head_aft"]), "clew": m(s["clew"]),
                "luff": [m(p) for p in s["luff"]],
                "leech": [m(p) for p in s["leech"]],
                "area_m2": s["area_m2"]}

    main, jib = sp["main"], sp["jib"]
    sheeting = _jib_sheeting(jib, sp.get("jib_track"))
    total = main["area_m2"] + jib["area_m2"]
    mast_top, mast_deck = sp["mast"]["top_mm"], sp["mast"]["deck_mm"]
    shroud = sp["shroud"]
    return {
        "main_area_m2": main["area_m2"], "jib_area_m2": jib["area_m2"],
        "sail_area_m2": round(total, 3),
        # Спинакера на чертеже нет, и остаётся он числом из ТТХ конструктора:
        # 27 м². Прежняя формула (56 полных минус лавировочные) брала оба
        # числа с сайта магазина; после обмера она стала мешать источники и
        # выдавала 33 м² там, где конструктор пишет 27. Пока спинакера в
        # симуляторе нет, это только запись в пакете.
        "spinnaker_area_m2": SPINNAKER_M2,
        "mast_x_m": round(mast_deck[0] / 1000.0, 4),
        "mast_top_x_m": round(mast_top[0] / 1000.0, 4),
        "mast_height_m": round(mast_top[1] / 1000.0, 4),
        "mast_deck_z_m": round(mast_deck[1] / 1000.0, 4),
        "mast_rake_deg": sp["mast"]["rake_deg"],
        # Ширина профиля мачты у палубы и у топа. Мачта стоит перед гротом и
        # портит ему поток у передней шкаторины; сила порчи задаётся только
        # отношением этой ширины к хорде паруса.
        "mast_width_m": [round(w / 1000.0, 4) for w in sp["mast"]["width_mm"]],
        "boom_m": round(sp["boom"]["length_mm"] / 1000.0, 4),
        "boom_z_m": round(sp["boom"]["gooseneck_mm"][1] / 1000.0, 4),
        "ce_x_m": round((main["centroid_mm"][0] * main["area_m2"] +
                         jib["centroid_mm"][0] * jib["area_m2"])
                        / total / 1000.0, 4),
        "ce_height_m": round((main["centroid_mm"][1] * main["area_m2"] +
                              jib["centroid_mm"][1] * jib["area_m2"])
                             / total / 1000.0, 4),
        "sails": {"main": poly(main),
                  "jib": dict(poly(jib), sheeting=sheeting)},
        "windage": _windage(hull, sp),
        "forestay": {"stem": m(sp["forestay"]["stem_mm"]),
                     "hounds": m(sp["forestay"]["hounds_mm"])},
        "shroud": None if shroud is None else {
            "tang": m(shroud["tang_mm"]),
            "chainplate": m(shroud["chainplate_mm"]),
            "chainplate_y_m": round(shroud.get("chainplate_y_mm", 0.0)
                                    / 1000.0, 4)},
        "note": ("Обводы обоих парусов, рангоут и стоячий такелаж сняты с "
                 "плана парусности 610.pdf. Сумма площадей сходится с "
                 "парусностью из штампа чертежа; паспортные 25 м² с сайта "
                 "магазина ей противоречат и не используются."),
    }


# Диаметр стоячего такелажа. На чертеже его нет — там такелаж показан линиями,
# — а для лодки этого размера 4 мм это обычный трос. Допущение названо вслух:
# сопротивление такелажа линейно по диаметру, и вдвое более толстый дал бы вдвое
# больше.
RIG_WIRE_MM = 4.0

# Лобовое сопротивление круглого троса. При восьми метрах в секунду и четырёх
# миллиметрах число Рейнольдса около двух тысяч — докритическая область, где у
# цилиндра cx около 1.2 и от скорости почти не зависит.
WIRE_CD = 1.2

# Человек в потоке. Площадь — силуэт сидящего боком: примерно 0.9 м в высоту на
# 0.6 в ширину за вычетом просветов. Спереди экипаж виден одним рядом, сбоку —
# каждый по отдельности. Сидя в кокпите человек наполовину закрыт бортом и
# палубой, на борту — открыт целиком.
CREW_AREA_M2 = 0.52
CREW_CD = 1.1
CREW_MASS_EACH = 80.0


def _silhouette(verts, across, z_from=0.0, nz=80):
    """Тень тела на вертикальную плоскость: площадь и высота центра.

    `across` — какая координата даёт ширину тени: 1 для вида спереди (размах по
    Y), 0 для вида сбоку (размах по X). Считается по слоям: у корпуса каждый
    горизонтальный срез — один отрезок, поэтому размах и есть ширина тени.
    Объединение срезов и даёт настоящий силуэт, а не сумму сечений.
    """
    zs = [v[2] for v in verts]
    z_hi = max(zs)
    if z_hi <= z_from:
        return 0.0, 0.0
    dz = (z_hi - z_from) / nz
    area = 0.0
    moment = 0.0
    for i in range(nz):
        lo, hi = z_from + i * dz, z_from + (i + 1) * dz
        vals = [v[across] for v in verts if lo <= v[2] <= hi]
        if len(vals) < 2:
            continue
        w = max(vals) - min(vals)
        area += w * dz
        moment += w * dz * 0.5 * (lo + hi)
    return area, (moment / area if area > 1e-9 else 0.0)


def _windage(hull, sp):
    """Парусность корпуса, экипажа и стоячего такелажа — по геометрии.

    Раньше здесь стояло одно число на всё: 0.56 кв.м с одним cx и одной
    высотой. Оно и было единственным местом, где сопротивление в воздухе
    назначалось, а не считалось, — и заодно единственным, где не различались
    курсы. А различать надо: лагом корпус подставляет потоку весь борт, а в
    бейдевинд только скулу, и разница у такой лодки почти вчетверо.

    Мачты здесь нет: её сопротивление считается по полоскам грота, на своей
    высоте и со своим кренящим плечом.
    """
    mesh = hull.closed_mesh(n_station=70, n_girth=18)
    verts = [(v[0] / 1000.0, v[1] / 1000.0, v[2] / 1000.0)
             for v in mesh["verts"] if v[2] > 0.0]
    front_a, front_z = _silhouette(verts, 1)
    side_a, side_z = _silhouette(verts, 0)

    # Такелаж: две ванты и штаг, длины из обмера. Тени у них по сути нет —
    # трос виден одинаково с любой стороны, — поэтому площадь одна на все курсы.
    def length(a, b, dy=0.0):
        return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + dy ** 2)

    fore = sp["forestay"]
    wires = [(length(fore["stem_mm"], fore["hounds_mm"]) / 1000.0,
              0.5 * (fore["stem_mm"][1] + fore["hounds_mm"][1]) / 1000.0)]
    shroud = sp.get("shroud")
    if shroud:
        ly = shroud.get("chainplate_y_mm", 0.0)
        wires += 2 * [(length(shroud["tang_mm"], shroud["chainplate_mm"], ly) / 1000.0,
                       0.5 * (shroud["tang_mm"][1] + shroud["chainplate_mm"][1]) / 1000.0)]
    wire_a = sum(L for L, _ in wires) * RIG_WIRE_MM / 1000.0
    wire_z = (sum(L * z for L, z in wires) / sum(L for L, _ in wires)) if wires else 0.0

    # Экипаж сидит на борту, спиной к потоку; высота центра — палуба плюс
    # полметра на туловище.
    deck_z = sp["mast"]["deck_mm"][1] / 1000.0
    return {
        "hull": {"front_m2": round(front_a, 4), "side_m2": round(side_a, 4),
                 "z_front_m": round(front_z, 4), "z_side_m": round(side_z, 4),
                 # Надводный корпус — тело обтекаемое, а не пластина: у него
                 # заметный подпор спереди и вихревой след сзади, но не отрыв
                 # по всей кромке. В парусных VPP для него берут около 0.7.
                 "cd": 0.7},
        "rigging": {"area_m2": round(wire_a, 5), "z_m": round(wire_z, 4),
                    "cd": WIRE_CD, "wire_mm": RIG_WIRE_MM,
                    "length_m": round(sum(L for L, _ in wires), 3)},
        "crew": {"area_each_m2": CREW_AREA_M2, "cd": CREW_CD,
                 "mass_each_kg": CREW_MASS_EACH,
                 "z_m": round(deck_z + 0.5, 3),
                 # Спереди экипаж стоит в затылок друг другу и виден почти
                 # одним силуэтом; сбоку — каждый отдельно.
                 "front_frac": 1.3},
    }


def _junction_cda(chord_m, tc):
    """Сопротивление стыка киля с корпусом, в виде cx·площадь (кв.м).

    У корня крыла, входящего в стенку, пограничные слои крыла и стенки
    сливаются, поток в углу тормозится вдвое и на передней кромке сворачивается
    в подковообразный вихрь. Это не поправка на трение и не индуктивное
    сопротивление — это отдельное явление, и живёт оно в самом углу.

    Формула Хёрнера для нескруглённого стыка: D/q = t²·(17·(t/c)² − 0.05), где
    t — толщина у корня. Никаких подгоняемых величин: и толщина, и хорда сняты
    с чертежа — на виде сверху колодец содержит профиль пера в натуральную
    величину.

    Стык пера с бульбом сюда не входит: его на таких лодках зализывают, и у
    скруглённого стыка Хёрнер даёт втрое меньше. Считать его так же значило бы
    завысить.
    """
    t = chord_m * tc
    return max(0.0, t * t * (17.0 * tc * tc - 0.05))


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
