#!/usr/bin/env python3
"""Пакет акватории для симулятора: out/export/terrain_pack.json.

    python3 scripts/build_terrain_pack.py

Выгрузка `out/terrain.json` собрана для просмотра глазами. Симулятору нужен свой
пакет: часть полей ему не нужна, а два поля надо посчитать заранее — по ним
работает физика, и считать их на каждом шаге нельзя.

Каждое поле здесь со своим разрешением, и выбирается оно по тому, кто поле
читает, а не одно на всех. Страница вклеивает всё в base64 и открывается с
file://, где `fetch()` запрещён политикой источника, — значит любое поле стоит
своего веса буквально.

    поле                       шаг    тип     кому
    высоты земли               20 м   int16   отрисовка
    покров (класс + высота)    20 м   uint8   отрисовка
    расстояние до берега       20 м   uint8   мель, кромка, отрисовка
    разгон по 16 румбам       100 м   uint8   волна, ветер
    высота горизонта, 16 рум. 100 м   uint8   ветер

План и обоснования — docs/terrain-in-sim.md.
"""

import base64
import hashlib
import json
import math
import os
import sys

import numpy as np
from scipy import ndimage, sparse
from scipy.sparse import linalg as spla

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

# Шаг полей физики. Оба меняются медленно: разгон между двумя точками в ста
# метрах отличается на те же сто метров из километров, укрытие за берегом — тем
# более. Пятьдесят метров дало бы вчетверо больший пакет без видимой пользы.
COARSE = 100.0

# Румбов по кругу. Между соседними — линейная интерполяция по направлению. У
# этого есть известный изъян: за мысом разгон меняется скачком, а интерполяция
# его сглаживает. На масштабе плёса скачки редки, но знать надо.
RHUMBS = 16

# Потолок разгона: упирается в диапазон uint8 при шаге 100 м.
FETCH_MAX = 255 * COARSE

# Докуда смотреть на берег в поисках укрытия и с каким шагом.
SKY_MIN, SKY_MAX, SKY_STEP = 20.0, 3000.0, 20.0

# Масштаб хранения высоты горизонта: тангенс угла, сотые доли. Потолок 2.55 —
# это стометровый обрыв в сорока метрах, ближе к берегу лодке делать нечего.
SKY_SCALE = 100.0

# Условное дно: те же два числа, что у мели в симуляторе. Одно выдуманное дно на
# оба применения — если разойдутся, лодка будет цепляться там, где не течёт.
SHOAL_SLOPE, SHOAL_MAX = 0.06, 6.0

# Створы, разделённые косой уже этого, считаются одним: остров посреди устья не
# делает из одной реки две.
PORT_GAP = 10

# Ось долины. Потолок высоты: выше него плато считается плоским, иначе овраги на
# самом плато заводят собственные оси, к речной долине отношения не имеющие.
# Первое сглаживание убирает шум съёмки, второе задаёт окно осреднения — «порядка
# километра», как и предполагал план.
VALLEY_CAP, VALLEY_S1, VALLEY_S2 = 80.0, 200.0, 1000.0

# Крутизна склона, при которой стена считается полноценной: пятьдесят метров на
# километр после сглаживания километровым окном. Снято с бровки правого берега;
# в пойме, где стены нет вовсе, выходит втрое меньше — и канализация там гаснет
# сама, а не выключается вручную.
VALLEY_REF = 0.05

# Потолок хранения уклона: три медианных уклона фарватера. Выше — только
# затоны и протоки в пару ячеек шириной, где течение всё равно не про лодку.
CUR_MAX = 3.0


def decode(b64, dtype, shape):
    return np.frombuffer(base64.b64decode(b64), dtype).reshape(shape).copy()


