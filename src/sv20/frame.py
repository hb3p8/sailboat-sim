"""Ф1: жёсткий каркас — то, что с чертежа снимается, а не додумывается.

Каждая кривая помечена уровнем достоверности:

    measured  — снята с чертежа напрямую, погрешность = погрешность масштаба
    derived   — получена совмещением двух видов (линия борта: X,Y сверху + Z сбоку)
    inferred  — достроена по здравому смыслу, на чертеже не проведена
    projected — снята с чертежа, но это проекция: одна координата неизвестна

Всё, чего на чертеже нет, перечислено в `gaps` — это вход для Ф2, а не то,
что можно молча нарисовать.
"""

import math


# Подписи и точность вывода — общие для отчёта и просмотрщика.
METRIC_LABELS = [
    ("loa_mm", "Длина наибольшая", "мм", 1),
    ("lwl_mm", "Длина по КВЛ", "мм", 1),
    ("beam_deck_mm", "Ширина по палубе", "мм", 1),
    ("beam_deck_x_pct_loa", "Наибольшая ширина, от кормы", "% LOA", 1),
    ("beam_transom_deck_mm", "Ширина транца по палубе", "мм", 1),
    ("freeboard_fwd_mm", "Надводный борт в носу", "мм", 1),
    ("freeboard_aft_mm", "Надводный борт в корме", "мм", 1),
    ("sheer_rise_mm", "Подъём линии борта к носу", "мм", 1),
    ("sheer_profile_points", "Линия борта сбоку задана точками", "шт", 0),
    ("transom_rake_deg", "Наклон транца (плюс — обратный)", "град", 2),
    ("transom_curvature_mm", "Кромка транца: отклонение от прямой", "мм", 1),
    ("transom_foot_above_dwl_mm", "Подошва транца над КВЛ", "мм", 1),
    ("transom_deck_overhang_mm", "Палубный угол транца впереди КО", "мм", 1),
    ("stem_rake_deg", "Наклон форштевня вперёд", "град", 2),
    ("volume_target_sea_m3", "Целевой объём (550 кг, морская)", "м³", 3),
    ("paths_below_dwl_in_hull_span", "Путей ниже КВЛ в габарите корпуса", "шт", 0),
    ("paths_excluded_from_scan", "Из них исключено (штамп, рамка)", "шт", 0),
]


def _lerp_z(sheer_profile, datum):
    """Z линии борта как функция X (на виде сбоку она прямая, но не полагаемся)."""
    pts = sorted(datum.profile(p) for p in sheer_profile.points)

    def z_at(x):
        if x <= pts[0][0]:
            return pts[0][1]
        if x >= pts[-1][0]:
            return pts[-1][1]
        for i in range(len(pts) - 1):
            x0, z0 = pts[i]
            x1, z1 = pts[i + 1]
            if x0 <= x <= x1:
                t = 0.0 if x1 == x0 else (x - x0) / (x1 - x0)
                return z0 + t * (z1 - z0)
        return pts[-1][1]

    return z_at, pts


def _straightness(pts):
    """Максимальное отклонение полилинии от хорды, мм."""
    (x0, z0), (x1, z1) = pts[0], pts[-1]
    dx, dz = x1 - x0, z1 - z0
    n = math.hypot(dx, dz)
    if n == 0:
        return 0.0
    return max(abs((p[0] - x0) * dz - (p[1] - z0) * dx) / n for p in pts)


