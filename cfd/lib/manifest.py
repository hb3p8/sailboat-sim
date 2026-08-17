# -*- coding: utf-8 -*-
"""Манифест случая: схема 1 (§3.5 docs/cfd-validation.md).

Случай задаётся одним JSON-файлом, а не копией каталога OpenFOAM. Причина
практическая: скопированный каталог решателя невозможно сравнить с соседним.
В нём триста строк, из которых меняются четыре, и какие именно — не видно ни
в `diff`, ни в отчёте. Манифест же читается целиком за десять секунд, и любое
отличие двух случаев есть отличие двух коротких словарей.

Проверка здесь нарочно строгая и без внешних зависимостей: незнакомое поле —
ошибка, а не «на всякий случай пропустим». Опечатка в имени поля иначе
превращается в молча потерянную настройку, и обнаруживается она через неделю
по расхождению, которому нет объяснения.
"""

import json
import math
import os

SCHEMA = 1

FAMILIES = ("verification", "sail-2d", "rig-3d", "appendages",
            "hull-resistance", "hull-lateral", "waves")

# Шаблон определяет, какие поля обязательны: у аэродинамики нет свободной
# поверхности, у VOF нет угла атаки паруса. Разделять же семейства и шаблоны
# нужно потому, что одно семейство может считаться двумя шаблонами (киль без
# воды и он же под поверхностью).
TEMPLATES = ("openfoam-aero", "openfoam-2d", "openfoam-halfspace",
             "openfoam-vof", "openfoam-manoeuvre")

TURBULENCE = ("kOmegaSST", "SpalartAllmaras", "laminar")
MESH_LEVELS = ("coarse", "medium", "fine")
RUNNERS = ("local", "ssh", "slurm")

_TOP = {"schema", "case_id", "family", "template", "geometry", "solver",
        "fluid", "condition", "mesh", "numerics", "convergence_group",
        "reference", "notes"}
_REQUIRED = {"schema", "case_id", "family", "template", "geometry", "solver",
             "fluid", "condition", "mesh", "numerics", "convergence_group",
             "reference"}


class ManifestError(ValueError):
    pass


def _need(d, keys, where):
    missing = [k for k in keys if k not in d]
    if missing:
        raise ManifestError("%s: нет полей %s" % (where, ", ".join(sorted(missing))))


def _extra(d, allowed, where):
    unknown = [k for k in d if k not in allowed]
    if unknown:
        raise ManifestError("%s: незнакомые поля %s — опечатка?"
                            % (where, ", ".join(sorted(unknown))))


def _positive(d, key, where):
    v = d.get(key)
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not v > 0:
        raise ManifestError("%s.%s должно быть положительным числом, а не %r"
                            % (where, key, v))
    if not math.isfinite(float(v)):
        raise ManifestError("%s.%s не конечно" % (where, key))