def shore_sdf(wet, step):
    """Знаковое расстояние до берега, м: плюс на воде, минус на суше.

    Оно же заменяет маску воды: знак даёт её даром. И оно, в отличие от маски,
    ИНТЕРПОЛИРУЕТСЯ — двадцатиметровая маска даёт ступенчатый берег, а
    двадцатиметровое расстояние даёт гладкий урез по нулевой изолинии, потому
    что между узлами оно меняется линейно. Это и есть способ получить приличную
    береговую черту, не измельчая сетку.

    Край массива берегом не считается нарочно: река уходит за границу квадрата,
    и объявлять там сушу значило бы городить фальшивую отмель поперёк русла.
    """
    inside = ndimage.distance_transform_edt(wet) * step
    outside = ndimage.distance_transform_edt(~wet) * step
    return np.where(wet, inside, -outside)


def fetch_field(wet, step, xs, ys, cxs, cys):
    """Разгон волны по румбам: сколько воды против ветра до первого берега.

    Луч идёт от ячейки ПРОТИВ ветра, то есть туда, откуда дует. Направление
    румба — тот же угол, что `windDir` в симуляторе: от оси X мира, ось X на
    восток. Дошёл до суши — там разгон и кончился.

    Луч, ушедший за край квадрата, останавливается на краю. Это заниженная
    оценка: река продолжается и дальше. Врать в эту сторону безопаснее — волна
    выйдет меньше настоящей, а не больше.
    """
    ny, nx = wet.shape
    gy, gx = np.meshgrid(cys, cxs, indexing="ij")
    out = np.zeros((RHUMBS, gy.shape[0], gy.shape[1]), np.uint8)
    x0, y0 = xs[0], ys[0]
    n_steps = int(FETCH_MAX / COARSE)
    for k in range(RHUMBS):
        a = 2.0 * math.pi * k / RHUMBS
        ux, uy = math.cos(a), math.sin(a)
        px, py = gx.copy(), gy.copy()
        alive = np.ones(gy.shape, bool)
        dist = np.zeros(gy.shape, np.float64)
        # Стартовая ячейка на суше разгона не имеет вовсе.
        i0 = np.clip(np.round((py - y0) / step).astype(int), 0, ny - 1)
        j0 = np.clip(np.round((px - x0) / step).astype(int), 0, nx - 1)
        alive &= wet[i0, j0]
        for _ in range(n_steps):
            if not alive.any():
                break
            px = px + ux * COARSE
            py = py + uy * COARSE
            i = np.round((py - y0) / step).astype(int)
            j = np.round((px - x0) / step).astype(int)
            inside = (i >= 0) & (i < ny) & (j >= 0) & (j < nx)
            ok = np.zeros(alive.shape, bool)
            ii, jj = np.clip(i, 0, ny - 1), np.clip(j, 0, nx - 1)
            ok[inside] = wet[ii[inside], jj[inside]]
            alive &= ok
            dist[alive] += COARSE
        out[k] = np.clip(np.round(dist / COARSE), 0, 255).astype(np.uint8)
    return out


