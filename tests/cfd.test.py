# -*- coding: utf-8 -*-
"""Батарея офлайн-контура CFD: .venv/bin/python tests/cfd.test.py

Решателя на этой машине нет и может не быть никогда: тяжёлый расчёт идёт на
Linux-машине. Поэтому здесь проверяется всё, что стоит ДО решателя и ПОСЛЕ
него, — и этого хватает, чтобы ошибка не доехала до счётной машины.

Три вещи проверяются жёстче прочих.

Первое — оси. Ошибка в них не падает, а тихо меняет знак боковой силы, и
обнаруживается через неделю по необъяснимому расхождению с симулятором.
Проверяются определитель, три базисных вектора и зеркало галса.

Второе — оценка сеточной сходимости. Она проверяется на изготовленном решении
с известным порядком: если метод не умеет вернуть порядок, который в это
решение заложен, его оценкам погрешности верить нельзя.

Третье — что каждый шаблон разворачивается КАЖДЫМ случаем без единой
незаполненной подстановки. Пропущенная подстановка — это `{{n_proc}}` в
командной строке mpirun на чужой машине через час ожидания в очереди.
"""

import json
import math
import os
import shutil
import sys
import tempfile

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)

from cfd.lib import axes as ax                       # noqa: E402
from cfd.lib import convergence as conv              # noqa: E402
from cfd.lib import forces as fx                     # noqa: E402
from cfd.lib import geometry as geo                  # noqa: E402
from cfd.lib import manifest, openfoam, report, simbridge  # noqa: E402

failures = 0


def check(name, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(("  ok   " if ok else "  ПЛОХО") + "  " + name +
          ("   " + detail if detail else ""))


def near(a, b, tol=1e-9):
    return abs(a - b) <= tol


# --- оси ----------------------------------------------------------------------

print("\nКонтракт координат\n")

check("определитель перехода ровно +1", near(ax.det(), 1.0, 1e-12),
      "%.15f" % ax.det())

# Три базисных вектора выгрузки: X в нос, Y вверх, Z на правый борт.
check("X выгрузки остаётся носом", ax.export_to_cfd((1, 0, 0)) == (1.0, 0.0, 0.0))
check("Y выгрузки (вверх) становится Z CFD",
      ax.export_to_cfd((0, 1, 0)) == (0.0, 0.0, 1.0))
check("Z выгрузки (правый борт) становится −Y CFD",
      ax.export_to_cfd((0, 0, 1)) == (0.0, -1.0, 0.0))

v = (1.7, -0.3, 2.9)
check("перевод обратим", all(near(a, b) for a, b in
                             zip(ax.cfd_to_export(ax.export_to_cfd(v)), v)))

# Тройка обязана остаться правой: X × Y = Z в связанных осях.
x = ax.export_to_cfd((1, 0, 0))
y = ax.export_to_cfd((0, 0, -1))          # левый борт есть −(правый борт)
cross = (x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2],
         x[0] * y[1] - x[1] * y[0])
check("нос × левый борт = вверх", cross == (0.0, 0.0, 1.0), str(cross))

flow = ax.onset_flow(2.5, 0.0)
check("поток идёт с носа в корму", flow[0] < 0, "Fx потока %.3f" % flow[0])
check("сопротивление буксируемого тела положительно",
      ax.drag((-137.0, 0.0, 0.0)) > 0)

f, m = (100.0, -20.0, 5.0), (7.0, 3.0, -11.0)
mf, mm = ax.mirror_tack(f, m)
check("зеркало галса меняет знак боковой силы", near(mf[1], 20.0))
check("зеркало галса меняет знак кренящего момента", near(mm[0], -7.0))
check("зеркало галса не трогает продольную силу", near(mf[0], 100.0))
check("зеркало дважды — тождество",
      ax.mirror_tack(mf, mm) == (f, m))

res = ax.symmetry_residual((f, m), (mf, mm))
check("невязка симметрии зеркальной пары нулевая",
      max(res.values()) < 1e-12, "max %.2e" % max(res.values()))

beta = ax.onset_flow(2.5, 4.0)
beta_neg = ax.onset_flow(2.5, -4.0)
check("смена знака дрейфа меняет знак поперечной составляющей потока",
      near(beta[1], -beta_neg[1]) and abs(beta[1]) > 1e-6)

# Крен вокруг +X: точка на левом борту уходит вверх, как в heelRotX симулятора.
p = ax.rotate_heel((0.0, 1.0, 0.0), 90.0)
check("крен +90° уводит левый борт вверх", near(p[2], 1.0, 1e-12), str(p))


# --- манифест -----------------------------------------------------------------

print("\nМанифест случая\n")

CASES = os.path.join(ROOT, "cfd", "cases")
found = manifest.find_cases(CASES)
check("случаи в cfd/cases/ читаются и проходят проверку", len(found) > 0,
      "%d штук" % len(found))

ids = [m["case_id"] for _p, m in found]
check("case_id не повторяются", len(ids) == len(set(ids)))

for path, m in found:
    stem = os.path.splitext(os.path.basename(path))[0]
    if stem != m["case_id"]:
        check("имя файла совпадает с case_id: " + stem, False,
              "внутри %s" % m["case_id"])
check("имена файлов совпадают с case_id",
      all(os.path.splitext(os.path.basename(p))[0] == m["case_id"]
          for p, m in found))

base = json.loads(json.dumps(found[0][1]))


def rejects(name, mutate):
    m = json.loads(json.dumps(base))
    mutate(m)
    try:
        manifest.validate(m)
    except manifest.ManifestError:
        check(name, True)
        return
    check(name, False, "принят, а не должен")


def _set_extra(m):
    m["turbulance"] = "kOmegaSST"


