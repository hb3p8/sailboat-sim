#!/usr/bin/env python3
"""Небо для симулятора: `assets/sky_clouds.hdr` -> `assets/sky.jpg` + положение солнца.

    python3 scripts/build_sky.py [--width 2048] [--quality 88]

ЗАЧЕМ ПЕРЕПАКОВЫВАТЬ. Исходник — пятнадцать мегабайт Radiance RGBE, 4096x2048.
Большой динамический диапазон в нём нужен тому, кто светит этой картой сцену; у
нас светит аналитическое солнце и полусферический свет, а карта работает фоном и
отражением в воде. Фону хватает восьми бит на канал: всё, что ярче белого, на
экране всё равно белое.

СОЛНЦЕ НА КАРТЕ И СОЛНЦЕ В СЦЕНЕ — ОДНО И ТО ЖЕ. Это главное здесь и есть.
Нарисованный диск в небе и источник света, от которого лежат блик на воде и тень
паруса, обязаны стоять в одном месте: иначе картинка разъезжается тем самым
образом, который глаз ловит мгновенно, а объяснить не может — блик не там, где
солнце. Поэтому направление не подбирается на глаз, а СЧИТАЕТСЯ по самой карте:
берётся яркостный центр тяжести диска и переводится в направление тем же
соотношением, каким three выбирает текселы равнопромежуточной карты
(`equirectUV` в вендоренной сборке):

    u = atan2(d.z, d.x) / 2pi + 0.5
    v = asin(d.y) / pi + 0.5

Строка файла и v связаны переворотом: у текстуры three по умолчанию flipY, то
есть первая строка файла — верх изображения, а верху отвечает v = 1.

ЭКСПОЗИЦИЯ. Диск солнца в этой карте ярче неба вокруг в тысячи раз, и «поделить
на максимум» превратило бы всё небо в чёрное. Масштаб берётся по НЕБУ: яркость,
ниже которой лежит заданная доля пикселей, кладётся в заданную точку шкалы.
Солнце при этом честно уходит в насыщение и остаётся белым диском — чем оно на
фотографии и является.
"""

import argparse
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "assets", "sky_clouds.hdr")
DST = os.path.join(ROOT, "assets", "sky.jpg")
META = os.path.join(ROOT, "assets", "sky.json")


def read_hdr(path):
    """Radiance RGBE со сжатием по строкам -> массив float (H, W, 3).

    Свой разбор, потому что PIL этого формата не знает, а тянуть ради одного
    файла ещё одну зависимость незачем. Формат простой: заголовок текстом,
    строка разрешения, дальше строки — либо новым RLE по четырём плоскостям,
    либо подряд.
    """
    with open(path, "rb") as f:
        blob = f.read()

    # Заголовок кончается пустой строкой, за ней строка разрешения.
    pos = 0
    while True:
        end = blob.index(b"\n", pos)
        line = blob[pos:end]
        pos = end + 1
        if line == b"":
            break
    end = blob.index(b"\n", pos)
    res = blob[pos:end].split()
    pos = end + 1
    if res[0] != b"-Y" or res[2] != b"+X":
        raise SystemExit("ожидалась развёртка -Y H +X W, а не %s" % res)
    h, w = int(res[1]), int(res[3])

    rgbe = np.zeros((h, w, 4), np.uint8)
    for y in range(h):
        if pos + 4 > len(blob):
            raise SystemExit("файл кончился на строке %d" % y)
        a, b, c, d = blob[pos], blob[pos + 1], blob[pos + 2], blob[pos + 3]
        if a == 2 and b == 2 and ((c << 8) | d) == w and 8 <= w < 32768:
            pos += 4
            for ch in range(4):
                x = 0
                while x < w:
                    n = blob[pos]
                    pos += 1
                    if n > 128:                     # повтор
                        rgbe[y, x:x + n - 128, ch] = blob[pos]
                        x += n - 128
                        pos += 1
                    else:                           # подряд
                        rgbe[y, x:x + n, ch] = np.frombuffer(
                            blob, np.uint8, n, pos)
                        x += n
                        pos += n
        else:                                       # без сжатия
            rgbe[y] = np.frombuffer(blob, np.uint8, w * 4, pos).reshape(w, 4)
            pos += w * 4

    e = rgbe[:, :, 3].astype(np.int32)
    scale = np.where(e > 0, np.exp2(e - (128 + 8)), 0.0).astype(np.float32)
    return rgbe[:, :, :3].astype(np.float32) * scale[:, :, None]