def skyline_field(top, ground, step, xs, ys, cxs, cys):
    """Высота горизонта против ветра: наибольший тангенс угла на берег.

    Здесь пакет отходит от плана, и вот почему. План предлагал считать заранее
    само укрытие:

        укрытие = 1 − max по d [ D₀ · exp(−d / (k·h(d))) ]

    Но `D₀` и `k` — подгоняемые числа, и подбирать их предстоит на воде, глядя
    на лодку. Запечённые в пакет, они потребовали бы пересборки страницы на
    каждую пробу.

    Между тем показатель экспоненты монотонен по h/d при любом k, а значит
    максимум по d достигается там же, где максимум ОТНОШЕНИЯ h/d — величины
    чисто геометрической. Поэтому в пакет идёт она:

        S(x, θ) = max по d [ (верх_покрова(x + d·û) − земля(x)) / d ]

    а укрытие считается на ходу как 1 − D₀·exp(−1/(k·S)), и оба числа остаются
    живыми ползунками. Ответ при этом тот же самый, до знака.

    Высота берётся по ВЕРХУ покрова, а не по земле: стена леса на бровке
    добавляет к обрыву свои восемнадцать метров, и в тени это чувствуется.
    """
    ny, nx = top.shape
    gy, gx = np.meshgrid(cys, cxs, indexing="ij")
    x0, y0 = xs[0], ys[0]
    i0 = np.clip(np.round((gy - y0) / step).astype(int), 0, ny - 1)
    j0 = np.clip(np.round((gx - x0) / step).astype(int), 0, nx - 1)
    base = ground[i0, j0]
    out = np.zeros((RHUMBS, gy.shape[0], gy.shape[1]), np.uint8)
    ds = np.arange(SKY_MIN, SKY_MAX + SKY_STEP, SKY_STEP)
    for k in range(RHUMBS):
        a = 2.0 * math.pi * k / RHUMBS
        ux, uy = math.cos(a), math.sin(a)
        best = np.zeros(gy.shape, np.float64)
        for d in ds:
            i = np.clip(np.round((gy + uy * d - y0) / step).astype(int), 0, ny - 1)
            j = np.clip(np.round((gx + ux * d - x0) / step).astype(int), 0, nx - 1)
            h = top[i, j] - base
            np.maximum(best, h / d, out=best)
        out[k] = np.clip(np.round(best * SKY_SCALE), 0, 255).astype(np.uint8)
    return out


