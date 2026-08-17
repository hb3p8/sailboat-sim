# -*- coding: utf-8 -*-
"""Что именно показывает HTML-отчёт: разделы, порядок, формулировки.

Отделено и от сбора чисел (`payload.py`), и от рисования (`htmlreport.py`).
Здесь принимаются решения, которые нельзя принять ни там, ни там: какую
величину считать главной для семейства, с чем её сравнивать и что означает
расхождение. Такое решение требует знать физику, а не формат графика.

Правило, которое держит этот файл честным: раздел, для которого нет данных, не
исчезает, а появляется с объяснением, чего не хватает. Отчёт, из которого
молча пропал неудобный случай, хуже отсутствующего.
"""

import os

from . import convergence as conv


def _tile(k, v, unit=None, d=3):
    if v is None:
        return [k, "—", unit]
    if isinstance(v, str):
        return [k, v, unit]
    if d == 0:
        # Счётные величины — числом с разделителем разрядов. «3.00e+05» вместо
        # «299 566» в графе «ячеек» выглядит как оценка, а это точное число.
        return [k, "{:,}".format(int(round(v))).replace(",", " "), unit]
    if abs(v) >= 1e5 or (v != 0 and abs(v) < 1e-3):
        return [k, "%.2e" % v, unit]
    return [k, ("%%.%df" % d) % v, unit]


def overview(meta, blocks):
    return {"title": "Что посчитано и на чём", "blocks": blocks}


# --- этап 0: плоский профиль --------------------------------------------------

def verification_section(cases, conv_rows):
    """NACA 0012. Проверяется не лодка, а метод: сетка, оси, постобработка."""
    blocks = [{
        "kind": "text",
        "html": ("Плоское сечение NACA 0012 на числе Рейнольдса 6·10⁶ — "
                 "канонический случай, на котором проверяется сам метод, а не "
                 "лодка. Пока он не сойдётся с опубликованными данными, "
                 "результаты на обводах SV20 эталонными не считаются (§5, "
                 "этап 0).")}]
    if not cases:
        blocks.append({"kind": "note", "html":
                       "Ни один случай тройки не посчитан — раздел пуст."})
        return {"title": "Этап 0: метод на плоском профиле", "blocks": blocks,
                "badge": "не закрыт", "badgeKind": "bad"}

    blocks.append({"kind": "note", "html":
                   "<b>Этап 0 не закрыт.</b> Опубликованный набор NASA "
                   "Turbulence Modeling Resource и верификационный случай "
                   "OpenFOAM в этой сессии оказались недоступны (переезд сайта "
                   "и 403), поэтому сверять полученные Cl и Cd не с чем. "
                   "Числа ниже — это ЧТО ПОСЧИТАЛОСЬ, а не что подтвердилось. "
                   "Пока сверка не сделана, всё, что дальше, имеет статус "
                   "«посчитано», а не «проверено»."})

    for c in cases:
        d = c["derived"]
        blocks.append({"kind": "h3", "html":
                       "%s — %s, %s ячеек"
                       % (c["case_id"], c["level"],
                          "{:,}".format(c["cells"] or 0).replace(",", " "))})
        blocks.append({"kind": "tiles", "items": [
            _tile("Cl (по потоку)", d.get("Cl"), None, 4),
            _tile("Cd (по потоку)", d.get("Cd"), None, 5),
            _tile("Cx (связанные)", d.get("Cx"), None, 5),
            _tile("ячеек", c["cells"], None, 0),
            _tile("y+ макс.", (c.get("yplus") or {}).get("max"), None, 1),
            _tile("дрейф Fy на окне", c["force"]["Fy"]["drift"], "σ", 2),
        ]})
        if c.get("history"):
            blocks.append({
                "kind": "convergence", "hist": c["history"],
                "keys": ["Rt", "Fy"],
                "window": c["force"]["Fx"]["window"][0],
                "title": "Выход сил на плато",
                "text": ("Сошедшиеся невязки не означают сошедшейся силы (§4.3). "
                         "Полоса — размах внутри окна прореживания: у "
                         "сошедшегося случая она схлопывается в линию."),
                "caption": ("Затенена область, по которой берётся среднее. "
                            "Наведите курсор, чтобы увидеть значение на "
                            "итерации.")})
        if c.get("residuals"):
            blocks.append({"kind": "residuals", "res": c["residuals"],
                           "title": "Невязки",
                           "caption": ("Полулогарифмическая шкала. Невязка по "
                                       "Uz у плоского слоя нормируется на поле, "
                                       "которое обязано быть нулевым, поэтому "
                                       "она не падает — и не должна.")})
        if c.get("slices", {}) and c["slices"].get("sliceSpan", {}).get("nx"):
            blocks.append({"kind": "field", "slice": c["slices"]["sliceSpan"],
                           "title": "Поле в плоскости сечения",
                           "caption": ("Частицы несёт то же поле, что нарисовано "
                                       "под ними. Белое — внутри тела, там "
                                       "значений нет. Переключатель меняет "
                                       "подложку на давление.")})
    for name, r in conv_rows:
        blocks.append(mesh_block(name, r))
    return {"title": "Этап 0: метод на плоском профиле", "blocks": blocks,
            "badge": "не закрыт", "badgeKind": "bad"}


