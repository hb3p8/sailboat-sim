"""Разовый генератор гидродинамических случаев. Не часть контура.

Случаев в семействе много и они отличаются одним числом — углом, скоростью,
уровнем сетки. Писать их руками значит гарантированно развести в чём-то ещё, а
§4.2 требует, чтобы в тройке сеток совпадало ВСЁ, кроме уровня.
"""
import json
import os

IMAGE = ("openfoam-app-arm64:2306@sha256:"
         "d7f74da0b7e3c777f9a09c1508c0ab8e0ed97b74ef7ba3ee4bcae36909bf8d35")
WATER = {"rho": 1025.0, "nu": 1.19e-06}

# --- киль -------------------------------------------------------------------
#
# Изолированное перо с бульбом, корень на плоскости симметрии. Проверяется
# foilCoeffs: линейный участок, наклон кривой и срыв.
KEEL_REF = {"area_m2": 0.46196, "length_m": 0.35110, "chord_m": 0.35110,
            "span_m": 1.31575, "rho": 1025.0, "speed_ms": 2.0,
            "origin_m": [3.05, 0.0, -0.66]}
KEEL_DOMAIN = {"fwd_l": 12.0, "aft_l": 25.0, "side_l": 15.0,
               "up_l": 0.0, "down_l": 15.0, "seed": [-3.0, 3.0, -3.0]}
KEEL_BOXES = [
    {"box": [[2.4, -0.8, -2.0], [5.2, 0.8, 0.05]], "level": 2},
    {"box": [[2.6, -0.35, -1.75], [3.9, 0.35, 0.05]], "level": 4},
]
KEEL_LEVELS = {"coarse": [3, 5], "medium": [4, 6], "fine": [5, 7]}
KEEL_LAYERS = {"coarse": 3, "medium": 4, "fine": 5}
KEEL_DIST = {"coarse": [[0.05, 4]], "medium": [[0.05, 5]], "fine": [[0.05, 6]]}
KEEL_ITER = {"coarse": 900, "medium": 1200, "fine": 1500}


def keel(alpha, level, group=None):
    return {
        "schema": 1,
        "case_id": "keel-u200-a%02d-%s" % (round(alpha), level),
        "family": "appendages",
        "template": "openfoam-halfspace",
        "convergence_group": group or "keel-u200-a%02d" % round(alpha),
        "notes": ("Изолированное перо киля с бульбом, корень на плоскости "
                  "симметрии. Зеркало даёт удлинение вдвое против "
                  "геометрического — верхнюю границу эффекта концевой шайбы, "
                  "который в симуляторе учтён множителем 1.5 (effective_ar). "
                  "Сравнение и показывает, насколько этот множитель верен. "
                  "Свободной поверхности нет: §5, этап 3 прямо разрешает "
                  "начать так."),
        "geometry": {
            "revision": "подставляется при разворачивании",
            "bodies": ["keel"],
            "files": {"keel": "sha256:" + "0" * 64},
        },
        "solver": {"name": "OpenFOAM", "image": IMAGE,
                   "application": "simpleFoam", "turbulence": "kOmegaSST",
                   "wall_treatment": "wall-function"},
        "fluid": dict(WATER),
        "condition": {"speed_ms": 2.0, "leeway_deg": float(alpha)},
        "mesh": {"level": level, "family": "keel-half-v1", "base_size_m": 0.35,
                 "refine": KEEL_LEVELS[level], "regions": KEEL_BOXES,
                 "surface_distance": KEEL_DIST[level],
                 "boundary_layers": KEEL_LAYERS[level], "yplus_target": 40.0,
                 "cells_target": 4000000, "n_proc": 4,
                 "domain": dict(KEEL_DOMAIN)},
        "numerics": {"iterations": KEEL_ITER[level], "end_time": KEEL_ITER[level],
                     "write_interval": 300, "dt_s": 1.0, "residual_tol": 1e-05,
                     "average_from": int(KEEL_ITER[level] * 0.75)},
        "reference": dict(KEEL_REF),
    }


# --- корпус двойным телом ----------------------------------------------------
#
# Плоскость симметрии по КВЛ. Волнообразования нет — остаётся вязкое
# сопротивление и сопротивление формы, то есть та часть hullResistance, которую
# можно проверить на этой машине. Что при этом НЕ проверяется, сказано в отчёте.
HULL_REF = {"area_m2": 6.7947, "length_m": 5.469, "rho": 1025.0,
            "speed_ms": 2.5, "origin_m": [2.73, 0.0, 0.0]}