def current_field(wet, step, xs, ys, cxs, cys):
    """Течение: уклон водной поверхности по акватории, безразмерный.

    Данных нет и взять их неоткуда (docs/terrain-in-sim.md §2), поэтому течение
    здесь — выдумка. Но выдумка с правильной структурой, и структура эта не
    придумана, а решена: течение считается из СОХРАНЕНИЯ РАСХОДА, а не из
    правил вида «на узком месте быстрее».

    Русло — плоский канал с условным дном. Для осреднённого по глубине потока
    удельный расход по Маннингу q = h^(5/3)·∇φ, где φ — отметка поверхности, а
    неразрывность даёт ∇·q = 0. Это уравнение Лапласа с проводимостью h^(5/3),
    и решается оно один раз на всю акваторию. Берег входит сам собой: на урезе
    h → 0, проводимость обращается в ноль, и поперёк берега не течёт ничего.

    Что из этого выходит даром, без единого дополнительного правила:

      * на узком месте быстрее, на плёсе медленнее;
      * у берега медленнее, на фарватере быстрее;
      * ниже устья притока расход больше на расход притока;
      * поток идёт вдоль русла, потому что поперёк ему течь некуда.

    Створы — там, где вода касается края квадрата. Самый широкий считается
    низовьем, остальные верховьями: расход вниз по течению растёт, а ширина
    русла растёт вместе с ним. Расход по створам делится по проводимости, то
    есть при одинаковом уклоне на всех створах — предположение более слабое,
    чем любое назначенное число.

    В пакет идёт НЕ скорость, а уклон ∇φ. Причина в разрешении: уклон почти
    постоянен по сечению (это и есть классическое гидравлическое допущение, и
    здесь оно вышло само — поперёк плёса 0.8…1.4), а вся поперечная структура
    сидит в множителе h^(2/3). Значит гладкую часть можно хранить на стометровой
    сетке, а резкую считать на ходу по двадцатиметровому расстоянию до берега —
    там, где разрешение и есть. Обратный порядок стоил бы мегабайта страницы.

    Нормируется на медианный уклон фарватера, так что ползунок в симуляторе
    задаёт прямо скорость на стрежне в метрах в секунду.
    """
    ny, nx = wet.shape
    lab, n = ndimage.label(wet)
    sizes = ndimage.sum(wet, lab, range(1, n + 1))
    # Только главный водоём: пруды и старицы не проточны, и решать на них
    # нечего — система там вырождена, а течения нет.
    main = lab == (int(np.argmax(sizes)) + 1)
    sdf_in = ndimage.distance_transform_edt(main) * step
    depth = np.minimum(SHOAL_MAX, sdf_in * SHOAL_SLOPE)
    K = np.where(main, np.maximum(1e-3, depth) ** (5.0 / 3.0), 0.0)

    # Обход границы квадрата по кругу, а не по сторонам: река, уходящая через
    # угол, — это один створ, а не два.
    ring_i = np.concatenate([np.zeros(nx, int), np.arange(ny),
                             np.full(nx, ny - 1), np.arange(ny)[::-1]])
    ring_j = np.concatenate([np.arange(nx), np.full(ny, nx - 1),
                             np.arange(nx)[::-1], np.zeros(ny, int)])
    ring = main[ring_i, ring_j]
    idx = np.flatnonzero(ring)
    if idx.size == 0:
        return np.zeros((2, cys.size, cxs.size), np.int8), 0.0, []
    segs = np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1)
    if len(segs) > 1 and idx[0] == 0 and idx[-1] == ring.size - 1:
        segs = [np.concatenate([segs[-1], segs[0]])] + segs[1:-1]
    merged = []
    for q in segs:
        if merged and (q[0] - merged[-1][-1]) % ring.size <= PORT_GAP:
            merged[-1] = np.concatenate([merged[-1], q])
        else:
            merged.append(q)
    segs = sorted(merged, key=len, reverse=True)

    ids = -np.ones((ny, nx), int)
    cells = np.argwhere(main)
    ids[main] = np.arange(len(cells))
    N = len(cells)
    i, j = cells[:, 0], cells[:, 1]
    rows, cols, vals = [], [], []
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ii, jj = i + di, j + dj
        ok = (ii >= 0) & (ii < ny) & (jj >= 0) & (jj < nx)
        ok[ok] &= main[ii[ok], jj[ok]]
        a = np.flatnonzero(ok)
        k = 0.5 * (K[i[a], j[a]] + K[ii[a], jj[a]])
        rows += [a, a]
        cols += [ids[ii[a], jj[a]], a]
        vals += [k, -k]
    A = sparse.coo_matrix((np.concatenate(vals),
                           (np.concatenate(rows), np.concatenate(cols))),
                          shape=(N, N)).tocsr()

    src = np.zeros(N)
    port = lambda q: np.unique(ids[ring_i[q], ring_j[q]])
    low, up = port(segs[0]), np.concatenate([port(q) for q in segs[1:]])
    up = np.unique(up)
    src[up] += K[i[up], j[up]]
    src[low] -= K[i[low], j[low]] * (K[i[up], j[up]].sum() / K[i[low], j[low]].sum())

    # Множитель Лагранжа, а не закрепление ячейки: система вырождена на
    # постоянную, правая часть согласована, и портить ей строку нельзя — это
    # ломает ровно тот расход, ради которого всё считается.
    one = np.ones((N, 1))
    M = sparse.bmat([[A, sparse.csr_matrix(one)],
                     [sparse.csr_matrix(one.T), None]]).tocsc()
    phi = spla.spsolve(M, np.concatenate([src, [0.0]]))[:N]
    F = np.zeros((ny, nx))
    F[main] = phi

    def grad(di, dj):
        def val(ii, jj):
            ok = (ii >= 0) & (ii < ny) & (jj >= 0) & (jj < nx)
            ok2 = ok.copy()
            ok2[ok] &= main[ii[ok], jj[ok]]
            return np.where(ok2, F[np.clip(ii, 0, ny - 1), np.clip(jj, 0, nx - 1)], np.nan)
        p, m = val(i + di, j + dj), val(i - di, j - dj)
        c = F[i, j]
        return np.where(np.isnan(p) & np.isnan(m), 0.0,
               np.where(np.isnan(p), c - m, np.where(np.isnan(m), p - c, (p - m) / 2)))

    G = np.zeros((2, ny, nx))
    G[0][i, j], G[1][i, j] = grad(0, 1), grad(1, 0)
    ref = float(np.median(np.hypot(G[0], G[1])[main & (sdf_in > 150)]))
    G /= max(ref, 1e-12)

    # Распространить поле на сушу ближайшим значением: иначе двулинейная выборка
    # у берега затянет нули с земли и течение у уреза оборвётся ступенькой.
    _, near = ndimage.distance_transform_edt(~main, return_indices=True)
    G = G[:, near[0], near[1]]

    # На стометровую сетку — осреднением по окну, а не выборкой узла: узел может
    # попасть в затон, а окно — нет.
    out = np.zeros((2, cys.size, cxs.size), np.int8)
    r = int(round(COARSE / step / 2))
    for cj, x in enumerate(cxs):
        j0 = int(round((x - xs[0]) / step))
        for ci, y in enumerate(cys):
            i0 = int(round((y - ys[0]) / step))
            sl = (slice(max(0, i0 - r), i0 + r + 1), slice(max(0, j0 - r), j0 + r + 1))
            for c in (0, 1):
                v = G[c][sl].mean() / CUR_MAX * 127.0
                out[c, ci, cj] = int(np.clip(round(v), -127, 127))
    widths = [len(q) * step for q in segs]
    return out, ref, widths


