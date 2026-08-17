# -*- coding: utf-8 -*-
"""Разворачивание манифеста в каталог OpenFOAM (§3.5, §3.6).

Шаблон — обычный каталог случая, в котором меняющиеся числа заменены на
`{{имя}}`. Никакого языка шаблонов: подстановка строк и наследование одного
базового шаблона. Причина в том, что шаблон обязан оставаться ЧИТАЕМЫМ как
случай OpenFOAM. Как только в `fvSolution` появляются циклы и условия, читать
его глазами становится нельзя, а глазами его читают каждый раз, когда расчёт
ведёт себя странно.

Наследование (`_extends` в корне шаблона) нужно ровно затем, чтобы разница
между воздухом и водой со свободной поверхностью была видна списком файлов, а
не диффом трёх сотен строк.

Ручная правка внутри сгенерированного каталога делает запуск грязным (§3.5).
Поэтому рядом с каталогом кладётся `case.json` с отпечатками всех написанных
файлов, и `collect_case.py` сверяет их перед приёмом результата.
"""

import json
import math
import os
import re
import shutil

from . import axes as ax
from . import hashing
from .manifest import coefficient_basis, dynamic_pressure

PLACEHOLDER = re.compile(r"\{\{([a-zA-Z0-9_]+)\}\}")

# Файлы, которые копируются как есть: подстановка в двоичном или в чужом
# формате только испортит их.
VERBATIM = (".stl", ".obj", ".gz", ".png")


class TemplateError(ValueError):
    pass


def resolve(template_root, name, _seen=None):
    """Список (относительный путь, полный путь) с учётом наследования.

    Файл потомка перекрывает файл предка с тем же относительным путём.
    """
    _seen = _seen or []
    if name in _seen:
        raise TemplateError("шаблоны наследуются по кругу: %s"
                            % " -> ".join(_seen + [name]))
    base = os.path.join(template_root, name)
    if not os.path.isdir(base):
        raise TemplateError("нет шаблона %s" % base)
    files = {}
    parent = os.path.join(base, "_extends")
    if os.path.exists(parent):
        with open(parent, encoding="utf-8") as f:
            files.update(resolve(template_root, f.read().strip(), _seen + [name]))
    for d, _dirs, names in os.walk(base):
        for n in sorted(names):
            if n == "_extends":
                continue
            p = os.path.join(d, n)
            files[os.path.relpath(p, base)] = p
    return files


