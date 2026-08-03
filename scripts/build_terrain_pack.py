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
from scipy import ndimage

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
    }

    # Отпечаток полей. Запись, сделанная на акватории, без неё не
    # воспроизводится, и об этом надо сказать вслух, а не разойтись молча.
    h = hashlib.sha1()
    for k in ("height_dm_b64", "cover_b64", "sdf_b64", "fetch_b64", "sky_b64"):
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


if __name__ == "__main__":
    main()
