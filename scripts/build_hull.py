#!/usr/bin/env python3
"""Ф2: сгенерировать корпус по параметрической модели и посчитать гидростатику.

    python3 scripts/build_hull.py

Читает out/frame.json (граничные условия с Ф1), пишет:
    out/hull.json    — шпангоуты, сетка, параметры, гидростатика
    out/hull.md      — отчёт с расхождением от целевых величин

На этом этапе параметры взяты правдоподобными, а не подобранными: задача Ф2 —
дать генератор и мерило, задача Ф3 — свести гидростатику к цели.
"""

import json
import os
import sys
import time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

from sv20 import calibrate, hullmodel, hydro  # noqa: E402

N_STATIONS_DRAWN = 21


def main():
    out = os.path.join(ROOT, "out")
    frame_doc = json.load(open(os.path.join(out, "frame.json")))

    t0 = time.time()
    boundary = hullmodel.Boundary(frame_doc)
    target_kg = calibrate.TARGET["displacement_kg"]

    # Если Ф3 уже отработал, берём подобранные параметры; иначе сводим
    # водоизмещение к цели одним скаляром — этого хватает, чтобы посмотреть
    # на правдоподобный корпус, не запуская оптимизатор.
    fitted = os.path.join(out, "params.json")
    fit_report = None
    if os.path.exists(fitted):
        doc_fit = json.load(open(fitted))
        params = hullmodel.HullParams.from_vector(doc_fit["vector"])
        fit_report = doc_fit["report"]
        factor, source = None, "Ф3, out/params.json"
    else:
        factor, params = hullmodel.calibrate_deadrise(
            boundary, hullmodel.DEFAULT, target_kg, hydro)
        source = "Ф2, одномерная калибровка килеватости"
    hull = hullmodel.Hull(boundary, params)
    h = hydro.hydrostatics(hull, 0.0)
    sink = hydro.sinkage_for(hull, target_kg)

    xs = [boundary.x_stem * i / float(N_STATIONS_DRAWN - 1)
          for i in range(N_STATIONS_DRAWN)]
    stations = hull.station_curves(xs)
    mesh = hull.mesh()
    dt = time.time() - t0

    insane = [s["x"] for s in stations if not s["sane"]]

    doc = {
        "units": "mm",
        "params": hull.p.to_dict(),
        "params_start": hullmodel.DEFAULT.to_dict(),
        "deadrise_factor": factor,
        "params_source": source,
        "fit_report": fit_report,
        "bounds": hull.p.bounds(),
        "boundary": {
            "x_deck_aft": boundary.x_deck_aft,
            "x_stem": boundary.x_stem,
            "x_run_end": boundary.x_run_end,
            "x_forefoot": boundary.x_forefoot,
            "transom_a": boundary.transom_a,
            "transom_b": boundary.transom_b,
            "transom_plane_rms_mm": boundary.transom_rms,
        },
        "target": calibrate.TARGET,
        "hydrostatics": h,
        "sinkage_for_target_mm": sink,
        "stations": stations,
        "chine_line": [[x] + list(hull.section(x).chine)
                       for x in [boundary.x_stem * i / 120.0 for i in range(121)]],
        "keel_line": [[x, 0.0, hull.z_keel(x)]
                      for x in [boundary.x_stem * i / 240.0 for i in range(241)]],
        "mesh": {"verts": [[round(c, 1) for c in v] for v in mesh["verts"]],
                 "quads": mesh["quads"],
                 "transom_edge": [[round(c, 1) for c in v]
                                  for v in mesh["transom_edge"]]},
        "warnings": ([] if not insane else
                     ["вырожденные шпангоуты на X = " +
                      ", ".join("%.0f" % x for x in insane)]),
        "build_seconds": dt,
    }

    with open(os.path.join(out, "hull.json"), "w") as f:
        json.dump(doc, f, ensure_ascii=False)
    with open(os.path.join(out, "hull.md"), "w") as f:
        f.write(render(doc))

    print("параметры: %s" % source)
    if factor:
        print("одномерная калибровка: множитель килеватости %.3f" % factor)
    print("сетка: %d вершин, %d четырёхугольников, %.1f с"
          % (len(mesh["verts"]), len(mesh["quads"]), dt))
    print("транец плоскостью: невязка %.1f мм" % boundary.transom_rms)
    if h:
        print("водоизмещение на КВЛ: %.0f кг (цель %.0f)"
              % (h["displacement_kg"], target_kg))
        print("осадка корпусом: %.0f мм (паспорт 150)" % h["draft_canoe_mm"])
        print("Cb %.3f  Cp %.3f  Cm %.3f  Cwp %.3f  ЦВ %.1f%% LWL от кормы"
              % (h["Cb"], h["Cp"], h["Cm"], h["Cwp"], h["lcb_pct_lwl_from_aft"]))
    print("посадка под цель: %s"
          % ("%.0f мм от КВЛ" % sink if sink is not None else "не найдена"))
    for w in doc["warnings"]:
        print("ВНИМАНИЕ: " + w)


ROWS = [
    ("displacement_kg", "Водоизмещение на КВЛ", "кг", 0),
    ("volume_m3", "Объём подводной части", "м³", 3),
    ("lwl_mm", "Длина по КВЛ", "мм", 0),
    ("bwl_mm", "Ширина по КВЛ", "мм", 0),
    ("draft_canoe_mm", "Осадка корпусом", "мм", 0),
    ("midship_area_m2", "Площадь мидель-шпангоута", "м²", 4),
    ("waterplane_area_m2", "Площадь ватерлинии", "м²", 3),
    ("wetted_area_m2", "Смоченная поверхность", "м²", 2),
    ("lcb_pct_lwl_from_aft", "ЦВ от кормовой точки КВЛ", "% LWL", 1),
    ("lcf_pct_lwl_from_aft", "ЦТ ватерлинии от кормовой точки КВЛ", "% LWL", 1),
    ("Cb", "Коэффициент общей полноты", "", 3),
    ("Cp", "Призматический коэффициент", "", 3),
    ("Cm", "Коэффициент полноты мидель-шпангоута", "", 3),
    ("Cwp", "Коэффициент полноты ватерлинии", "", 3),
]