def mesh_block(name, r):
    g = r["gate"]
    rows = [["coarse", r["refinement"]["cells"][0], r["values"]["coarse"]],
            ["medium", r["refinement"]["cells"][1], r["values"]["medium"]],
            ["fine", r["refinement"]["cells"][2], r["values"]["fine"]],
            ["Ричардсон h→0", "—", r["extrapolated"]]]
    return {
        "kind": "mesh", "result": r, "quantity": name.split(" / ")[-1],
        "title": "Тройка сеток: " + name,
        "text": ("Разность medium→fine %.2f%%, порог %s %.0f%%. "
                 "Наблюдаемый порядок %s. GCI тонкой сетки %s. Итог: %s."
                 % (r["rel_medium_fine"] * 100, g["regime"], g["limit"] * 100,
                    "—" if r["order"] is None else "%.2f" % r["order"],
                    "—" if r["gci_fine"] is None
                    else "%.2f%%" % (r["gci_fine"] * 100),
                    "прошло" if g["passed"] else "; ".join(g["problems"]))),
        "caption": ("По горизонтали — относительный размер ячейки. Пунктир — "
                    "экстраполяция Ричардсона на бесконечно мелкую сетку; "
                    "расстояние до неё и есть оценка сеточной погрешности."),
        "table": {"head": ["сетка", "ячеек", "значение"], "rows": rows},
    }


# --- киль ---------------------------------------------------------------------

def keel_section(cases, sim_curve, sim_points, conv_rows):
    blocks = [{
        "kind": "text",
        "html": ("Изолированное перо киля с бульбом, скорость 2 м/с, корень на "
                 "плоскости симметрии. Зеркало даёт удлинение вдвое против "
                 "геометрического — это верхняя граница эффекта концевой шайбы "
                 "от днища. В симуляторе тот же эффект учтён множителем 1.5 к "
                 "удлинению (<code>effective_ar</code>), и сравнение показывает, "
                 "насколько этот множитель верен.")}]
    if not cases:
        blocks.append({"kind": "note", "html":
                       "Ни одной точки поляры не посчитано."})
        return {"title": "Киль: поляра пера", "blocks": blocks}

    pts = []
    for c in sorted(cases, key=lambda x: x["condition"].get("leeway_deg", 0)):
        a = c["condition"].get("leeway_deg", 0.0)
        pts.append({"x": a, "y": c["derived"]["Cl"], "label": c["case_id"],
                    "sim": sim_points.get(round(a, 3))})
    blocks.append({
        "kind": "polar", "pts": pts, "curve": sim_curve,
        "xlab": "угол атаки, °", "ylab": "Cl", "opt": {"yd": 2},
        "title": "Подъёмная сила по углу атаки",
        "text": ("Синие точки — CFD, оранжевая кривая — <code>foilCoeffs</code> "
                 "симулятора на его собственном эффективном удлинении. "
                 "Расхождение по НАКЛОНУ означает неверное удлинение; "
                 "расхождение по срыву — неверный угол срыва."),
        "caption": "Наведите курсор на точку, чтобы увидеть оба значения.",
        "table": {"head": ["угол, °", "Cl (CFD)", "Cl (симулятор)", "Δ, %"],
                  "rows": [[p["x"], p["y"], p["sim"],
                            None if not p["sim"] else
                            100 * (p["y"] - p["sim"]) / abs(p["sim"])]
                           for p in pts]},
    })
    ref = cases[0]
    if ref.get("slices", {}) and ref["slices"].get("sliceSpan", {}).get("nx"):
        blocks.append({"kind": "field", "slice": ref["slices"]["sliceSpan"],
                       "title": "Горизонтальный разрез на середине размаха",
                       "caption": ("Случай %s. Виден скос потока за пером — то "
                                   "самое, из-за чего руль работает не на "
                                   "геометрическом угле." % ref["case_id"])})
    if ref.get("slices", {}) and ref["slices"].get("sliceCentre", {}).get("nx"):
        blocks.append({"kind": "field", "slice": ref["slices"]["sliceCentre"],
                       "title": "Диаметральная плоскость",
                       "caption": ("Тот же случай сбоку: перо, бульб и их след. "
                                   "Верх картинки — плоскость симметрии, то есть "
                                   "днище.")})
    if ref.get("history"):
        blocks.append({"kind": "convergence", "hist": ref["history"],
                       "keys": ["Rt", "Fy"],
                       "window": ref["force"]["Fx"]["window"][0],
                       "title": "Выход сил на плато: " + ref["case_id"],
                       "caption": "Полоса — размах внутри окна прореживания."})
    for name, r in conv_rows:
        blocks.append(mesh_block(name, r))
    return {"title": "Киль: поляра пера", "blocks": blocks}


