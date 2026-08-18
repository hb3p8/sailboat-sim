# -*- coding: utf-8 -*-
"""Подготовка геометрии для CFD (§3.2 docs/cfd-validation.md).

`scripts/export.py` уже пишет тела по отдельности и проверяет их на
замкнутость. Здесь не повторяется его работа, а делается то, чего realtime не
требовалось: перевод в связанные оси CFD, отчёт о замкнутости КАЖДОГО тела
после перевода, отпечатки входов и объединение тел в одну поверхность там, где
сеточнику нужна именно она.

Про объединение отдельно. Настоящая булева операция над оболочками здесь не
делается: писать надёжный CSG ради стыка киля с корпусом — несколько недель, а
`surfaceBooleanFeatures`/`snappyHexMesh` умеют работать с несколькими
пересекающимися поверхностями напрямую. Поэтому «объединение» — это один
многосоставный STL с именованными solid'ами: сеточник сам разбирается со
стыком, а имена нужны, чтобы силы снимались по телам раздельно.

Формат STL не хранит ни единиц, ни имён осей, поэтому рядом с каждым файлом
кладётся JSON-манифест. Без него метры от миллиметров отличает только чутьё.
"""

import json
import os
import struct

import numpy as np

from . import axes as ax
from . import hashing


# --- чтение и запись STL ------------------------------------------------------

def read_stl(path):
    """Двоичный или текстовый STL -> массив треугольников (n, 3, 3), float64."""
    with open(path, "rb") as f:
        head = f.read(84)
        if len(head) < 84:
            raise ValueError("%s: файл короче заголовка STL" % path)
        n = struct.unpack("<I", head[80:84])[0]
        rest = f.read()
    # Двоичный STL: 50 байт на треугольник. Если размер сошёлся — он двоичный,
    # даже когда начинается со слова "solid" (а он часто начинается).
    if len(rest) == 50 * n and n > 0:
        raw = np.frombuffer(rest, dtype=np.uint8).reshape(n, 50)
        vals = raw[:, 12:48].copy().view("<f4").reshape(n, 3, 3)
        return vals.astype(np.float64)
    return _read_stl_ascii(path)


def _read_stl_ascii(path):
    tris, cur = [], []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            w = line.split()
            if len(w) == 4 and w[0] == "vertex":
                cur.append([float(w[1]), float(w[2]), float(w[3])])
                if len(cur) == 3:
                    tris.append(cur)
                    cur = []
    if not tris:
        raise ValueError("%s: не разобрался ни как двоичный, ни как текстовый STL"
                         % path)
    return np.asarray(tris, dtype=np.float64)


def write_stl_ascii(path, solids):
    """Текстовый STL с именованными solid'ами.

    Именно текстовый и именно здесь: `snappyHexMesh` берёт из имени solid'а имя
    патча, а в двоичном формате имени нет вовсе. Файл получается втрое тяжелее,
    но он производный, лежит в `out/` и в git не попадает.
    """
    out = []
    for name, tris in solids:
        out.append("solid %s\n" % name)
        n = normals(tris)
        for t, nv in zip(tris, n):
            out.append("  facet normal %.7e %.7e %.7e\n" % tuple(nv))
            out.append("    outer loop\n")
            for v in t:
                out.append("      vertex %.7e %.7e %.7e\n" % tuple(v))
            out.append("    endloop\n  endfacet\n")
        out.append("endsolid %s\n" % name)
    with open(path, "w", encoding="ascii") as f:
        f.write("".join(out))
    return path


# --- свойства -----------------------------------------------------------------

def normals(tris):
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    L = np.linalg.norm(n, axis=1)
    L[L == 0] = 1.0
    return n / L[:, None]


def area_m2(tris):
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    return float(0.5 * np.linalg.norm(n, axis=1).sum())


def volume_m3(tris):
    """Знаковый объём. Отрицательный — нормали смотрят внутрь."""
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def bbox_m(tris):
    v = tris.reshape(-1, 3)
    lo, hi = v.min(axis=0), v.max(axis=0)
    return {"min_m": lo.tolist(), "max_m": hi.tolist(),
            "size_m": (hi - lo).tolist()}