def valley_axis(height, level, step, cxs, cys):
    """Ось долины и сила канализации: два числа на ячейку, в двойном угле.

    Приземный ветер в долине идёт вдоль неё: стенки непроницаемы, и поперёк них
    течь нечему. Свободный ветер под углом θ к оси разворачивается к ней тем
    сильнее, чем лучше долина выражена, — и выбирает то из двух её направлений,
    на которое у него положительная проекция. Отсюда, между прочим, и переворот
    приземного ветра на 180° при переходе свободного через поперечное
    направление: это не изъян модели, а наблюдаемое явление.

    Ось берётся СТРУКТУРНЫМ ТЕНЗОРОМ рельефа, а не осью реки. Разница
    существенная: канализацию делает долина, а река в широкой пойме может гулять
    поперёк неё. Проверено на этом участке — там, где стена есть, ось долины и
    ось реки сходятся на два-восемь градусов, а в пойме расходятся на тридцать.

    J = G_σ * (∇H ∇Hᵀ), собственный вектор МЕНЬШЕГО собственного числа и есть
    ось: градиент высоты смотрит поперёк долины, вдоль по ней рельеф не меняется.

    Хранится не угол, а ДВОЙНОЙ угол, помноженный на силу:

        c₂ = A·cos 2α,   s₂ = A·sin 2α

    Причина не в упаковке. Ось — не вектор, а направление без знака, и
    усреднять её как вектор нельзя: две противоположно записанные соседние
    ячейки взаимно уничтожатся. В двойном угле этой беды нет, и обе операции —
    осреднение по окну при сборке и двулинейная выборка на ходу — становятся
    обычным линейным сложением.

    Даром выходит и главное для этой карты: там, где сходятся две долины, оси
    Волги и Оки в окне складываются под большим углом и частично гасят друг
    друга, так что сила A падает сама. Никакого разбора случаев для слияния
    писать не пришлось — двойной угол разобрался с ним раньше нас.

    Сила A = анизотропия × насколько вообще есть стена. Одной анизотропии мало:
    она нормирована и остаётся высокой даже там, где перепад ничтожен, и
    канализировала бы ветер посреди ровной поймы.
    """
    ny, nx = height.shape
    H = ndimage.gaussian_filter(np.minimum(height, level + VALLEY_CAP), VALLEY_S1 / step)
    gy, gx = np.gradient(H, step)
    sg = VALLEY_S2 / step
    jxx = ndimage.gaussian_filter(gx * gx, sg)
    jyy = ndimage.gaussian_filter(gy * gy, sg)
    jxy = ndimage.gaussian_filter(gx * gy, sg)
    # (jxx−jyy, 2jxy) — ориентация ГРАДИЕНТА в двойном угле; ось поперёк ему,
    # то есть в двойном угле — со сменой знака.
    c2, s2 = -(jxx - jyy), -2.0 * jxy
    tr = jxx + jyy
    aniso = np.hypot(c2, s2) / np.maximum(tr, 1e-12)
    wall = np.minimum(1.0, np.sqrt(np.maximum(tr, 0.0)) / VALLEY_REF)
    a = aniso * wall
    ang = 0.5 * np.arctan2(s2, c2)
    fx, fy = a * np.cos(2 * ang), a * np.sin(2 * ang)

    out = np.zeros((2, cys.size, cxs.size), np.int8)
    r = int(round(COARSE / step / 2))
    x0, y0 = -0.5 * (nx - 1) * step, -0.5 * (ny - 1) * step
    for cj, x in enumerate(cxs):
        j0 = int(round((x - x0) / step))
        for ci, y in enumerate(cys):
            i0 = int(round((y - y0) / step))
            sl = (slice(max(0, i0 - r), i0 + r + 1), slice(max(0, j0 - r), j0 + r + 1))
            out[0, ci, cj] = int(np.clip(round(fx[sl].mean() * 127.0), -127, 127))
            out[1, ci, cj] = int(np.clip(round(fy[sl].mean() * 127.0), -127, 127))
    return out


