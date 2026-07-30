#!/usr/bin/env python3
"""Ф3: подогнать параметры обводов. Требует scipy.

    .venv/bin/python scripts/fit_hull.py

Читает out/frame.json, пишет out/params.json и out/fit.md.
`build_hull.py` подхватывает out/params.json автоматически, если он есть.
"""

import json
import os
import sys
import time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

from sv20 import calibrate, fit, hullmodel, hydro  # noqa: E402


def snapshot(boundary, params):
    hull = hullmodel.Hull(boundary, params)
    h = hydro.hydrostatics(hull, 0.0, n=160)
    h["min_flare_deg"] = min(hull.section(x).flare_deg
                             for x in [500, 1500, 2500, 3500, 4500])
    return h


def main():
    out = os.path.join(ROOT, "out")
    frame_doc = json.load(open(os.path.join(out, "frame.json")))
    boundary = hullmodel.Boundary(frame_doc)

    target_kg = calibrate.TARGET["displacement_kg"]
    draft_mm = calibrate.SPEC["draft_hull_mm"]

    start = hullmodel.DEFAULT
    before = snapshot(boundary, start)

    t0 = time.time()
    params, report = fit.fit(boundary, start, target_kg, draft_mm, verbose=0)
    dt = time.time() - t0

    after = snapshot(boundary, params)
    groups = fit.breakdown(boundary, params, target_kg, draft_mm)

    doc = {
        "params": params.to_dict(),
        "vector": params.to_vector(),
        "target": {"displacement_kg": target_kg, "draft_hull_mm": draft_mm},
        "bands": dict((k, list(v)) for k, v in fit.BANDS.items()),
        "weights": fit.WEIGHTS,
        "report": report,
        "seconds": dt,
        "before": before,
        "after": after,
        "cost_groups": groups,
    }
    with open(os.path.join(out, "params.json"), "w") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out, "fit.md"), "w") as f:
        f.write(render(doc))

    print("%s за %.0f с, %d вычислений невязки"
          % (report["message"], dt, report["evaluations"]))
    print("стоимость: %.4f -> %.4f" % (report["cost_start"], report["cost_end"]))
    for key, label, unit, prec in COMPARE:
        print("  %-34s %10.*f -> %10.*f  %s"
              % (label, prec, before[key], prec, after[key], unit))
    print("записано в out/: params.json, fit.md")


COMPARE = [
    ("displacement_kg", "Водоизмещение", "кг", 0),
    ("draft_canoe_mm", "Осадка корпусом", "мм", 0),
    ("bwl_mm", "Ширина по КВЛ", "мм", 0),
    ("wetted_area_m2", "Смоченная поверхность", "м²", 2),
    ("lcb_pct_lwl_from_aft", "ЦВ от кормы, % LWL", "", 1),
    ("Cp", "Cp", "", 3),
    ("Cm", "Cm", "", 3),
    ("Cwp", "Cwp", "", 3),
    ("min_flare_deg", "Наименьший развал борта", "град", 1),
]


def render(doc):
    b, a, t = doc["before"], doc["after"], doc["target"]
    r = doc["report"]
    L = ["# Ф3 — подгонка обводов\n",
         "Сгенерировано `scripts/fit_hull.py`. Не редактировать вручную.\n",
         "%s. %d параметров, %d невязок, %d вычислений, %.0f с. "
         "Стоимость %.4f → %.4f.\n"
         % (r["message"].rstrip("."), r["parameters"], r["residuals"],
            r["evaluations"], doc["seconds"], r["cost_start"], r["cost_end"]),
         "## Было и стало\n",
         "| Величина | Ф2 | Ф3 | Цель или коридор |", "|---|---:|---:|---|"]

    for key, label, unit, prec in COMPARE:
        ref = ""
        if key == "displacement_kg":
            ref = "%.0f кг" % t["displacement_kg"]
        elif key == "draft_canoe_mm":
            ref = "%.0f мм" % t["draft_hull_mm"]
        elif key in doc["bands"]:
            lo, hi, _ = doc["bands"][key]
            ok = lo <= a[key] <= hi
            ref = "%.2f–%.2f %s" % (lo, hi, "✓" if ok else "мимо")
        L.append("| %s | %.*f | %.*f | %s |"
                 % (label, prec, b[key], prec, a[key], ref))
    L.append("")

    binding = []
    for key, (lo, hi, _) in sorted(doc["bands"].items()):
        v = a[key]
        span = hi - lo
        if v <= lo + 0.04 * span:
            binding.append((key, v, "нижнюю", lo))
        elif v >= hi - 0.04 * span:
            binding.append((key, v, "верхнюю", hi))
    L.append("## Где рамка правдоподобия реально работает\n")
    if binding:
        L.append("Эти величины легли на границу коридора — значит их определили "
                 "не данные, а моё предположение о том, каким должен быть "
                 "спортбот. Если предположение неверно, форма поедет:\n")
        for key, v, side, edge in binding:
            L.append("- `%s` = %.3f, упирается в %s границу %.2f" %
                     (key, v, side, edge))
    else:
        L.append("Ни одна величина не легла на границу коридора: форму "
                 "определили данные, а не рамка правдоподобия.")
    L.append("")

    L.append("## Из чего сложилась итоговая невязка\n")
    L.append("| Группа | Слагаемых | Стоимость |")
    L.append("|---|---:|---:|")
    for g in doc["cost_groups"]:
        L.append("| %s | %d | %.4f |" % (g["group"], g["terms"], g["cost"]))
    L.append("")
    top = max(doc["cost_groups"], key=lambda g: g["cost"])
    total = sum(g["cost"] for g in doc["cost_groups"]) or 1.0
    L.append("Наибольшая доля — «%s», %.0f%% остатка. Большая доля на коридорах "
             "означала бы, что данные и рамка правдоподобия тянут в разные "
             "стороны; большая доля на плавности — что форма упирается в "
             "гладкость.\n" % (top["group"], 100.0 * top["cost"] / total))

    p = doc["params"]
    L.append("## Подобранные законы\n")
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
    return "\n".join(L)


if __name__ == "__main__":
    main()
