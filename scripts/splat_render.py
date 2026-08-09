#!/usr/bin/env python3
"""Отладочный вид на облако сплатов из произвольной камеры.

    python3 scripts/splat_render.py data/video/shot01/splat_7000.ply \\
        --poses data/video/shot01/sparse/1 --view train --out /tmp/a.png

Это НЕ рендерер сплатов. Здесь нет ни анизотропии, ни альфа-смешивания, ни
сортировки по глубине внутри тайла — каждый сплат кладётся квадратиком своего
цвета, ближний перекрывает дальний. Для оценки «узнаётся ли берег» этого
достаточно, а полноценный растеризатор ради одной картинки писать незачем: он
есть в самом Brush, но там интерактивное окно, а нужен файл.

Что этот вид показывает честно: геометрию, цвет, флоатеры и дыры. Чего он не
показывает: мягкость краёв и всё, что даёт полупрозрачность.

Виды:
  train  — из первой обучающей камеры. Проверка, что модель вообще обучилась;
           если и здесь каша, дальше смотреть нечего.
  eval   — из отложенной камеры (каждая восьмая), то есть настоящий новый вид.
  water  — с высоты глаза над водой. Ради этого всё и затевалось, и именно
           здесь съёмка сверху обязана посыпаться, если ей суждено.
"""

import argparse
import os
import struct

import numpy as np
from PIL import Image

SH_C0 = 0.28209479177387814


def load_ply(path):
    """Прочитать сплаты Brush: позиции, масштабы, прозрачность, цвет."""
    with open(path, "rb") as f:
        head, props = b"", []
        while True:
            ln = f.readline()
            head += ln
            s = ln.decode("ascii", "ignore").strip()
            if s.startswith("element vertex"):
                n = int(s.split()[-1])
            elif s.startswith("property float"):
                props.append(s.split()[-1])
            elif s == "end_header":
                break
        raw = np.frombuffer(f.read(n * len(props) * 4), np.float32)
    a = raw.reshape(n, len(props))
    col = {p: i for i, p in enumerate(props)}
    xyz = a[:, [col["x"], col["y"], col["z"]]]
    scale = np.exp(a[:, [col["scale_0"], col["scale_1"], col["scale_2"]]])
    opac = 1.0 / (1.0 + np.exp(-a[:, col["opacity"]]))
    rgb = 0.5 + SH_C0 * a[:, [col["f_dc_0"], col["f_dc_1"], col["f_dc_2"]]]
    return xyz, scale, opac, np.clip(rgb, 0, 1)


def read_poses(sparse_dir):
    """Центры и матрицы поворота камер из текстовой модели COLMAP."""
    out = []
    for ln in open(os.path.join(sparse_dir, "images.txt")):
        p = ln.split()
        if ln.startswith("#") or len(p) < 9 or not p[0].isdigit():
            continue
        qw, qx, qy, qz = map(float, p[1:5])
        t = np.array(list(map(float, p[5:8])))
        R = np.array([
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)]])
        out.append({"name": p[9] if len(p) > 9 else "", "R": R, "C": -R.T @ t})
    out.sort(key=lambda d: d["name"])
    return out


def intrinsics(sparse_dir):
    for ln in open(os.path.join(sparse_dir, "cameras.txt")):
        if ln.startswith("#") or not ln.strip():
            continue
        p = ln.split()
        return float(p[4]), int(p[2]), int(p[3])
    raise RuntimeError("камера не нашлась")