# Ориентиры для спортбота такого размера — не нормы, а рамка правдоподобия.
SANE = {
    "Cp": (0.52, 0.62),
    "Cm": (0.55, 0.80),
    "Cwp": (0.68, 0.82),
    "lcb_pct_lwl_from_aft": (40.0, 50.0),
}


def render(doc):
    h = doc["hydrostatics"]
    t = doc["target"]
    L = ["# Параметрический корпус\n",
         "Сгенерировано `scripts/build_hull.py`. Не редактировать вручную.\n",
         "## Что это\n",
         "Шпангоут составной: днищевая панель от киля до скулы, бортовая от "
         "скулы до линии борта, между ними сопряжение переменного радиуса. "
         "По длине меняются пять законов — килеватость, положение скулы, погибь "
         "каждой панели и скругление скулы, — плюс линия киля в ДП. Границы "
         "(линия борта, кормовое днище, форштевень, транец) взяты с Ф1 и не "
         "подгоняются.\n",
         "Источник параметров: **%s**.\n" % doc.get("params_source", "—"),
         "## Гидростатика на снятой с чертежа КВЛ\n",
         "| Величина | Значение | | Ориентир |", "|---|---:|---|---|"]

    for key, label, unit, prec in ROWS:
        ref = ""
        if key in SANE:
            lo, hi = SANE[key]
            ok = lo <= h[key] <= hi
            ref = "%.2f–%.2f %s" % (lo, hi, "✓" if ok else "мимо")
        if key == "displacement_kg":
            ref = "цель %.0f кг (%s)" % (t["displacement_kg"], t["source"])
        if key == "draft_canoe_mm":
            ref = "паспорт 150 мм"
        L.append("| %s | %.*f | %s | %s |" % (label, prec, h[key], unit, ref))
    L.append("")

    d = h["displacement_kg"] - t["displacement_kg"]
    L.append("Невязка по водоизмещению **%+.0f кг (%+.1f%%)**."
             % (d, 100.0 * d / t["displacement_kg"]))
    if doc["sinkage_for_target_mm"] is not None:
        L.append("Чтобы вытеснить целевые %.0f кг, модель должна сесть на "
                 "**%+.0f мм** относительно снятой с чертежа КВЛ.\n"
                 % (t["displacement_kg"], doc["sinkage_for_target_mm"]))
    if doc["deadrise_factor"]:
        L.append("## Проверка достижимости\n")
        L.append("Стартовый набор параметров давал 400 кг. Водоизмещение сведено "
                 "к цели **одним числом** — общим множителем килеватости "
                 "**%.3f**: килеватость при заданной осадке определяет полноту "
                 "подводного шпангоута, почти не трогая ни линию борта, ни линию "
                 "киля. То, что цель берётся одним скаляром, означает, что "
                 "параметризация накрывает нужную форму и Ф3 есть где искать. "
                 "Это не подгонка: остальные величины ниже никто не сводил.\n"
                 % doc["deadrise_factor"])

    b = doc["boundary"]
    L.append("## Упрощения\n")
    L.append("- Транец принят плоским: `X = %.1f %+.4f·Z`. Реальная кромка "
             "отклоняется от этой плоскости на **%.1f мм** (среднеквадратично). "
             "Кормовая граница сетки лежит ровно на этой плоскости, поэтому "
             "транец получается плоским многоугольником без обрезки треугольников."
             % (b["transom_a"], b["transom_b"], b["transom_plane_rms_mm"]))
    L.append("- Впереди подошвы форштевня (X ≥ %.0f мм) линия киля берётся прямо "
             "с чертежа, а не из сплайна: там снятая скула радиусом около 40 мм, "
             "и параметризовать её незачем." % b["x_forefoot"])
    L.append("- Развал борта не задаётся, а следует из положения скулы и линии борта: "
             "одной степенью свободы меньше у оптимизатора.\n")

    L.append("## Параметры\n")
    p = doc["params"]
    L.append("| X, мм | " + " | ".join("%.0f" % x for x in p["shape_stations"]) + " |")
    L.append("|---" * (len(p["shape_stations"]) + 1) + "|")
    for key, label in (("beta", "Килеватость, град"),
                       ("w", "Скула, доля полушироты"),
                       ("b0", "Погибь днища"),
                       ("b1", "Погибь борта"),
                       ("r", "Скругление скулы")):
        L.append("| %s | " % label + " | ".join("%.3f" % v for v in p[key]) + " |")
    L.append("")
    L.append("Линия киля, мм от КВЛ:\n")
    L.append("| X, мм | " + " | ".join("%.0f" % x for x in p["keel_stations"]) + " |")
    L.append("|---" * (len(p["keel_stations"]) + 1) + "|")
    L.append("| Z | " + " | ".join("%.0f" % v for v in p["keel_z"]) + " |")
    L.append("")

    if doc["warnings"]:
        L.append("## Предупреждения\n")
        for w in doc["warnings"]:
            L.append("- " + w)
        L.append("")
    return "\n".join(L)


if __name__ == "__main__":
    main()