def sun_direction(lum, frac=0.02):
    """Направление на солнце: яркостный центр тяжести самого яркого пятна.

    Один пиксель брать нельзя — диск занимает десятки, и максимум в нём стоит
    не в середине, а там, где меньше облака. Порог берётся долей от максимума, и
    дальше считается взвешенное среднее по НАПРАВЛЕНИЯМ, а не по координатам:
    складывать долготы у края карты значило бы получить середину не там, где
    пятно, а на противоположной стороне неба.
    """
    h, w = lum.shape
    thr = lum.max() * frac
    ys, xs = np.nonzero(lum >= thr)
    if not len(ys):
        raise SystemExit("на карте нет ничего ярче порога")
    wgt = lum[ys, xs].astype(np.float64)

    u = (xs + 0.5) / w
    v = 1.0 - (ys + 0.5) / h            # flipY: первая строка файла — верх
    a = (u - 0.5) * 2 * math.pi
    y = np.sin((v - 0.5) * math.pi)
    cp = np.sqrt(np.maximum(0.0, 1.0 - y * y))
    d = np.stack([np.cos(a) * cp, y, np.sin(a) * cp], -1)
    s = (d * wgt[:, None]).sum(0)
    s /= np.linalg.norm(s)
    return s, len(ys), float(lum.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=2048,
                    help="ширина перепакованной карты")
    ap.add_argument("--quality", type=int, default=88)
    ap.add_argument("--rotate", type=float, default=180.0,
                    help="повернуть карту вокруг вертикали, градусов")
    ap.add_argument("--sky-percentile", type=float, default=97.0,
                    help="какой процентиль яркости НЕБА класть в точку шкалы")
    ap.add_argument("--sky-level", type=float, default=0.86,
                    help="...и в какую именно, 0..1")
    args = ap.parse_args()

    if not os.path.exists(SRC):
        raise SystemExit("нет %s" % os.path.relpath(SRC, ROOT))
    img = read_hdr(SRC)
    h, w, _ = img.shape
    # ПОВОРОТ ДЕЛАЕТСЯ ЗДЕСЬ, а не в сцене, и это важнее, чем кажется. Солнце
    # ищется на карте ПОСЛЕ поворота, значит рисунок и направление остаются
    # связаны по построению — их нечем рассогласовать. Поверни карту в сцене, и
    # эту связь пришлось бы держать в голове, а держится она ровно до первой
    # правки.
    #
    # Зачем вообще: закат на исходной карте приходится на восток. Для здешней
    # акватории это невозможное небо, а разворот на полкруга ставит его туда,
    # где солнце и садится.
    if args.rotate:
        img = np.roll(img, int(round(w * (args.rotate / 360.0))), axis=1)
    # Яркость покомпонентно, а не матричным произведением: на массиве в
    # четверть гигабайта numpy ругался на него «invalid value», хотя ни одного
    # не-числа в данных нет. Спорить не о чем — три умножения и так яснее.
    lum = (img[:, :, 0] * 0.2126 + img[:, :, 1] * 0.7152
           + img[:, :, 2] * 0.0722)

    d, npix, peak = sun_direction(lum)
    # Высота над горизонтом и азимут — только чтобы человеку было что прочитать
    # в выводе; в сцену идёт сам вектор.
    alt = math.degrees(math.asin(d[1]))
    azi = (math.degrees(math.atan2(d[2], d[0])) + 360) % 360
    print("карта %dx%d, пик яркости %.0f, диск %d пикселей" % (w, h, peak, npix))
    print("солнце: направление (%.4f, %.4f, %.4f), над горизонтом %.1f°"
          % (d[0], d[1], d[2], alt))

    # Экспозиция по небу, а не по максимуму: см. заголовок.
    sky = lum[lum < peak * 0.02]
    ref = float(np.percentile(sky, args.sky_percentile))
    k = args.sky_level / max(ref, 1e-6)
    print("небо: %g-й процентиль = %.3f -> %.2f, множитель %.3f"
          % (args.sky_percentile, ref, args.sky_level, k))

    # Цвет горизонта — средний по полосе в пять градусов вокруг него, в
    # линейном пространстве и с той же экспозицией, что у самой карты. Им
    # красится туман и им же остаётся небо, пока карта не пришла: если взять
    # цвет с потолка, дальний берег растворяется не в то небо, над которым
    # стоит, и стык видно даже на неподвижном кадре.
    band = max(1, int(h * 5.0 / 180.0))
    j0 = h // 2 - band
    horizon = np.clip(img[j0:j0 + 2 * band].reshape(-1, 3).mean(0) * k, 0, 1)
    hs = np.where(horizon <= 0.0031308, horizon * 12.92,
                  1.055 * np.power(horizon, 1 / 2.4) - 0.055)
    hex_horizon = "#%02x%02x%02x" % tuple(int(c * 255 + 0.5) for c in hs)
    print("горизонт: %s" % hex_horizon)

    ldr = np.clip(img * k, 0.0, 1.0)
    # В файл кладётся sRGB: JPEG хранится именно так, и три читает его так же,
    # если текстуре поставить sRGB-пространство.
    srgb = np.where(ldr <= 0.0031308, ldr * 12.92,
                    1.055 * np.power(ldr, 1 / 2.4) - 0.055)
    pic = Image.fromarray((srgb * 255 + 0.5).astype(np.uint8))
    if args.width and args.width < w:
        pic = pic.resize((args.width, args.width // 2), Image.LANCZOS)
    pic.save(DST, "JPEG", quality=args.quality, optimize=True,
             progressive=True)

    json.dump({"sun": [round(float(x), 5) for x in d],
               "horizon": hex_horizon,
               "sun_altitude_deg": round(alt, 2),
               "sun_azimuth_deg": round(azi, 2),
               "source": os.path.basename(SRC),
               "exposure": round(k, 6)},
              open(META, "w"), ensure_ascii=False, indent=1)
    print("%s — %.0f КБ (было %.1f МБ)"
          % (os.path.relpath(DST, ROOT), os.path.getsize(DST) / 1024,
             os.path.getsize(SRC) / 1048576))


if __name__ == "__main__":
    main()