def render(xyz, rgb, opac, scale, R, C, f, w, h, min_opacity=0.15,
           chunks=48, max_radius=48):
    """Точечный вид: ближний сплат перекрывает дальний.

    Размер квадратика считается из настоящего масштаба сплата и дальности, а не
    берётся постоянным. Это не украшение: в облаке полно крупных фоновых
    сплатов, каждый из которых кроет пол-экрана, и если рисовать их точками,
    картинка выходит звёздным небом вместо сцены — ровно так первый вариант и
    выглядел.

    Порядок соблюдается приблизительно: облако режется на `chunks` слоёв по
    глубине, слои кладутся от дальнего к ближнему, внутри слоя порядок не важен.
    Точный Z-буфер тут не нужен, а векторизация нужна: сплатов полмиллиона.
    """
    good = np.isfinite(xyz).all(1) & (opac >= min_opacity)
    P = (R @ (xyz[good] - C).T).T          # в систему камеры, Z вперёд
    col, sc, al = rgb[good], scale[good].mean(1), opac[good]
    front = P[:, 2] > 1e-6
    P, col, sc, al = P[front], col[front], sc[front], al[front]

    z = P[:, 2]
    u = (f * P[:, 0] / z + w / 2).astype(np.int32)
    v = (f * P[:, 1] / z + h / 2).astype(np.int32)
    rad = np.clip((f * sc / z).astype(np.int32), 1, max_radius)

    pad = max_radius
    ok = (u > -pad) & (u < w + pad) & (v > -pad) & (v < h + pad)
    u, v, z, col, rad, al = u[ok], v[ok], z[ok], col[ok], rad[ok], al[ok]

    o = np.argsort(-z)
    u, v, col, rad, al = u[o], v[o], col[o], rad[o], al[o]

    # Небо в этой съёмке ничем не замаскировано, и обучение набило его крупными
    # полупрозрачными сплатами. Фон берётся серым, а не чёрным, чтобы дыры в
    # облаке не читались как «тут что-то тёмное»: чёрный фон врёт в пользу
    # плотности.
    img = np.full((h, w, 3), 0.55, np.float32)
    bucket = np.clip(np.ceil(np.log2(rad)).astype(np.int32), 0, 6)
    step = max(1, len(u) // chunks)
    for lo in range(0, len(u), step):
        hi = lo + step
        for b in range(7):
            m = bucket[lo:hi] == b
            if not m.any():
                continue
            uu, vv = u[lo:hi][m], v[lo:hi][m]
            cc, aa = col[lo:hi][m], al[lo:hi][m][:, None]
            s = 1 << b
            for dy in range(s):
                for dx in range(s):
                    yy = np.clip(vv + dy - s // 2, 0, h - 1)
                    xx = np.clip(uu + dx - s // 2, 0, w - 1)
                    img[yy, xx] = img[yy, xx] * (1 - aa) + cc * aa
    return (np.clip(img, 0, 1) * 255).astype(np.uint8), len(u)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ply")
    ap.add_argument("--poses", required=True)
    ap.add_argument("--view", default="train",
                    choices=["train", "eval", "water"])
    ap.add_argument("--index", type=int, default=0)
    ap.add_argument("--height", type=float, default=1.6,
                    help="высота глаза над водой, м (для вида water)")
    ap.add_argument("--metres-per-unit", type=float, default=None,
                    help="масштаб реконструкции; по умолчанию из высоты полёта")
    ap.add_argument("--drone-altitude", type=float, default=350.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    xyz, scale, opac, rgb = load_ply(args.ply)
    poses = read_poses(args.poses)
    f, w, h = intrinsics(args.poses)
    print("сплатов %d, из них плотнее 0.15: %d" % (len(xyz), int((opac >= 0.15).sum())))

    if args.view in ("train", "eval"):
        i = args.index if args.view == "train" else (args.index * 8 + 7)
        p = poses[min(i, len(poses) - 1)]
        R, C = p["R"], p["C"]
        print("камера: %s" % p["name"])
    else:
        # Вертикаль оценивается по самим камерам: дрон летит горизонтально, а
        # земля под ним, поэтому «вверх» — та сторона, где камеры относительно
        # облака точек.
        cams = np.array([p["C"] for p in poses])
        up = cams.mean(0) - np.median(xyz, axis=0)
        up /= np.linalg.norm(up)

        mpu = args.metres_per_unit
        if mpu is None:
            alt = float(np.dot(cams.mean(0) - np.median(xyz, axis=0), up))
            mpu = args.drone_altitude / alt
            print("масштаб: 1 единица ≈ %.2f м (по высоте полёта %.0f м)"
                  % (mpu, args.drone_altitude))

        # Уровень земли — не медиана облака (в ней сидят крыши и небо), а
        # нижний хвост распределения по вертикали.
        alt = xyz @ up
        ground_level = np.percentile(alt, 5)
        centre = np.median(xyz[alt < np.percentile(alt, 40)], axis=0)
        centre = centre - up * np.dot(centre, up) + up * ground_level

        # Камера отходит назад вдоль полёта и опускается к воде, а смотрит в
        # середину сцены. Направление «вдоль полёта наугад» здесь не годится:
        # первый вариант так и смотрел, и в кадр не попало ни одной точки.
        fwd = cams[-1] - cams[0]
        fwd -= up * np.dot(fwd, up)
        fwd /= np.linalg.norm(fwd)
        span = float(np.ptp(xyz @ fwd))
        C = centre - fwd * (0.6 * span) + up * (args.height / mpu)

        look = centre - C
        look /= np.linalg.norm(look)
        right = np.cross(look, up)
        right /= np.linalg.norm(right)
        down = np.cross(look, right)
        R = np.stack([right, down, look])     # строки: X вправо, Y вниз, Z вперёд
        print("камера с воды: %.1f м над урезом, %.0f м до середины сцены"
              % (args.height, 0.6 * span * mpu))

    img, n = render(xyz, rgb, opac, scale, R, C, f, w, h)
    Image.fromarray(img).save(args.out)
    print("нарисовано точек: %d -> %s" % (n, args.out))


if __name__ == "__main__":
    main()
