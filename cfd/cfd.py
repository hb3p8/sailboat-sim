#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Единая точка входа офлайн-контура CFD.

    python3 cfd/cfd.py <команда> [ключи]

§3.6 требует, чтобы всё то же самое работало и без `make`. Поэтому цели
Makefile — однострочные обёртки над этими командами, а не наоборот: `make`
удобен, но он есть не везде, а на счётной машине его может не быть вовсе.

    validate                проверить все манифесты случаев
    geometry                собрать CFD-геометрию из out/export/
    case      --case ...    развернуть манифест в каталог решателя
    run       --case ...    развернуть и посчитать
    collect   --run ...     собрать силы и погрешность в сводку
    convergence --family ...  тройка сеток по сводкам
    compare   --family ...  сравнение с realtime-моделью
    report    --family ...  собрать оба отчёта в один Markdown

Команды намеренно раздельны. Соблазн сделать одну «посчитай всё» велик, но
тяжёлый расчёт идёт часами и на другой машине, и склеивать его с разбором
результата значит терять разбор при каждом обрыве связи.
"""

import argparse
import json
import math
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from cfd.lib import axes as ax                       # noqa: E402
from cfd.lib import convergence as conv              # noqa: E402
from cfd.lib import fields                           # noqa: E402
from cfd.lib import forces as fx                     # noqa: E402
from cfd.lib import geometry as geo                  # noqa: E402
from cfd.lib import htmlreport, payload, story       # noqa: E402
from cfd.lib import hashing, manifest, openfoam      # noqa: E402
from cfd.lib import report as rep                    # noqa: E402
from cfd.lib import runners, simbridge               # noqa: E402

CFD = os.path.join(ROOT, "cfd")
CASES = os.path.join(CFD, "cases")
TEMPLATES = os.path.join(CFD, "templates")
REPORTS = os.path.join(CFD, "reports")
GOLDEN = os.path.join(CFD, "golden")
OUT = os.path.join(ROOT, "out", "cfd")
OUT_GEOM = os.path.join(OUT, "geometry")
OUT_RUNS = os.path.join(OUT, "runs")
OUT_SUM = os.path.join(OUT, "summaries")
EXPORT = os.path.join(ROOT, "out", "export")


def rel(p):
    return os.path.relpath(p, ROOT)


# --- validate -----------------------------------------------------------------

def cmd_validate(a):
    found = manifest.find_cases(CASES)
    if not found:
        print("случаев нет: cfd/cases/ пуст")
        return 0
    ids = {}
    bad = 0
    for path, m in found:
        # Совпадение case_id у двух файлов ломает всё ниже по цепочке: каталоги
        # запусков и сводки называются по нему, и второй молча затрёт первый.
        if m["case_id"] in ids:
            print("  ПЛОХО  %s: case_id %s уже занят в %s"
                  % (rel(path), m["case_id"], rel(ids[m["case_id"]])))
            bad += 1
        ids[m["case_id"]] = path
        print("  ok     %s  [%s / %s / %s]"
              % (rel(path), m["family"], m["template"], m["mesh"]["level"]))
    groups = manifest.group_of([m for _p, m in found])
    print("\nгрупп сходимости: %d" % len(groups))
    for g, ms in sorted(groups.items()):
        levels = sorted(x["mesh"]["level"] for x in ms)
        full = set(levels) == set(conv.MESH_ORDER)
        print("  %-40s %s%s" % (g, ", ".join(levels),
                                "" if full else "   (тройка неполна)"))
    print("\nвсего случаев: %d, ошибок: %d" % (len(found), bad))
    return 1 if bad else 0


# --- geometry -----------------------------------------------------------------

def cmd_geometry(a):
    src = a.src or EXPORT
    dst = a.dst or OUT_GEOM
    unions = a.union or ["underwater", "keel"]
    if a.canonical_only:
        r = {"schema": 1, "bodies": {}, "unions": {}, "files": {}, "inputs": {},
             "transform": "канонические тела строятся сразу в осях CFD",
             "axes_out": ax.AXES_CFD}
    else:
        r = geo.prepare(src, dst, unions=unions, heel_deg=a.heel,
                        yaw_deg=a.yaw, origin_m=(a.origin or [0.0, 0.0, 0.0]))
    if a.canonical or a.canonical_only:
        # Канонические тела этапа 0 лежат рядом с обводами лодки нарочно: они
        # проходят те же проверки замкнутости и те же оси. Проверка, которая
        # для них соврёт, соврёт и для корпуса.
        made = geo.canonical(dst, span=a.span, chord=a.chord)
        for name, b in made.items():
            r["bodies"][name] = {k: v for k, v in b.items() if k != "sha256"}
            r["files"][name] = b["sha256"]
        with open(os.path.join(dst, "geometry.json"), "w", encoding="utf-8") as f:
            json.dump(r, f, ensure_ascii=False, indent=1, sort_keys=True)
    print("геометрия в %s" % rel(dst))
    print("  переход осей: %s" % r["transform"])
    for name, b in sorted(r["bodies"].items()):
        w = b["watertight"]
        print("  %-10s %7d тр.  S=%6.3f м²  V=%7.4f м³  %s"
              % (name, w["tris"], b["area_m2"], b["volume_m3"],
                 "замкнуто" if w["watertight"]
                 else "НЕ замкнуто: висящих рёбер %d, неманифольдных %d, "
                      "разноориентированных %d"
                      % (w["boundary"], w["nonmanifold"], w["inconsistent"])))
    for name, u in sorted(r["unions"].items()):
        c = u["connectivity"]
        print("  союз %-10s из %s: %s"
              % (name, "+".join(u["parts"]),
                 "связен" if not c["detached"]
                 else "ОТОРВАНЫ " + ", ".join(c["detached"])))
        for who in c["detached"]:
            near = min(g for k, g in c["gaps_m"].items() if who in k.split("|"))
            print("         %s не касается ни одного тела союза, ближайшее в "
                  "%.4f м — сеточник пустит через щель воду внутрь"
                  % (who, near))
    bad = [n for n, b in r["bodies"].items() if not b["watertight"]["watertight"]]
    return 1 if bad else 0


# --- case ---------------------------------------------------------------------

def _geometry_stamp(m, geom_dir):
    """Подставить в манифест настоящие отпечатки геометрии.

    В файле случая они стоят заглушками: писать туда sha руками — значит
    обновлять их руками при каждой пересборке обводов, а этого никто не делает.
    Настоящие значения берутся из `out/cfd/geometry/geometry.json` в момент
    разворачивания и уходят в `case.json`, то есть в сводку.
    """
    path = os.path.join(geom_dir, "geometry.json")
    if not os.path.exists(path):
        raise SystemExit("нет %s: сначала `make cfd-geometry`" % rel(path))
    with open(path, encoding="utf-8") as f:
        g = json.load(f)
    out = dict(m)
    files = {}
    for name in m["geometry"]["files"]:
        if name not in g["files"]:
            raise SystemExit("в геометрии нет тела %r; есть: %s"
                             % (name, ", ".join(sorted(g["files"]))))
        files[name] = g["files"][name]
    rev = hashing.git_revision(ROOT)
    out["geometry"] = dict(m["geometry"], files=files,
                           revision=rev["sha"] or m["geometry"]["revision"],
                           dirty=rev["dirty"])
    return manifest.validate(out)


def _case_path(spec):
    if os.path.exists(spec):
        return spec
    for path, m in manifest.find_cases(CASES):
        if m["case_id"] == spec:
            return path
    raise SystemExit("нет случая %r ни файлом, ни по case_id" % spec)


def cmd_case(a):
    m = manifest.load(_case_path(a.case))
    geom = a.geometry or OUT_GEOM
    m = _geometry_stamp(m, geom)
    dst = a.dst or os.path.join(OUT_RUNS, m["case_id"])
    rec = openfoam.generate(m, TEMPLATES, dst, geometry_dir=geom, force=a.force)
    print("случай развёрнут в %s" % rel(dst))
    print("  шаблон %s, решатель %s, %s"
          % (m["template"], m["solver"]["application"], m["solver"]["turbulence"]))
    print("  поток (%.4f %.4f %.4f) м/с, |U| = %.4f"
          % (rec["context"]["U_x"], rec["context"]["U_y"],
             rec["context"]["U_z"], rec["context"]["U_mag"]))
    print("  домен X %.1f…%.1f, Y ±%.1f, Z %.1f…%.1f м"
          % (rec["context"]["dom_xmin"], rec["context"]["dom_xmax"],
             rec["context"]["dom_ymax"], rec["context"]["dom_zmin"],
             rec["context"]["dom_zmax"]))
    print("  файлов написано: %d" % len(rec["written"]))
    if m["geometry"].get("dirty"):
        print("  ВНИМАНИЕ: рабочее дерево грязное — в golden/ такой запуск не идёт")
    return 0


# --- run ----------------------------------------------------------------------

def cmd_run(a):
    m = manifest.load(_case_path(a.case))
    dst = a.dst or os.path.join(OUT_RUNS, m["case_id"])
    if not os.path.exists(dst) or a.force:
        cmd_case(argparse.Namespace(case=a.case, geometry=a.geometry, dst=dst,
                                    force=True))
    runner = runners.from_config(a.runner, m["solver"]["image"])
    print("запуск %s через %s" % (m["case_id"], runner.name))
    rec = runner.run(dst)
    rec["case_id"] = m["case_id"]
    runners.write_run_record(dst, rec)
    if rec.get("async"):
        print("  задача поставлена в очередь: %s" % rec.get("job_id"))
        print("  когда досчитает: cfd/cfd.py collect --run %s" % rel(dst))
    else:
        print("  готово; дальше: cfd/cfd.py collect --run %s" % rel(dst))
    return 0


# --- collect ------------------------------------------------------------------

def cmd_collect(a):
    run_dir = a.run
    with open(os.path.join(run_dir, "case.json"), encoding="utf-8") as f:
        case = json.load(f)
    m = case["manifest"]

    dirty = openfoam.verify_clean(run_dir)
    post = os.path.join(run_dir, "postProcessing")
    series = fx.read_run(post, "forces")

    start = m["numerics"].get("average_from")
    force = fx.summarise(series["force"], start, a.window, ("Fx", "Fy", "Fz"))
    moment = (fx.summarise(series["moment"], start, a.window, ("Mx", "My", "Mz"))
              if series["moment"] else {})

    F = [force[k]["mean"] for k in ("Fx", "Fy", "Fz")]
    M = [moment[k]["mean"] for k in ("Mx", "My", "Mz")] if moment else [0.0] * 3
    q = case["coefficient_basis"]["q_pa"]
    A = case["coefficient_basis"]["area_m2"]
    L = case["coefficient_basis"]["length_m"]
    ctx = case["context"]
    along, cross = ax.flow_frame((ctx["U_x"], ctx["U_y"], ctx["U_z"]))

    logs = os.path.join(run_dir, "log")
    summary = {
        "schema": 1,
        "run_dir": rel(os.path.abspath(run_dir)),
        "case_id": m["case_id"],
        "family": m["family"],
        "convergence_group": m["convergence_group"],
        "mesh_level": m["mesh"]["level"],
        "manifest": m,
        "coefficient_basis": case["coefficient_basis"],
        "clean": not dirty,
        "dirty_files": dirty,
        "force": force,
        "moment": moment,
        "frames": ax.both_frames(F, M),
        "flow_frame": {"along": list(along), "cross": list(cross)},
        "derived": {
            "Rt_n": ax.drag(F), "Fy_n": ax.side(F),
            "Fx": F[0], "Fy": F[1], "Fz": F[2],
            "Mx": M[0], "My": M[1], "Mz": M[2],
            # §3.7: коэффициент без записанного основания не принимается,
            # поэтому он и лежит рядом с `coefficient_basis`, а не отдельно.
            #
            # Cx/Cy — в СВЯЗАННЫХ осях: с ними сравнивается симулятор, который
            # тоже считает силы в осях лодки. Cd/Cl — ОТНОСИТЕЛЬНО ПОТОКА: в
            # этом смысле их печатают в справочниках, и только так их можно
            # сверить с опубликованной полярой профиля.
            "Cx": ax.drag(F) / (q * A), "Cy": ax.side(F) / (q * A),
            "Cz": F[2] / (q * A),
            "Cd": ax.dot(F, along) / (q * A),
            "Cl": ax.dot(F, cross) / (q * A),
            "D_n": ax.dot(F, along), "L_n": ax.dot(F, cross),
            "Cmz": M[2] / (q * A * L),
            "cop_x_m": (-M[1] / F[2]) if abs(F[2]) > 1e-9 else None,
            "cop_z_m": (M[0] / F[1]) if abs(F[1]) > 1e-9 else None,
        },
        "mesh": _read_log(logs, "checkMesh.log", fx.read_mesh_stats),
        "yplus": _read_log(logs, m["solver"]["application"] + ".log", fx.read_yplus),
        "residuals": _read_log(logs, m["solver"]["application"] + ".log",
                               fx.read_residuals),
        "continuity": _read_log(logs, m["solver"]["application"] + ".log",
                                fx.read_continuity),
    }
    os.makedirs(OUT_SUM, exist_ok=True)
    dst = os.path.join(OUT_SUM, m["case_id"] + ".json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1, sort_keys=True)

    print("сводка: %s" % rel(dst))
    print("  окно усреднения %.4g…%.4g с, точек %d"
          % (force["Fx"]["window"][0], force["Fx"]["window"][1],
             force["Fx"]["samples"]))
    for k in ("Fx", "Fy", "Fz"):
        s = force[k]
        print("  %s = %12.4f ± %.4f Н  (размах %.4f, дрейф %.2f от разброса)"
              % (k, s["mean"], s["std"], s["range"], s["drift"]))
    d = summary["derived"]
    print("  Rt(связ.) = %.4f Н;  по потоку: D = %.4f Н, L = %.4f Н"
          % (d["Rt_n"], d["D_n"], d["L_n"]))
    print("  Cd = %.5f, Cl = %.5f при q = %.2f Па, S = %.4f м²"
          % (d["Cd"], d["Cl"], q, A))
    if summary["mesh"] and summary["mesh"].get("cells"):
        print("  ячеек %d, max non-ortho %.1f"
              % (summary["mesh"]["cells"], summary["mesh"].get("max_non_ortho", 0)))
    if dirty:
        print("  ГРЯЗНЫЙ запуск, в golden/ не идёт: %s" % "; ".join(dirty))
    # Дрейфующей сила считается, только когда тренд велик И относительно
    # разброса, И относительно МАСШТАБА СИЛ В ЭТОМ СЛУЧАЕ.
    #
    # Масштаб берётся по наибольшей из трёх составляющих, а не по самой
    # величине. Обе крайности проверены на живых расчётах: по разбросу одному
    # тревога поднималась на сошедшемся киле, где разброс — последние разряды
    # записи; по собственному среднему — на боковой силе при нулевом угле,
    # которая законно почти нуль, и любой микротренд относительно неё огромен.
    scale = max(abs(force[k]["mean"]) for k in ("Fx", "Fy", "Fz")) or 1.0
    drifting = [k for k in ("Fx", "Fy", "Fz")
                if force[k]["drift"] > 1.0
                and force[k]["trend_over_window"] / scale > 1e-3]
    if drifting:
        print("  дрейфуют %s — среднее по окну сравнивать нельзя (§4.3)"
              % ", ".join(drifting))
    return 0


def _read_log(logs, name, fn):
    p = os.path.join(logs, name)
    if not os.path.exists(p):
        return None
    try:
        return fn(p)
    except (OSError, ValueError):
        return None


# --- sail ---------------------------------------------------------------------

def cmd_sail(a):
    """Сечения паруса в CFD-геометрию — по тому, что симулятор сам себе назначил.

    Пузо и положение горба не выдумываются и не берутся из чертежа: они
    спрашиваются у рига в рабочей точке. Иначе CFD считал бы не ту форму,
    которую модель считает своей, и расхождение нечему было бы приписать.
    """
    dst = a.dst or os.path.join(OUT_GEOM, "sail")
    os.makedirs(dst, exist_ok=True)
    made, report = {}, {"schema": 1, "bodies": {}, "files": {},
                        "axes_out": ax.AXES_CFD, "inputs": {}, "unions": {},
                        "transform": "сечение строится сразу в осях CFD"}

    strips = None
    if a.twa is not None:
        ok, why = simbridge.available()
        if not ok:
            raise SystemExit("нужен мост к симулятору: " + why)
        strips = simbridge.one({"fn": "gennakerStrips", "twa_deg": a.twa,
                                "sheet_m": a.sheet, "seconds": a.seconds})
        print("генакер при TWA %.0f°, шкот %.1f м: предохранитель %d раз, "
              "Γ до %.2e, ход %.2f уз"
              % (a.twa, a.sheet, strips["fuse_trips"], strips["gamma_max"],
                 strips["speed_kn"]))
        print("  пол.  угол   пузо  проектн.  запас  хорда   Ve     cl  доля потолка")
        for g in strips["strips"]:
            print("  %3d %6.1f° %6.3f %8.3f %6.3f %6.2f %5.2f %6.3f %8.2f"
                  % (g["strip"], g["alpha_deg"], g["camber"], g["design"],
                     g["slack"], g["chord_m"], g["ve_ms"], g["cl"],
                     g["at_ceiling"]))

    for spec in (a.section or []):
        parts = spec.split(",")
        name = parts[0]
        camber = float(parts[1])
        draft = float(parts[2]) if len(parts) > 2 else 0.5
        up, lo = geo.sail_section(camber, draft, a.chord, a.thickness)
        tris = geo.extrude_section(up, lo, a.span, z0=-0.5 * a.span)
        geo.write_stl_ascii(os.path.join(dst, name + ".stl"), [(name, tris)])
        w = geo.watertight(tris)
        report["files"][name] = hashing.sha256_file(
            os.path.join(dst, name + ".stl"))
        report["bodies"][name] = {"watertight": w, "area_m2": geo.area_m2(tris),
                                  "volume_m3": geo.volume_m3(tris),
                                  "bbox_m": geo.bbox_m(tris),
                                  "camber": camber, "draft": draft,
                                  "chord_m": a.chord,
                                  "thickness_rel": a.thickness}
        made[name] = w["watertight"]
        print("  %-22s пузо %.3f, горб %.2f, хорда %.2f м, толщина %.1f%% — %s"
              % (name, camber, draft, a.chord, 100 * a.thickness,
                 "замкнуто" if w["watertight"] else "НЕ замкнуто"))
    if strips:
        report["gennaker_point"] = strips
    if made:
        with open(os.path.join(dst, "geometry.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1, sort_keys=True)
        print("сечения в %s" % rel(dst))
    return 0 if all(made.values()) else 1


# --- slices -------------------------------------------------------------------

# Какие разрезы имеют смысл для семейства. Плоскость поперёк размаха показывает
# сечение и след; продольная вертикальная — распределение по глубине.
def _planes_for(m, ctx):
    fam, r = m["family"], m["reference"]
    o = r.get("origin_m", [0, 0, 0])
    L, half = r["length_m"], r.get("chord_m", r["length_m"])
    if fam in ("verification", "sail-2d") and m["template"] == "openfoam-2d":
        # Профиль: смотреть надо на хорду и ближний след, а не на домен в
        # сорок хорд, поэтому разрезу задана рамка.
        return [{"name": "sliceSpan", "point": [o[0], 0.0, 0.0],
                 "normal": [0, 0, 1], "axes": (0, 1),
                 "box": [[-0.8 * half, -1.1 * half], [3.0 * half, 1.1 * half]]}]
    if fam == "appendages":
        return [{"name": "sliceSpan", "point": [o[0], 0.0, o[2]],
                 "normal": [0, 0, 1], "axes": (0, 1),
                 "box": [[o[0] - 3 * half, -2.5 * half],
                         [o[0] + 8 * half, 2.5 * half]]},
                {"name": "sliceCentre", "point": [o[0], 0.0, o[2]],
                 "normal": [0, 1, 0], "axes": (0, 2),
                 "box": [[o[0] - 3 * half, -2.2], [o[0] + 8 * half, 0.05]]}]
    # Корпус: горизонт на половине осадки и диаметральная плоскость.
    return [{"name": "sliceSpan", "point": [o[0], 0.0, -0.075],
             "normal": [0, 0, 1], "axes": (0, 1),
             "box": [[-0.35 * L, -0.45 * L], [1.45 * L, 0.45 * L]]},
            {"name": "sliceCentre", "point": [o[0], 0.0, -0.4],
             "normal": [0, 1, 0], "axes": (0, 2),
             "box": [[-0.35 * L, -1.8], [1.45 * L, 0.05]]}]


def cmd_slices(a):
    run_dir = a.run
    with open(os.path.join(run_dir, "case.json"), encoding="utf-8") as f:
        case = json.load(f)
    m = case["manifest"]
    planes = _planes_for(m, case["context"])
    path, out = fields.extract(run_dir, m["solver"]["image"], planes,
                               nx=a.nx, ny=a.ny)
    print("срезы: %s" % rel(path))
    for name, s in sorted(out.items()):
        if "error" in s:
            print("  %-13s не снят: %s" % (name, s["error"]))
        else:
            print("  %-13s %d×%d, время %g, |U| до %.3f м/с"
                  % (name, s["nx"], s["ny"], s["time"], s["speed"]["hi"]))
    return 0


# --- convergence --------------------------------------------------------------

def _summaries(family=None, group=None):
    if not os.path.isdir(OUT_SUM):
        raise SystemExit("нет %s: сначала collect" % rel(OUT_SUM))
    out = []
    for n in sorted(os.listdir(OUT_SUM)):
        if not n.endswith(".json"):
            continue
        with open(os.path.join(OUT_SUM, n), encoding="utf-8") as f:
            s = json.load(f)
        if family and s["family"] != family:
            continue
        if group and s["convergence_group"] != group:
            continue
        out.append(s)
    return out


# Какая величина главная для семейства. Сходимость проверяется по ней и по
# положению центра давления: §4.2 требует, чтобы сходился не только модуль
# силы, но и точка её приложения.
PRIMARY = {"hull-resistance": ("Rt_n", "cop_x_m"),
           "hull-lateral": ("Fy", "Mz"),
           "appendages": ("Fy", "Fx"),
           "sail-2d": ("Cl", "Cd"),
           "rig-3d": ("Fy", "cop_z_m"),
           "verification": ("Cd", "Cl"),
           "waves": ("Rt_n", "Fz")}

REGIME = {"hull-resistance": "two-phase", "waves": "two-phase",
          "hull-lateral": "separated", "rig-3d": "separated",
          "sail-2d": "attached", "appendages": "attached",
          "verification": "attached"}


def convergence_results(family=None):
    groups = {}
    for s in _summaries(family):
        groups.setdefault(s["convergence_group"], {})[s["mesh_level"]] = s
    out = []
    for g, by_level in sorted(groups.items()):
        missing = [lv for lv in conv.MESH_ORDER if lv not in by_level]
        if missing:
            out.append((g, None, "тройка неполна, нет: " + ", ".join(missing)))
            continue
        fam = by_level["fine"]["family"]
        for quantity in PRIMARY.get(fam, ("Rt_n",)):
            vals, cells = {}, {}
            ok = True
            for lv in conv.MESH_ORDER:
                s = by_level[lv]
                v = s["derived"].get(quantity)
                c = (s.get("mesh") or {}).get("cells")
                if v is None or not c:
                    ok = False
                    break
                vals[lv], cells[lv] = float(v), int(c)
            if not ok:
                out.append((g + " / " + quantity, None,
                            "нет величины или числа ячеек на всех трёх сетках"))
                continue
            # В ворота §4.2 идёт дрейф только той величины, которая и
            # дрейфует по обеим мерам разом; иначе тройка не проходила бы
            # из-за микротренда в последних разрядах.
            drift = 0.0
            for lv in conv.MESH_ORDER:
                f = by_level[lv]["force"]["Fx"]
                if f.get("trend_frac", 0.0) > 1e-3:
                    drift = max(drift, f["drift"])
            drift = None if not math.isfinite(drift) else drift
            r = conv.triple(vals, cells, REGIME.get(fam, "attached"),
                            dim=2 if fam == "sail-2d" else 3, drift=drift)
            out.append((g + " / " + quantity, r, None))
    return out


def cmd_convergence(a):
    results = convergence_results(a.family)
    if not results:
        print("нечего проверять: нет сводок")
        return 0
    bad = 0
    for name, r, why in results:
        if r is None:
            print("  —      %s: %s" % (name, why))
            continue
        g = r["gate"]
        bad += 0 if g["passed"] else 1
        print("  %s  %s: medium→fine %.3f%%, порядок %s, GCI %s"
              % ("ok    " if g["passed"] else "ПЛОХО ", name,
                 r["rel_medium_fine"] * 100,
                 "—" if r["order"] is None else "%.2f" % r["order"],
                 "—" if r["gci_fine"] is None else "%.3f%%" % (r["gci_fine"] * 100)))
        for p in g["problems"]:
            print("           %s" % p)
    return 1 if bad else 0


# --- compare ------------------------------------------------------------------

def compare_rows(family=None):
    """Строки таблицы §6 и их статусы."""
    summaries = _summaries(family)
    # Неопределённость CFD берётся из сеточной оценки той же группы. Без этого
    # §4.5.2 («расхождение больше объединённой численной неопределённости»)
    # проверять нечем: разброс на окне усреднения о сеточной ошибке не знает
    # ничего и почти всегда занижен на порядок.
    gci_by_group = {}
    for name, r, _why in convergence_results(family):
        if r and r["gci_fine"] is not None:
            group = name.split(" / ")[0]
            gci_by_group[group] = max(gci_by_group.get(group, 0.0),
                                      r["gci_fine"])
    reqs, meta = [], []
    for s in summaries:
        req, pairs = simbridge.request_for(s["manifest"])
        if not req:
            continue
        reqs.append(req)
        meta.append((s, pairs))
    if not reqs:
        return [], []
    answers = simbridge.query(reqs)
    points, rows = [], []
    for (s, pairs), ans in zip(meta, answers):
        # Если тройка сеток для этой группы не закрыта, остаётся только
        # разброс на окне — и такой строке в отчёте верить нельзя: числа в ней
        # честные, а оценка их точности отсутствует. Отмечается это тем, что
        # неопределённость выходит подозрительно маленькой, и группа видна в
        # `cfd-convergence` как неполная тройка.
        unc_rel = gci_by_group.get(s["convergence_group"])
        for label, sim_key, cfd_key in pairs:
            # Незнакомое имя — это опечатка в таблице соответствий, а не
            # отсутствие данных. Ровно так и было: `Rt` против `Rt_n`, и
            # сравнение молча выдавало пустую таблицу вместо строки корпуса.
            if cfd_key not in s["derived"]:
                raise SystemExit(
                    "величины %r нет в сводке %s; есть: %s"
                    % (cfd_key, s["case_id"], ", ".join(sorted(s["derived"]))))
            if sim_key not in ans:
                raise SystemExit(
                    "мост не вернул %r на вопрос %s" % (sim_key, req.get("fn")))
            cfd_v, sim_v = s["derived"][cfd_key], ans[sim_key]
            if cfd_v is None or sim_v is None:
                # None бывает законно: центр давления не определён там, где
                # сила, на которую он делится, близка к нулю.
                continue
            scatter = 0.0
            for comp in ("Fx", "Fy", "Fz"):
                if s["force"].get(comp):
                    scatter = max(scatter, s["force"][comp]["std"])
            unc = rep.combined_uncertainty(
                abs(cfd_v) * (unc_rel or 0.0), 0.0, floor=scatter)
            status, d = rep.status_point(cfd_v, sim_v, unc)
            p = {"case": s["case_id"], "quantity": label, "cfd": cfd_v,
                 "sim": sim_v, "delta": d, "uncertainty": unc, "status": status}
            points.append(p)
    rep.status_family(points)
    for p in points:
        rows.append([p["case"], p["quantity"], p["cfd"], p["sim"], p["delta"],
                     None if abs(p["sim"]) < 1e-12
                     else 100.0 * p["delta"] / abs(p["sim"]),
                     p["uncertainty"], p["status"]])
    return rows, points


def cmd_compare(a):
    ok, why = simbridge.available()
    if not ok:
        print("мост к симулятору недоступен: %s" % why)
        return 2
    rows, points = compare_rows(a.family)
    if not rows:
        print("сравнивать нечего: нет сводок семейств с вопросом к симулятору")
        return 0
    print(rep.table(["случай", "величина", "CFD", "симулятор", "Δ", "Δ %",
                     "неопр.", "статус"], rows))
    change = [p for p in points if p["status"] == "model-change"]
    look = [p for p in points if p["status"] == "investigate"]
    print("\nok: %d, investigate: %d, model-change: %d"
          % (len(points) - len(look) - len(change), len(look), len(change)))
    if change:
        print("\nmodel-change значит только то, что §4.5.2 и §4.5.3 выполнены.")
        print("Остальные три условия — влияние на ход лодки и натурная")
        print("валидация — проверяются человеком, а не этой командой.")
    return 0


# --- html ---------------------------------------------------------------------

def _blocks_for(summaries):
    out = []
    for s in summaries:
        run_dir = os.path.join(ROOT, s["run_dir"])
        if not os.path.isdir(run_dir):
            run_dir = os.path.join(OUT_RUNS, s["case_id"])
        out.append(payload.case_block(s, run_dir))
    return out


def _keel_sim_curve(cases):
    """Кривая `foilCoeffs` симулятора и его же значения в точках CFD.

    Кривая берётся у самого симулятора, а не пересчитывается здесь: §6
    требует звать те же функции, которыми считает лодка.
    """
    ok, _why = simbridge.available()
    if not ok:
        return [], {}
    # Кривая рисуется только на том диапазоне углов, который посчитан, плюс
    # четыре градуса запаса. Тянуть её до срыва при двух посчитанных точках
    # значит сжать эти точки в левый угол графика: видно будет красивую
    # параболу симулятора и ничего из того, ради чего график сделан.
    top = max([c["condition"].get("leeway_deg", 0.0) for c in cases] or [12.0])
    top = min(30.0, top + 4.0)
    n = max(8, int(top * 2))
    grid = [i * top / n for i in range(n + 1)]
    ans = simbridge.query([{"fn": "foil", "alpha_deg": a, "foil": "keel"}
                           for a in grid])
    curve = [{"x": a, "y": r["cl"]} for a, r in zip(grid, ans)]
    pts = {}
    if cases:
        alphas = sorted({round(c["condition"].get("leeway_deg", 0.0), 3)
                         for c in cases})
        got = simbridge.query([{"fn": "foil", "alpha_deg": a, "foil": "keel"}
                               for a in alphas])
        pts = {a: r["cl"] for a, r in zip(alphas, got)}
    return curve, pts


def _bars_for(family):
    ok, _why = simbridge.available()
    if not ok:
        return []
    try:
        rows, points = compare_rows(family)
    except (SystemExit, simbridge.BridgeError):
        return []
    return [{"label": "%s · %s" % (p["case"], p["quantity"]),
             "cfd": p["cfd"], "sim": p["sim"]} for p in points]


def cmd_html(a):
    summaries = _summaries()
    if not summaries:
        raise SystemExit("нет сводок: сначала посчитать и собрать")
    blocks = _blocks_for(summaries)
    by_family = {}
    for b in blocks:
        by_family.setdefault(b["family"], []).append(b)

    conv_by_family = {}
    for fam in sorted(by_family):
        rows = [(n, r) for n, r, _w in convergence_results(fam) if r]
        conv_by_family[fam] = rows

    ver = sorted(by_family.get("verification", []),
                 key=lambda b: conv.MESH_ORDER.index(b["level"]))
    keel = by_family.get("appendages", [])
    hull_r = sorted(by_family.get("hull-resistance", []),
                    key=lambda b: b["condition"]["speed_ms"])
    hull_l = by_family.get("hull-lateral", [])

    curve, simpts = _keel_sim_curve(keel)
    sections = []

    rev = hashing.git_revision(ROOT)
    solved = ", ".join(sorted({b["turbulence"] for b in blocks})) or "—"
    sections.append(story.overview({}, [
        {"kind": "text", "html":
         ("Считал OpenFOAM v2306, нативная сборка arm64, отпечаток закреплён "
          "в каждом манифесте случая. Модель турбулентности: %s. "
          "Дерево: <code>%s</code>%s. Собрано %s."
          % (solved, (rev["sha"] or "?")[:12],
             ", грязное" if rev["dirty"] else "", htmlreport.stamp()))},
        {"kind": "tiles", "items": [
            ["случаев посчитано", str(len(blocks)), None],
            ["семейств", str(len(by_family)), None],
            ["ячеек всего", "{:,}".format(sum(b["cells"] or 0 for b in blocks))
             .replace(",", " "), None],
            ["чистых запусков", "%d из %d"
             % (sum(1 for b in blocks if b["clean"]), len(blocks)), None]]},
        {"kind": "text", "html":
         ("Порядок разделов повторяет §5 документа: сначала метод на "
          "каноническом теле, потом отдельные части лодки, потом их сумма. "
          "Каждый график продублирован таблицей — она под спойлером «таблица "
          "тех же чисел».")},
    ]))
    sections.append(story.verification_section(
        ver, conv_by_family.get("verification", [])))
    sections.append(story.keel_section(
        keel, curve, simpts, conv_by_family.get("appendages", [])))
    sections.append(story.hull_section(
        hull_r, _bars_for("hull-resistance"),
        conv_by_family.get("hull-resistance", []), "res"))
    sections.append(story.hull_section(
        hull_l, _bars_for("hull-lateral"),
        conv_by_family.get("hull-lateral", []), "lat"))

    # Чувствительность к границе домена: два случая киля, отличающиеся только
    # размером домена. Это и §4.4, и первое объяснение расхождения с моделью.
    wide = next((b for b in keel if b["case_id"].endswith("-wide")), None)
    base = next((b for b in keel
                 if b["case_id"] == "keel-u200-a06-medium"), None)
    sens = story.sensitivity_section(base, wide)
    if sens:
        sections.append(sens)

    pair = [b for b in hull_l
            if abs(b["condition"].get("leeway_deg", 0)) == 4.0]
    if len(pair) == 2:
        pair = sorted(pair, key=lambda b: -b["condition"]["leeway_deg"])
        sim_lat = None
        ok, _why = simbridge.available()
        if ok:
            c = pair[0]["condition"]
            sim_lat = simbridge.one({
                "fn": "hullLateral", "speed_ms": c["speed_ms"],
                "heel_deg": c.get("heel_deg", 0.0),
                "leeway_deg": c.get("leeway_deg", 0.0),
                "yaw_rate_nd": 0.0})
        sections.append(story.mirror_section(pair, sim_lat))
    sections.append(story.limits_section(a.limit or []))

    data = payload.sanitise({"sections": [s for s in sections if s]})
    dst = a.out or os.path.join(REPORTS, "hydro.html")
    htmlreport.build(data, "SV20 — офлайн CFD: гидродинамика",
                     "Что посчитано, чем это отличается от realtime-модели и "
                     "чего эти расчёты не показывают.", dst)
    size = os.path.getsize(dst) / 1024.0
    print("отчёт: %s (%.0f КБ)" % (rel(dst), size))
    for fam, bl in sorted(by_family.items()):
        print("  %-16s случаев %d" % (fam, len(bl)))
    return 0


# --- report -------------------------------------------------------------------

def cmd_report(a):
    sections = []
    for name, r, why in convergence_results(a.family):
        if r is None:
            sections.append("### %s\n\n%s\n" % (name, why))
        else:
            sections.append(rep.convergence_section(name, r))
    ok, why = simbridge.available()
    if ok:
        rows, _points = compare_rows(a.family)
        if rows:
            sections.append(rep.compare_section("сравнение с симулятором", rows))
    else:
        sections.append("### сравнение с симулятором\n\nнедоступно: %s\n" % why)

    rev = hashing.git_revision(ROOT)
    intro = ("Семейство: **%s**. Дерево: `%s`%s.\n\n"
             "Сводки взяты из `out/cfd/summaries/`. Пороги и правила статуса — "
             "docs/cfd-validation.md §4.2, §4.5, §6."
             % (a.family or "все", (rev["sha"] or "?")[:12],
                ", грязное" if rev["dirty"] else ""))
    text = rep.document("Отчёт CFD: %s" % (a.family or "все семейства"),
                        intro, sections)
    os.makedirs(REPORTS, exist_ok=True)
    dst = os.path.join(REPORTS, (a.family or "all") + ".md")
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    print("отчёт: %s" % rel(dst))
    return 0


# --- разбор ключей ------------------------------------------------------------

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("validate", help="проверить манифесты случаев")

    g = sub.add_parser("geometry", help="собрать CFD-геометрию")
    g.add_argument("--src", help="откуда брать STL (умолчание out/export)")
    g.add_argument("--dst", help="куда класть (умолчание out/cfd/geometry)")
    g.add_argument("--union", action="append", choices=sorted(geo.UNIONS),
                   help="какие союзы тел собрать; можно несколько раз")
    g.add_argument("--heel", type=float, default=0.0, help="крен тела, град")
    g.add_argument("--yaw", type=float, default=0.0, help="поворот тела, град")
    g.add_argument("--origin", type=float, nargs=3, help="перенос начала, м")
    g.add_argument("--canonical", action="store_true",
                   help="добавить тела этапа 0: NACA 0012 и клин для знаков")
    g.add_argument("--canonical-only", action="store_true",
                   help="только их, без обводов лодки")
    g.add_argument("--span", type=float, default=0.1,
                   help="толщина плоского тела, м")
    g.add_argument("--chord", type=float, default=1.0, help="хорда, м")

    c = sub.add_parser("case", help="развернуть манифест в каталог решателя")
    c.add_argument("--case", required=True, help="путь к манифесту или case_id")
    c.add_argument("--geometry", help="каталог CFD-геометрии")
    c.add_argument("--dst", help="куда развернуть")
    c.add_argument("--force", action="store_true", help="пересобрать поверх")

    r = sub.add_parser("run", help="развернуть и посчитать")
    r.add_argument("--case", required=True)
    r.add_argument("--geometry")
    r.add_argument("--dst")
    r.add_argument("--force", action="store_true")
    r.add_argument("--runner", default="local",
                   help="local | ssh:host:/путь | slurm:host:/путь")

    co = sub.add_parser("collect", help="собрать силы и погрешность в сводку")
    co.add_argument("--run", required=True, help="каталог запуска")
    co.add_argument("--window", type=float, default=0.5,
                    help="доля хвоста для усреднения, если случай её не задал")

    sa = sub.add_parser("sail", help="сечения паруса в CFD-геометрию")
    sa.add_argument("--section", action="append",
                    help="имя,пузо[,горб] — можно несколько раз")
    sa.add_argument("--chord", type=float, default=1.0, help="хорда, м")
    sa.add_argument("--span", type=float, default=0.1, help="толщина слоя, м")
    sa.add_argument("--thickness", type=float, default=0.015,
                    help="толщина сечения в долях хорды")
    sa.add_argument("--dst", help="куда писать")
    sa.add_argument("--twa", type=float,
                    help="спросить риг о полосках генакера на этом курсе")
    sa.add_argument("--sheet", type=float, default=4.5, help="длина шкота, м")
    sa.add_argument("--seconds", type=float, default=25.0)

    sl = sub.add_parser("slices", help="снять поля на плоскостях для отчёта")
    sl.add_argument("--run", required=True, help="каталог запуска")
    sl.add_argument("--nx", type=int, default=200)
    sl.add_argument("--ny", type=int, default=130)

    cv = sub.add_parser("convergence", help="тройка сеток по сводкам")
    cv.add_argument("--family", choices=manifest.FAMILIES)

    cp = sub.add_parser("compare", help="сравнение с realtime-моделью")
    cp.add_argument("--family", choices=manifest.FAMILIES)

    hm = sub.add_parser("html", help="собрать HTML-отчёт с графиками")
    hm.add_argument("--out", help="куда писать (умолчание cfd/reports/hydro.html)")
    hm.add_argument("--limit", action="append",
                    help="добавить строку в раздел границ применимости")

    rp = sub.add_parser("report", help="собрать Markdown-отчёт")
    rp.add_argument("--family", choices=manifest.FAMILIES)

    a = p.parse_args(argv)
    if not a.cmd:
        p.print_help()
        return 2
    return {"validate": cmd_validate, "geometry": cmd_geometry, "case": cmd_case,
            "run": cmd_run, "collect": cmd_collect, "slices": cmd_slices, "sail": cmd_sail,
            "convergence": cmd_convergence, "compare": cmd_compare,
            "html": cmd_html, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