def _scan_below_dwl(subpaths, datum, loa, title_box, media_box):
    """Найти пути, заходящие ниже КВЛ в габарите корпуса.

    Из перебора исключаются штамп и рамка листа: они лежат внизу страницы и
    попадают под КВЛ чисто геометрически, не имея отношения к корпусу.
    Возвращает (список нарушителей, число исключённых).
    """
    tx0, ty0, tx1, ty1 = title_box
    sheet_w = 0.9 * (media_box[2] - media_box[0])
    hits, excluded = [], 0
    for sp in subpaths:
        bx0, by0, bx1, by1 = sp.bbox
        if bx0 >= tx0 and bx1 <= tx1 and by0 >= ty0 and by1 <= ty1:
            excluded += 1
            continue
        if (bx1 - bx0) >= sheet_w:      # рамка листа
            excluded += 1
            continue
        if by0 >= datum.y_dwl:
            continue
        if any(datum.Z(p[1]) < -1.0 and -50.0 <= datum.X(p[0]) <= loa + 50.0
               for p in sp.points):
            hits.append({"bbox_mm": [round(datum.X(bx0), 1), round(datum.Z(by0), 1),
                                     round(datum.X(bx1), 1), round(datum.Z(by1), 1)],
                         "points": len(sp.points)})
    return hits, excluded