def _weld_index(tris, tol_m=2e-5):
    """Индексы вершин после склейки с допуском. Допуск — в метрах.

    Двадцать микрон: мельче полотно чертежа всё равно не помнит, крупнее —
    начинают слипаться узлы задней кромки руля.
    """
    v = tris.reshape(-1, 3)
    keys = np.round(v / tol_m).astype(np.int64)
    _uniq, inv = np.unique(keys, axis=0, return_inverse=True)
    return inv.reshape(-1, 3)


def watertight(tris, tol_m=2e-5):
    """Отчёт о замкнутости: висящие, неманифольдные и разноориентированные рёбра.

    Считается на склеенных индексах, а не на координатах: сырой STL — суп
    треугольников, в нём каждое ребро уникально и любая оболочка выглядит
    дырявой.
    """
    idx = _weld_index(tris, tol_m)
    e = np.concatenate([idx[:, [0, 1]], idx[:, [1, 2]], idx[:, [2, 0]]])
    # Неориентированный ключ ребра и признак направления.
    lo = np.minimum(e[:, 0], e[:, 1])
    hi = np.maximum(e[:, 0], e[:, 1])
    fwd = (e[:, 0] < e[:, 1]).astype(np.int64)
    key = np.stack([lo, hi], axis=1)
    uniq, inv, counts = np.unique(key, axis=0, return_inverse=True,
                                  return_counts=True)
    n_fwd = np.bincount(inv, weights=fwd, minlength=len(uniq))
    boundary = int((counts == 1).sum())
    nonmanifold = int((counts > 2).sum())
    # Пара из двух одинаково направленных полурёбер — соседи смотрят в разные
    # стороны. Это не дырка, но нормали такой оболочки бесполезны.
    inconsistent = int(((counts == 2) & (n_fwd != 1)).sum())
    degenerate = int((idx[:, 0] == idx[:, 1]).sum()
                     + (idx[:, 1] == idx[:, 2]).sum()
                     + (idx[:, 2] == idx[:, 0]).sum())
    return {"tris": int(len(tris)), "verts": int(idx.max() + 1),
            "edges": int(len(uniq)), "boundary": boundary,
            "nonmanifold": nonmanifold, "inconsistent": inconsistent,
            "degenerate_tris": degenerate,
            "watertight": boundary == 0 and nonmanifold == 0
            and inconsistent == 0 and degenerate == 0}


# --- перевод осей -------------------------------------------------------------

_M = np.asarray(ax.EXPORT_TO_CFD, dtype=np.float64)


def to_cfd_axes(tris):
    """Треугольники из осей выгрузки в связанные оси CFD.

    Порядок вершин не трогается — и не должен: определитель перехода +1,
    зеркала нет, значит наружная нормаль остаётся наружной. Если однажды
    захочется поменять оси на зеркальные, обход придётся разворачивать, и
    тест определителя в tests/cfd.test.py об этом напомнит.
    """
    return tris @ _M.T


def place(tris, heel_deg=0.0, yaw_deg=0.0, origin_m=(0.0, 0.0, 0.0)):
    """Поставить тело в положение случая: крен, рыскание, снос начала координат.

    Крен и дрейф можно задавать двумя способами — поворачивать тело или
    поворачивать поток. Поток здесь поворачивается для ДРЕЙФА (он не меняет
    свободной поверхности), а тело — для КРЕНА: при VOF накренённый корпус
    обязан стоять относительно плоскости воды, а не относительно потока.
    """
    v = tris.reshape(-1, 3)
    if heel_deg:
        c, s = np.cos(np.radians(heel_deg)), np.sin(np.radians(heel_deg))
        R = np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
        v = v @ R.T
    if yaw_deg:
        c, s = np.cos(np.radians(yaw_deg)), np.sin(np.radians(yaw_deg))
        R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
        v = v @ R.T
    v = v - np.asarray(origin_m, dtype=np.float64)
    return v.reshape(-1, 3, 3)


# --- сборка -------------------------------------------------------------------

BODIES = ("hull", "keel_fin", "bulb", "rudder", "keel_case")

# Что с чем сшивается в одну поверхность. Корпус, колодец, киль и бульб для
# сеточника — одно тело: между ними нет воды, и щель в стыке сеточник примет за
# щель настоящую. Руль оставлен отдельным нарочно: он поворачивается.
UNIONS = {"underwater": ("hull", "keel_case", "keel_fin", "bulb"),
          "keel": ("keel_fin", "bulb"),
          "hull_only": ("hull", "keel_case")}
