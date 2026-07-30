#!/usr/bin/env python3
"""Собрать самодостаточный просмотрщик из результатов extract.py.

    python3 scripts/build_viewer.py

Данные и код вшиваются в один HTML: файл открывается двойным кликом, без
сервера и без внешних библиотек.
"""

import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

from sv20 import frame  # noqa: E402

# Штамп — выклеенный в кривые текст, в просмотрщике он бесполезен и весит много.
SKIP_GROUPS = {"title"}


def curve(fr, name):
    for c in fr["curves"]:
        if c["name"] == name:
            return c["points"]
    raise KeyError(name)


HYDRO_ROWS = [
    ("displacement_kg", "Водоизмещение", "кг", 0),
    ("volume_m3", "Объём", "м³", 3),
    ("lwl_mm", "Длина по КВЛ", "мм", 0),
    ("bwl_mm", "Ширина по КВЛ", "мм", 0),
    ("draft_canoe_mm", "Осадка корпусом", "мм", 0),
    ("midship_area_m2", "Площадь миделя", "м²", 3),
    ("wetted_area_m2", "Смоченная поверхность", "м²", 2),
    ("lcb_pct_lwl_from_aft", "ЦВ от кормы", "% LWL", 1),
    ("Cb", "Cb", "", 3),
    ("Cp", "Cp", "", 3),
    ("Cm", "Cm", "", 3),
    ("Cwp", "Cwp", "", 3),
]


def build_notes(fr):
    m = fr["metrics"]
    sheer = curve(fr, "sheer_stbd")
    x_b = m["beam_deck_x_mm"]
    p_b = min(sheer, key=lambda p: abs(p[0] - x_b))
    stem = curve(fr, "stem")
    transom = curve(fr, "transom")

    return [
        {"p": [p_b[0], p_b[1], p_b[2]], "d": [26, -34], "c": "--c-derived",
         "t": "Наибольшая ширина %.0f мм\nX = %.0f мм (%.0f%% LOA от кормы)"
              % (m["beam_deck_mm"], x_b, m["beam_deck_x_pct_loa"])},
        {"p": transom[-1], "d": [-30, 30], "c": "--c-projected",
         "t": "Подошва транца — кормовая оконечность\nна %.0f мм выше КВЛ; транец с обратным\nнаклоном %.1f°"
              % (m["transom_foot_above_dwl_mm"], m["transom_rake_deg"])},
        {"p": transom[0], "d": [-34, -40], "c": "--c-projected",
         "t": "Палубный угол транца\nвпереди кормовой оконечности на %.0f мм"
              % m["transom_deck_overhang_mm"]},
        {"p": stem[0], "d": [30, -30], "c": "--c-measured",
         "t": "Топ форштевня\nнадводный борт %.0f мм, завал вперёд %.1f°"
              % (m["freeboard_fwd_mm"], m["stem_rake_deg"])},
        {"p": [m["lwl_fwd_x_mm"], 0, 0], "d": [26, 26], "c": "--c-measured",
         "t": "Нос выходит на КВЛ здесь\nLWL = %.0f мм" % m["lwl_mm"]},
        {"p": [m["lwl_aft_x_mm"], 0, 0], "d": [-26, 26], "c": "--c-measured",
         "t": "Корма выходит на КВЛ здесь\nкормовой свес над водой %.0f мм"
              % m["lwl_aft_x_mm"]},
        {"p": [m["loa_mm"] * 0.45, 0, -m["draft_hull_spec_mm"] * 0.5],
         "d": [0, 58], "c": "--c-gap",
         "t": "Здесь на чертеже нет ничего.\nОсадка корпусом 150 мм и объём %.3f м³ известны,\nформа — нет. Это задача Ф2–Ф3."
              % m["volume_target_sea_m3"]},
    ]


def hull_notes(hl):
    h = hl["hydrostatics"]
    xm = h["midship_x_mm"]
    return [
        {"p": [xm, h["bwl_mm"] / 2.0, 0.0], "d": [30, 30], "c": "--c-hull",
         "t": "Ширина по КВЛ %.0f мм\nмидель %.3f м², Cm = %.2f"
              % (h["bwl_mm"], h["midship_area_m2"], h["Cm"])},
        {"p": [h["lcb_mm"], 0.0, -h["draft_canoe_mm"] * 0.45], "d": [-30, 40],
         "c": "--c-hull",
         "t": "ЦВ на %.1f%% LWL от кормы\n%.0f кг при осадке корпусом %.0f мм"
              % (h["lcb_pct_lwl_from_aft"], h["displacement_kg"],
                 h["draft_canoe_mm"])},
    ]


def main():
    out = os.path.join(ROOT, "out")
    fr = json.load(open(os.path.join(out, "frame.json")))
    dr = json.load(open(os.path.join(out, "drawing.json")))

    groups = dict((k, v) for k, v in dr["groups"].items() if k not in SKIP_GROUPS)
    for g in groups.values():
        for p in g["paths"]:
            p["pts"] = [[round(c, 1) for c in q] for q in p["pts"]]

    rows = [[label, ("%.*f" % (prec, fr["metrics"][key])), unit]
            for key, label, unit, prec in frame.METRIC_LABELS]

    payload = {"frame": fr, "draw": groups, "notes": build_notes(fr),
               "metricRows": rows}

    hull_path = os.path.join(out, "hull.json")
    if os.path.exists(hull_path):
        hl = json.load(open(hull_path))
        h = hl["hydrostatics"]
        payload["hull"] = {
            "mesh": hl["mesh"],
            "stations": [s["points"] for s in hl["stations"]],
            "keel_line": [[round(c, 1) for c in p] for p in hl["keel_line"]],
            "chine_line": hl.get("chine_line", []),
            "deadrise_factor": hl["deadrise_factor"],
            "hydroRows": [[label, "%.*f" % (prec, h[key]), unit]
                          for key, label, unit, prec in HYDRO_ROWS],
        }
        payload["notes"] += hull_notes(hl)

    tpl = open(os.path.join(ROOT, "viewer", "template.html")).read()
    js = open(os.path.join(ROOT, "viewer", "renderer.js")).read()
    html = tpl.replace("/*__DATA__*/ null",
                       json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    html = html.replace("/*__RENDERER__*/", js)

    dst = os.path.join(ROOT, "viewer", "index.html")
    with open(dst, "w") as f:
        f.write(html)
    print("%s — %.0f КБ" % (os.path.relpath(dst, ROOT), os.path.getsize(dst) / 1024))


if __name__ == "__main__":
    main()
