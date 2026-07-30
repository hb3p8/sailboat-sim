"""Ф6: операции над треугольными сетками и их проверка.

Для симуляции важна не картинка, а свойства тела: замкнутость, правильная
ориентация нормалей, объём, центр тяжести, тензор инерции. Всё это считается
здесь и попадает в манифест — чтобы движок не пересчитывал их сам и чтобы
любую ошибку было видно до того, как она превратится в странное поведение
лодки на воде.

Зависимостей нет.
"""

import math
import struct  # noqa: F401  (используется экспортёрами через этот модуль)

MM_PER_M = 1000.0


def weld(verts, tris, tol=0.02):
    """Склеить совпадающие вершины. Без этого оболочка не замкнута по швам."""
    grid = {}
    remap = [0] * len(verts)
    out = []
    inv = 1.0 / tol
    for i, v in enumerate(verts):
        key = (int(round(v[0] * inv)), int(round(v[1] * inv)), int(round(v[2] * inv)))
        j = grid.get(key)
        if j is None:
            j = len(out)
            grid[key] = j
            out.append([float(v[0]), float(v[1]), float(v[2])])
        remap[i] = j
    new_tris = []
    for t in tris:
        a, b, c = remap[t[0]], remap[t[1]], remap[t[2]]
        if a != b and b != c and a != c:
            new_tris.append([a, b, c])
    return out, new_tris


def edge_check(tris):
    """Сколько рёбер встречается один раз, два, больше двух.

    Замкнутая согласованно ориентированная оболочка: каждое ребро ровно дважды
    и в противоположных направлениях.
    """
    directed = {}
    for t in tris:
        for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            directed[e] = directed.get(e, 0) + 1
    seen, boundary, nonmanifold, inconsistent = set(), 0, 0, 0
    for (a, b), n in directed.items():
        key = (a, b) if a < b else (b, a)
        if key in seen:
            continue
        seen.add(key)
        m = directed.get((b, a), 0)
        total = n + m
        if total == 1:
            boundary += 1
        elif total > 2:
            nonmanifold += 1
        elif n != 1 or m != 1:
            # ребро использовано дважды в одну сторону: соседние треугольники
            # смотрят в разные стороны
            inconsistent += 1
    return {"edges": len(seen), "boundary": boundary,
            "nonmanifold": nonmanifold, "inconsistent": inconsistent,
            "watertight": boundary == 0 and nonmanifold == 0 and inconsistent == 0}