def build(subpaths, datum, key, spec, title_box, media_box):
    deck = key["deck_starboard"]
    sheer_profile = key["sheer_profile"]
    outline = key["profile_outline"]

    z_at, sheer_pts_2d = _lerp_z(sheer_profile, datum)

    # --- линия борта в 3D: X,Y с вида сверху, Z с вида сбоку -----------------
    plan_xy = sorted(datum.plan(p) for p in deck.points)
    sheer_stbd = [[x, y, z_at(x)] for x, y in plan_xy]
    sheer_port = [[x, -y, z] for x, y, z in sheer_stbd]

    # --- оконечности в ДП ----------------------------------------------------
    def chain2d(*roles):
        out = []
        for role in roles:
            for p in outline[role]:
                q = datum.profile(p)
                if not out or abs(q[0] - out[-1][0]) > 1e-9 or abs(q[1] - out[-1][1]) > 1e-9:
                    out.append(q)
        return out

    stem_xz = chain2d("stem", "forefoot")          # от топа форштевня вниз до КВЛ
    transom_xz = chain2d("transom")                # от палубного угла вниз до подошвы
    run_aft_xz = chain2d("run_aft")                # подошва транца вперёд до КВЛ

    # --- достроенное ---------------------------------------------------------
    x_deck_aft = plan_xy[0][0]
    y_deck_aft = plan_xy[0][1]
    z_deck_aft = sheer_stbd[0][2]
    transom_top = [[x_deck_aft, -y_deck_aft, z_deck_aft],
                   [x_deck_aft, y_deck_aft, z_deck_aft]]

    curves = [
        {"name": "sheer_stbd", "label": "Линия борта, правый борт",
         "confidence": "derived", "points": sheer_stbd,
         "note": "X,Y сняты с вида сверху, Z — с вида сбоку по той же абсциссе"},
        {"name": "sheer_port", "label": "Линия борта, левый борт",
         "confidence": "derived", "points": sheer_port,
         "note": "зеркало правого борта; невязка зеркальности на чертеже — доли миллиметра"},
        {"name": "stem", "label": "Форштевень со скулой",
         "confidence": "measured", "points": [[x, 0.0, z] for x, z in stem_xz],
         "note": "лежит в ДП; ниже КВЛ не проведён"},
        {"name": "transom", "label": "Кромка транца (проекция)",
         "confidence": "projected", "points": [[x, 0.0, z] for x, z in transom_xz],
         "note": "снят силуэт в плоскости XZ; полуширота Y вдоль кромки неизвестна"},
        {"name": "run_aft", "label": "Днище в ДП, надводная часть",
         "confidence": "measured", "points": [[x, 0.0, z] for x, z in run_aft_xz],
         "note": "batox Y=0 от подошвы транца вперёд до выхода на КВЛ"},
        {"name": "transom_top", "label": "Верхняя кромка транца",
         "confidence": "inferred", "points": transom_top,
         "note": "на чертеже не проведена; достроена прямой, погибь палубы не учтена"},
    ]

    # --- метрики -------------------------------------------------------------
    loa = datum.X(datum.x_fp)
    ys = [p[1] for p in plan_xy]
    bmax_half = max(ys)
    x_bmax = plan_xy[ys.index(bmax_half)][0]
    x_wl_aft = run_aft_xz[-1][0]
    x_wl_fwd = stem_xz[-1][0]

    tr_top, tr_foot = transom_xz[0], transom_xz[-1]
    st_top = datum.profile(outline["stem"][0])
    st_foot = datum.profile(outline["stem"][-1])

    metrics = {
        "loa_mm": loa,
        "lwl_mm": x_wl_fwd - x_wl_aft,
        "lwl_aft_x_mm": x_wl_aft,
        "lwl_fwd_x_mm": x_wl_fwd,
        "beam_deck_mm": 2 * bmax_half,
        "beam_deck_x_mm": x_bmax,
        "beam_deck_x_pct_loa": 100.0 * x_bmax / loa,
        "beam_transom_deck_mm": 2 * y_deck_aft,
        "freeboard_fwd_mm": sheer_stbd[-1][2],
        "freeboard_aft_mm": z_deck_aft,
        "sheer_rise_mm": sheer_stbd[-1][2] - z_deck_aft,
        "sheer_profile_points": len(sheer_pts_2d),
        "transom_rake_deg": math.degrees(math.atan2(tr_top[0] - tr_foot[0],
                                                    tr_top[1] - tr_foot[1])),
        "transom_curvature_mm": _straightness(transom_xz),
        "transom_foot_above_dwl_mm": tr_foot[1],
        "transom_deck_overhang_mm": x_deck_aft,
        "stem_rake_deg": math.degrees(math.atan2(st_top[0] - st_foot[0],
                                                 st_top[1] - st_foot[1])),
        "deck_aft_x_mm": x_deck_aft,
        "displacement_target_kg": spec["displacement_kg"],
        "volume_target_sea_m3": spec["displacement_kg"] / 1025.0,
        "volume_target_fresh_m3": spec["displacement_kg"] / 1000.0,
        "draft_hull_spec_mm": spec["draft_hull_mm"],
    }

    below, excluded = _scan_below_dwl(subpaths, datum, loa, title_box, media_box)
    metrics["paths_below_dwl_in_hull_span"] = len(below)
    metrics["paths_excluded_from_scan"] = excluded

    gaps = [
        {"what": "Обводы ниже КВЛ",
         "detail": "перебраны все %d полилиний листа; ниже КВЛ в габарите корпуса "
                   "не проходит ни одна (%d исключены как штамп и рамка листа, "
                   "осталось %d)" % (len(subpaths), excluded, len(below)),
         "blocks": "форма шпангоутов, килеватость, скула, развал бортов"},
        {"what": "Теоретический чертёж",
         "detail": "шпангоутов, батоксов и ватерлиний на листе нет вовсе",
         "blocks": "кривая площадей, положение ЦВ, гидростатика"},
        {"what": "Полуширота кромки транца",
         "detail": "силуэт транца снят точно, но Y вдоль кромки не определён; "
                   "известны только концы: Y=%.0f мм у палубы и Y=0 у подошвы"
                   % y_deck_aft,
         "blocks": "форма кормового шпангоута"},
        {"what": "Киль",
         "detail": "перо, бульб и колодец на виде сбоку не показаны; "
                   "колодец на виде сверху однозначно не опознан",
         "blocks": "положение и форма балласта, боковая площадь"},
        {"what": "Руль",
         "detail": "навесной на транце, но нарисован в поднятом положении — "
                   "профиль пера ниже КВЛ отсутствует",
         "blocks": "площадь и форма пера, ось баллера"},
        {"what": "Погибь палубы",
         "detail": "линия ДП палубы на виде сбоку есть, но её интерпретация "
                   "(крыша рубки / комингс / погибь) не подтверждена",
         "blocks": "верхняя кромка транца, объём надводной части"},
    ]

    return {"curves": curves, "metrics": metrics, "gaps": gaps}
