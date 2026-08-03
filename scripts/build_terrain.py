#!/usr/bin/env python3
"""Выгрузить рельеф и берег речного участка в out/terrain.json.

    python3 scripts/build_terrain.py [--step 20] [--level 66.0]

Участок задан ниже константой BBOX — плёс Волги ниже стрелки с Окой. Скачанное
кладётся в data/terrain/ и оттуда переиспользуется: сеть до бакета DEM бывает
медленной, а данные не меняются.

Что получается на выходе: высоты и доля воды на метрической сетке, упакованные
в base64 (int16 в дециметрах и uint8 соответственно). Ни физики, ни привязки к
симулятору здесь нет — это заготовка, которую пока только смотрят глазами
(`scripts/build_terrain_viewer.py`).
"""

import argparse
import base64
import json
import os
import sys

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

from sv20 import terrain  # noqa: E402

# Квадрат от N 56.37601° E 43.90788° до N 56.27226° E 44.15816° — примерно
# 15.5 × 11.5 км: стрелка Оки с Волгой и плёс вниз по течению.
BBOX = {"north": 56.37601, "west": 43.90788, "south": 56.27226, "east": 44.15816}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--step", type=float, default=20.0,
                    help="шаг сетки, м (по умолчанию 20)")
    ap.add_argument("--level", type=float, default=None,
                    help="урез воды, м над эллипсоидом; по умолчанию — медиана DEM по воде")
    args = ap.parse_args()

    cache = os.path.join(ROOT, "data", "terrain")
    t = terrain.build(BBOX, args.step, cache, level=args.level)

    h, cov = t.pop("height"), t.pop("water")
    # Дециметры: диапазон высот здесь — сотни метров, а 0.1 м мельче, чем
    # что-либо в этих данных различимо.
    hi = np.round(h * 10.0).astype(np.int16)
    t["height_dm_b64"] = base64.b64encode(hi.tobytes()).decode()
    t["water_b64"] = base64.b64encode(
        np.round(cov * 255).astype(np.uint8).tobytes()).decode()

    out = os.path.join(ROOT, "out")
    os.makedirs(out, exist_ok=True)
    dst = os.path.join(out, "terrain.json")
    with open(dst, "w") as f:
        json.dump(t, f, ensure_ascii=False, separators=(",", ":"))

    print("%s — %.0f КБ" % (os.path.relpath(dst, ROOT), os.path.getsize(dst) / 1024))
    print("сетка %d × %d, шаг %.0f м, участок %.2f × %.2f км"
          % (t["nx"], t["ny"], t["step"], t["size"][0] / 1000, t["size"][1] / 1000))
    print("урез %.1f м, высоты %.1f…%.1f м, воды %.0f%% площади"
          % (t["level"], t["hmin"], t["hmax"], 100 * t["water_fraction"]))


if __name__ == "__main__":
    main()