def _tet_props(a, b, c):
    """Знаковый объём тетраэдра (0,a,b,c) и его вклад в матрицу вторых моментов."""
    v = (a[0] * (b[1] * c[2] - b[2] * c[1])
         - a[1] * (b[0] * c[2] - b[2] * c[0])
         + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return v


def volume_m3(verts, tris):
    """Объём замкнутой оболочки, м³. Вершины в миллиметрах."""
    s = 1.0 / MM_PER_M
    total = 0.0
    for t in tris:
        a = [verts[t[0]][k] * s for k in range(3)]
        b = [verts[t[1]][k] * s for k in range(3)]
        c = [verts[t[2]][k] * s for k in range(3)]
        total += _tet_props(a, b, c)
    return total


def surface_area_m2(verts, tris):
    s = 1.0 / MM_PER_M
    total = 0.0
    for t in tris:
        a, b, c = (verts[t[i]] for i in range(3))
        ux, uy, uz = ((b[k] - a[k]) * s for k in range(3))
        vx, vy, vz = ((c[k] - a[k]) * s for k in range(3))
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        total += 0.5 * math.sqrt(nx * nx + ny * ny + nz * nz)
    return total


def volume_below_m3(verts, tris, z_plane=0.0):
    """Объём части тела ниже плоскости z, м³ — без обрезки и сшивания.

    По теореме Гаусса для поля F = (0, 0, min(z − z0, 0)): дивергенция равна
    единице ниже плоскости и нулю выше, поэтому объём равен потоку через
    замкнутую поверхность. Треугольники, пересекающие плоскость, разрезаются,
    чтобы интеграл остался точным.
    """
    s = 1.0 / MM_PER_M
    total = 0.0
    for t in tris:
        p = [[verts[t[i]][k] * s for k in range(3)] for i in range(3)]
        for tri in _split_by_z(p, z_plane * s):
            if max(q[2] for q in tri) > z_plane * s + 1e-12:
                continue
            a, b, c = tri
            az = 0.5 * ((b[0] - a[0]) * (c[1] - a[1])
                        - (b[1] - a[1]) * (c[0] - a[0]))
            zbar = (a[2] + b[2] + c[2]) / 3.0 - z_plane * s
            total += az * zbar
    return total


def _split_by_z(tri, z):
    """Разрезать треугольник плоскостью z на части целиком выше и ниже."""
    below = [i for i in range(3) if tri[i][2] <= z]
    if len(below) == 3 or len(below) == 0:
        return [tri]

    def cut(p, q):
        f = (z - p[2]) / (q[2] - p[2])
        return [p[k] + f * (q[k] - p[k]) for k in range(3)]

    if len(below) == 1:
        i = below[0]
        j, k = (i + 1) % 3, (i + 2) % 3
        m, n = cut(tri[i], tri[j]), cut(tri[i], tri[k])
        return [[tri[i], m, n], [m, tri[j], tri[k]], [m, tri[k], n]]
    i = [x for x in range(3) if x not in below][0]
    j, k = (i + 1) % 3, (i + 2) % 3
    m, n = cut(tri[i], tri[j]), cut(tri[i], tri[k])
    return [[tri[i], m, n], [m, tri[j], tri[k]], [m, tri[k], n]]


def orient_outward(verts, tris):
    """Развернуть все треугольники, если объём вышел отрицательным."""
    if volume_m3(verts, tris) < 0:
        return [[t[0], t[2], t[1]] for t in tris]
    return tris


def solid_properties(verts, tris, density=1.0):
    """Масса, центр тяжести и тензор инерции однородного тела.

    Разложение на тетраэдры от начала координат; ковариация каждого через
    каноническую матрицу. Возвращает СИ: кг, метры, кг·м².
    """
    s = 1.0 / MM_PER_M
    canon = [[2.0, 1.0, 1.0], [1.0, 2.0, 1.0], [1.0, 1.0, 2.0]]
    vol = 0.0
    com = [0.0, 0.0, 0.0]
    cov = [[0.0] * 3 for _ in range(3)]

    for t in tris:
        a = [verts[t[0]][k] * s for k in range(3)]
        b = [verts[t[1]][k] * s for k in range(3)]
        c = [verts[t[2]][k] * s for k in range(3)]
        v = _tet_props(a, b, c)
        vol += v
        for k in range(3):
            com[k] += v * (a[k] + b[k] + c[k]) / 4.0
        A = [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]]
        # cov += v * 6 * A · canon/120 · Aᵀ  (шестикратный объём уже в v)
        for i in range(3):
            for j in range(3):
                acc = 0.0
                for m in range(3):
                    for n in range(3):
                        acc += A[i][m] * canon[m][n] * A[j][n]
                cov[i][j] += v * 6.0 * acc / 120.0

    if abs(vol) < 1e-12:
        return None
    com = [k / vol for k in com]
    mass = density * vol

    # перенос ковариации в центр тяжести
    for i in range(3):
        for j in range(3):
            cov[i][j] -= vol * com[i] * com[j]
    trace = cov[0][0] + cov[1][1] + cov[2][2]
    inertia = [[0.0] * 3 for _ in range(3)]
    for i in range(3):
        for j in range(3):
            inertia[i][j] = density * ((trace - cov[i][j]) if i == j else -cov[i][j])

    return {
        "volume_m3": vol,
        "mass_kg": mass,
        "com_mm": [k * MM_PER_M for k in com],
        "inertia_kg_m2": inertia,
        "inertia_diag_kg_m2": [inertia[0][0], inertia[1][1], inertia[2][2]],
    }


def normals(verts, tris):
    """Усреднённые по площади нормали в вершинах."""
    n = [[0.0, 0.0, 0.0] for _ in verts]
    for t in tris:
        a, b, c = (verts[t[i]] for i in range(3))
        ux, uy, uz = (b[k] - a[k] for k in range(3))
        vx, vy, vz = (c[k] - a[k] for k in range(3))
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        for i in t:
            n[i][0] += nx
            n[i][1] += ny
            n[i][2] += nz
    for v in n:
        L = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
        if L > 0:
            v[0] /= L
            v[1] /= L
            v[2] /= L
        else:
            v[2] = 1.0
    return n


def bbox(verts):
    lo = [min(v[k] for v in verts) for k in range(3)]
    hi = [max(v[k] for v in verts) for k in range(3)]
    return {"min_mm": lo, "max_mm": hi,
            "size_mm": [hi[k] - lo[k] for k in range(3)]}


def prepare(verts, tris, tol=0.02):
    """Склеить, развернуть наружу, проверить. Возвращает (verts, tris, отчёт)."""
    v, t = weld(verts, tris, tol)
    t = orient_outward(v, t)
    rep = edge_check(t)
    rep["verts"] = len(v)
    rep["tris"] = len(t)
    return v, t, rep