rejects("опечатка в имени поля отвергается", _set_extra)
rejects("образ без digest отвергается",
        lambda m: m["solver"].__setitem__("image", "openfoam:2306"))
rejects("отсутствие опорной площади отвергается",
        lambda m: m["reference"].pop("area_m2"))
rejects("отрицательная плотность отвергается",
        lambda m: m["fluid"].__setitem__("rho", -1.0))
rejects("неизвестное семейство отвергается",
        lambda m: m.__setitem__("family", "sails"))
rejects("отпечаток без sha256: отвергается",
        lambda m: m["geometry"]["files"].__setitem__(
            sorted(m["geometry"]["files"])[0], "abc"))
rejects("пустая группа сходимости отвергается",
        lambda m: m.__setitem__("convergence_group", ""))
rejects("пробел в case_id отвергается",
        lambda m: m.__setitem__("case_id", "плохое имя"))

groups = manifest.group_of([m for _p, m in found])
check("группа сходимости не смешивает семейства",
      all(len({x["family"] for x in ms}) == 1 for ms in groups.values()))
check("в группе не два случая одного уровня сетки",
      all(len({x["mesh"]["level"] for x in ms}) == len(ms)
          for ms in groups.values()))

q = manifest.dynamic_pressure(base)
r = base["reference"]
check("опорный напор считается один раз и верно",
      near(q, 0.5 * r["rho"] * r["speed_ms"] ** 2))


# --- геометрия ----------------------------------------------------------------

print("\nГеометрия\n")

tmp = tempfile.mkdtemp(prefix="sv20-cfd-test-")
try:
    made = geo.canonical(os.path.join(tmp, "geom"), span=0.1, chord=1.0)
    for name, b in sorted(made.items()):
        check("каноническое тело %s замкнуто" % name,
              b["watertight"]["watertight"], json.dumps(b["watertight"]))
        check("каноническое тело %s ориентировано наружу" % name,
              b["volume_m3"] > 0, "V = %.6f" % b["volume_m3"])

    # Сечение паруса: тонкая изогнутая дуга. Замкнуть её веером из центра
    # габарита нельзя — у такой дуги центр лежит снаружи тела, — а задняя
    # кромка, сведённая в точку, оказывается тоньше допуска склейки. Обе
    # ошибки были сделаны и обе ловятся здесь.
    for cam, drf, n in ((0.0, 0.5, 60), (0.185, 0.45, 200), (0.30, 0.35, 120)):
        up, lo = geo.sail_section(cam, drf, 3.9, 0.015, n=n)
        s = geo.extrude_section(up, lo, 0.4)
        w = geo.watertight(s)
        check("сечение паруса замкнуто: пузо %.3f, %d точек" % (cam, n),
              w["watertight"], json.dumps(w))
        check("сечение паруса ориентировано наружу: пузо %.3f" % cam,
              geo.volume_m3(s) > 0, "V = %.6f" % geo.volume_m3(s))
        got = float(np.max(np.abs(0.5 * (up[:, 1] + lo[:, 1])))) / 3.9
        check("пузо сечения выдержано: заказано %.3f" % cam,
              near(got, cam, 0.006), "вышло %.4f" % got)
    # Толщина задней кромки конечна и не меньше заказанной: иначе её не
    # разрешит ни склейка геометрии, ни сетка.
    up, lo = geo.sail_section(0.185, 0.45, 3.9, 0.015, n=200,
                              te_thickness=0.003)
    # Толщина меряется по РАССТОЯНИЮ между кромочными точками, а не по разности
    # ординат: у сечения с пузом обшивка наклонена, и вертикальный зазор меньше
    # настоящей толщины на косинус наклона. Первая версия проверки мерила
    # ординаты и падала на совершенно исправной геометрии.
    te = float(np.hypot(*(up[-1] - lo[-1]))) / 3.9
    check("задняя кромка сечения обрезана по заданной толщине",
          te >= 0.003 * 0.98, "вышло %.4f хорды" % te)

    loop = geo.naca_symmetric(0.12, 1.0, 60)
    check("профиль NACA 0012 имеет верную наибольшую толщину",
          near(2 * loop[:, 1].max(), 0.12, 0.002),
          "%.4f" % (2 * loop[:, 1].max()))

    # Вывернутый контур обязан дать то же тело: обход приводится к единому.
    flipped = geo.extrude(loop[::-1], 0.1)
    check("вывернутый контур не даёт вывернутого тела",
          geo.volume_m3(flipped) > 0, "V = %.6f" % geo.volume_m3(flipped))

    # Дырка обязана обнаруживаться: выбрасывается один треугольник.
    holed = geo.extrude(loop, 0.1)[:-1]
    check("выброшенный треугольник ломает замкнутость",
          not geo.watertight(holed)["watertight"])

    box = np.array([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]], dtype=float)
    moved = geo.to_cfd_axes(box)
    check("перевод осей применяется к каждой вершине",
          tuple(moved[0][1]) == (1.0, 0.0, 0.0)
          and tuple(moved[0][2]) == (0.0, 0.0, 1.0), str(moved[0]))

    # Запись и чтение STL: тело обязано пережить круг без потерь.
    tris = geo.extrude(loop, 0.1)
    p_stl = os.path.join(tmp, "round.stl")
    geo.write_stl_ascii(p_stl, [("round", tris)])
    back = geo.read_stl(p_stl)
    check("STL переживает запись и чтение",
          back.shape == tris.shape
          and float(np.abs(back - tris).max()) < 1e-6,
          "%s, макс. расхождение %.2e" % (back.shape,
                                          float(np.abs(back - tris).max())))
finally:
    shutil.rmtree(tmp, ignore_errors=True)


# --- разбор истории сил -------------------------------------------------------