def context(m, geometry_dir=None):
    """Числа и строки, которыми заполняется шаблон, — из манифеста и только.

    Ни одно значение здесь не берётся «по умолчанию из шаблона»: если случай
    его не задал, оно вычисляется из заданных и попадает в `case.json`. Иначе
    настройка живёт в двух местах, и через месяц никто не скажет, какое из них
    победило.
    """
    c, n, r, f = m["condition"], m["numerics"], m["reference"], m["fluid"]
    speed = c.get("speed_ms") or c.get("aws_ms")
    if speed is None:
        # Случай задан числом Рейнольдса — скорость выводится из него и хорды.
        speed = c["reynolds"] * f["nu"] / r.get("chord_m", r["length_m"])
    angle = c.get("awa_deg")
    if angle is not None:
        U = ax.onset_flow_aero(speed, angle)
    else:
        U = ax.onset_flow(speed, c.get("leeway_deg", 0.0))
    if c.get("alpha_deg"):
        # Двумерное сечение ставится прямо, а угол атаки задаётся потоком:
        # так одна сетка обслуживает всю поляру и сеточная погрешность не
        # меняется от точки к точке.
        #
        # Знак поворота именно такой, чтобы направление НАБЕГАНИЯ (то есть −U)
        # составляло с осью «в нос» ровно +alpha. Первая версия ставила минус,
        # и вся поляра считалась бы зеркальной — молча, потому что профиль
        # симметричный и по модулю Cl вышел бы тот же самый.
        U = ax.rotate_yaw(U, c["alpha_deg"])

    umag = math.sqrt(sum(x * x for x in U)) or 1.0
    # Начальные k и omega по обычным для внешней задачи 1% турбулентности и
    # масштабу вихря в 10% опорной длины. Это НЕ измерение: настоящая
    # чувствительность к ним проверяется отдельно (§4.4).
    intensity = 0.01
    length_scale = 0.1 * r["length_m"]
    k = 1.5 * (umag * intensity) ** 2
    omega = math.sqrt(k) / (0.09 ** 0.25 * length_scale)
    epsilon = 0.09 ** 0.75 * k ** 1.5 / length_scale

    # Направлений подъёмной силы и сопротивления здесь нет нарочно. Их просит
    # функция-объект `forceCoeffs`, а она не используется: коэффициенты
    # считаются в `collect` из вектора силы в связанных осях, вместе с
    # записанным основанием (§3.7). Пара «свой liftDir в словаре решателя и
    # свой пересчёт в коллекторе» — это два источника правды, и разойдутся они
    # на первом же случае с креном.
    origin = r.get("origin_m", [0.0, 0.0, 0.0])
    # Имена патчей тела берутся из имён solid'ов в STL, а те — из имён тел
    # выгрузки. Совпадение обязательно: по этим же именам снимаются силы по
    # телам раздельно, и рассогласование даёт не ошибку, а тихий ноль в графе.
    bodies = m["geometry"].get("bodies") or sorted(m["geometry"]["files"])
    ctx = {
        "bodies": " ".join(bodies),
        "body_patch": bodies[0],
        "wall_patches": '"(%s)"' % "|".join(bodies),
        "geometry_file": bodies[0] + ".stl",
        "case_id": m["case_id"],
        "family": m["family"],
        "template": m["template"],
        "application": m["solver"]["application"],
        "turbulence_model": m["solver"]["turbulence"],
        "simulation_type": "laminar" if m["solver"]["turbulence"] == "laminar" else "RAS",
        "nu": f["nu"], "rho": f["rho"],
        "nu_air": f.get("nu_air", 1.5e-5), "rho_air": f.get("rho_air", 1.225),
        "g": f.get("g", -9.81), "sigma": f.get("sigma", 0.07),
        "U_x": U[0], "U_y": U[1], "U_z": U[2], "U_mag": umag,
        "k": k, "omega": omega, "epsilon": epsilon, "nut": k / max(omega, 1e-9),
        "nu_tilda": 3.0 * f["nu"],
        "speed_ms": speed,
        "heel_deg": c.get("heel_deg", 0.0),
        "leeway_deg": c.get("leeway_deg", 0.0),
        "rudder_deg": c.get("rudder_deg", 0.0),
        "yaw_rate_rad_s": (c.get("yaw_rate_nd", 0.0) * speed / r["length_m"]),
        "yaw_rpm": (c.get("yaw_rate_nd", 0.0) * speed / r["length_m"]
                    * 60.0 / (2.0 * math.pi)),
        "wave_height_m": c.get("wave_height_m", 0.0),
        "wave_period_s": c.get("wave_period_s", 1.0),
        "ref_area": r["area_m2"], "ref_length": r["length_m"],
        "ref_speed": r["speed_ms"], "ref_rho": r["rho"],
        "q_pa": dynamic_pressure(m),
        "cofr_x": origin[0], "cofr_y": origin[1], "cofr_z": origin[2],
        "end_time": n.get("end_time", n.get("iterations", 2000)),
        "iterations": n.get("iterations", n.get("end_time", 2000)),
        "write_interval": n.get("write_interval", 200),
        "dt": n.get("dt_s", 1.0),
        "max_co": n.get("maxCo", 0.5),
        "max_alpha_co": n.get("maxAlphaCo", 0.5),
        "residual_tol": n.get("residual_tol", 1e-5),
        "mesh_level": m["mesh"]["level"],
        "mesh_family": m["mesh"]["family"],
        "geometry_dir": geometry_dir or "",
    }
    ctx.update(_mesh_context(m))
    ctx.update(_blocks(m, bodies, ctx))
    return ctx