# Руля здесь нет ни в одном союзе, и это не упущение: он не касается ни киля,
# ни корпуса и в общую поверхность не сшивается. Первая версия сшивала его с
# килем в союз «appendages», и проверка связности честно назвала его
# оторванным — она оказалась права, а список неправ.


def prepare(src_dir, dst_dir, bodies=BODIES, unions=(), heel_deg=0.0,
            yaw_deg=0.0, origin_m=(0.0, 0.0, 0.0)):
    """Пересобрать выгрузку в CFD-геометрию и написать отчёт.

    Возвращает манифест: отпечаток каждого ВХОДНОГО файла, свойства каждого
    тела до и после перевода, отчёт о замкнутости и список написанного.
    """
    os.makedirs(dst_dir, exist_ok=True)
    report = {"schema": 1, "source_dir": os.path.relpath(src_dir),
              "axes_in": ax.AXES_EXPORT, "axes_out": ax.AXES_CFD,
              "transform": "X_cfd=X_exp, Y_cfd=-Z_exp, Z_cfd=Y_exp",
              "placement": {"heel_deg": heel_deg, "yaw_deg": yaw_deg,
                            "origin_m": list(origin_m)},
              "inputs": {}, "bodies": {}, "unions": {}, "files": {}}

    loaded = {}
    for name in bodies:
        src = os.path.join(src_dir, name + ".stl")
        if not os.path.exists(src):
            continue
        report["inputs"][name] = hashing.sha256_file(src)
        raw = read_stl(src)
        tris = place(to_cfd_axes(raw), heel_deg, yaw_deg, origin_m)
        loaded[name] = tris
        dst = os.path.join(dst_dir, name + ".stl")
        write_stl_ascii(dst, [(name, tris)])
        report["files"][name] = hashing.sha256_file(dst)
        report["bodies"][name] = {
            "watertight": watertight(tris),
            "area_m2": area_m2(tris),
            "volume_m3": volume_m3(tris),
            "bbox_m": bbox_m(tris),
        }

    if not loaded:
        raise ValueError("в %s не найдено ни одного тела: сначала `make export`"
                         % src_dir)

    for uname in unions:
        parts = [(n, loaded[n]) for n in UNIONS[uname] if n in loaded]
        if not parts:
            continue
        dst = os.path.join(dst_dir, uname + ".stl")
        write_stl_ascii(dst, parts)
        report["files"][uname] = hashing.sha256_file(dst)
        allt = np.concatenate([t for _n, t in parts])
        # Замкнутость СОСТАВНОЙ поверхности здесь не требуется и не проверяется:
        # тела пересекаются по стыкам, и «висящих рёбер нет» для них означало бы
        # только то, что их сшили заранее. Что важно и проверяется — что каждое
        # тело замкнуто по отдельности (выше) и что тела действительно
        # пересекаются, а не висят в сантиметре друг от друга.
        report["unions"][uname] = {
            "parts": [n for n, _t in parts],
            "tris": int(len(allt)),
            "bbox_m": bbox_m(allt),
            "connectivity": _connectivity(parts),
        }

    with open(os.path.join(dst_dir, "geometry.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1, sort_keys=True)
    return report


# --- канонические тела этапа 0 ------------------------------------------------
#
# Этап 0 (§5) обязан проверить решатель, сетку, оси и постобработку ДО того, как
# в дело пойдёт геометрия SV20. Для этого нужны тела с известным ответом, и
# строятся они здесь, а не берутся файлами: файл без скрипта через год никто не
# повторит, а тридцать строк тригонометрии повторяются всегда.


# Носок сечения обязан смотреть В ПОТОК, то есть лежать при БОЛЬШИХ x.
#
# Связанные оси CFD: X в нос, и набегающий поток идёт в сторону убывающего x
# (cfd/lib/axes.py, `onset_flow`). У обводов лодки это так само собой — нос
# корпуса стоит при x = 6.1, — а вот построенное здесь сечение по привычке
# аэродинамических таблиц начиналось с носка при x = 0 и встречало поток
# ХВОСТОМ. Обращённый профиль — это острый нос и тупая корма, он срывается
# сразу, и именно это показывали и NACA 0012 на десяти градусах, и сечение
# генакера, у которого пузо якобы снижало подъёмную силу вчетверо.
#
# Заодно переворачивается знак y: после разворота пузо должно выпирать в ту
# сторону, куда смотрит подъёмная сила при положительном угле атаки, иначе
# «положительное пузо» означало бы вогнутый в поток парус.
def _nose_to_flow(pts, chord):
    out = pts.copy()
    out[:, 0] = chord - out[:, 0]
    out[:, 1] = -out[:, 1]
    return out

def naca_symmetric(thickness=0.12, chord=1.0, n=120):
    """Контур симметричного профиля NACA 00xx, замкнутый на задней кромке.

    Точки сгущены к кромкам косинусным законом: передняя кромка — там, где
    решается вся подъёмная сила, и равномерная разбивка врёт на ней сильнее
    всего.
    """
    beta = np.linspace(0.0, np.pi, n)
    x = 0.5 * (1.0 - np.cos(beta))
    t = thickness
    y = 5 * t * (0.2969 * np.sqrt(x) - 0.1260 * x - 0.3516 * x ** 2
                 + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    # Последний коэффициент взят в редакции с замкнутой задней кромкой
    # (−0.1036 вместо −0.1015): открытая кромка даёт висящие рёбра, и тело
    # перестаёт быть замкнутым — ровно то, что проверяет `watertight`.
    upper = np.stack([x, y], axis=1)
    lower = np.stack([x[::-1], -y[::-1]], axis=1)
    loop = np.concatenate([upper, lower[1:-1]]) * chord
    return _nose_to_flow(loop, chord)


def extrude(loop_xy, span=0.1, z0=None):
    """Замкнутая призма из плоского контура: бока плюс две крышки.

    Контур задаётся в плоскости XY связанных осей (X в нос, Y на левый борт),
    выдавливается по Z. Для плоского случая толщина берётся равной толщине
    домена, и тогда сила с одной ячейки поперёк сразу относится к нужной
    площади.
    """
    # Обход контура приводится к против часовой стрелки. Без этого призма
    # выходит вывернутой: замкнутой она остаётся, а объём и все нормали —
    # отрицательными, и сила на теле меняет знак. Проверка дешевле, чем
    # помнить порядок точек в каждом строителе контура.
    loop_xy = np.asarray(loop_xy, dtype=np.float64)
    x, y = loop_xy[:, 0], loop_xy[:, 1]
    if float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) < 0:
        loop_xy = loop_xy[::-1]
    n = len(loop_xy)
    z0 = -0.5 * span if z0 is None else z0
    z1 = z0 + span
    lo = np.column_stack([loop_xy, np.full(n, z0)])
    hi = np.column_stack([loop_xy, np.full(n, z1)])
    tris = []
    for i in range(n):
        j = (i + 1) % n
        tris.append([lo[i], lo[j], hi[j]])
        tris.append([lo[i], hi[j], hi[i]])
    # Крышки веером из первой точки. Контур выпуклый не всюду, но профиль —
    # звёздчатый относительно точки на хорде, и веера хватает.
    c_lo = np.array([loop_xy[:, 0].mean(), loop_xy[:, 1].mean(), z0])
    c_hi = np.array([c_lo[0], c_lo[1], z1])
    for i in range(n):
        j = (i + 1) % n
        tris.append([c_lo, lo[j], lo[i]])
        tris.append([c_hi, hi[i], hi[j]])
    return np.asarray(tris, dtype=np.float64)


def sail_section(camber, draft=0.5, chord=1.0, thickness=0.015, n=200,
                 te_thickness=0.003):
    """Сечение мягкого паруса: средняя линия с заданным пузом плюс толщина.

    Пузо и положение горба берутся у симулятора (`membraneCamber`), а не
    выдумываются: сравнивать надо ту форму, которую он сам себе назначил.

    Толщина нужна не парусу, а сеточнику. Настоящее полотнище — поверхность
    нулевой толщины, и такую `snappyHexMesh` не строит вовсе: ячейка не может
    быть по обе стороны грани. Полтора процента хорды — компромисс: тоньше
    сетка не разрешает, толще начинает менять поляру. Величина записана в
    манифест случая, потому что она входит в ответ.

    Передняя кромка скруглена, задняя острая. У паруса это не условность: на
    передней шкаторине мягкая ткань принимает конечный радиус, а задняя
    вытянута шкотом в линию. И ровно от острой задней кромки зависит
    циркуляция — что уже стоило один заход по килю.
    """
    beta = np.linspace(0.0, np.pi, n)
    x = 0.5 * (1.0 - np.cos(beta))
    # Средняя линия NACA четырёхзначного вида: две параболы, сшитые в горбе.
    # При draft = 0.5 она вырождается в дугу, как у круглого паруса.
    p = min(max(draft, 0.05), 0.95)
    mline = np.where(
        x < p,
        camber / p ** 2 * (2 * p * x - x ** 2),
        camber / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * x - x ** 2))
    dyc = np.where(
        x < p,
        2 * camber / p ** 2 * (p - x),
        2 * camber / (1 - p) ** 2 * (p - x))
    # Толщина: тот же вид, что у NACA, но приведённый к нулю на задней кромке.
    t = thickness
    yt = 5 * t * (0.2969 * np.sqrt(x) - 0.1260 * x - 0.3516 * x ** 2
                  + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    th = np.arctan(dyc)
    xu, yu = x - yt * np.sin(th), mline + yt * np.cos(th)
    xl, yl = x + yt * np.sin(th), mline - yt * np.cos(th)
    # Задняя кромка обрезается по КОНЕЧНОЙ толщине, а не сводится в точку.
    #
    # Причина сначала численная: у сведённой в точку кромки последние узлы
    # оказываются ближе друг к другу, чем допуск склейки, треугольники
    # схлопываются, и тело выходит незамкнутым — на двухстах точках по хорде
    # это ровно так и вышло. Причина физическая та же по сути: шкаторина
    # паруса подшита и имеет толщину в несколько миллиметров, а разрешить в
    # сетке кромку тоньше этого всё равно нельзя.
    keep = 2.0 * yt >= te_thickness
    keep[0] = True                      # носок оставляем всегда
    if keep.sum() < 8:
        keep[:] = True
    xu, yu, xl, yl = xu[keep], yu[keep], xl[keep], yl[keep]
    return (_nose_to_flow(np.stack([xu, yu], axis=1) * chord, chord),
            _nose_to_flow(np.stack([xl, yl], axis=1) * chord, chord))


def extrude_section(upper, lower, span=0.1, z0=None):
    """Призма из пары поверхностей — для ТОНКИХ сечений.

    Отличается от `extrude` только крышками, и это не мелочь. Веером из центра
    габарита крышку тонкой изогнутой дуги замкнуть нельзя: у такой дуги центр
    габарита лежит СНАРУЖИ тела, треугольники веера самопересекаются, и
    проверка честно объявляет тело незамкнутым. Здесь крышка сшивается лентой
    между верхней и нижней поверхностями — то есть по тем же парам точек, по
    которым сечение и построено.
    """
    n = len(upper)
    z0 = -0.5 * span if z0 is None else z0
    z1 = z0 + span
    # Замкнутый контур: верх от носка к хвосту, низ обратно. Совпадающие концы
    # выбрасываются по факту совпадения, а не по счёту: у сведённой в точку
    # кромки конец общий, у обрезанной — свой на каждой стороне, и жёсткое
    # `[1:-1]` в этом втором случае теряло целую грань. Так и вышло: шесть
    # висячих рёбер ровно по числу узлов торца.
    loop = _dedupe_loop(np.concatenate([upper, lower[::-1]]))
    tris = list(extrude(loop, span, z0))
    # Веерные крышки из `extrude` выбрасываются, остаются только боковые грани.
    tris = tris[:2 * len(loop)]
    for arr, z, flip in ((upper, z0, False), (upper, z1, True)):
        u = np.column_stack([arr, np.full(n, z)])
        l = np.column_stack([lower, np.full(n, z)])
        for i in range(n - 1):
            a, b = (u[i], u[i + 1])
            c, d = (l[i], l[i + 1])
            # На носке и на хвосте верх и низ сходятся в одну точку, и
            # четырёхугольник вырождается в треугольник. Вырожденный
            # треугольник нулевой площади не просто лишний: у него нет
            # нормали, и проверка замкнутости честно объявляет тело дырявым —
            # что и произошло на первом же сечении.
            for t in ([a, b, d], [a, d, c]):
                if _degenerate(t):
                    continue
                tris.append(t[::-1] if flip else t)
    return np.asarray(tris, dtype=np.float64)


def _dedupe_loop(pts, tol=1e-9):
    """Выбросить совпадающие подряд точки, включая пару «конец — начало»."""
    out = [pts[0]]
    for p in pts[1:]:
        if np.hypot(*(p - out[-1])) > tol:
            out.append(p)
    while len(out) > 2 and np.hypot(*(out[-1] - out[0])) <= tol:
        out.pop()
    return np.asarray(out)


def _degenerate(t, tol=1e-12):
    n = np.cross(np.asarray(t[1]) - np.asarray(t[0]),
                 np.asarray(t[2]) - np.asarray(t[0]))
    return bool(np.dot(n, n) < tol * tol)


def sign_probe(size=1.0):
    """Заведомо несимметричное тело для проверки знаков (§5, этап 0.6).

    Клин, у которого все три оси различимы: длинный по X, скошенный на левый
    борт по Y и срезанный сверху по Z. Такое тело даёт ненулевые силу и момент
    по каждой оси, и перестановка любых двух компонент сразу видна.
    """
    v = np.array([
        [1.0, 0.0, 0.0], [-0.5, 0.35, -0.2], [-0.5, -0.15, -0.2],
        [-0.5, 0.15, 0.45], [-0.7, 0.0, 0.0],
    ]) * size
    faces = [(0, 1, 3), (0, 3, 2), (0, 2, 1), (4, 3, 1), (4, 2, 3), (4, 1, 2)]
    return np.asarray([[v[a], v[b], v[c]] for a, b, c in faces],
                      dtype=np.float64)


CANONICAL = ("naca0012", "sign_probe")


def canonical(dst_dir, span=0.1, chord=1.0):
    """Написать канонические тела этапа 0 и отчёт по ним.

    Тела кладутся в тот же каталог, что и геометрия лодки, и проходят те же
    проверки замкнутости: если проверка врёт, она обязана соврать и здесь, где
    ответ известен заранее.
    """
    os.makedirs(dst_dir, exist_ok=True)
    made = {}
    for name, tris in (("naca0012", extrude(naca_symmetric(0.12, chord), span)),
                       ("sign_probe", sign_probe(chord))):
        write_stl_ascii(os.path.join(dst_dir, name + ".stl"), [(name, tris)])
        made[name] = {"watertight": watertight(tris),
                      "area_m2": area_m2(tris), "volume_m3": volume_m3(tris),
                      "bbox_m": bbox_m(tris),
                      "sha256": hashing.sha256_file(
                          os.path.join(dst_dir, name + ".stl"))}
    return made


def _connectivity(parts):
    """Связность союза по габаритам — дешёвая проверка §3.2.4.

    Проверяется не «каждый с каждым», а именно СВЯЗНОСТЬ. Бульб не касается
    корпуса и касаться не должен: он висит на пере киля, и цепочка
    корпус—колодец—перо—бульб связна, хотя габариты корпуса и бульба разошлись
    на метр с лишним. Первая версия этой проверки требовала попарного
    пересечения и ругалась на совершенно исправную геометрию.

    Пересечение габаритов не доказывает, что поверхности сошлись, — но
    ОТСУТСТВИЕ пути между телами доказывает щель наверняка.
    """
    names = [n for n, _t in parts]
    boxes = {n: bbox_m(t) for n, t in parts}
    touch = {n: set() for n in names}
    pairs = {}
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = boxes[names[i]], boxes[names[j]]
            gap = max(max(a["min_m"][k] - b["max_m"][k],
                          b["min_m"][k] - a["max_m"][k]) for k in range(3))
            pairs["%s|%s" % (names[i], names[j])] = gap
            if gap <= 0:
                touch[names[i]].add(names[j])
                touch[names[j]].add(names[i])
    # Обход в ширину от первого тела.
    seen, queue = {names[0]}, [names[0]]
    while queue:
        cur = queue.pop()
        for nxt in touch[cur] - seen:
            seen.add(nxt)
            queue.append(nxt)
    return {"gaps_m": pairs, "connected": sorted(seen),
            "detached": sorted(set(names) - seen)}
