# -*- coding: utf-8 -*-
"""Таблица поляры против своих же данных: .venv/bin/python tests/polar.test.py

Таблица собрана из опыта, но собрана не целиком из него: часть кривых измерена, а
часть достроена правилом по измеренным величинам. Батарея проверяет две разные
вещи, и путать их нельзя.

Первое — что таблица не переврала измеренное. Там, где кривая снята с фигуры
целиком, таблица обязана её воспроизвести.

Второе, и оно важнее, — что ПРАВИЛО достройки верно. Проверяется так: правило
применяется насильно к тем пузам, где измеренная кривая есть, но её прячут, и
результат сверяется с ней. Если правило врёт там, где есть чем проверить, ему
нечего делать там, где проверить нечем.
"""

import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

from sv20.polar import (CD_MIN, CL_SLOPE, build_table,  # noqa: E402
                        cd_curve, cl_curve)

failures = 0
REF = json.load(open(os.path.join(ROOT, "data/section/wallis_arl74.json"), encoding="utf-8"))


def check(name, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(("  ok   " if ok else "  ПЛОХО") + "  " + name + ("   " + detail if detail else ""))


def measured(cam):
    row = REF["Re6e5"]["пузо"]["%.2f" % cam]
    return [(float(a), float(c)) for a, c in zip(REF["Re6e5"]["alpha_deg"], row)
            if c is not None]


def at(table, cam, a):
    """Значение из таблицы линейной интерполяцией по обеим осям."""
    ci = table["camber"].index(cam)
    xs, ys = table["alpha_deg"], table["cl"][ci]
    for i in range(1, len(xs)):
        if a <= xs[i]:
            t = (a - xs[i - 1]) / (xs[i] - xs[i - 1])
            return ys[i - 1] + t * (ys[i] - ys[i - 1])
    return ys[-1]


T = build_table()

# --- таблица против измеренного -----------------------------------------------
print("\nТаблица против измеренных кривых (пузо 4/6/8%, Re = 6·10⁵):\n")
print("    пузо   точек   худшее   среднее")
worst_all = 0.0
for cam in (0.04, 0.06, 0.08):
    d = [abs(at(T, cam, a) - c) for a, c in measured(cam)]
    worst_all = max(worst_all, max(d))
    print("  %6.0f%% %7d %8.3f %9.3f" % (cam * 100, len(d), max(d), sum(d) / len(d)))
print("")
# Худшее расхождение сидит на самом краю по углу, где на кривую наложено условие
# монотонности по пузу (см. `build_table`). В середине, где лодка и работает,
# таблица идёт по измеренным точкам.
mid = [abs(at(T, cam, a) - c) for cam in (0.04, 0.06, 0.08)
       for a, c in measured(cam) if a >= -2]
check("в рабочей части углов таблица идёт точно по измеренному",
      max(mid) < 0.005, "худшее %.4f" % max(mid))
check("на всём диапазоне расхождение остаётся мелким", worst_all < 0.15,
      "худшее %.3f" % worst_all)

# --- проверка ПРАВИЛА ---------------------------------------------------------
#
# Данные прячутся, правило применяется, результат сверяется с тем, что спрятали.
print("Правило достройки, применённое туда, где есть чем проверить:\n")
print("    пузо   худшее   среднее")
rule_worst = 0.0
for cam in (0.04, 0.06, 0.08):
    hidden = {k: v for k, v in REF["Re6e5"]["пузо"].items() if k != "%.2f" % cam}
    ref2 = dict(REF, Re6e5=dict(REF["Re6e5"], **{"пузо": hidden}))
    pts = measured(cam)
    got = cl_curve(ref2, cam, [a for a, _ in pts])
    d = [abs(g - c) for g, (_, c) in zip(got, pts)]
    rule_worst = max(rule_worst, max(d))
    print("  %6.0f%% %8.3f %9.3f" % (cam * 100, max(d), sum(d) / len(d)))
print("")
check("правило воспроизводит измеренные кривые в среднем лучше пяти сотых",
      all(sum(abs(g - c) for g, (_, c) in
              zip(cl_curve(dict(REF, Re6e5=dict(REF["Re6e5"], **{"пузо": {
                  k: v for k, v in REF["Re6e5"]["пузо"].items() if k != "%.2f" % cam}})),
                           cam, [a for a, _ in measured(cam)]), measured(cam)))
          / len(measured(cam)) < 0.05 for cam in (0.04, 0.06, 0.08)))
check("и нигде не промахивается больше чем на две десятых", rule_worst < 0.2,
      "худшее %.3f" % rule_worst)

# --- свойства таблицы ---------------------------------------------------------
print("Свойства таблицы:\n")
cl = T["cl"]
print("     α   " + "".join("%8.0f%%" % (c * 100) for c in T["camber"]))
for a in (-8, -4, 0, 4, 8, 12, 16, 20, 30):
    i = T["alpha_deg"].index(float(a))
    print("  %5d° " % a + "".join("%9.3f" % cl[k][i] for k in range(len(cl))))
print("")

check("подъёмная сила растёт с пузом на каждом угле",
      all(cl[k][i] >= cl[k - 1][i] - 1e-9
          for k in range(1, len(cl)) for i in range(len(T["alpha_deg"]))))
check("у плоской пластины на нулевом угле подъёмной силы нет",
      abs(cl[0][T["alpha_deg"].index(0.0)]) < 1e-9)
# Вершина ищется в измеренном диапазоне углов, а не по всей таблице: за срывом
# все сечения сходятся к плоской пластине, и там максимум у всех один и тот же —
# около 2·sin α·cos α. Это не изъян, а то, как оно и есть.
# Диапазон углов сузился до 14° сверху И до −14° снизу: за срывом все сечения
# сходятся к плоской пластине, и её максимум (единица при 45°) заслоняет вершину
# у малого пуза.
peak = [max(v for a, v in zip(T["alpha_deg"], row) if -14 <= a <= 14) for row in cl]
check("наибольшая подъёмная сила растёт с пузом",
      all(peak[k] > peak[k - 1] for k in range(1, len(peak))),
      ", ".join("%.2f" % v for v in peak))
# Наклон обязан совпасть с измеренным: это ЕДИНСТВЕННОЕ число, на котором стоит
# вся достройка, и если таблица его не воспроизводит, значит собрана не из него.
for cam in (0.02, 0.06, 0.10):
    got = (at(T, cam, 6.0) - at(T, cam, 2.0)) / 4.0
    check("наклон при пузе %.0f%% равен измеренному" % (cam * 100),
          abs(got - CL_SLOPE) < 0.012, "%.4f против %.4f" % (got, CL_SLOPE))
# Сопротивление: минимум измерен, положение минимума измерено.
cd = cd_curve(REF, 0.06, [float(v) for v in range(-4, 13)])
i_min = cd.index(min(cd))
check("минимум сопротивления равен измеренному", abs(min(cd) - CD_MIN) < 1e-6,
      "%.4f" % min(cd))
check("минимум сопротивления лежит около двух градусов", abs(-4 + i_min - 2) <= 1,
      "на %d°" % (-4 + i_min))
check("сопротивление на срыве в разы больше минимального",
      cd_curve(REF, 0.06, [16.0])[0] / CD_MIN > 3,
      "в %.1f раза" % (cd_curve(REF, 0.06, [16.0])[0] / CD_MIN))

# --- таблица доехала до пакета ------------------------------------------------
pack = os.path.join(ROOT, "out/export/physics.json")
if os.path.exists(pack):
    with open(pack, encoding="utf-8") as fh:
        sp = json.load(fh).get("sail_polar")
    check("таблица лежит в пакете физики", sp is not None)
    if sp:
        check("в пакете та же таблица, что собирается здесь",
              sp["cl"] == T["cl"] and sp["cd"] == T["cd"] and sp["camber"] == T["camber"])

print(("%d проверок провалено" % failures) if failures else "все проверки прошли")
print("")
sys.exit(1 if failures else 0)