print("\nИстория сил и статистика\n")

tmp = tempfile.mkdtemp(prefix="sv20-cfd-forces-")
try:
    d = os.path.join(tmp, "postProcessing", "forces", "0")
    os.makedirs(d)
    # Ряд с затухающим переходом и наложенным колебанием известной частоты.
    t = np.linspace(0.0, 20.0, 2001)
    fxs = -100.0 + 40.0 * np.exp(-t) + 2.0 * np.sin(2 * np.pi * 0.5 * t)
    lines = ["# Time (total_x total_y total_z) (pressure) (viscous)"]
    for ti, v in zip(t, fxs):
        lines.append("%.6f ((%.8f 3.0 -1.0) (%.8f 2.0 -0.5) (%.8f 1.0 -0.5))"
                     % (ti, v, v * 0.8, v * 0.2))
    with open(os.path.join(d, "force.dat"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(d, "moment.dat"), "w", encoding="utf-8") as f:
        f.write("# Time (total)\n")
        f.write("\n".join("%.6f ((0.5 -0.25 7.0))" % ti for ti in t) + "\n")

    run = fx.read_run(os.path.join(tmp, "postProcessing"))
    check("новый формат force.dat разбирается",
          run["force"]["total"].shape == (2001, 3),
          str(run["force"]["total"].shape))
    check("сумма и составляющие читаются раздельно",
          run["force"]["pressure"] is not None
          and run["force"]["viscous"] is not None)

    s = fx.summarise(run["force"], start=10.0)
    check("среднее берётся по окну, а не по всему ряду",
          near(s["Fx"]["mean"], -100.0, 0.2), "%.4f" % s["Fx"]["mean"])
    check("окно усреднения записано в сводку",
          near(s["Fx"]["window"][0], 10.0, 0.02), str(s["Fx"]["window"]))
    check("размах колебания попадает в сводку",
          near(s["Fx"]["range"], 4.0, 0.2), "%.4f" % s["Fx"]["range"])
    check("основная частота найдена",
          near(s["Fx"]["frequency"]["hz"], 0.5, 0.05),
          "%.4f Гц" % s["Fx"]["frequency"]["hz"])
    check("постоянная сила не объявляется дрейфующей",
          s["Fy"]["drift"] < 1e-6, "%.3e" % s["Fy"]["drift"])

    # Тот же ряд, но окно взято по всему расчёту: переход обязан дать дрейф.
    s_all = fx.summarise(run["force"], start=0.0)
    check("окно с начальным переходом помечается дрейфом",
          s_all["Fx"]["drift"] > 1.0, "%.3f" % s_all["Fx"]["drift"])

    # Старый формат: две группы, суммы нет.
    d2 = os.path.join(tmp, "post2", "forces", "0")
    os.makedirs(d2)
    with open(os.path.join(d2, "forces.dat"), "w", encoding="utf-8") as f:
        f.write("# Time (pressure) (viscous)\n")
        f.write("1.0 ((8.0 1.0 0.0) (2.0 1.0 0.0))\n")
        f.write("2.0 ((8.0 1.0 0.0) (2.0 1.0 0.0))\n")
    old = fx.read_run(os.path.join(tmp, "post2"))
    check("старый формат складывает давление и вязкость",
          near(float(old["force"]["total"][0][0]), 10.0),
          str(old["force"]["total"][0]))
finally:
    shutil.rmtree(tmp, ignore_errors=True)


# --- сеточная сходимость ------------------------------------------------------

print("\nСеточная сходимость\n")

# Изготовленное решение: f(h) = 10 − 3·h². Порядок известен и равен двум,
# точный ответ известен и равен десяти. Метод обязан вернуть оба.
cells = {"coarse": 8000, "medium": 27000, "fine": 91125}


def manufactured(n, p=2.0):
    h = conv.representative_size(n)
    return 10.0 - 3.0 * h ** p


vals = {k: manufactured(v) for k, v in cells.items()}
r = conv.triple(vals, cells, "attached")
check("наблюдаемый порядок изготовленного решения равен двум",
      near(r["order"], 2.0, 0.01), "%.5f" % r["order"])
check("экстраполяция Ричардсона возвращает точный ответ",
      near(r["extrapolated"], 10.0, 1e-6), "%.8f" % r["extrapolated"])
check("сходимость признана монотонной", r["monotonic"])
check("GCI мал там, где решение почти сошлось",
      r["gci_fine"] < 0.01, "%.5f" % r["gci_fine"])

r4 = conv.triple({k: manufactured(v, 4.0) for k, v in cells.items()},
                 cells, "attached")
check("порядок четыре тоже опознаётся", near(r4["order"], 4.0, 0.02),
      "%.5f" % r4["order"])

# Ворота: разность medium→fine больше порога обязана валить проверку.
bad = conv.triple({"coarse": 1.0, "medium": 1.20, "fine": 1.10}, cells,
                  "attached")
check("разность больше 2% не проходит ворота присоединённого течения",
      not bad["gate"]["passed"], "; ".join(bad["gate"]["problems"]))
check("двухфазному течению позволено 5%",
      conv.GATES["two-phase"] > conv.GATES["attached"])

drifting = conv.triple(vals, cells, "attached", drift=3.0)
check("дрейф на окне валит сеточную проверку",
      not drifting["gate"]["passed"], "; ".join(drifting["gate"]["problems"]))

check("немонотонная сходимость помечается",
      not conv.gci(1.0, 1.2, 1.1, cells["fine"], cells["medium"],
                   cells["coarse"])["monotonic"])
check("совпавшие решения не дают выдуманного порядка",
      conv.observed_order(0.0, 0.0, 1.5, 1.5) is None)


# --- разворачивание шаблонов --------------------------------------------------

print("\nШаблоны и разворачивание\n")

TEMPLATES = os.path.join(ROOT, "cfd", "templates")
tmp = tempfile.mkdtemp(prefix="sv20-cfd-gen-")
try:
    geom = os.path.join(tmp, "geom")
    # Толще любого слоя домена: заглушка обязана удовлетворять тому же
    # правилу, что и настоящие тела, иначе проверка проверяет саму себя.
    geo.canonical(geom, span=0.4, chord=1.0)
    # Тела лодки для случаев, которым они нужны, подменяются канонической
    # заглушкой: здесь проверяется разворачивание, а не обводы.
    # Заглушки под тела, которых в каноническом наборе нет: здесь проверяется
    # разворачивание, а не обводы. Список берётся из самих случаев, а не
    # пишется руками — иначе новый случай молча остаётся непроверенным, что уже
    # случилось с сечениями генакера.
    for _p, m in found:
        for name in (m["geometry"].get("bodies") or m["geometry"]["files"]):
            dst = os.path.join(geom, name + ".stl")
            if not os.path.exists(dst):
                shutil.copyfile(os.path.join(geom, "sign_probe.stl"), dst)

    seen_templates = set()
    for path, m in found:
        dst = os.path.join(tmp, "runs", m["case_id"])
        try:
            rec = openfoam.generate(m, TEMPLATES, dst, geometry_dir=geom,
                                    force=True)
        except openfoam.TemplateError as e:
            check("разворачивается: " + m["case_id"], False, str(e))
            continue
        seen_templates.add(m["template"])
        left = []
        for rel_p in rec["written"]:
            if rel_p.endswith(".stl"):
                continue
            with open(os.path.join(dst, rel_p), encoding="utf-8") as f:
                if openfoam.PLACEHOLDER.search(f.read()):
                    left.append(rel_p)
        check("разворачивается без остатка: " + m["case_id"], not left,
              ", ".join(left))

    check("развёрнуты все шаблоны из схемы",
          seen_templates == set(manifest.TEMPLATES),
          "не задеты: " + ", ".join(sorted(set(manifest.TEMPLATES)
                                           - seen_templates)))

    # Наследование: шаблон VOF обязан взять fvSolution свой, а
    # surfaceFeatureExtractDict — от предка.
    files = openfoam.resolve(TEMPLATES, "openfoam-vof")
    check("наследование берёт файл предка",
          "system/surfaceFeatureExtractDict" in files)
    check("файл потомка перекрывает предка",
          "openfoam-vof" in files["system/fvSolution"])

    # Грязный запуск обязан обнаруживаться по отпечаткам.
    victim = os.path.join(tmp, "runs", found[0][1]["case_id"])
    check("чистый каталог признаётся чистым",
          openfoam.verify_clean(victim) == [])
    with open(os.path.join(victim, "system", "fvSolution"), "a",
              encoding="utf-8") as f:
        f.write("\n// правка руками\n")
    check("правка руками делает запуск грязным",
          any("fvSolution" in x for x in openfoam.verify_clean(victim)))
    os.remove(os.path.join(victim, "system", "fvSchemes"))
    check("удалённый файл тоже виден",
          any("fvSchemes" in x for x in openfoam.verify_clean(victim)))

    # Маска патчей тела обязана ловить составные имена. `snappyHexMesh`
    # называет патч по паре «файл_solid»: тело `keel` из двух solid'ов даёт
    # `keel_keel_fin`. Без хвоста `.*` решатель падает уже ПОСЛЕ построения
    # сетки — минута на случай, и так двенадцать раз подряд.
    import re as _re
    for _p, m in found:
        c = openfoam.context(m, geom)
        mask = c["wall_patches"].strip('"')
        for body in m["geometry"]["files"]:
            if not _re.fullmatch(mask, body + "_part"):
                check("маска патчей ловит составное имя: " + m["case_id"],
                      False, "%s не ловит %s_part" % (mask, body))
    check("маска патчей ловит и простое имя, и составное",
          all(_re.fullmatch(openfoam.context(m, geom)["wall_patches"].strip('"'),
                            b) and
              _re.fullmatch(openfoam.context(m, geom)["wall_patches"].strip('"'),
                            b + "_solid")
              for _p, m in found for b in m["geometry"]["files"]))

    # Рёбра тела обязаны быть ПЕРЕДАНЫ сеточнику, а не только извлечены.
    # Пустой список `features` — самая дорогая из найденных ошибок: работа
    # `surfaceFeatureExtract` пропадала впустую, задняя кромка пера скруглялась,
    # и поляра киля вышла втрое ниже модели. Ничего при этом не падало.
    for _p, m in found:
        c = openfoam.context(m, geom)
        bodies = m["geometry"].get("bodies") or sorted(m["geometry"]["files"])
        if c["features_block"].count(".eMesh") != len(bodies):
            check("рёбра переданы сеточнику: " + m["case_id"], False,
                  c["features_block"][:120])
        if c["extract_block"].count("extractionMethod") != len(bodies):
            check("рёбра извлекаются у всех тел: " + m["case_id"], False,
                  c["extract_block"][:120])
    check("рёбра каждого тела извлекаются и передаются сеточнику",
          all(openfoam.context(m, geom)["features_block"].count(".eMesh")
              == len(m["geometry"].get("bodies")
                     or m["geometry"]["files"])
              and openfoam.context(m, geom)["extract_block"]
              .count("extractionMethod")
              == len(m["geometry"].get("bodies") or m["geometry"]["files"])
              for _p, m in found))
    # Уровень на ребре обязан быть не ниже поверхностного: ребро сгущают,
    # чтобы разрешить кромку, а не чтобы отметить её.
    check("уровень на ребре не ниже поверхностного",
          all(openfoam.context(m, geom)["feature_level"]
              >= openfoam.context(m, geom)["refine_max"] for _p, m in found))

    # Кромка обязана быть разрешена сеткой, а не просто объявлена ребром.
    # Ячейка у поверхности крупнее толщины кромки означает, что кромки в
    # расчёте нет, какие бы рёбра ей ни назначили.
    for _p, m in found:
        if m["family"] != "appendages":
            continue
        c = openfoam.context(m, geom)
        cell = c["base_size_m"] / (2 ** c["feature_level"])
        te = 0.0164 * m["reference"].get("chord_m", m["reference"]["length_m"])
        if cell > 0.5 * te:
            check("кромка пера разрешена сеткой: " + m["case_id"], False,
                  "ячейка на ребре %.5f м, толщина кромки %.5f м" % (cell, te))
    check("у всех случаев киля кромка разрешена хотя бы двумя ячейками",
          all((openfoam.context(m, geom)["base_size_m"]
               / (2 ** openfoam.context(m, geom)["feature_level"]))
              <= 0.5 * 0.0164 * m["reference"].get("chord_m",
                                                   m["reference"]["length_m"])
              for _p, m in found if m["family"] == "appendages"))

    # Плоский случай: тело обязано быть ТОЛЩЕ слоя домена и пересекать обе
    # плоскости симметрии насквозь. Совпадение торца тела с границей домена
    # сеточник обрабатывает плохо — торцы приходится и снимать, и притягивать
    # одновременно, — и на профиле NACA это стоило незакрытого случая.
    for _p, m in found:
        if m["template"] != "openfoam-2d":
            continue
        c = openfoam.context(m, geom)
        for name in (m["geometry"].get("bodies") or m["geometry"]["files"]):
            stl = os.path.join(geom, name + ".stl")
            if not os.path.exists(stl):
                continue
            bb = geo.bbox_m(geo.read_stl(stl))
            if bb["min_m"][2] > c["span_lo"] - 1e-9 \
                    or bb["max_m"][2] < c["span_hi"] + 1e-9:
                check("тело плоского случая толще слоя: " + m["case_id"], False,
                      "тело z %.3f…%.3f, слой %.3f…%.3f"
                      % (bb["min_m"][2], bb["max_m"][2],
                         c["span_lo"], c["span_hi"]))
    def _thicker(m):
        c = openfoam.context(m, geom)
        for name in (m["geometry"].get("bodies") or m["geometry"]["files"]):
            stl = os.path.join(geom, name + ".stl")
            if not os.path.exists(stl):
                continue
            bb = geo.bbox_m(geo.read_stl(stl))
            if bb["min_m"][2] > c["span_lo"] - 1e-9 \
                    or bb["max_m"][2] < c["span_hi"] + 1e-9:
                return False
        return True

    check("у плоских случаев тело толще слоя домена",
          all(_thicker(m) for _p, m in found
              if m["template"] == "openfoam-2d"))

    # Области сгущения: ящик обязан попасть в словарь сеточника, иначе переход
    # от фоновой ячейки к поверхностной идёт в один скачок и сеточник его
    # срезает — на профиле остаётся тридцать ячеек на хорду.
    boxed = [m for _p, m in found if m["mesh"].get("regions")]
    if boxed:
        c = openfoam.context(boxed[0], geom)
        check("ящики сгущения попадают в словарь",
              c["regions_block"].count("mode inside")
              == len(boxed[0]["mesh"]["regions"]))
        check("ящики объявлены геометрией",
              c["geometry_block"].count("searchableBox")
              == len(boxed[0]["mesh"]["regions"]))
    dist = [m for _p, m in found if m["mesh"].get("surface_distance")]
    if dist:
        c = openfoam.context(dist[0], geom)
        check("сгущение по расстоянию попадает в словарь",
              "mode distance" in c["regions_block"])

    # Явные уровни сгущения отменяют масштабирование фоновой ячейки: иначе
    # тройка сгущалась бы дважды, и наблюдаемый порядок считался бы не по тому
    # отношению.
    expl = [m for _p, m in found if m["mesh"].get("refine")]
    if expl:
        sizes = {}
        for m in expl:
            if m["convergence_group"] not in sizes:
                sizes[m["convergence_group"]] = set()
            sizes[m["convergence_group"]].add(
                round(openfoam.context(m, geom)["base_size_m"], 9))
        check("при явных уровнях фоновая ячейка одна на всю тройку",
              all(len(v) == 1 for v in sizes.values()),
              str({k: sorted(v) for k, v in sizes.items() if len(v) > 1}))

    # Поток: угол атаки обязан поворачивать вектор, а не сетку.
    m2d = [m for _p, m in found if m["condition"].get("alpha_deg")][0]
    ctx = openfoam.context(m2d, geom)
    got = math.degrees(math.atan2(-ctx["U_y"], -ctx["U_x"]))
    check("угол атаки задан поворотом вектора потока",
          near(got, m2d["condition"]["alpha_deg"], 1e-6),
          "%.6f против %.6f" % (got, m2d["condition"]["alpha_deg"]))
    check("модуль скорости сохраняется при повороте",
          near(ctx["U_mag"], m2d["condition"]["speed_ms"], 1e-6))

    # Точка засева обязана лежать внутри домена и снаружи тела.
    for _path, m in found:
        c = openfoam.context(m, geom)
        inside = (c["dom_xmin"] < c["seed_x"] < c["dom_xmax"]
                  and c["dom_ymin"] < c["seed_y"] < c["dom_ymax"])
        if not inside:
            check("точка засева внутри домена: " + m["case_id"], False,
                  "(%g %g %g)" % (c["seed_x"], c["seed_y"], c["seed_z"]))
    check("точка засева всех случаев внутри домена",
          all((openfoam.context(m, geom)["dom_xmin"]
               < openfoam.context(m, geom)["seed_x"]
               < openfoam.context(m, geom)["dom_xmax"])
              for _p, m in found))
finally:
    shutil.rmtree(tmp, ignore_errors=True)


# --- правило статуса ----------------------------------------------------------

print("\nПравило статуса\n")

st, d = report.status_point(1.05, 1.00, 0.10)
check("расхождение внутри неопределённости — ok", st == "ok", "%.3f" % d)
st, d = report.status_point(1.30, 1.00, 0.10)
check("расхождение больше неопределённости — investigate",
      st == "investigate")

single = [{"quantity": "Cl", "status": "investigate", "delta": +0.3}]
report.status_family(single)
check("одиночная точка не становится поводом менять модель",
      single[0]["status"] == "investigate")

many = [{"quantity": "Cl", "status": "investigate", "delta": +0.3}
        for _ in range(report.NEIGHBOURS)]
report.status_family(many)
check("несколько соседних одного знака — model-change",
      all(p["status"] == "model-change" for p in many))

mixed = [{"quantity": "Cl", "status": "investigate", "delta": +0.3},
         {"quantity": "Cl", "status": "investigate", "delta": -0.3},
         {"quantity": "Cl", "status": "investigate", "delta": +0.3}]
report.status_family(mixed)
check("разнознаковые расхождения не складываются в системное",
      all(p["status"] == "investigate" for p in mixed))

split = [{"quantity": "Cl", "status": "investigate", "delta": +0.3},
         {"quantity": "Cd", "status": "investigate", "delta": +0.3},
         {"quantity": "Cmz", "status": "investigate", "delta": +0.3}]
report.status_family(split)
check("расхождения по разным величинам не считаются соседями",
      all(p["status"] == "investigate" for p in split))

check("неопределённость складывается квадратично",
      near(report.combined_uncertainty(3.0, 4.0), 5.0))
check("порог снизу не даёт нулевой неопределённости",
      near(report.combined_uncertainty(0.0, 0.0, floor=0.5), 0.5))


# --- вопросы к симулятору -----------------------------------------------------

print("\nМост к realtime-модели\n")

for path, m in found:
    try:
        req, pairs = simbridge.request_for(m)
    except simbridge.BridgeError as e:
        check("вопрос задан для семейства " + m["family"], False, str(e))
        continue
    if m["family"] in ("verification", "waves"):
        check("для %s вопрос к симулятору не выдумывается" % m["family"],
              req is None)
    else:
        check("вопрос задан: " + m["case_id"], req is not None and bool(pairs))

ok, why = simbridge.available()
if not ok:
    print("  —      живой мост пропущен: %s" % why)
else:
    a = simbridge.query([
        {"fn": "hullResistance", "speed_ms": 2.5, "heel_deg": 0.0},
        {"fn": "hullResistance", "speed_ms": 3.5, "heel_deg": 0.0},
        {"fn": "polar", "alpha_deg": 8.0, "camber": 0.1},
        {"fn": "hullLateral", "speed_ms": 2.5, "heel_deg": 0.0,
         "leeway_deg": 4.0, "yaw_rate_nd": 0.0},
        {"fn": "hullLateral", "speed_ms": 2.5, "heel_deg": 0.0,
         "leeway_deg": -4.0, "yaw_rate_nd": 0.0},
        {"fn": "foilForce", "foil": "keel", "speed_ms": 2.0,
         "leeway_deg": 6.0, "deflect_deg": 0.0},
    ])
    check("симулятор отвечает на пакет запросов", len(a) == 6)
    check("сопротивление растёт со скоростью", a[1]["rt_n"] > a[0]["rt_n"],
          "%.2f -> %.2f Н" % (a[0]["rt_n"], a[1]["rt_n"]))
    check("поляра даёт положительную подъёмную на положительном угле",
          a[2]["cl"] > 0, "Cl = %.4f" % a[2]["cl"])
    check("боковая сила корпуса меняет знак вместе с дрейфом",
          near(a[3]["fy_n"], -a[4]["fy_n"], 1e-9)
          and abs(a[3]["fy_n"]) > 1e-6,
          "%.4f и %.4f Н" % (a[3]["fy_n"], a[4]["fy_n"]))
    # Проверяется работа силы, а НЕ знак её продольной составляющей. Первая
    # версия требовала fx < 0 и была неправа: на дрейфе подъёмная сила киля
    # перпендикулярна местному потоку, а не диаметрали, и её проекция на ось
    # «в нос» перекрывает профильное сопротивление. Fx у киля действительно
    # положительна — а вот работать движителем крыло не может, и это условие
    # проверяется вдоль его собственной скорости.
    b = math.radians(6.0)
    along = a[5]["fx"] * math.cos(b) + a[5]["fy"] * math.sin(b)
    check("киль отбирает энергию, а не отдаёт", along < 0, "%.3f Н" % along)
    # Тот же знак дрейфа, что и в осях CFD: сносит в +Y, крыло держит в −Y.
    check("киль держит против сноса", a[5]["fy"] < 0, "%.3f Н" % a[5]["fy"])


# --- сквозной путь: собрать -> сходимость -> отчёт ----------------------------

print("\nСквозной разбор тройки сеток\n")

# Решателя на этой машине нет, поэтому его вывод изготавливается. Проверяется
# не физика, а цепочка: разбор истории сил, перевод в коэффициенты, сборка
# тройки по `convergence_group` и ворота §4.2. Сила задана как
# Rt(h) = 137 − 90·h², то есть с известным порядком и известным пределом.

import cfd.cfd as cli                                # noqa: E402

tmp = tempfile.mkdtemp(prefix="sv20-cfd-e2e-")
try:
    geom = os.path.join(tmp, "geom")
    # Толще любого слоя домена: заглушка обязана удовлетворять тому же
    # правилу, что и настоящие тела, иначе проверка проверяет саму себя.
    geo.canonical(geom, span=0.4, chord=1.0)
    # Заглушки под тела, которых в каноническом наборе нет: здесь проверяется
    # разворачивание, а не обводы. Список берётся из самих случаев, а не
    # пишется руками — иначе новый случай молча остаётся непроверенным, что уже
    # случилось с сечениями генакера.
    for _p, m in found:
        for name in (m["geometry"].get("bodies") or m["geometry"]["files"]):
            dst = os.path.join(geom, name + ".stl")
            if not os.path.exists(dst):
                shutil.copyfile(os.path.join(geom, "sign_probe.stl"), dst)
    triple = [(p, m) for p, m in found
              if m["convergence_group"] == "naca0012-a10"]
    check("тройка naca0012-a10 найдена целиком", len(triple) == 3)

    CELLS = {"coarse": 8000, "medium": 27000, "fine": 91125}
    RT_EXACT, C = 137.0, 90.0

    saved_sum, saved_reports = cli.OUT_SUM, cli.REPORTS
    cli.OUT_SUM = os.path.join(tmp, "summaries")
    cli.REPORTS = os.path.join(tmp, "reports")
    try:
        for path, m in sorted(triple, key=lambda x: x[1]["mesh"]["level"]):
            lvl = m["mesh"]["level"]
            run = os.path.join(tmp, "runs", m["case_id"])
            openfoam.generate(m, TEMPLATES, run, geometry_dir=geom, force=True)
            q = manifest.dynamic_pressure(m)
            h = conv.representative_size(CELLS[lvl])
            rt = RT_EXACT - C * h ** 2

            d = os.path.join(run, "postProcessing", "forces", "0")
            os.makedirs(d)
            ts = np.linspace(0.0, 3000.0, 601)
            with open(os.path.join(d, "force.dat"), "w", encoding="utf-8") as f:
                f.write("# Time (total) (pressure) (viscous)\n")
                for ti in ts:
                    # Сопротивление есть −Fx, поэтому Fx отрицателен.
                    #
                    # Постоянная затухания намеренно мала: у случаев тройки
                    # окна усреднения разные (2000 и 2500 итераций), и медленно
                    # затухающий переход попадал бы в них по-разному. Первая
                    # версия ставила /300, и оценка порядка сползала с 2.00 на
                    # 1.94 — не из-за метода, а из-за того, что на трёх сетках
                    # усреднялись разные куски переходного процесса. Это же
                    # ровно та ошибка, от которой предостерегает §4.3.
                    fxi = -rt + 5.0 * math.exp(-ti / 100.0)
                    f.write("%.4f ((%.8f 12.0 -3.0) (%.8f 9.0 -2.0) "
                            "(%.8f 3.0 -1.0))\n"
                            % (ti, fxi, fxi * 0.7, fxi * 0.3))
            with open(os.path.join(d, "moment.dat"), "w", encoding="utf-8") as f:
                f.write("# Time (total)\n")
                for ti in ts:
                    f.write("%.4f ((1.5 -0.75 4.0))\n" % ti)

            logs = os.path.join(run, "log")
            os.makedirs(logs)
            with open(os.path.join(logs, "checkMesh.log"), "w",
                      encoding="utf-8") as f:
                f.write("    cells:  %d\n" % CELLS[lvl])
                f.write("Max non-orthogonality = 42.1 average: 5.3\n")
                f.write("Max skewness = 2.9 OK.\n")
                f.write("Mesh OK.\n")
            with open(os.path.join(logs, "simpleFoam.log"), "w",
                      encoding="utf-8") as f:
                f.write("Solving for Ux, Initial residual = 1e-2\n")
                f.write("Solving for Ux, Initial residual = 4e-7\n")
                f.write("y+ : min: 21 max: 84 average: 43\n")
                f.write("time step continuity errors : sum local = 1e-9, "
                        "global = -2e-12, cumulative = 3e-11\n")

            rc = cli.cmd_collect(type("A", (), {"run": run, "window": 0.5})())
            check("сводка собрана: " + m["case_id"], rc == 0)

            with open(os.path.join(cli.OUT_SUM, m["case_id"] + ".json"),
                      encoding="utf-8") as f:
                s = json.load(f)
            if lvl == "medium":
                check("сопротивление снято как −Fx",
                      near(s["derived"]["Rt_n"], rt, 0.05),
                      "%.4f против %.4f" % (s["derived"]["Rt_n"], rt))
                # Cx — в связанных осях, и он равен −Fx/(qS) всегда.
                check("Cx посчитан по записанному основанию",
                      near(s["derived"]["Cx"],
                           rt / (q * m["reference"]["area_m2"]), 1e-3))
                # Cd и Cl — ОТНОСИТЕЛЬНО ПОТОКА, и на угле атаки в десять
                # градусов это другие числа. Проверяются независимым
                # разложением того же вектора силы по тем же ортам: если
                # коллектор перепутает оси, совпадения не будет.
                al = s["flow_frame"]["along"]
                cr = s["flow_frame"]["cross"]
                F = [s["derived"][k] for k in ("Fx", "Fy", "Fz")]
                qa = q * m["reference"]["area_m2"]
                check("Cd — проекция силы на направление потока",
                      near(s["derived"]["Cd"],
                           sum(F[i] * al[i] for i in range(3)) / qa, 1e-9))
                check("Cl — проекция силы поперёк потока",
                      near(s["derived"]["Cl"],
                           sum(F[i] * cr[i] for i in range(3)) / qa, 1e-9))
                check("на угле атаки Cd и Cx — разные числа",
                      abs(s["derived"]["Cd"] - s["derived"]["Cx"]) > 1e-4,
                      "Cd %.5f, Cx %.5f" % (s["derived"]["Cd"],
                                            s["derived"]["Cx"]))
                check("орты потока единичны и ортогональны",
                      near(sum(x * x for x in al), 1.0, 1e-9)
                      and near(sum(x * x for x in cr), 1.0, 1e-9)
                      and near(sum(al[i] * cr[i] for i in range(3)), 0.0, 1e-9))
                check("основание коэффициента лежит рядом с ним",
                      set(s["coefficient_basis"]) >=
                      {"area_m2", "length_m", "rho", "speed_ms", "q_pa"})
                check("силы записаны в обеих системах",
                      near(s["frames"]["export"]["force_n"][1],
                           s["frames"]["cfd"]["force_n"][2]),
                      json.dumps(s["frames"]["export"]["force_n"]))
                check("число ячеек попало в сводку из checkMesh",
                      s["mesh"]["cells"] == CELLS[lvl])
                check("y+ попал в сводку", s["yplus"]["max"] == 84.0)
                check("баланс неразрывности попал в сводку",
                      s["continuity"]["cumulative"] == 3e-11)
                check("грязным запуск не считается", s["clean"])

        res = cli.convergence_results("verification")
        rt_rows = [(n, r) for n, r, _w in res if r and n.endswith("Cd")]
        check("тройка собралась в оценку сходимости", len(rt_rows) == 1,
              "; ".join(n for n, _r, _w in res))
        if rt_rows:
            r = rt_rows[0][1]
            check("порядок изготовленного сопротивления равен двум",
                  near(r["order"], 2.0, 0.05), "%.4f" % r["order"])
            check("ворота присоединённого течения пройдены",
                  r["gate"]["passed"], "; ".join(r["gate"]["problems"]))

        # Сравнение с симулятором: тройка корпуса, у которой вопрос к модели
        # есть. Проверяется главное — что неопределённость строки берётся из
        # сеточной оценки, а не из одного разброса на окне. Разброс о сеточной
        # ошибке не знает ничего, и §4.5.2 по нему проверять нельзя.
        ok_bridge, _why = simbridge.available()
        if not ok_bridge:
            print("  —      сравнение пропущено: нет моста к симулятору")
        else:
            hull = [(p, m) for p, m in found
                    if m["convergence_group"] == "hull-u250-heel0"]
            check("тройка корпуса найдена целиком", len(hull) == 3)
            for path, m in hull:
                lvl = m["mesh"]["level"]
                run = os.path.join(tmp, "runs", m["case_id"])
                openfoam.generate(m, TEMPLATES, run, geometry_dir=geom,
                                  force=True)
                h = conv.representative_size(CELLS[lvl])
                rt = 150.0 - 60.0 * h ** 2
                d = os.path.join(run, "postProcessing", "forces", "0")
                os.makedirs(d)
                with open(os.path.join(d, "force.dat"), "w",
                          encoding="utf-8") as f:
                    f.write("# Time (total) (pressure) (viscous)\n")
                    for ti in np.linspace(16.0, 25.0, 181):
                        f.write("%.4f ((%.8f 0.0 0.0) (%.8f 0.0 0.0) "
                                "(%.8f 0.0 0.0))\n"
                                % (ti, -rt, -rt * 0.6, -rt * 0.4))
                with open(os.path.join(d, "moment.dat"), "w",
                          encoding="utf-8") as f:
                    f.write("# Time (total)\n")
                    for ti in np.linspace(16.0, 25.0, 181):
                        f.write("%.4f ((0.0 -40.0 0.0))\n" % ti)
                logs = os.path.join(run, "log")
                os.makedirs(logs)
                with open(os.path.join(logs, "checkMesh.log"), "w",
                          encoding="utf-8") as f:
                    f.write("    cells:  %d\nMesh OK.\n" % CELLS[lvl])
                cli.cmd_collect(type("A", (), {"run": run, "window": 0.5})())

            gcis = [r["gci_fine"] for n, r, _w
                    in cli.convergence_results("hull-resistance")
                    if r and r["gci_fine"] is not None]
            check("для тройки корпуса посчитан GCI", bool(gcis))

            rows, points = cli.compare_rows("hull-resistance")
            check("сравнение построило строки", bool(rows), "%d" % len(rows))
            uncs = {p["uncertainty"] for p in points}
            check("неопределённость строки взята из сеточной оценки",
                  all(u > 0 for u in uncs)
                  and any(near(u, max(gcis) * abs(p["cfd"]), 1e-9)
                          for p in points for u in [p["uncertainty"]]),
                  "GCI %.5f, неопределённости %s"
                  % (max(gcis), sorted(round(u, 4) for u in uncs)))
            check("статус проставлен каждой строке",
                  all(p["status"] in ("ok", "investigate", "model-change")
                      for p in points))

        rc = cli.cmd_report(type("A", (), {"family": "verification"})())
        check("отчёт собирается", rc == 0)
        text = open(os.path.join(cli.REPORTS, "verification.md"),
                    encoding="utf-8").read()
        check("в отчёте есть таблица сходимости", "наблюдаемый порядок" in text)
        check("в отчёте записаны сами разности, а не только вердикт",
              "разность medium→fine" in text)
    finally:
        cli.OUT_SUM, cli.REPORTS = saved_sum, saved_reports
finally:
    shutil.rmtree(tmp, ignore_errors=True)


print("\nвсего плохо: %d" % failures)
sys.exit(1 if failures else 0)
