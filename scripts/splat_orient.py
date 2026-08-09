#!/usr/bin/env python3
"""Привести облако сплатов к канонической системе: вверх +Y, вдоль полёта +Z.

    python3 scripts/splat_orient.py data/video/shot01/evalout/splat_7000.ply \\
        --poses data/video/shot01/sparse/1 --out .../splat_up.ply

Зачем. Реконструкция выходит в произвольной системе SfM, и вертикали в ней нет
никакой. Brush оценивает её сам и пишет в комментарий PLY, но на этой съёмке
промахнулся на 87° — просмотрщик показывал сцену лежащей на боку.

Как оценивается вертикаль здесь. Не по центроиду облака: центроид смещён небом
и застройкой, и на этой съёмке такая оценка ошибается на 58°. Берутся два
условия, оба геометрические:

  * у камеры без крена вектор «вправо» горизонтален;
  * дрон летит горизонтально, то есть траектория тоже горизонтальна.

Вертикаль перпендикулярна обоим, то есть равна их векторному произведению.
Проверка встроена и печатается: при верной вертикали траектория обязана лечь в
горизонт с точностью в доли градуса. Если печатается больше — съёмка была с
набором высоты, и оценку надо брать иначе.

Поворачиваются и позиции, и кватернионы сплатов; масштабы, цвет и прозрачность
не меняются.
"""

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from splat_render import read_poses  # noqa: E402


def read_ply_raw(path):
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
        data = np.frombuffer(f.read(n * len(props) * 4), np.float32).reshape(n, -1)
    return head.decode("ascii", "ignore"), props, data.copy()


def quat_of_matrix(M):
    """Кватернион (w, x, y, z) по матрице поворота."""
    t = M.trace()
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        return np.array([0.25 * s, (M[2, 1] - M[1, 2]) / s,
                         (M[0, 2] - M[2, 0]) / s, (M[1, 0] - M[0, 1]) / s])
    i = int(np.argmax([M[0, 0], M[1, 1], M[2, 2]]))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = np.sqrt(M[i, i] - M[j, j] - M[k, k] + 1.0) * 2
    q = np.zeros(4)
    q[0] = (M[k, j] - M[j, k]) / s
    q[i + 1], q[j + 1], q[k + 1] = 0.25 * s, (M[j, i] + M[i, j]) / s, (M[k, i] + M[i, k]) / s
    return q


def quat_mul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw], axis=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ply")
    ap.add_argument("--poses", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    head, props, data = read_ply_raw(args.ply)
    col = {p: i for i, p in enumerate(props)}
    poses = read_poses(args.poses)
    cams = np.array([p["C"] for p in poses])

    right = np.array([p["R"][0] for p in poses]).mean(0)
    right /= np.linalg.norm(right)
    fwd = cams[-1] - cams[0]
    fwd /= np.linalg.norm(fwd)
    up = np.cross(fwd, right)
    up /= np.linalg.norm(up)

    xyz = data[:, [col["x"], col["y"], col["z"]]]
    if np.dot(up, cams.mean(0) - np.median(xyz, axis=0)) < 0:
        up = -up
    tilt = 90 - np.degrees(np.arccos(np.clip(abs(np.dot(fwd, up)), -1, 1)))
    print("вертикаль: %s" % np.round(up, 4))
    print("проверка: траектория к горизонту %.2f° (должно быть около нуля)" % tilt)

    # Строки матрицы — новые оси в старых координатах: X вправо, Y вверх, Z вдоль
    # полёта. Ортогонализация нужна, потому что fwd и up получены независимо.
    f = fwd - up * np.dot(fwd, up)
    f /= np.linalg.norm(f)
    M = np.stack([np.cross(f, up), up, f])
    if np.linalg.det(M) < 0:
        M[0] = -M[0]

    # Сплаты с NaN в позиции невидимы, но габариты сцены считаются по всем, и
    # один такой делает габарит бесконечным — просмотрщик после этого ставит
    # камеру неизвестно куда. Выбрасываются здесь, раз файл всё равно пишется
    # заново.
    ok = np.isfinite(data).all(1)
    if not ok.all():
        print("выброшено сплатов с NaN: %d" % int((~ok).sum()))
        data, xyz = data[ok], xyz[ok]

    centre = np.median(xyz, axis=0)
    data[:, [col["x"], col["y"], col["z"]]] = (M @ (xyz - centre).T).T

    q = data[:, [col["rot_0"], col["rot_1"], col["rot_2"], col["rot_3"]]]
    data[:, [col["rot_0"], col["rot_1"], col["rot_2"], col["rot_3"]]] = \
        quat_mul(quat_of_matrix(M), q)

    out_head = []
    for ln in head.split("\n"):
        if ln.startswith("comment Vertical axis"):
            ln = "comment Vertical axis: 0 1 0"
        elif ln.startswith("element vertex"):
            ln = "element vertex %d" % len(data)
        out_head.append(ln)
    with open(args.out, "wb") as fo:
        fo.write("\n".join(out_head).encode("ascii"))
        fo.write(data.astype(np.float32).tobytes())

    h = data[:, col["y"]]
    print("после поворота, высоты облака (ед): %s"
          % np.round(np.percentile(h, [1, 25, 50, 75, 99]), 1))
    print("записано: %s" % args.out)


if __name__ == "__main__":
    main()
