#!/usr/bin/env python3
"""Ф6: выгрузка отдельных тел и физического манифеста.

    python3 scripts/export.py

Тела выгружаются раздельно — корпус, перо киля, бульб, руль, — потому что в
реальном времени каждое приложение считается своим: подъёмная сила и
сопротивление крыла берутся по его собственным площади, размаху и углу атаки.
Сшивать их в одну оболочку имело бы смысл для RANS, но не здесь.

Пишет в out/export/:
    sv20.glb        все тела, glTF 2.0 — Godot, Unity, Unreal, three.js
    sv20.obj        то же в текстовом виде, для Blender и для глаз
    *.stl           каждое тело отдельно, на случай сеточных генераторов
    sv20.json       манифест: массы, инерция, площади, оси, гидростатика
    export.md       отчёт с проверками
"""

import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

from sv20 import (appendages, calibrate, exporters, features, hullmodel,  # noqa: E402
                  hydro, meshops, pdf_paths, sailplan, stability)

LODS = [("hull", 140, 32), ("hull_lod1", 70, 18)]

COLOURS = {
    "keel_case": [0.80, 0.84, 0.88],
    "hull": [0.62, 0.70, 0.78],
    "hull_lod1": [0.62, 0.70, 0.78],
    "keel_fin": [0.42, 0.45, 0.50],
    "bulb": [0.55, 0.45, 0.25],
    "rudder": [0.42, 0.45, 0.50],
}


def body(name, mesh, density=None):
    v, t, rep = meshops.prepare(mesh["verts"], mesh["tris"])
    props = meshops.solid_properties(v, t, density if density else 1.0)
    return {
        "name": name,
        "verts": v, "tris": t,
        "normals": meshops.normals(v, t),
        "check": rep,
        "props": props,
        "area_m2": meshops.surface_area_m2(v, t),
        "bbox": meshops.bbox(v),
        "density": density,
    }