def _blocks(m, bodies, ctx):
    """Куски словарей, которые зависят от СПИСКА тел, а не от одного числа.

    Подстановка строк не умеет циклов, и это сделано нарочно (см. заголовок).
    Цикл по телам живёт здесь, на питоне, где его видно и можно проверить
    тестом, а в шаблоне остаётся одна понятная строка `{{geometry_block}}`.
    """
    geom, refine, layers, forces = [], [], [], []
    for b in bodies:
        geom.append("    %s.stl\n    {\n        type triSurfaceMesh;\n"
                    "        name %s;\n    }" % (b, b))
        refine.append("            %s\n            {\n"
                      "                level (%d %d);\n"
                      "                patchInfo { type wall; }\n"
                      "            }"
                      % (b, ctx["refine_min"], ctx["refine_max"]))
        layers.append("            \"%s.*\"\n            {\n"
                      "                nSurfaceLayers %d;\n            }"
                      % (b, ctx["n_layers"]))
        forces.append(_forces_fo(b, [b], ctx))
    # Отдельно — сумма по всем телам, всегда под именем `forces`. Она и
    # сравнивается с симулятором; силы по телам нужны, чтобы понять, КАКОЕ
    # тело разошлось. Постоянное имя важно: коллектор читает
    # `postProcessing/forces` и не должен знать состав случая.
    forces.append(_forces_fo("forces", bodies, ctx))
    return {"geometry_block": "\n".join(geom),
            "refinement_block": "\n".join(refine),
            "layers_block": "\n".join(layers),
            "forces_block": "\n".join(forces)}


def _forces_fo(name, patches, ctx):
    """Функция-объект `forces`.

    Опорные величины подставляются из манифеста, а не из умолчаний OpenFOAM:
    §3.7 запрещает безымянный коэффициент. Центр приведения моментов — тот же
    `reference.origin_m`, что уйдёт в сводку, иначе момент нечем сравнить.
    """
    return """    %s
    {
        type            forces;
        libs            (forces);
        writeControl    timeStep;
        writeInterval   1;
        log             no;
        patches         (%s);
        rho             rhoInf;
        rhoInf          %r;
        CofR            (%r %r %r);
        writeFields     no;
    }""" % (name, " ".join('"%s.*"' % p for p in patches), ctx["ref_rho"],
            ctx["cofr_x"], ctx["cofr_y"], ctx["cofr_z"])


# Сгущение тройки сеток: каждый шаг — корень из двух по линейному размеру,
# то есть примерно вдвое-втрое по числу ячеек. Согласованное отношение важнее
# круглых чисел: по нему считается наблюдаемый порядок (cfd/lib/convergence.py).
LEVEL_SCALE = {"coarse": 1.0, "medium": 1.0 / math.sqrt(2.0),
               "fine": 1.0 / 2.0}
LEVEL_REFINE = {"coarse": (1, 2), "medium": (2, 3), "fine": (3, 4)}
LEVEL_LAYERS = {"coarse": 3, "medium": 5, "fine": 7}


def _mesh_context(m):
    mesh, r = m["mesh"], m["reference"]
    L = r["length_m"]
    dom = mesh.get("domain", {})
    # Домен по умолчанию — двадцать длин вокруг тела. Размер проверяется в §4.4
    # как отдельная чувствительность, поэтому он и вынесен в манифест.
    back = dom.get("aft_l", 12.0) * L
    front = dom.get("fwd_l", 8.0) * L
    side = dom.get("side_l", 8.0) * L
    up = dom.get("up_l", 8.0) * L
    down = dom.get("down_l", 8.0) * L
    base = mesh.get("base_size_m", L / 8.0) * LEVEL_SCALE[mesh["level"]]
    lo, hi = LEVEL_REFINE[mesh["level"]]
    nx = max(4, int(round((front + back) / base)))
    ny = max(4, int(round(2 * side / base)))
    nz = max(4, int(round((up + down) / base)))
    # Точка внутри жидкости для `snappyHexMesh`. Сорок процентов пути к границе:
    # заведомо снаружи тела и заведомо внутри домена. Задаётся вручную только
    # там, где тело охватывает начало координат необычным образом.
    seed = mesh.get("domain", {}).get("seed") or [0.4 * front, 0.4 * side,
                                                  0.4 * up]
    # Толщина плоского случая. Значение не влияет ни на что, кроме масштаба
    # силы: она снимается на одну ячейку поперёк и делится на эту же толщину
    # при переходе к коэффициенту. Отсюда и требование задавать `reference.
    # area_m2` как хорда × толщина, а не как площадь настоящего паруса.
    span = dom.get("span_m", base)
    return {
        "span_lo": -0.5 * span, "span_hi": 0.5 * span, "span_m": span,
        "seed_x": seed[0], "seed_y": seed[1], "seed_z": seed[2],
        "n_proc": mesh.get("n_proc", 4),
        "dom_xmin": -back, "dom_xmax": front,
        "dom_ymin": -side, "dom_ymax": side,
        "dom_zmin": -down, "dom_zmax": up,
        "n_x": nx, "n_y": ny, "n_z": nz,
        "base_size_m": base,
        "refine_min": lo, "refine_max": hi,
        "n_layers": mesh.get("boundary_layers", LEVEL_LAYERS[mesh["level"]]),
        "yplus_target": mesh.get("yplus_target", 30.0),
        "cells_target": mesh.get("cells_target", nx * ny * nz),
    }