HULL_DOMAIN = {"fwd_l": 1.2, "aft_l": 2.5, "side_l": 1.5,
               "up_l": 0.0, "down_l": 1.2, "seed": [-5.0, 5.0, -4.0]}
HULL_BOXES = [
    {"box": [[-3.0, -2.2, -3.5], [8.0, 2.2, 0.05]], "level": 1},
    {"box": [[-0.6, -1.35, -1.75], [6.6, 1.35, 0.05]], "level": 3},
]
HULL_LEVELS = {"coarse": [2, 4], "medium": [3, 5], "fine": [4, 6]}
HULL_LAYERS = {"coarse": 3, "medium": 4, "fine": 5}
HULL_DIST = {"coarse": [[0.25, 3]], "medium": [[0.25, 4]], "fine": [[0.25, 5]]}
HULL_ITER = {"coarse": 900, "medium": 1200, "fine": 1500}


def hull(speed, leeway, level, family, group):
    tag = "hull-db-u%03d-b%02d-%s" % (round(speed * 100), round(abs(leeway)),
                                      level)
    if leeway < 0:
        tag = tag.replace("-b%02d" % round(abs(leeway)),
                          "-bm%02d" % round(abs(leeway)))
    ref = dict(HULL_REF)
    ref["speed_ms"] = speed
    return {
        "schema": 1,
        "case_id": tag,
        "family": family,
        "template": "openfoam-halfspace",
        "convergence_group": group,
        "notes": ("Корпус двойным телом: плоскость симметрии по КВЛ, надводная "
                  "часть вне домена. Волновой составляющей в ответе нет вовсе, "
                  "поэтому сравнивать его с полной таблицей hullResistance "
                  "нельзя — сравнивается вязкая часть плюс сопротивление формы."),
        "geometry": {
            "revision": "подставляется при разворачивании",
            "bodies": ["underwater"],
            "files": {"underwater": "sha256:" + "0" * 64},
        },
        "solver": {"name": "OpenFOAM", "image": IMAGE,
                   "application": "simpleFoam", "turbulence": "kOmegaSST",
                   "wall_treatment": "wall-function"},
        "fluid": dict(WATER),
        "condition": {"speed_ms": speed, "leeway_deg": float(leeway),
                      "heel_deg": 0.0},
        "mesh": {"level": level, "family": "hull-db-v1", "base_size_m": 0.5,
                 "refine": HULL_LEVELS[level], "regions": HULL_BOXES,
                 "surface_distance": HULL_DIST[level],
                 "boundary_layers": HULL_LAYERS[level], "yplus_target": 60.0,
                 "cells_target": 5000000, "n_proc": 4,
                 "domain": dict(HULL_DOMAIN)},
        "numerics": {"iterations": HULL_ITER[level], "end_time": HULL_ITER[level],
                     "write_interval": 300, "dt_s": 1.0, "residual_tol": 1e-05,
                     "average_from": int(HULL_ITER[level] * 0.75)},
        "reference": ref,
    }


def write(case, sub):
    p = os.path.join("cfd/cases", sub, case["case_id"] + ".json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(case, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(p)


made = []
# Поляра киля на средней сетке и тройка на шести градусах — на линейном
# участке, где сравнение с foilCoeffs осмысленнее всего.
for a in (2, 4, 6, 8, 12):
    made.append((keel(a, "medium"), "appendages"))
for lv in ("coarse", "fine"):
    made.append((keel(6, lv), "appendages"))

# Корпус: тройка на 2.5 м/с без дрейфа и пара точек по дрейфу на средней.
for lv in ("coarse", "medium", "fine"):
    made.append((hull(2.5, 0.0, lv, "hull-resistance", "hull-db-u250-b00"), "hull-resistance"))
for u in (1.5, 3.5):
    made.append((hull(u, 0.0, "medium", "hull-resistance",
                      "hull-db-u%03d-b00" % round(u * 100)), "hull-resistance"))
for b in (4.0, -4.0, 8.0):
    made.append((hull(2.5, b, "medium", "hull-lateral",
                      "hull-db-u250-b%02d" % round(abs(b))), "hull-lateral"))

for case, sub in made:
    write(case, sub)
print("всего:", len(made))