# --- корпус --------------------------------------------------------------------

def hull_section(cases, rows, conv_rows, kind):
    title = ("Корпус: сопротивление двойным телом" if kind == "res"
             else "Корпус: боковая сила и рыскательный момент")
    blocks = [{
        "kind": "text",
        "html": ("Корпус считается ДВОЙНЫМ ТЕЛОМ: плоскость симметрии по КВЛ, "
                 "надводная часть вне домена. Волнообразования в такой "
                 "постановке нет вовсе.")
        if kind == "res" else
        ("Тот же двойной корпус под дрейфом. Проверяются самые эмпирические "
         "места модели — <code>HULL_CROSSFLOW_CD</code> и "
         "<code>HULL_HEEL_YAW</code>.")}]
    if kind == "res":
        blocks.append({"kind": "note", "html":
                       "<b>Что это НЕ проверяет.</b> Волновое сопротивление. "
                       "Таблица <code>hullResistance</code> симулятора включает "
                       "и его, поэтому прямое сравнение полных чисел бессмысленно "
                       "— сравнивать можно только вязкую часть с сопротивлением "
                       "формы. Волновую часть проверяет постановка со свободной "
                       "поверхностью, а она на этой машине не считается."})
    if not cases:
        blocks.append({"kind": "note", "html": "Ни одного случая не посчитано."})
        return {"title": title, "blocks": blocks}

    for c in cases:
        d = c["derived"]
        items = [_tile("скорость", c["condition"]["speed_ms"], "м/с", 2),
                 _tile("дрейф", c["condition"].get("leeway_deg", 0.0), "°", 1),
                 _tile("Rt (связ.)", d["Rt_n"], "Н", 2),
                 _tile("Fy", d["Fy"], "Н", 2),
                 _tile("Mz", d["Mz"], "Н·м", 1),
                 _tile("ячеек", c["cells"], None, 0)]
        if c.get("decomposition"):
            items.insert(3, _tile("давление", c["decomposition"]["pressure_n"],
                                  "Н", 2))
            items.insert(4, _tile("трение", c["decomposition"]["viscous_n"],
                                  "Н", 2))
        blocks.append({"kind": "h3", "html": c["case_id"]})
        blocks.append({"kind": "tiles", "items": items})
    if rows:
        blocks.append({
            "kind": "bars", "rows": rows,
            "title": "CFD против симулятора",
            "text": ("Столбики — модули величин; справа относительная разность. "
                     "Знак сверяется отдельно, по таблице."),
            "caption": "Синий — CFD, оранжевый — realtime-модель.",
            "table": {"head": ["величина", "CFD", "симулятор", "Δ, %"],
                      "rows": [[r["label"], r["cfd"], r["sim"],
                                None if r["sim"] == 0 else
                                100 * (r["cfd"] - r["sim"]) / abs(r["sim"])]
                               for r in rows]}})
    ref = cases[0]
    for key, cap in (("sliceSpan", "Горизонтальный разрез на половине осадки"),
                     ("sliceCentre", "Диаметральная плоскость")):
        s = (ref.get("slices") or {}).get(key)
        if s and s.get("nx"):
            blocks.append({"kind": "field", "slice": s, "title": cap,
                           "caption": "Случай %s." % ref["case_id"]})
    if ref.get("history"):
        blocks.append({"kind": "convergence", "hist": ref["history"],
                       "keys": ["Rt", "Rp", "Rv"],
                       "window": ref["force"]["Fx"]["window"][0],
                       "title": "Сопротивление и его составляющие",
                       "text": ("Rp — от давления, Rv — от трения. Их сумма и "
                                "есть Rt. Разложение — единственное, ради чего "
                                "стоит считать корпус двойным телом: полная "
                                "таблица симулятора его не даёт."),
                       "caption": "Затенено окно усреднения."})
    for name, r in conv_rows:
        blocks.append(mesh_block(name, r))
    return {"title": title, "blocks": blocks}