def render_text(text, ctx, where=""):
    missing = []

    def sub(match):
        key = match.group(1)
        if key not in ctx:
            missing.append(key)
            return match.group(0)
        v = ctx[key]
        if isinstance(v, float):
            return repr(v) if abs(v) >= 1e-4 or v == 0 else "%.10e" % v
        return str(v)

    out = PLACEHOLDER.sub(sub, text)
    if missing:
        raise TemplateError("%s: шаблон просит неизвестные величины %s"
                            % (where, ", ".join(sorted(set(missing)))))
    return out


def generate(m, template_root, dst, geometry_dir=None, force=False):
    """Развернуть манифест в каталог решателя.

    Каталог всегда пересоздаётся целиком. Дописывать в существующий нельзя:
    остатки прошлого случая — самый дешёвый способ получить необъяснимый
    результат, а объяснять его потом дороже, чем пересобрать.
    """
    if os.path.exists(dst):
        if not force:
            raise TemplateError("%s уже есть; --force чтобы пересобрать" % dst)
        shutil.rmtree(dst)
    ctx = context(m, geometry_dir)
    files = resolve(template_root, m["template"])
    written = {}
    for rel, src in sorted(files.items()):
        out_rel = render_text(rel, ctx, rel)
        target = os.path.join(dst, out_rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if rel.endswith(VERBATIM):
            shutil.copyfile(src, target)
        else:
            with open(src, encoding="utf-8") as f:
                text = f.read()
            with open(target, "w", encoding="utf-8") as f:
                f.write(render_text(text, ctx, rel))
            if os.access(src, os.X_OK):
                os.chmod(target, 0o755)
        written[out_rel] = hashing.sha256_file(target)

    if geometry_dir:
        # Копируются ТОЛЬКО тела этого случая. Соблазн скопировать весь каталог
        # велик — но тогда в каталоге плоского профиля лежит корпус лодки, и
        # `snappyHexMesh` при первой же опечатке в имени патча возьмёт не то
        # тело вместо того, чтобы упасть.
        tri = os.path.join(dst, "constant", "triSurface")
        os.makedirs(tri, exist_ok=True)
        for name in sorted(m["geometry"]["files"]):
            src = os.path.join(geometry_dir, name + ".stl")
            if not os.path.exists(src):
                raise TemplateError("нет %s: тело случая не собрано" % src)
            shutil.copyfile(src, os.path.join(tri, name + ".stl"))
            written["constant/triSurface/" + name + ".stl"] = \
                hashing.sha256_file(os.path.join(tri, name + ".stl"))

    record = {"schema": 1, "manifest": m, "context": ctx,
              "coefficient_basis": coefficient_basis(m),
              "template_files": {k: os.path.relpath(v, template_root)
                                 for k, v in sorted(files.items())},
              "written": written}
    with open(os.path.join(dst, "case.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=1, sort_keys=True)
    return record


def verify_clean(run_dir):
    """Сверить содержимое каталога с отпечатками из `case.json` (§3.5).

    Возвращает список расхождений. Пустой список — запуск чистый; всё
    остальное значит, что каталог правили руками, и в `golden/` он не идёт.
    """
    with open(os.path.join(run_dir, "case.json"), encoding="utf-8") as f:
        rec = json.load(f)
    bad = []
    for rel, want in sorted(rec["written"].items()):
        p = os.path.join(run_dir, rel)
        if not os.path.exists(p):
            bad.append("удалён: " + rel)
        elif hashing.sha256_file(p) != want:
            bad.append("изменён: " + rel)
    return bad
