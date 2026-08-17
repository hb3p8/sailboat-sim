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
from cfd.lib import forces as fx                     # noqa: E402
from cfd.lib import geometry as geo                  # noqa: E402
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
        "derived": {
            "Rt_n": ax.drag(F), "Fy_n": ax.side(F),
            "Fx": F[0], "Fy": F[1], "Fz": F[2],
            "Mx": M[0], "My": M[1], "Mz": M[2],
            # §3.7: коэффициент без записанного основания не принимается,
            # поэтому он и лежит рядом с `coefficient_basis`, а не отдельно.
            "Cd": ax.drag(F) / (q * A), "Cy": ax.side(F) / (q * A),
            "Cl": F[2] / (q * A),
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
    print("  Rt = %.4f Н, Cd = %.5f при q = %.2f Па, S = %.4f м²"
          % (summary["derived"]["Rt_n"], summary["derived"]["Cd"], q, A))
    if summary["mesh"] and summary["mesh"].get("cells"):
        print("  ячеек %d, max non-ortho %.1f"
              % (summary["mesh"]["cells"], summary["mesh"].get("max_non_ortho", 0)))
    if dirty:
        print("  ГРЯЗНЫЙ запуск, в golden/ не идёт: %s" % "; ".join(dirty))
    worst = max(force[k]["drift"] for k in ("Fx", "Fy", "Fz"))
    if worst > 1.0:
        print("  сила дрейфует на окне — среднее по нему сравнивать нельзя (§4.3)")
    return 0


def _read_log(logs, name, fn):
    p = os.path.join(logs, name)
    if not os.path.exists(p):
        return None
    try:
        return fn(p)
    except (OSError, ValueError):
        return None


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
            drift = max(by_level[lv]["force"]["Fx"]["drift"]
                        for lv in conv.MESH_ORDER)
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

    cv = sub.add_parser("convergence", help="тройка сеток по сводкам")
    cv.add_argument("--family", choices=manifest.FAMILIES)

    cp = sub.add_parser("compare", help="сравнение с realtime-моделью")
    cp.add_argument("--family", choices=manifest.FAMILIES)

    rp = sub.add_parser("report", help="собрать Markdown-отчёт")
    rp.add_argument("--family", choices=manifest.FAMILIES)

    a = p.parse_args(argv)
    if not a.cmd:
        p.print_help()
        return 2
    return {"validate": cmd_validate, "geometry": cmd_geometry, "case": cmd_case,
            "run": cmd_run, "collect": cmd_collect,
            "convergence": cmd_convergence, "compare": cmd_compare,
            "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