def main():
    src = os.path.join(ROOT, "out", "terrain.json")
    if not os.path.exists(src):
        raise SystemExit("нет out/terrain.json — сначала `make terrain`")
    t = json.load(open(src))

    nx, ny, step = t["nx"], t["ny"], t["step"]
    height = decode(t["height_dm_b64"], np.int16, (ny, nx)).astype(np.float64) / 10.0
    cover = decode(t["cover_b64"], np.uint8, (ny, nx))
    water = decode(t["water_b64"], np.uint8, (ny, nx))
    cover_h = (cover & 0x3F).astype(np.float64)
    top = height + cover_h
    wet = water > 127

    xs = -0.5 * (nx - 1) * step + step * np.arange(nx)
    ys = -0.5 * (ny - 1) * step + step * np.arange(ny)
    cxs = np.arange(xs[0], xs[-1] + COARSE, COARSE)
    cys = np.arange(ys[0], ys[-1] + COARSE, COARSE)

    sdf = shore_sdf(wet, step)
    fetch = fetch_field(wet, step, xs, ys, cxs, cys)
    sky = skyline_field(top, height, step, xs, ys, cxs, cys)
    cur, cur_ref, ports = current_field(wet, step, xs, ys, cxs, cys)
    chan = valley_axis(height, t["level"], step, cxs, cys)

    pack = {
        "origin": t["origin"],
        "meters_per_deg": t["meters_per_deg"],
        "step": step,
        "nx": nx, "ny": ny,
        "coarse": COARSE,
        "cnx": int(cxs.size), "cny": int(cys.size),
        "rhumbs": RHUMBS,
        # Начало отсчёта — ЦЕНТР квадрата, а не угол: мир физики совпадает с
        # системой выгрузки, X на восток, Y на север (docs/terrain-in-sim.md §3).
        "x0": float(xs[0]), "y0": float(ys[0]),
        "level": t["level"],
        "hmin": t["hmin"], "hmax": t["hmax"], "top_max": t["top_max"],
        "open_water": t["open_water"], "widest_m": t["widest_m"],
        "high_point": t["high_point"],
        "sky_scale": SKY_SCALE,
        "cur_max": CUR_MAX,
        # Дно течения и дно мели — одно и то же условное дно. Числа в пакете,
        # чтобы симулятор брал их отсюда, а не заводил свою копию.
        "shoal_slope": SHOAL_SLOPE, "shoal_max": SHOAL_MAX,
        "fetch_max_m": FETCH_MAX,
        "attribution": t["attribution"],
        "height_dm_b64": t["height_dm_b64"],
        "cover_b64": t["cover_b64"],
        # Смещение 128: диапазон −128…+127 м. Дальше ста двадцати семи метров от
        # берега ни мель, ни кромка, ни затухание волны не нужны.
        "sdf_b64": base64.b64encode(
            np.clip(np.round(sdf) + 128, 0, 255).astype(np.uint8).tobytes()).decode(),
        "fetch_b64": base64.b64encode(fetch.tobytes()).decode(),
        "sky_b64": base64.b64encode(sky.tobytes()).decode(),
        # Уклон водной поверхности, две знаковые компоненты на ячейку.
        # Скорость из него получается на ходу: v = ползунок · уклон · (h/hmax)^(2/3).
        "cur_b64": base64.b64encode(cur.tobytes()).decode(),
        # Ось долины в двойном угле, помноженная на силу канализации.
        "chan_b64": base64.b64encode(chan.tobytes()).decode(),
    }

    # Отпечаток полей. Запись, сделанная на акватории, без неё не
    # воспроизводится, и об этом надо сказать вслух, а не разойтись молча.
    h = hashlib.sha1()
    for k in ("height_dm_b64", "cover_b64", "sdf_b64", "fetch_b64", "sky_b64",
              "cur_b64", "chan_b64"):
        h.update(pack[k].encode())
    pack["hash"] = h.hexdigest()[:12]

    dst_dir = os.path.join(ROOT, "out", "export")
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, "terrain_pack.json")
    with open(dst, "w") as f:
        json.dump(pack, f, ensure_ascii=False, separators=(",", ":"))

    print("%s — %.1f МБ, отпечаток %s" % (os.path.relpath(dst, ROOT),
                                          os.path.getsize(dst) / 1024 / 1024,
                                          pack["hash"]))
    print("сетка %d × %d по %.0f м, поля физики %d × %d по %.0f м на %d румбов"
          % (nx, ny, step, pack["cnx"], pack["cny"], COARSE, RHUMBS))
    print("расстояние до берега: %.0f…%.0f м (обрезано до ±127)"
          % (sdf.min(), sdf.max()))
    ow = t["open_water"]
    ci = int(round((ow[1] - ys[0]) / COARSE)), int(round((ow[0] - xs[0]) / COARSE))
    print("на середине плёса разгон по румбам, км: "
          + " ".join("%.1f" % (fetch[k, ci[0], ci[1]] * COARSE / 1000) for k in range(RHUMBS)))
    print("высота горизонта там же, тангенс: "
          + " ".join("%.2f" % (sky[k, ci[0], ci[1]] / SKY_SCALE) for k in range(RHUMBS)))
    print("течение: створы %s м (первый — низовье), уклон на фарватере %.3g"
          % (" ".join("%.0f" % w for w in ports), cur_ref))
    cx = cur[0, ci[0], ci[1]] / 127.0 * CUR_MAX
    cy = cur[1, ci[0], ci[1]] / 127.0 * CUR_MAX
    print("на середине плёса уклон ×%.2f, направление %.0f° от оси X"
          % (math.hypot(cx, cy), math.degrees(math.atan2(cy, cx))))
    for name, (px, py) in (("Волга у плёса", ow), ("Ока выше устья", (-4000.0, -3500.0))):
        cj = int(round((px - xs[0]) / COARSE)); ci = int(round((py - ys[0]) / COARSE))
        ax, ay = chan[0, ci, cj] / 127.0, chan[1, ci, cj] / 127.0
        print("ось долины, %s: %.0f°, сила %.2f"
              % (name, math.degrees(math.atan2(ay, ax)) / 2 % 180, math.hypot(ax, ay)))


if __name__ == "__main__":
    main()