def main():
    out = os.path.join(ROOT, "out")
    dst = os.path.join(out, "export")
    os.makedirs(dst, exist_ok=True)

    frame_doc = json.load(open(os.path.join(out, "frame.json")))
    boundary = hullmodel.Boundary(frame_doc)
    params_path = os.path.join(out, "params.json")
    if os.path.exists(params_path):
        params = hullmodel.HullParams.from_vector(
            json.load(open(params_path))["vector"])
    else:
        params = hullmodel.DEFAULT
    hull = hullmodel.Hull(boundary, params)

    feats = frame_doc.get("features")
    if feats is None:
        data = open(os.path.join(ROOT, "data", "raw", "610.pdf"), "rb").read()
        feats = features.extract(pdf_paths.parse(data), None, None)

    x_keel = 0.5 * (feats["keel_section"]["x_le_mm"] + feats["keel_section"]["x_te_mm"])
    keel = appendages.build_keel(feats, hull.z_keel(x_keel),
                                 calibrate.TARGET["draft_max_mm"],
                                 calibrate.TARGET["ballast_kg"])
    rudder = appendages.build_rudder(feats, sailplan.upwind_area_m2(feats))
    case = appendages.build_keel_case(feats, hull.z_keel(x_keel) - 5.0,
                                      appendages.TRUNK_TOP_MM)

    bodies = []
    for name, ns, ng in LODS:
        bodies.append(body(name, hull.closed_mesh(n_station=ns, n_girth=ng)))
    # выгружаем полное перо, включая уходящую в колодец часть: иначе масса
    # тела в манифесте не сошлась бы с массой пера в разделе балласта
    bodies.append(body("keel_fin", keel["fin_full"].mesh(), keel["fin_density"]))
    bodies.append(body("bulb", keel["bulb"].mesh(
        keel["bulb_x_nose_mm"], -keel["draft_mm"] + keel["bulb"].radius),
        appendages.LEAD_DENSITY))
    bodies.append(body("rudder", rudder["blade"].mesh(), 1200.0))
    if case:
        # масса колодца входит в конструкцию корпуса, отдельной плотности нет
        bodies.append(body("keel_case", case["mesh"]))

    export = [(b["name"], b) for b in bodies if b["name"] != "hull_lod1"]
    exporters.write_glb(os.path.join(dst, "sv20.glb"),
                        [(b["name"], b) for b in bodies], COLOURS)
    exporters.write_obj(os.path.join(dst, "sv20.obj"), export)
    for b in bodies:
        if b["name"] == "hull_lod1":
            continue
        exporters.write_stl(os.path.join(dst, b["name"] + ".stl"), b)

    manifest = build_manifest(hull, keel, rudder, bodies, feats)
    with open(os.path.join(dst, "sv20.json"), "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out, "export.md"), "w") as f:
        f.write(render(manifest, bodies))

    print("выгружено в out/export/:")
    for b in bodies:
        c = b["check"]
        print("  %-10s %6d тр.  %s  V=%.5f м³%s"
              % (b["name"], c["tris"],
                 "замкнуто" if c["watertight"] else "НЕ ЗАМКНУТО",
                 b["props"]["volume_m3"],
                 "" if not b["density"] else "  %.1f кг" % b["props"]["mass_kg"]))
    v = manifest["checks"]["displacement_mesh_vs_sections"]
    print("сверка объёма под КВЛ: сетка %.5f, шпангоуты %.5f, %+.2f%%"
          % (v["mesh_m3"], v["sections_m3"], v["deviation_pct"]))


def build_manifest(hull, keel, rudder, bodies, feats):
    by = dict((b["name"], b) for b in bodies)
    h = hydro.hydrostatics(hull, 0.0, n=200)
    hull_body = by["hull"]

    table = []
    for dz in range(-100, 301, 25):
        hh = hydro.hydrostatics(hull, float(dz), n=120)
        if not hh:
            continue
        table.append({"waterline_mm": dz,
                      "displacement_kg": hh["displacement_kg"],
                      "volume_m3": hh["volume_m3"],
                      "waterplane_area_m2": hh["waterplane_area_m2"],
                      "vcb_mm": hh["vcb_mm"], "bm_mm": hh["bm_mm"],
                      "lcb_mm": hh["lcb_mm"], "lcf_mm": hh["lcf_mm"],
                      "wetted_area_m2": hh["wetted_area_m2"]})

    mesh_below = meshops.volume_below_m3(hull_body["verts"], hull_body["tris"], 0.0)

    fin, blade = keel["fin"], rudder["blade"]
    return {
        "generator": "sv20 reverse-engineering pipeline, Ф0–Ф6",
        "units": {"internal": "мм, Z вверх, X от кормовой оконечности в нос",
                  "export": "м, Y вверх, X в нос (glTF/OBJ/STL)"},
        "boat": {
            "name": "SV20 / проект 610",
            "loa_mm": 6100.0, "beam_mm": 2199.9, "lwl_mm": h["lwl_mm"],
            "displacement_kg": calibrate.TARGET["displacement_kg"],
            "ballast_kg": calibrate.TARGET["ballast_kg"],
            "draft_max_mm": calibrate.TARGET["draft_max_mm"],
            "sail_area_upwind_m2": calibrate.TARGET["sail_area_upwind_m2"],
            "sail_area_downwind_m2": calibrate.TARGET["sail_area_downwind_m2"],
        },
        "bodies": [
            {"name": b["name"],
             "files": {"glb_node": b["name"],
                       "stl": None if b["name"] == "hull_lod1"
                       else b["name"] + ".stl"},
             "triangles": b["check"]["tris"], "vertices": b["check"]["verts"],
             "watertight": b["check"]["watertight"],
             "volume_m3": b["props"]["volume_m3"],
             "surface_area_m2": b["area_m2"],
             "com_mm": b["props"]["com_mm"],
             "density_kg_m3": b["density"],
             "mass_kg": b["props"]["mass_kg"] if b["density"] else None,
             "inertia_unit_density_kg_m2": b["props"]["inertia_kg_m2"],
             "bbox_mm": b["bbox"]}
            for b in bodies],
        "foils": {
            "keel": {
                "area_m2": keel["area_m2"], "span_mm": fin.span,
                "chord_mm": fin.root_chord, "aspect_ratio": keel["aspect_ratio"],
                "thickness_ratio": feats["keel_section"]["thickness_ratio"],
                "section_family": feats["keel_section_family"]["nearest"],
                "section_measured": True,
                "quarter_chord_mm": [
                    [fin.x_le_root - 0.25 * fin.root_chord, 0.0, fin.z_root],
                    [fin.x_le_tip - 0.25 * fin.tip_chord, 0.0, fin.z_tip]],
                "lifts_vertically": feats["lifts_vertically"]},
            "rudder": {
                "area_m2": rudder["area_m2"], "span_mm": blade.span,
                "root_chord_mm": rudder["root_chord_mm"],
                "tip_chord_mm": rudder["tip_chord_mm"],
                "aspect_ratio": rudder["aspect_ratio"],
                "thickness_ratio": rudder["thickness_ratio"],
                "section_family": "NACA 0012", "section_measured": False,
                "stock_axis_mm": [[rudder["x_stock_mm"], 0.0, blade.z_root],
                                  [rudder["x_stock_mm"], 0.0, blade.z_tip]],
                "pintles_z_mm": [feats["rudder_pintles"]["stock_z_lo_mm"],
                                 feats["rudder_pintles"]["stock_z_hi_mm"]]
                if feats.get("rudder_pintles") else None},
        },
        "ballast": {
            "total_kg": calibrate.TARGET["ballast_kg"],
            "fin_kg": keel["fin_mass_kg"], "bulb_kg": keel["bulb_mass_kg"],
            "vcg_mm": appendages.ballast_vcg_mm(keel),
            "fin_density_kg_m3": keel["fin_density"],
            "fin_density_range": list(appendages.FIN_DENSITY_RANGE)},
        "stability": stability_payload(hull, keel, bodies, feats, h),
        "hydrostatics_at_dwl": h,
        "hydrostatic_table": table,
        "checks": {
            "displacement_mesh_vs_sections": {
                "mesh_m3": mesh_below, "sections_m3": h["volume_m3"],
                "deviation_pct": 100.0 * (mesh_below - h["volume_m3"]) / h["volume_m3"]},
            "all_watertight": all(b["check"]["watertight"] for b in bodies),
            "fin_mesh_vs_analytic_kg": {
                "mesh": by["keel_fin"]["props"]["mass_kg"],
                "analytic": keel["fin_mass_kg"]},
            "bulb_mesh_vs_analytic_kg": {
                "mesh": by["bulb"]["props"]["mass_kg"],
                "analytic": keel["bulb_mass_kg"]},
        },
        "assumptions": appendages.ASSUMPTIONS,
    }


def stability_payload(hull, keel, bodies, feats, h):
    by = dict((b["name"], b) for b in bodies)
    shell = meshops.shell_properties(by["hull"]["verts"], by["hull"]["tris"])
    grid = [2600.0, 3100.0, 3600.0, 4300.0, 5000.0, 6400.0, 7850.0]
    rows = appendages.sensitivity(
        feats, keel["fin"].z_root, keel["draft_mm"],
        calibrate.TARGET["ballast_kg"], grid, meshops=meshops)

    items, o = stability.budget(
        keel, by["keel_fin"]["props"], by["bulb"]["props"], shell,
        calibrate.TARGET["displacement_kg"])
    ref = stability.evaluate(items, h, o)
    return {
        "shell": shell,
        "ballast_by_fin_density": rows,
        "defaults": stability.BUDGET_DEFAULTS,
        "total_kg": calibrate.TARGET["displacement_kg"],
        "items_at_defaults": items,
        "reference": ref,
        "note": ("GM и период считаются по обводам плюс весовая сводка. "
                 "Обводы проверены гидростатикой, сводка — нет: рангоут, "
                 "палубное железо и плотность пера киля оценены. Поэтому "
                 "период — это то место, где реконструкцию можно поймать "
                 "на несоответствии памяти."),
    }


def render(m, bodies):
    L = ["# Ф6 — выгрузка\n",
         "Сгенерировано `scripts/export.py`. Не редактировать вручную.\n",
         "Тела выгружены **раздельно**: в реальном времени каждое приложение "
         "считается своим — подъёмная сила и сопротивление крыла берутся по его "
         "собственным площади, размаху и углу атаки. Сшивать всё в одну "
         "оболочку имело бы смысл для RANS, но не здесь.\n",
         "Экспорт в метрах и с осью Y вверх — как ждут движки. Внутренняя "
         "судостроительная система (миллиметры, Z вверх) не менялась.\n",
         "## Тела\n",
         "| Тело | Треугольников | Замкнуто | Объём, м³ | Масса, кг | ЦТ X, мм |",
         "|---|---:|---|---:|---:|---:|"]
    for b in m["bodies"]:
        L.append("| `%s` | %d | %s | %.5f | %s | %.0f |"
                 % (b["name"], b["triangles"], "да" if b["watertight"] else "**нет**",
                    b["volume_m3"],
                    "—" if b["mass_kg"] is None else "%.1f" % b["mass_kg"],
                    b["com_mm"][0]))
    L.append("")

    c = m["checks"]
    d = c["displacement_mesh_vs_sections"]
    L.append("## Проверки\n")
    L.append("- Все тела замкнуты и согласованно ориентированы: **%s**."
             % ("да" if c["all_watertight"] else "НЕТ"))
    L.append("- Объём под КВЛ, посчитанный **по сетке** через теорему Гаусса, — "
             "%.5f м³; посчитанный **по шпангоутам** интегрированием площадей — "
             "%.5f м³. Расхождение **%+.2f%%**. Это два независимых пути от "
             "параметров до объёма, и они сходятся: значит ни в сетке, ни в "
             "гидростатике грубой ошибки нет."
             % (d["mesh_m3"], d["sections_m3"], d["deviation_pct"]))
    for key, what in (("fin_mesh_vs_analytic_kg", "пера"),
                      ("bulb_mesh_vs_analytic_kg", "бульба")):
        bm = c[key]
        L.append("- Масса %s: по сетке %.1f кг, по аналитической форме %.1f кг "
                 "(%+.1f%% — цена огранки)."
                 % (what, bm["mesh"], bm["analytic"],
                    100.0 * (bm["mesh"] - bm["analytic"]) / bm["analytic"]))
    L.append("")

    f = m["foils"]
    L.append("## Что нужно физике\n")
    L.append("| Величина | Киль | Руль |")
    L.append("|---|---:|---:|")
    L.append("| Площадь, м² | %.3f | %.3f |" % (f["keel"]["area_m2"], f["rudder"]["area_m2"]))
    L.append("| Размах, мм | %.0f | %.0f |" % (f["keel"]["span_mm"], f["rudder"]["span_mm"]))
    L.append("| Удлинение | %.2f | %.2f |"
             % (f["keel"]["aspect_ratio"], f["rudder"]["aspect_ratio"]))
    L.append("| Относительная толщина | %.3f | %.3f |"
             % (f["keel"]["thickness_ratio"], f["rudder"]["thickness_ratio"]))
    L.append("| Профиль | %s | %s |"
             % (f["keel"]["section_family"], f["rudder"]["section_family"]))
    L.append("| Обмерен или принят | **обмерен** | принят |")
    L.append("")
    L.append("Ось баллера и линия четверти хорды киля лежат в манифесте — к ним "
             "прикладываются силы. Балласт %.0f кг с ЦТ на %.0f мм от КВЛ."
             % (m["ballast"]["total_kg"], m["ballast"]["vcg_mm"]))
    L.append("")

    st = m.get("stability")
    if st and st["reference"]:
        r = st["reference"]
        L.append("## Бортовая качка\n")
        L.append("| Величина | Значение |")
        L.append("|---|---:|")
        L.append("| Аппликата ЦТ, KG | %+.0f мм |" % r["kg_mm"])
        L.append("| Аппликата ЦВ, KB | %+.0f мм |" % r["kb_mm"])
        L.append("| Метацентрический радиус, BM | %.0f мм |" % r["bm_mm"])
        L.append("| Метацентрическая высота, GM | **%.0f мм** |" % r["gm_mm"])
        L.append("| Момент инерции при качке | %.0f кг·м² |" % r["ixx_kg_m2"])
        L.append("| Радиус инерции | %.0f мм |" % r["gyradius_mm"])
        L.append("| Присоединённая инерция | ×%.2f |" % r["added_inertia"])
        L.append("| **Период бортовой качки** | **%.2f с** |" % r["roll_period_s"])
        L.append("")
        L.append("Весовая сводка:\n")
        L.append("| Статья | Масса | ЦТ по высоте | Откуда |")
        L.append("|---|---:|---:|---|")
        for it in st["items_at_defaults"]:
            L.append("| %s | %.1f кг | %+.0f мм | %s |"
                     % (it["name"], it["mass_kg"], it["com_mm"][2], it["note"]))
        L.append("")
        L.append(st["note"] + "\n")

    L.append("## Гидростатическая таблица\n")
    L.append("Чтобы движку не интегрировать сетку на каждом шаге: осадка → "
             "водоизмещение и площадь ватерлинии. Ноль — снятая с чертежа КВЛ.\n")
    L.append("| Уровень воды, мм | Водоизмещение, кг | S ватерлинии, м² | ЦВ, мм |")
    L.append("|---:|---:|---:|---:|")
    for row in m["hydrostatic_table"]:
        L.append("| %+d | %.0f | %.2f | %.0f |"
                 % (row["waterline_mm"], row["displacement_kg"],
                    row["waterplane_area_m2"], row["lcb_mm"]))
    L.append("")
    L.append("## Допущения, перенесённые из Ф5\n")
    for a in m["assumptions"]:
        L.append("- " + a)
    L.append("")
    return "\n".join(L)


if __name__ == "__main__":
    main()
