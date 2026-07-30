#!/usr/bin/env python3
"""Ф0 + Ф1: чертёж -> структурированная геометрия.

    python3 scripts/extract.py [data/raw/610.pdf] [out]

Пишет в каталог вывода:
    frame.json    — каркас Ф1: кривые в 3D, метрики, список пробелов
    drawing.json  — все пути чертежа, разложенные по видам, в миллиметрах
    report.md     — то же самое человеческим языком
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from sv20 import calibrate, frame, layers, pdf_paths  # noqa: E402


def project(groups, datum):
    """Пути каждого вида -> миллиметры в своей плоскости.

    Вид сверху ложится на плоскость КВЛ (Z=0), вид сбоку — в ДП (Y=0).
    Это не реконструкция, а подложка: два исходных изображения, разнесённые
    в пространстве так, как они на самом деле друг к другу относятся.
    """
    out = {}
    for name, items in groups.items():
        plane = "plan" if name in ("plan", "deck_line") else "profile"
        conv = datum.plan if plane == "plan" else datum.profile
        out[name] = {
            "plane": plane,
            "paths": [{"w": s.width,
                       "pts": [[round(c, 2) for c in conv(p)] for p in s.points]}
                      for s in items],
        }
    return out


def main():
    pdf = sys.argv[1] if len(sys.argv) > 1 else "data/raw/610.pdf"
    outdir = sys.argv[2] if len(sys.argv) > 2 else "out"
    os.makedirs(outdir, exist_ok=True)

    data = open(pdf, "rb").read()
    media = pdf_paths.media_box(data)
    subpaths = pdf_paths.parse(data)
    ops = pdf_paths.operator_histogram(data)

    datum, key, checks = calibrate.calibrate(subpaths)
    views = layers.make_views(datum, key, media)
    groups = layers.classify(subpaths, views, key)
    fr = frame.build(subpaths, datum, key, calibrate.SPEC,
                     views.title_box, media)

    frame_doc = {
        "source": {"file": os.path.basename(pdf), "media_box_pt": list(media),
                   "subpaths": len(subpaths),
                   "points": sum(len(s.points) for s in subpaths),
                   "operators": dict(ops)},
        "datum": datum.to_dict(),
        "units": "mm",
        "axes": {"X": "от кормовой оконечности в нос",
                 "Y": "полуширота, вправо от ДП",
                 "Z": "вверх от КВЛ"},
        "calibration_checks": checks,
        "curves": fr["curves"],
        "metrics": fr["metrics"],
        "gaps": fr["gaps"],
        "layer_summary": layers.summary(groups),
    }
    with open(os.path.join(outdir, "frame.json"), "w") as f:
        json.dump(frame_doc, f, ensure_ascii=False, indent=1)

    with open(os.path.join(outdir, "drawing.json"), "w") as f:
        json.dump({"units": "mm", "views": views.to_dict(),
                   "groups": project(groups, datum)}, f, ensure_ascii=False)

    with open(os.path.join(outdir, "report.md"), "w") as f:
        f.write(render_report(frame_doc))

    print("разобрано путей: %d (%d точек)" % (len(subpaths), frame_doc["source"]["points"]))
    print("масштаб: %.6f мм/пт" % datum.scale)
    for c in checks:
        dev = "" if c["deviation"] is None else "  откл %+.2f%%" % (100 * c["deviation"])
        print("  %-32s %10.3f  (паспорт %8.3f)%s" % (c["name"], c["value"], c["expected"], dev))
    print("слои: " + ", ".join("%s=%d" % (k, v["paths"])
                               for k, v in frame_doc["layer_summary"].items()))
    print("записано в %s/: frame.json, drawing.json, report.md" % outdir)


METRIC_LABELS = frame.METRIC_LABELS


def render_report(doc):
    L = []
    L.append("# 610 / SV20 — разбор чертежа (Ф0–Ф1)\n")
    L.append("Сгенерировано `scripts/extract.py`. Не редактировать вручную.\n")
    s = doc["source"]
    L.append("## Исходник\n")
    L.append("`%s`, лист %.0f×%.0f пт, %d полилиний, %d точек. "
             "Кривых Безье и матриц трансформации нет — только `m`/`l`/`h`/`re`, "
             "поэтому координаты берутся из файла без аппроксимации.\n"
             % (s["file"], s["media_box_pt"][2], s["media_box_pt"][3],
                s["subpaths"], s["points"]))

    L.append("## Привязка\n")
    d = doc["datum"]
    L.append("Масштаб **%.6f мм/пт** получен из габаритной длины 6100 мм. "
             "Кормовая оконечность — подошва транца (у 610 обратный наклон, "
             "и низ транца уходит в корму дальше палубного угла).\n" % d["mm_per_pt"])
    L.append("| Проверка | Чертёж | Паспорт | Отклонение |")
    L.append("|---|---:|---:|---:|")
    for c in doc["calibration_checks"]:
        dev = "—" if c["deviation"] is None else "%+.2f%%" % (100 * c["deviation"])
        L.append("| %s | %.2f | %.2f | %s |" % (c["name"], c["value"], c["expected"], dev))
    L.append("")

    L.append("## Снятые величины\n")
    L.append("| Величина | Значение | |")
    L.append("|---|---:|---|")
    for k, label, unit, prec in METRIC_LABELS:
        L.append("| %s | %.*f | %s |" % (label, prec, doc["metrics"][k], unit))
    L.append("")

    L.append("## Каркас\n")
    L.append("| Кривая | Точек | Достоверность | Примечание |")
    L.append("|---|---:|---|---|")
    for c in doc["curves"]:
        L.append("| %s | %d | `%s` | %s |"
                 % (c["label"], len(c["points"]), c["confidence"], c["note"]))
    L.append("")

    L.append("## Слои чертежа\n")
    L.append("| Слой | Путей | Точек |")
    L.append("|---|---:|---:|")
    for k, v in doc["layer_summary"].items():
        L.append("| %s | %d | %d |" % (k, v["paths"], v["points"]))
    L.append("")

    L.append("## Чего на чертеже нет\n")
    for g in doc["gaps"]:
        L.append("- **%s.** %s — блокирует: %s" % (g["what"], g["detail"], g["blocks"]))
    L.append("")
    return "\n".join(L)


if __name__ == "__main__":
    main()
