"""Разовое сравнение боковой силы подводного комплекса. Не часть контура.

CFD считает тело `underwater` — корпус, колодец, перо киля и бульб разом.
Модель то же самое разносит по слагаемым: киль через `foilForce`, корпус через
`hullLateral`. Сравнивать надо СУММУ, иначе сравниваются разные вещи.
"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from cfd.lib import simbridge  # noqa: E402

U, BETA = 2.5, 4.0
keel, hull = simbridge.query([
    {"fn": "foilForce", "foil": "keel", "speed_ms": U, "leeway_deg": BETA,
     "deflect_deg": 0.0},
    {"fn": "hullLateral", "speed_ms": U, "heel_deg": 0.0, "leeway_deg": BETA,
     "yaw_rate_nd": 0.0},
])
print("модель при %.1f м/с и дрейфе %.0f°:" % (U, BETA))
print("  киль (foilForce)      Fy = %9.2f Н" % keel["fy"])
print("  корпус (hullLateral)  Fy = %9.2f Н" % hull["fy_n"])
print("  сумма                 Fy = %9.2f Н" % (keel["fy"] + hull["fy_n"]))
for name in ("hull-db-u250-b04-medium", "hull-db-u250-bm04-medium"):
    p = "out/cfd/summaries/%s.json" % name
    if os.path.exists(p):
        s = json.load(open(p, encoding="utf-8"))
        print("  CFD %-26s Fy = %9.2f Н, Mz = %8.1f Н·м"
              % (name, s["derived"]["Fy"], s["derived"]["Mz"]))