def mirror_section(pair):
    """Зеркальная пара по дрейфу — проверка знаков на настоящей геометрии."""
    if len(pair) != 2:
        return None
    a, b = pair
    da, db = a["derived"], b["derived"]
    rows = [["Rt, Н", da["Rt_n"], db["Rt_n"], "должны совпасть"],
            ["Fy, Н", da["Fy"], db["Fy"], "должны быть противоположны"],
            ["Mz, Н·м", da["Mz"], db["Mz"], "должны быть противоположны"],
            ["Fz, Н", da["Fz"], db["Fz"], "должны совпасть"]]
    same = abs(da["Rt_n"] - db["Rt_n"]) / max(abs(da["Rt_n"]), 1e-9)
    opp = (abs(da["Fy"] + db["Fy"]) / max(abs(da["Fy"]), 1e-9))
    ok = same < 0.02 and opp < 0.05
    return {"title": "Зеркальная пара по дрейфу",
            "badge": "знаки сходятся" if ok else "знаки НЕ сходятся",
            "badgeKind": "ok" if ok else "bad",
            "blocks": [
                {"kind": "text", "html":
                 ("Два случая отличаются ровно знаком дрейфа. §3.3 требует, "
                  "чтобы при этом продольное сопротивление сохранилось, а "
                  "боковая сила и рыскательный момент поменяли знак. Это "
                  "проверка не физики, а того, что оси, геометрия и "
                  "постобработка не переставили компоненты местами — ошибка, "
                  "которая иначе всплывает через неделю необъяснимым "
                  "расхождением с симулятором.")},
                {"kind": "tiles", "items": [
                    _tile("расхождение Rt", same * 100, "%", 2),
                    _tile("невязка антисимметрии Fy", opp * 100, "%", 2)]},
                {"kind": "table", "open": True,
                 "head": ["величина", a["case_id"], b["case_id"], "ожидание"],
                 "rows": rows}]}


def limits_section(extra):
    items = [
        "Волнового сопротивления нет ни в одном посчитанном случае: все они "
        "либо однофазные, либо двойное тело. Волновая часть "
        "<code>hullResistance</code> здесь не проверена никак.",
        "Свободных heave и pitch нет — корпус закреплён, всплытие и дифферент "
        "не считались.",
        "Крена нет ни в одном посчитанном случае.",
        "Паруса не считались вовсе: выгрузки их формы из "
        "<code>sim/membrane.js</code> пока не существует.",
        "Опубликованные данные для NACA 0012 в этой сессии недоступны, поэтому "
        "этап 0 не закрыт и слово «проверено» ни к одному числу не относится.",
        "Пристеночные функции, одна модель турбулентности, один размер домена: "
        "чувствительность к постановке (§4.4) не проверялась.",
    ]
    items.extend(extra or [])
    return {"title": "Границы: чего эти расчёты НЕ показывают",
            "blocks": [{"kind": "text", "html":
                        "Список нужен затем, чтобы отчёт нельзя было прочитать "
                        "шире, чем он есть."},
                       {"kind": "table", "open": True,
                        "head": ["не проверено"],
                        "rows": [[i] for i in items]}]}
