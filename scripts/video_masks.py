#!/usr/bin/env python3
"""Маски неба и воды для обучения сплатов.

    python3 scripts/video_masks.py data/video/shot01 [--check 0025.jpg]

Brush ищет каталог `masks` рядом с `images` и копирует красный канал маски в
альфу кадра; при непустой маске включается режим `masked`, в котором нулевая
альфа означает «этот пиксель в обучении не участвует». Значит **белое
оставляем, чёрное выбрасываем**.

НЕБО берётся геометрической затравкой и доростом по связности.

Затравка точна: вертикаль известна по камерам, значит известен угол луча
каждого пикселя к горизонту, а выше горизонта в этой съёмке не может быть
ничего, кроме неба — дрон идёт на трёхстах пятидесяти метрах, всё в округе
ниже. Но только затравка: вертикаль опирается на допущение «камера без крена»,
и на этой съёмке геометрический горизонт вышел градуса на три выше настоящего.
Полоса неба под ним оставалась незакрытой.

(Отдельно стоит сказать, чем эта ошибка НЕ ловится. Проверка «траектория
горизонтальна при такой вертикали» ничего не значит: вертикаль строится
перпендикулярно траектории, и ноль получается по построению. Циклическая
проверка выглядит убедительно и не проверяет ничего.)

Поэтому от затравки идёт дорост вниз по пикселям, похожим на небо — гладким и
светлым или синеватым. Связность и решает: облака и дымка соединены с верхом
кадра, а река — нет, её отсекает дальний берег.

ВОДА — то, что осталось: гладкое, синеватое, ниже горизонта, не примыкающее к
небу, и крупными связными кусками. Гладкие крыши и асфальт под условия попадают
тоже, поэтому порог по площади высокий: одиночная крыша его не проходит, плёс
проходит.

ТИТРЫ. В ролик вжжено название города, и в экранных координатах оно неподвижно.
Для фотограмметрии это яд: камера движется, а надпись стоит, и реконструкция
честно поместит её в воздух отдельным объектом. Ловится тем же, чем и держится
— постоянством: у движущейся сцены временно́е отклонение яркости пикселя велико,
у вжжённой надписи мало. Порог по нему и выбрасывает титры, не трогая остального.
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from splat_render import read_poses, intrinsics  # noqa: E402

SKY_MARGIN_DEG = 0.0     # затравка строго выше геометрического горизонта
SMOOTH_WIN = 9           # окно локального отклонения, px
SMOOTH_MAX = 6.0         # порог гладкости (0..255)
MIN_WATER_FRAC = 0.004   # минимальная доля кадра для связной области воды
TITLE_HIT_FRAC = 0.35    # доля кадров, в которых пиксель ярко-бел — это титр
TITLE_MIN_FRAC = 2e-4    # мельче этого — шум, а не надпись


def vertical_axis(poses):
    cams = np.array([p["C"] for p in poses])
    right = np.array([p["R"][0] for p in poses]).mean(0)
    right /= np.linalg.norm(right)
    fwd = cams[-1] - cams[0]
    fwd /= np.linalg.norm(fwd)
    up = np.cross(fwd, right)
    up /= np.linalg.norm(up)
    # Знак: дрон смотрит вниз, значит ось взгляда камеры (третья строка R)
    # направлена против вертикали. Без этой проверки маска неба получается
    # инверсной и съедает девять десятых кадра — заметно только по числам.
    look = np.array([p["R"][2] for p in poses]).mean(0)
    if np.dot(up, look) > 0:
        up = -up
    return up, cams, fwd


def sky_mask(R, up, f, w, h):
    """True там, где луч пикселя уходит выше горизонта."""
    v, u = np.mgrid[0:h, 0:w]
    d = np.stack([(u - w / 2) / f, (v - h / 2) / f, np.ones_like(u, float)], -1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    world = d @ R                      # R — мир→камера, значит обратно это R^T,
    return world @ up > np.sin(np.radians(SKY_MARGIN_DEG))   # (d @ R) == R.T @ d


def smoothness(a):
    lum = a.mean(2)
    m = ndimage.uniform_filter(lum, SMOOTH_WIN)
    sd = np.sqrt(np.maximum(ndimage.uniform_filter(lum * lum, SMOOTH_WIN) - m * m, 0))
    return sd, lum


def sky_and_water(img, seed):
    """Небо = затравка, доращенная по связности; вода = остальное гладко-синее."""
    a = np.asarray(img.convert("RGB"), np.float32)
    sd, lum = smoothness(a)
    smooth = sd < SMOOTH_MAX
    # Яркое считается небом и без гладкости: облака текстурны, условие гладкости
    # их отсекало, и дорост рвался на них, не дойдя до настоящего горизонта.
    skyish = (lum > 150) | (smooth & (a[..., 2] > a[..., 0] + 4))

    # Дорост: берутся только те связные куски «похожего на небо», которые
    # соприкасаются с геометрической затравкой.
    grow = skyish | seed
    lab, n = ndimage.label(grow)
    touch = set(np.unique(lab[seed])) - {0}
    sky = np.isin(lab, list(touch)) if touch else seed.copy()
    sky = ndimage.binary_closing(sky, np.ones((9, 9)))

    cand = smooth & (a[..., 2] > a[..., 0] + 4) & ~sky
    cand = ndimage.binary_closing(cand, np.ones((7, 7)))
    cand = ndimage.binary_opening(cand, np.ones((5, 5)))
    lab, n = ndimage.label(cand)
    if n:
        sizes = ndimage.sum(cand, lab, range(1, n + 1))
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= MIN_WATER_FRAC * cand.size
        water = ndimage.binary_dilation(keep[lab], np.ones((9, 9)))
    else:
        water = np.zeros_like(cand)
    return sky, water & ~sky


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("shot_dir")
    ap.add_argument("--sparse", default=None)
    ap.add_argument("--check", default=None, help="кадр, для которого сохранить наложение")
    args = ap.parse_args()

    sparse = args.sparse or os.path.join(args.shot_dir, "sparse", "1")
    images = os.path.join(args.shot_dir, "images")
    masks = os.path.join(args.shot_dir, "masks")
    os.makedirs(masks, exist_ok=True)

    poses = read_poses(sparse)
    f, w, h = intrinsics(sparse)
    up, cams, fwd = vertical_axis(poses)
    if np.dot(up, cams.mean(0) - cams[0]) == 0:
        pass
    print("вертикаль %s, кадров %d, %dx%d, f=%.0f" % (np.round(up, 3), len(poses), w, h, f))

    # Вжжённая графика. Первый заход искал её по малому временно́му отклонению
    # яркости — и провалился дважды разом: набрал 27% кадра неподвижной далью
    # (за 7.6 с дальний план почти не смещается) и не взял саму надпись, потому
    # что она проявляется и гаснет, то есть меняется сильнее фона.
    #
    # Признак нужен свой: титр ярок и обесцвечен, и остаётся таким в одном и том
    # же пикселе бо́льшую часть плана. Содержимое сцены под камерой едет, и ни
    # один его пиксель не держится ярко-белым так долго.
    names = [p["name"] for p in poses if os.path.exists(os.path.join(images, p["name"]))]
    hits = None
    for nm in names:
        a = np.asarray(Image.open(os.path.join(images, nm)).convert("RGB"), np.float32)
        bright = (a.mean(2) > 200) & (a.max(2) - a.min(2) < 25)
        hits = bright.astype(np.float32) if hits is None else hits + bright
    title = hits / len(names) > TITLE_HIT_FRAC
    lab, n = ndimage.label(ndimage.binary_closing(title, np.ones((5, 5))))
    if n:
        sizes = ndimage.sum(title, lab, range(1, n + 1))
        keep_l = np.zeros(n + 1, bool)
        keep_l[1:] = sizes >= TITLE_MIN_FRAC * title.size
        title = ndimage.binary_dilation(keep_l[lab], np.ones((13, 13)))
    else:
        title = np.zeros_like(title)
    print("вжжённая графика: %.2f%% кадра" % (100 * title.mean()))

    stat = []
    for p in poses:
        src = os.path.join(images, p["name"])
        if not os.path.exists(src):
            continue
        img = Image.open(src)
        iw, ih = img.size
        sc = iw / w
        seed = sky_mask(p["R"], up, f * sc, iw, ih)
        sky, wat = sky_and_water(img, seed)
        keep = ~(sky | wat | title)
        Image.fromarray((keep * 255).astype(np.uint8)).save(
            os.path.join(masks, os.path.splitext(p["name"])[0] + ".png"))
        stat.append((sky.mean(), wat.mean(), keep.mean()))

        if args.check and p["name"] == args.check:
            a = np.asarray(img.convert("RGB"), np.float32)
            a[sky] = a[sky] * 0.35 + np.array([255, 60, 60]) * 0.65
            a[wat] = a[wat] * 0.35 + np.array([60, 120, 255]) * 0.65
            a[title] = a[title] * 0.35 + np.array([255, 230, 60]) * 0.65
            Image.fromarray(a.astype(np.uint8)).save(
                os.path.join(args.shot_dir, "mask_check.jpg"), quality=90)
            print("наложение: %s/mask_check.jpg (красное небо, синее вода, жёлтое титры)"
                  % args.shot_dir)

    s = np.array(stat)
    print("в среднем по кадрам: небо %.1f%%, вода %.1f%%, остаётся %.1f%%"
          % (100 * s[:, 0].mean(), 100 * s[:, 1].mean(), 100 * s[:, 2].mean()))


if __name__ == "__main__":
    main()