def validate(m):
    """Проверить манифест. Возвращает его же, чтобы вызов можно было вложить."""
    if not isinstance(m, dict):
        raise ManifestError("манифест должен быть объектом JSON")
    _extra(m, _TOP, "манифест")
    _need(m, _REQUIRED, "манифест")

    if m["schema"] != SCHEMA:
        raise ManifestError("схема %r не поддерживается, нужна %d"
                            % (m["schema"], SCHEMA))
    if m["family"] not in FAMILIES:
        raise ManifestError("семейство %r не из списка %s"
                            % (m["family"], ", ".join(FAMILIES)))
    if m["template"] not in TEMPLATES:
        raise ManifestError("шаблон %r не из списка %s"
                            % (m["template"], ", ".join(TEMPLATES)))
    if not isinstance(m["case_id"], str) or not m["case_id"]:
        raise ManifestError("case_id должен быть непустой строкой")
    if any(c in m["case_id"] for c in "/\\ "):
        raise ManifestError("case_id идёт в имя каталога: без пробелов и слэшей")

    g = m["geometry"]
    _extra(g, {"revision", "dirty", "files", "bodies", "scale"}, "geometry")
    _need(g, {"revision", "files"}, "geometry")
    if not isinstance(g["files"], dict) or not g["files"]:
        raise ManifestError("geometry.files: пустой список тел")
    for name, h in g["files"].items():
        if not isinstance(h, str) or not h.startswith("sha256:"):
            raise ManifestError("geometry.files.%s: нужен отпечаток sha256:, а не %r"
                                % (name, h))

    s = m["solver"]
    _extra(s, {"name", "image", "application", "turbulence", "wall_treatment"},
           "solver")
    _need(s, {"name", "image", "application", "turbulence"}, "solver")
    if s["turbulence"] not in TURBULENCE:
        raise ManifestError("solver.turbulence %r не из списка %s"
                            % (s["turbulence"], ", ".join(TURBULENCE)))
    if "@sha256:" not in str(s["image"]):
        # Тега мало: тег переезжает на другой образ молча, и тогда «тот же
        # расчёт» через полгода считается другой версией решателя (§3.1).
        raise ManifestError("solver.image обязан содержать digest вида "
                            "registry/name@sha256:...")

    f = m["fluid"]
    _extra(f, {"rho", "nu", "rho_air", "nu_air", "g", "sigma"}, "fluid")
    _need(f, {"rho", "nu"}, "fluid")
    _positive(f, "rho", "fluid")
    _positive(f, "nu", "fluid")

    c = m["condition"]
    _extra(c, {"speed_ms", "heel_deg", "leeway_deg", "rudder_deg", "yaw_rate_nd",
               "awa_deg", "aws_ms", "alpha_deg", "camber", "reynolds",
               "sheet_deg", "twist_deg", "wave_height_m", "wave_period_s",
               "wave_heading_deg", "free_heave", "free_pitch", "free_roll"},
           "condition")
    speed_keys = [k for k in ("speed_ms", "aws_ms") if k in c]
    if not speed_keys and "reynolds" not in c:
        raise ManifestError("condition: нужна скорость (speed_ms или aws_ms) "
                            "или reynolds")
    for k in speed_keys:
        _positive(c, k, "condition")

    mesh = m["mesh"]
    _extra(mesh, {"level", "family", "cells_target", "base_size_m",
                  "boundary_layers", "yplus_target", "domain", "n_proc",
                  "refine", "regions", "surface_distance", "feature_level",
                  "feature_angle"}, "mesh")
    for box in mesh.get("regions") or []:
        if set(box) != {"box", "level"} or len(box["box"]) != 2:
            raise ManifestError("mesh.regions: нужен {\"box\": [[x0,y0,z0], "
                                "[x1,y1,z1]], \"level\": n}, а не %r" % (box,))
    for pair in mesh.get("surface_distance") or []:
        if len(pair) != 2:
            raise ManifestError("mesh.surface_distance: пары [расстояние, "
                                "уровень], а не %r" % (pair,))
    if "refine" in mesh:
        r2 = mesh["refine"]
        if (not isinstance(r2, list) or len(r2) != 2
                or not all(isinstance(x, int) for x in r2) or r2[0] > r2[1]):
            raise ManifestError("mesh.refine: нужна пара целых [min, max], "
                                "min <= max, а не %r" % (r2,))
    _need(mesh, {"level", "family"}, "mesh")
    if mesh["level"] not in MESH_LEVELS:
        raise ManifestError("mesh.level %r не из списка %s"
                            % (mesh["level"], ", ".join(MESH_LEVELS)))

    n = m["numerics"]
    _extra(n, {"dt_s", "maxCo", "maxAlphaCo", "end_time", "write_interval",
               "iterations", "average_from", "residual_tol"}, "numerics")
    if not n:
        raise ManifestError("numerics пуст: нечем воспроизвести расчёт")

    r = m["reference"]
    _extra(r, {"area_m2", "length_m", "span_m", "chord_m", "rho", "speed_ms",
               "origin_m"}, "reference")
    _need(r, {"area_m2", "length_m", "rho", "speed_ms"}, "reference")
    for k in ("area_m2", "length_m", "rho", "speed_ms"):
        _positive(r, k, "reference")
    # §3.7: безымянный Cl не принимается. Опорные величины обязаны быть в
    # манифесте ДО расчёта, иначе коэффициент нечем разделить на его же напор.
    if "origin_m" in r and len(r["origin_m"]) != 3:
        raise ManifestError("reference.origin_m: нужны три координаты")

    if not isinstance(m["convergence_group"], str) or not m["convergence_group"]:
        raise ManifestError("convergence_group должен быть непустой строкой: "
                            "по нему собирается тройка сеток")
    return m


def load(path):
    with open(path, encoding="utf-8") as f:
        try:
            m = json.load(f)
        except ValueError as e:
            raise ManifestError("%s: не читается как JSON — %s" % (path, e))
    try:
        return validate(m)
    except ManifestError as e:
        raise ManifestError("%s: %s" % (os.path.basename(path), e))


def save(path, m):
    validate(m)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    return path


def dynamic_pressure(m):
    """Опорный напор q = ½ρU². Одно место, чтобы не разошлось с коллектором."""
    r = m["reference"]
    return 0.5 * r["rho"] * r["speed_ms"] ** 2


def coefficient_basis(m):
    """Всё, чем нормируется коэффициент, — в результат целиком (§3.7)."""
    r = m["reference"]
    return {"area_m2": r["area_m2"], "length_m": r["length_m"],
            "rho": r["rho"], "speed_ms": r["speed_ms"],
            "q_pa": dynamic_pressure(m),
            "origin_m": r.get("origin_m", [0.0, 0.0, 0.0]),
            "axes": "cfd: X нос, Y левый борт, Z вверх"}


def group_of(manifests):
    """Разложить манифесты по `convergence_group` — вход для тройки сеток."""
    out = {}
    for m in manifests:
        out.setdefault(m["convergence_group"], []).append(m)
    return out


def find_cases(root, family=None):
    """Все манифесты в `cfd/cases/`. Возвращает пары (путь, манифест).

    Путь отдаётся рядом, а не полем внутри: манифест обязан оставаться ровно
    тем, что лежит в файле, иначе его нельзя ни сравнить, ни отпечатать.
    """
    paths = []
    for base, _dirs, files in os.walk(root):
        for name in sorted(files):
            if name.endswith(".json"):
                paths.append(os.path.join(base, name))
    out = []
    for p in sorted(paths):
        m = load(p)
        if family and m["family"] != family:
            continue
        out.append((p, m))
    return out
