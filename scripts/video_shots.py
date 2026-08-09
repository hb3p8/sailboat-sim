#!/usr/bin/env python3
"""Разрезать видео на планы и вынуть кадры одного плана для фотограмметрии.

    python3 scripts/video_shots.py data/video/6LTJFLL0pAQ.webm --list
    python3 scripts/video_shots.py data/video/6LTJFLL0pAQ.webm --shot 1 --fps 3

Зачем разрезать. Ролик с дрона — это монтаж: десяток пролётов, снятых в разных
местах и склеенных встык. Для фотограмметрии это не одна съёмка, а десять
независимых, и подавать их в SfM вместе бессмысленно: между планами нет ни
перекрытия, ни общей геометрии, зато есть похожие текстуры (вода, кроны,
крыши), на которых сопоставление радостно склеивает несвязанные места.

Границы ищутся штатным детектором ffmpeg по разнице кадров. Порог 0.3 берёт
монтажные склейки и не срабатывает на плавном полёте; наплывы и растворения он
не поймает, но в съёмке с дрона их обычно и нет.

Кадры прореживаются и фильтруются по резкости. Прореживание — потому что при
30 к/с соседние кадры отличаются на сантиметры, и SfM от них только пухнет.
Фильтр по резкости — потому что дрон на развороте смазывает, а смазанный кадр
не просто бесполезен: он даёт ложные соответствия и тянет за собой ошибку в
позы соседей.

Резкость меряется дисперсией лапласиана — обычная мера для этого, и порог берётся
не абсолютный, а по медиане самого плана: экспозиция и грейдинг у роликов
разные, и одно число на все не годится.
"""

import argparse
import json
import os
import re
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

SCENE_THRESHOLD = 0.3    # разница кадров, выше которой это склейка
MIN_SHOT_S = 4.0         # планы короче не интересны: позы по ним не сойдутся
SHARP_FRACTION = 0.6     # доля медианной резкости, ниже которой кадр выбрасывается


def probe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def find_cuts(path):
    """Секунды, на которых ffmpeg видит монтажную склейку."""
    out = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", path,
         "-vf", "select='gt(scene,%g)',showinfo" % SCENE_THRESHOLD,
         "-an", "-f", "null", "-"],
        capture_output=True, text=True)
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", out.stderr)]


def shots(path):
    dur = probe_duration(path)
    bounds = [0.0] + find_cuts(path) + [dur]
    out = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a >= MIN_SHOT_S:
            out.append((a, b))
    return out, dur


def sharpness(path):
    """Дисперсия лапласиана по яркости, уменьшенной до 512 по длинной стороне."""
    im = Image.open(path).convert("L")
    im.thumbnail((512, 512))
    a = np.asarray(im, np.float32)
    lap = (-4 * a[1:-1, 1:-1] + a[:-2, 1:-1] + a[2:, 1:-1]
           + a[1:-1, :-2] + a[1:-1, 2:])
    return float(lap.var())


def extract(path, start, end, dst, fps, width):
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(dst):
        os.remove(os.path.join(dst, f))
    subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", "%.3f" % start, "-to", "%.3f" % end,
         "-i", path, "-vf", "fps=%g,scale=%d:-2:flags=lanczos" % (fps, width),
         "-q:v", "2", os.path.join(dst, "%04d.jpg")],
        check=True)
    return sorted(os.listdir(dst))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("video")
    ap.add_argument("--list", action="store_true", help="только показать планы")
    ap.add_argument("--shot", type=int, default=1, help="номер плана, с единицы")
    ap.add_argument("--fps", type=float, default=3.0)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    sh, dur = shots(args.video)
    if args.list:
        print("%s — %.0f с, планов длиннее %.0f с: %d"
              % (os.path.basename(args.video), dur, MIN_SHOT_S, len(sh)))
        for i, (a, b) in enumerate(sh, 1):
            print("  %2d  %6.1f…%6.1f  %5.1f с" % (i, a, b, b - a))
        return

    a, b = sh[args.shot - 1]
    dst = args.out or os.path.join(ROOT, "data", "video", "shot%02d" % args.shot,
                                   "images")
    names = extract(args.video, a, b, dst, args.fps, args.width)
    print("план %d: %.1f…%.1f с, кадров %d" % (args.shot, a, b, len(names)))

    # Отбраковка смазанных
    vals = {n: sharpness(os.path.join(dst, n)) for n in names}
    med = float(np.median(list(vals.values())))
    dropped = [n for n, v in vals.items() if v < SHARP_FRACTION * med]
    for n in dropped:
        os.remove(os.path.join(dst, n))
    print("резкость: медиана %.0f, выброшено %d, осталось %d"
          % (med, len(dropped), len(names) - len(dropped)))

    meta = {"video": os.path.relpath(args.video, ROOT), "shot": args.shot,
            "start_s": a, "end_s": b, "fps": args.fps, "width": args.width,
            "frames": len(names) - len(dropped)}
    with open(os.path.join(os.path.dirname(dst), "shot.json"), "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
