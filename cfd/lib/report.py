# -*- coding: utf-8 -*-
"""Сборка отчётов и правило статуса (§4.5, §6).

Статус ставится правилом, а не глазом по цвету графика. Это записанное
требование §6, и держится оно тем, что правило целиком лежит в одной функции
ниже — вместе с порогами, которые в неё входят.

Правило повторяет §4.5. Расхождение объявляется поводом менять realtime-модель
только когда оно больше объединённой неопределённости И повторяется в
нескольких соседних режимах одним знаком. Одиночная точка даёт `investigate` —
то есть «иди разберись», а не «правь формулу».
"""

import math

# Сколько соседних точек одного семейства должны разойтись одинаково, чтобы
# расхождение перестало быть одиночным (§4.5.3).
NEIGHBOURS = 3


def combined_uncertainty(cfd_unc, sim_unc=0.0, floor=0.0):
    """Квадратичная сумма неопределённостей и абсолютный порог снизу.

    Порог снизу нужен для величин, которые около нуля: боковая сила на нулевом
    дрейфе имеет нулевую относительную неопределённость и любое численное
    дребезжание объявляет расхождением.
    """
    return max(floor, math.sqrt(cfd_unc ** 2 + sim_unc ** 2))


def status_point(cfd, sim, uncertainty):
    """Статус одной точки без учёта соседей: `ok` или `investigate`."""
    d = cfd - sim
    if abs(d) <= uncertainty:
        return "ok", d
    return "investigate", d


def status_family(points):
    """Поднять `investigate` до `model-change` там, где расхождение системное.

    Соседство — по КООРДИНАТАМ режима, а не по имени величины (§13.5). Прежняя
    версия поднимала любые три расхождения одного знака с одинаковым именем;
    три разрозненных случая — разная геометрия, разные скорости — выполняли
    формальное условие, не образуя тренда. Теперь соседями считаются точки
    одной величины и одного семейства, у которых условия различаются РОВНО
    ОДНИМ числовым полем; вдоль этой оси они сортируются, и до `model-change`
    поднимается только цепочка из NEIGHBOURS подряд идущих расхождений одного
    знака. Точка `ok` между ними цепочку рвёт — так и задумано: это уже не
    системный уход, а два отдельных вопроса.
    """
    by_q = {}
    for p in points:
        by_q.setdefault((p.get("family"), p["quantity"]), []).append(p)
    for _key, group in by_q.items():
        if len(group) < NEIGHBOURS:
            continue
        # Ось: единственное числовое поле условий, по которому точки различаются.
        keys = set()
        for p in group:
            keys.update(k for k, v in p.get("condition", {}).items()
                        if isinstance(v, (int, float)))
        axes = [k for k in sorted(keys)
                if len({p.get("condition", {}).get(k) for p in group}) > 1]
        if len(axes) != 1:
            continue
        ax_key = axes[0]
        chain = sorted((p for p in group
                        if p.get("condition", {}).get(ax_key) is not None),
                       key=lambda p: p["condition"][ax_key])
        run = []
        for p in chain + [None]:
            same = (p is not None and p["status"] == "investigate" and
                    (not run or (p["delta"] > 0) == (run[0]["delta"] > 0)))
            if same:
                run.append(p)
                continue
            if len(run) >= NEIGHBOURS:
                for r in run:
                    r["status"] = "model-change"
            run = [p] if p is not None and p["status"] == "investigate" else []
    return points


# --- Markdown -----------------------------------------------------------------

def table(header, rows):
    out = ["| " + " | ".join(header) + " |",
           "|" + "|".join(["---"] * len(header)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(_cell(c) for c in r) + " |")
    return "\n".join(out)


def _cell(v):
    if v is None:
        return "—"
    if isinstance(v, float):
        if v == 0:
            return "0"
        if abs(v) >= 1e4 or abs(v) < 1e-3:
            return "%.3e" % v
        return "%.4g" % v
    return str(v)


def convergence_section(name, result):
    g = result["gate"]
    lines = ["### %s" % name, "",
             table(["величина", "coarse", "medium", "fine"],
                   [["значение", result["values"]["coarse"],
                     result["values"]["medium"], result["values"]["fine"]],
                    ["ячеек"] + list(result["refinement"]["cells"])]),
             "",
             table(["показатель", "значение"],
                   [["разность medium→fine", "%.3f%%" % (result["rel_medium_fine"] * 100)],
                    ["разность coarse→medium", "%.3f%%" % (result["rel_coarse_medium"] * 100)],
                    ["наблюдаемый порядок", result["order"]],
                    ["экстраполяция Ричардсона", result["extrapolated"]],
                    ["GCI тонкой сетки", None if result["gci_fine"] is None
                     else "%.3f%%" % (result["gci_fine"] * 100)],
                    ["монотонность", "да" if result["monotonic"] else "нет"],
                    ["ворота", "%s, порог %.0f%%" % (g["regime"], g["limit"] * 100)],
                    ["итог", "прошло" if g["passed"] else "; ".join(g["problems"])]]),
             ""]
    return "\n".join(lines)


def compare_section(family, rows):
    """Таблица §6: CFD, симулятор, разность, неопределённость, статус."""
    head = ["случай", "величина", "CFD", "симулятор", "Δ", "Δ, %",
            "неопр. CFD", "статус"]
    return "\n".join(["### %s" % family, "", table(head, rows), ""])


def document(title, intro, sections):
    parts = ["# %s" % title, "", intro, ""]
    parts.extend(sections)
    parts.append("")
    parts.append("---")
    parts.append("")
    parts.append("Отчёт собран `cfd/scripts/`; правила статуса — "
                 "docs/cfd-validation.md §4.5 и §6.")
    return "\n".join(parts) + "\n"
