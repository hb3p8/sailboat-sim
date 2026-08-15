#!/usr/bin/env python3
"""Карта акватории в сжатый GLB: `assets/terrain.glb`.

    python3 scripts/build_terrain_glb.py [--eye 6] [--dirs 64] [--no-cull]

Раньше геометрия карты строилась в браузере, из полей, вклеенных в страницу
base64. Это стоило дважды: полтора мегабайта в самом файле и полсекунды на
разбор с постройкой семисот буферов при каждом открытии. Ни то ни другое не
меняется от запуска к запуску — карта одна и та же, — и значит должно быть
запечено заранее.

Здесь оно и запекается: тот же рельеф, тот же покров, те же куски по 48 ячеек
ради отбраковки по пирамиде видимости, — но один раз и в жатый Draco файл.
Страница его подгружает, как подгружает фигурки экипажа, и без сервера
открывается без карты, а не ломается.

ЧТО ВЫБРАСЫВАЕТСЯ И ПОЧЕМУ

Покров — лес и застройка — занимает 47 % клеток, и с воды его почти не видно.
Не «плохо видно», а НЕ ВИДНО: массив закрывает сам себя. С уреза различима
передняя кромка квартала да то, что поднимается над ней силуэтом; всё, что за
ними, заслонено, и рисуется впустую.

Считается это развёрткой по азимутам. Для каждого из `--dirs` направлений сетка
режется на параллельные лучи; по лучу идёт бегущий максимум угла возвышения, а
наблюдатель переезжает на воду каждый раз, как луч её пересекает, — река петляет,
и один и тот же склон виден с разных её колен. Клетка считается видимой, если её
верх поднимается выше уже накопленного горизонта. Заслоняет ВЕРХ покрова, а не
земля: стена леса на бровке закрывает всё за собой.

Мерено на здешней акватории: при глазе в полутора метрах над урезом прячется
94.3 % покрова, при пяти — 92.0 %, при пятнадцати — 84.8 %. До пяти метров
кривая плоская, и туда попадают все лодочные камеры. Отсюда и `--eye 6` по
умолчанию: с запасом на свободную камеру, поднятую над палубой.

Чего это стоит: массив делается полым. С воды разницы нет по построению, а вот
вид с высоты — тот, что с километра, — показывает кольцо леса с землёй внутри.
Это осознанная плата: вид с высоты здесь карта, а не картина.

РАЗМЕР КУСКА, и почему он такой странный

Куски нужны, чтобы three выбрасывал из отрисовки то, что за спиной. Чем они
мельче, тем точнее отбраковка, — и тем больше объектов, матриц и вызовов
отрисовки. Оптимум мерен на скамье, случай «у воды», по цене кадра:

    куски по  48 ячеек, 446 штук  — 1.41 мс
    куски по 144 ячейки,  78 штук — 0.94 мс
    куски по 288 ячеек,   24 штуки — 1.49 мс

Отсюда 144. Крупнее — отбраковка перестаёт отбраковывать и в кадр лезет вся
карта; мельче — накладные расходы съедают выигрыш.

ЛОДОВ ЗДЕСЬ НЕТ, И ЭТО ТОЖЕ РЕЗУЛЬТАТ ЗАМЕРА

Уровни детализации были сделаны и померены: каждый кусок в трёх прореживаниях
(20/40/80 м), швы закрыты юбками, сборка через THREE.LOD. Вышло МЕДЛЕННЕЕ — 1.86
мс против 1.41 при тех же кусках. Причина простая и на бумаге невидимая: кадр
упирается не в треугольники, а в число объектов. Восемьсот тысяч треугольников
эта видеокарта рисует за миллисекунду с небольшим, а вот втрое больше узлов в
графе сцены — с их матрицами и обходом — обходятся дороже, чем сэкономленная
геометрия. Отсюда и размер куска выше: единственный работающий рычаг здесь —
меньше объектов, а не меньше вершин.
"""

import argparse
import base64
import json
import math
import os
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PACK = os.path.join(ROOT, "out", "export", "terrain_pack.json")
DST = os.path.join(ROOT, "assets", "terrain.glb")

# Ячеек в куске сетки. Число мерено, а не взято на глаз, — см. заголовок.
CHUNK = 144

# Прореживание уровней: 1 — полная сетка (20 м), 2 — 40 м, 4 — 80 м.
#
# Уровни пекутся ОТДЕЛЬНЫМИ СЕТКАМИ ОДНОГО И ТОГО ЖЕ КУСКА, а не отдельными
# узлами сцены — страница подменяет мешу геометрию по дальности, и число
# объектов в кадре остаётся прежним. Прошлая попытка лодов делалась через
# THREE.LOD, то есть втрое больше узлов, и вышла медленнее (1.86 мс против
# 1.41): кадр на настольной машине упирается именно в узлы. Здесь этой платы нет.
LODS = (1, 2, 4)

# Цвета. Земля красится по высоте над урезом, дно под водой — своим цветом:
# иначе мель читается как суша, и вся береговая черта теряет смысл.
LAND_RAMP = [(0.0, 0x4d6b4a), (6.0, 0x6f8352), (18.0, 0x8b9159),
             (40.0, 0xa89a6c), (80.0, 0xc0b189), (140.0, 0xdcd5c0)]
BED = 0x2f4a52
COVER_COLOUR = {1: 0x2f4a26, 2: 0x8c8377}
COVER_NAME = {1: "лес", 2: "застройка"}


def srgb_to_linear(c):
    """glTF хранит baseColorFactor и COLOR_0 в линейном пространстве."""
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hex_rgb(h):
    return np.array([(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255])


def land_tint(dh):
    """Цвет земли по превышению над урезом, линейный."""
    xs = np.array([p[0] for p in LAND_RAMP])
    cs = np.stack([hex_rgb(p[1]) for p in LAND_RAMP])
    i = np.clip(np.searchsorted(xs, dh, "right") - 1, 0, len(xs) - 2)
    t = np.clip((dh - xs[i]) / (xs[i + 1] - xs[i]), 0, 1)[:, None]
    return srgb_to_linear(cs[i] * (1 - t) + cs[i + 1] * t)


def viewshed(top, water, level, eye, dirs, far):
    """Что видно хотя бы с одной точки воды. Подробности — в заголовке."""
    ny, nx = top.shape
    step = STEP
    vis = np.zeros((ny, nx), bool)
    for a in range(dirs):
        th = 2 * np.pi * a / dirs
        dx, dy = np.cos(th), np.sin(th)
        along_x = abs(dx) >= abs(dy)
        if along_x:
            n_main, n_line, slope = nx, ny, dy / dx
            sgn = 1 if dx > 0 else -1
        else:
            n_main, n_line, slope = ny, nx, dx / dy
            sgn = 1 if dy > 0 else -1
        lines = np.arange(n_line)
        step_len = step / max(abs(dx), abs(dy))

        have = np.zeros(n_line, bool)
        obs_s = np.zeros(n_line, np.float32)
        horiz = np.full(n_line, -1e9, np.float32)
        start = 0 if sgn > 0 else n_main - 1

        for si, s in enumerate(range(n_main) if sgn > 0
                               else range(n_main - 1, -1, -1)):
            off = np.rint(lines + (s - start) * slope * sgn).astype(np.int32)
            ok = (off >= 0) & (off < n_line)
            if along_x:
                iy, ix = np.clip(off, 0, ny - 1), np.full(n_line, s)
            else:
                iy, ix = np.full(n_line, s), np.clip(off, 0, nx - 1)

            w = water[iy, ix] & ok
            have |= w
            obs_s = np.where(w, si, obs_s)
            horiz = np.where(w, -1e9, horiz)

            d = (si - obs_s) * step_len
            live = have & ok & (~w) & (d > 0) & (d <= far)
            ang = np.where(live, (top[iy, ix] - (level + eye))
                           / np.maximum(d, 1e-3), -1e9)
            seen = live & (ang >= horiz)
            vis[iy[seen], ix[seen]] = True
            horiz = np.where(live, np.maximum(horiz, ang), horiz)
    return vis


# --- настоящие здания -----------------------------------------------------------
#
# Кубики по клеткам двадцать на двадцать метров — это гребёнка, а не город.
# Настоящие контуры лежат в OSM, и в видимой с воды полосе их около трёх с
# половиной тысяч: примерно восемьдесят тысяч треугольников, то есть пять
# процентов к бюджету карты. За эти пять процентов берег перестаёт быть
# гребёнкой.
#
# ВЫСОТЫ, и это главная морока. У Яндекса они наверняка есть, но данные там
# проприетарные и брать их нельзя. Свой Copernicus DSM тоже не выручил: он
# поверхность отражения, крыши в нём есть, — но подстановка земли под массивом
# настроена на кварталы целиком, и на отдельных домах разность вырождается.
# Померено: 98.8 % клеток застройки стоят ровно на минимуме в десять метров.
#
# Остаётся OSM, и там картина неровная. По всему квадрату `height` проставлен у
# сорока зданий из тридцати двух тысяч. Зато `building:levels` в полосе
# набережной есть почти у половины — 579 из 1200, — а нам нужна ровно она.
# Остальным этажность берётся у соседей: застройка идёт кварталами одной эпохи,
# и медиана по округе предсказывает лучше любой константы.
OVERPASS = ("https://overpass-api.de/api/interpreter",
            "https://overpass.private.coffee/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter")
CACHE = os.path.join(ROOT, "data", "terrain")
STOREY_M = 3.0            # высота этажа, м
HOUSE_M = 10.0            # если и у соседей ничего нет
# Радиусы, которыми спрашиваем соседей, — ступенями. Первый заход брал один
# радиус в полтораста метров, и высота по умолчанию досталась 57 % домов: на
# плотной набережной сосед с тегом всегда рядом, а на выселках его нет ни
# одного. Ступени решают это, не размывая плотную застройку: там ответ находится
# на первом же радиусе, и до следующих дело не доходит.
NEAR_M = (150.0, 400.0, 1200.0)
TILE_DEG = 0.02           # шаг сетки запросов, ~1.2 x 2.2 км


def osm_buildings(bbox):
    """Контуры зданий с тегами. Качается плитками и кэшируется на диск.

    Плитками — потому что запрос на весь квадрат Overpass не отдаёт: тридцать
    пять тысяч контуров с геометрией это десятки мегабайт, и зеркала отвечают
    на это пятьсот четвёртой. Плитка кэшируется своим файлом, так что повторная
    сборка сети не трогает вовсе.
    """
    out = []
    lat0, lat1 = bbox[0], bbox[2]
    lon0, lon1 = bbox[1], bbox[3]
    ny = int(math.ceil((lat1 - lat0) / TILE_DEG))
    nx = int(math.ceil((lon1 - lon0) / TILE_DEG))
    for jy in range(ny):
        for jx in range(nx):
            s0 = lat0 + jy * TILE_DEG
            w0 = lon0 + jx * TILE_DEG
            box = (s0, w0, min(s0 + TILE_DEG, lat1), min(w0 + TILE_DEG, lon1))
            name = "buildings_%.4f_%.4f.json" % (s0, w0)
            path = os.path.join(CACHE, name)
            if not os.path.exists(path):
                q = ('[out:json][timeout:300];\n(way["building"](%f,%f,%f,%f);'
                     'relation["building"](%f,%f,%f,%f););\nout geom;'
                     % (box + box))
                blob = None
                for url in OVERPASS:
                    try:
                        req = urllib.request.Request(
                            url, data=urllib.parse.urlencode({"data": q}).encode(),
                            headers={"User-Agent": "sv20-terrain/1.0"})
                        with urllib.request.urlopen(req, timeout=300) as r:
                            blob = r.read()
                        json.loads(blob)   # обрыв на середине выглядит успехом
                        break
                    except Exception:      # noqa: BLE001 — важен факт, не вид
                        blob = None
                        time.sleep(3)
                if blob is None:
                    print("плитка %.3f,%.3f не скачалась — пропущена"
                          % (s0, w0), file=sys.stderr)
                    continue
                os.makedirs(CACHE, exist_ok=True)
                open(path + ".part", "wb").write(blob)
                os.replace(path + ".part", path)
            for e in json.load(open(path))["elements"]:
                tags = e.get("tags", {})
                if e["type"] == "way" and e.get("geometry"):
                    out.append(([(g["lat"], g["lon"]) for g in e["geometry"]], tags))
                elif e["type"] == "relation":
                    # Дырки не берём: это дворы, и с воды в них не заглянуть.
                    for m in e.get("members", []):
                        if m.get("role") == "outer" and m.get("geometry"):
                            out.append(([(g["lat"], g["lon"])
                                         for g in m["geometry"]], tags))
    return out


def levels_of(tags):
    """Этажность из тегов: сперва высота в метрах, потом этажи."""
    h = tags.get("height")
    if h:
        try:
            return float(str(h).split()[0]) / STOREY_M
        except ValueError:
            pass
    lv = tags.get("building:levels")
    if lv:
        try:
            return float(str(lv).split(";")[0])
        except ValueError:
            pass
    return None


def earclip(ring):
    """Треугольники простого многоугольника отсечением ушей.

    Библиотеки под рукой нет, а нужен здесь самый простой случай: контур без
    самопересечений и без дырок. Сорок строк дешевле зависимости.
    """
    n = len(ring)
    if n < 3:
        return []
    idx = list(range(n))
    tri = []
    guard = 0
    while len(idx) > 3 and guard < 4 * n:
        guard += 1
        for k in range(len(idx)):
            a, b, c = idx[k - 2], idx[k - 1], idx[k]
            ax, az = ring[a]; bx, bz = ring[b]; cx, cz = ring[c]
            cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
            if cross >= 0:            # не выпуклый угол при нашей ориентации
                continue
            bad = False
            for m in idx:
                if m in (a, b, c):
                    continue
                px, pz = ring[m]
                d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax)
                d2 = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx)
                d3 = (ax - cx) * (pz - cz) - (az - cz) * (px - cx)
                if (d1 <= 0) == (d2 <= 0) and (d2 <= 0) == (d3 <= 0):
                    bad = True
                    break
            if bad:
                continue
            tri.append((a, b, c))
            idx.pop(k - 1)
            guard = 0
            break
        else:
            break
    if len(idx) == 3:
        tri.append(tuple(idx))
    return tri



def building_meshes(pack, keep_urban):
    """Здания в осях сцены, разложенные по кускам карты.

    Возвращает {(ix0, iy0): (позиции, индексы)} и сводку по источникам высоты.
    """
    o, mpd = pack["origin"], pack["meters_per_deg"]
    hx = (NX - 1) * STEP / 2.0
    hy = (NY - 1) * STEP / 2.0
    bbox = (o["lat"] - hy / mpd["lat"], o["lon"] - hx / mpd["lon"],
            o["lat"] + hy / mpd["lat"], o["lon"] + hx / mpd["lon"])
    raw = osm_buildings(bbox)

    # Контуры в метры участка и отсев по видимости: держим только то, что стоит
    # на клетках, доживших до отбраковки по виду с воды.
    rings, lv = [], []
    for pts, tags in raw:
        xy = [((lon - o["lon"]) * mpd["lon"], (lat - o["lat"]) * mpd["lat"])
              for lat, lon in pts]
        if len(xy) > 2 and xy[0] == xy[-1]:
            xy.pop()
        if len(xy) < 3:
            continue
        cx = sum(p[0] for p in xy) / len(xy)
        cy = sum(p[1] for p in xy) / len(xy)
        ix = int(round((cx - X0) / STEP))
        iy = int(round((cy - Y0) / STEP))
        if not (0 <= ix < NX and 0 <= iy < NY) or not keep_urban[iy, ix]:
            continue
        rings.append((xy, cx, cy, ix, iy))
        lv.append(levels_of(tags))

    # Этажность у тех, кому её не проставили, берётся у соседей: застройка идёт
    # кварталами одной эпохи, и медиана по округе честнее любой константы.
    known = [i for i, v in enumerate(lv) if v]
    kx = np.array([rings[i][1] for i in known])
    ky = np.array([rings[i][2] for i in known])
    kv = np.array([lv[i] for i in known], float)
    src = {"свой тег": len(known), "по соседям": 0, "по умолчанию": 0}
    heights = []
    for i, (xy, cx, cy, ix, iy) in enumerate(rings):
        if lv[i]:
            heights.append(lv[i] * STOREY_M)
            continue
        for r in NEAR_M:
            near = (np.abs(kx - cx) < r) & (np.abs(ky - cy) < r)
            if near.any():
                heights.append(float(np.median(kv[near])) * STOREY_M)
                src["по соседям"] += 1
                break
        else:
            heights.append(HOUSE_M)
            src["по умолчанию"] += 1

    out = {}
    for (xy, cx, cy, ix, iy), h in zip(rings, heights):
        # Земля под пятном: подошва по самой низкой точке, крыша от медианы.
        # Иначе дом на склоне либо висит углом, либо тонет в бугре.
        gx = np.clip([int(round((p[0] - X0) / STEP)) for p in xy], 0, NX - 1)
        gy = np.clip([int(round((p[1] - Y0) / STEP)) for p in xy], 0, NY - 1)
        g = HEIGHT[gy, gx]
        base, roof = float(g.min()) - 1.0, float(np.median(g)) + h

        ring = [(x, -y) for x, y in xy]        # мир -> оси сцены
        a2 = sum(ring[k][0] * ring[(k + 1) % len(ring)][1]
                 - ring[(k + 1) % len(ring)][0] * ring[k][1]
                 for k in range(len(ring)))
        # Ориентация закрепляется знаком площади: при a2 < 0 крыша смотрит
        # вверх, а стенки, намотанные в том же порядке, — наружу. Знак выведен
        # на бумаге и совпадает с намоткой земли.
        if a2 > 0:
            ring.reverse()
        tri = earclip(ring)
        if not tri:
            continue

        key = (min((ix // CHUNK) * CHUNK, NX - 2), min((iy // CHUNK) * CHUNK, NY - 2))
        vp, vi = out.setdefault(key, ([], []))
        n0 = len(vp)
        for x, z in ring:
            vp.append((x, roof, z))
        for a, b, c in tri:
            vi.extend([n0 + a, n0 + b, n0 + c])
        m = len(ring)
        for k in range(m):
            x1, z1 = ring[k]
            x2, z2 = ring[(k + 1) % m]
            n = len(vp)
            vp.extend([(x1, base, z1), (x2, base, z2), (x2, roof, z2), (x1, roof, z1)])
            vi.extend([n, n + 1, n + 2, n, n + 2, n + 3])

    return {k: (np.array(v[0], np.float32), np.array(v[1], np.uint32))
            for k, v in out.items()}, src, len(rings)



# --- геометрия ----------------------------------------------------------------
#
# Оси: мир физики (X на восток, Y на север, Z вверх) в сцену three переводится
# как (x, z, -y). Здесь это делается один раз, при записи вершин, — тем же
# отображением, что и в sim/axes.js.

def land_chunk(ix0, iy0, nx, ny, stride=1):
    """Кусок рельефа. `stride` — прореживание: 2 это вчетверо меньше треугольников.

    КРАЙ КУСКА ВСЕГДА ПОЛНОЙ ПЛОТНОСТИ, прореживается только середина. Соседние
    куски выбирают уровень каждый по своей дальности, и если проредить край,
    два соседа на разных уровнях разойдутся по стыку — сквозь щель видно небо, и
    на воде это читается сразу.

    Обычное лекарство от этого — юбка, вертикальная стенка по периметру. Здесь
    она была сделана и выброшена: глубина юбки обязана покрывать то, на сколько
    прореженная поверхность отходит от полной, а на здешнем рельефе с перепадом
    в полтораста метров это десятки метров. Стенка такой высоты стоит на границе
    куска поперёк реки и загораживает пол-экрана. Проверено взглядом: при
    насильном уровне 2 (`sv20lod(2)`) кадр закрывало бежевой стеной целиком.

    Раз край общий и точный, щели нет ни при каких сочетаниях уровней, и никакой
    юбки не нужно. Платится за это переходной полосой треугольников вдоль края:
    ячейка на границе разбивается веером от своего внутреннего угла на мелкий
    край. Считается это по ячейкам, а не сеткой, — их немного, а ошибиться в
    намотке проще, чем сэкономить.
    """
    if stride <= 1:
        j, i = np.meshgrid(np.arange(ny), np.arange(nx), indexing="ij")
        x = X0 + (ix0 + i) * STEP
        y = Y0 + (iy0 + j) * STEP
        z = HEIGHT[iy0:iy0 + ny, ix0:ix0 + nx]
        pos = np.stack([x, z, -y], -1).reshape(-1, 3)
        wet = SDF[iy0:iy0 + ny, ix0:ix0 + nx] > 128
        col = land_tint((z - LEVEL).ravel())
        col[wet.ravel()] = srgb_to_linear(hex_rgb(BED))
        a = (j[:-1, :-1] * nx + i[:-1, :-1]).ravel()
        b, d, e = a + 1, a + nx, a + nx + 1
        # Намотка против часовой при взгляде сверху. Проверять это надо на
        # бумаге: «очевидный» порядок обхода даёт нормали вниз, вся суша уходит в
        # отбраковку задних граней, и экран показывает пустую воду.
        idx = np.stack([a, b, d, b, e, d], -1).ravel().astype(np.uint32)
        return pos.astype(np.float32), col.astype(np.float32), idx

    z_all = HEIGHT[iy0:iy0 + ny, ix0:ix0 + nx]
    wet_all = SDF[iy0:iy0 + ny, ix0:ix0 + nx] > 128

    ii = list(range(0, nx - 1, stride)) + [nx - 1]
    jj = list(range(0, ny - 1, stride)) + [ny - 1]

    vid = {}
    pos, col = [], []

    def vert(i, j):
        k = vid.get((i, j))
        if k is not None:
            return k
        k = len(pos)
        vid[(i, j)] = k
        z = float(z_all[j, i])
        pos.append((X0 + (ix0 + i) * STEP, z, -(Y0 + (iy0 + j) * STEP)))
        col.append(srgb_to_linear(hex_rgb(BED)) if wet_all[j, i]
                   else land_tint(np.array([z - LEVEL]))[0])
        return k

    def edge(i0, j0, i1, j1, fine):
        """Точки ребра от (i0,j0) до (i1,j1) БЕЗ последней; fine — дробить ли."""
        if not fine:
            return [(i0, j0)]
        n = max(abs(i1 - i0), abs(j1 - j0))
        si = (i1 - i0) // n if i1 != i0 else 0
        sj = (j1 - j0) // n if j1 != j0 else 0
        return [(i0 + si * t, j0 + sj * t) for t in range(n)]

    idx = []
    for l in range(len(jj) - 1):
        for k in range(len(ii) - 1):
            i0, i1 = ii[k], ii[k + 1]
            j0, j1 = jj[l], jj[l + 1]
            # Дробится только то ребро, что лежит на кромке куска.
            ring = (edge(i0, j0, i1, j0, j0 == 0)
                    + edge(i1, j0, i1, j1, i1 == nx - 1)
                    + edge(i1, j1, i0, j1, j1 == ny - 1)
                    + edge(i0, j1, i0, j0, i0 == 0))
            v = [vert(i, j) for i, j in ring]
            # Веер от первой вершины. Ячейка в плане прямоугольная, значит
            # выпуклая, и веер из любой её вершины покрывает её целиком.
            for t in range(1, len(v) - 1):
                idx += [v[0], v[t], v[t + 1]]

    pos = np.array(pos, np.float32)
    col = np.array(col, np.float32)
    idx = np.array(idx, np.uint32)
    return pos, col, idx


def cover_chunk(ix0, iy0, nx, ny, mask):
    """Крышка по верху слоя и вертикальные стенки там, где массив кончается.

    С воды квартал и опушка читаются сплошной стеной, а не набором коробок, —
    ради этого стенки и нужны.

    НАМОТКА СТЕНОК СЧИТАЕТСЯ, а не отдаётся двусторонности. Раньше материал
    покрова был doubleSided: намотка зависит от того, с какой стороны ячейки
    выросла стенка, и разбираться с четырьмя случаями было не за что. Теперь
    есть за что — лес едет в общий буфер с землёй, а земля односторонняя, и
    двусторонний материал пришлось бы поднимать на весь рельеф. Сторона берётся
    из того же условия, по которому стенка и появилась: наружу — туда, где
    крышки нет.
    """
    vp, vi, node = [], [], {}

    def capped(i, j):
        if i < 0 or j < 0 or i >= nx - 1 or j >= ny - 1:
            return False
        y0, x0 = iy0 + j, ix0 + i
        return bool(mask[y0, x0] and mask[y0, x0 + 1]
                    and mask[y0 + 1, x0] and mask[y0 + 1, x0 + 1])

    def scene_xz(y0, x0):
        return X0 + x0 * STEP, -(Y0 + y0 * STEP)

    def put(y0, x0):
        key = y0 * NX + x0
        n = node.get(key)
        if n is None:
            n = len(vp)
            node[key] = n
            sx, sz = scene_xz(y0, x0)
            vp.append((sx, TOP[y0, x0], sz))
        return n

    def wall(y1, x1, y2, x2, flip):
        n = len(vp)
        ax, az = scene_xz(y1, x1)
        bx, bz = scene_xz(y2, x2)
        vp.extend([(ax, HEIGHT[y1, x1], az), (bx, HEIGHT[y2, x2], bz),
                   (bx, TOP[y2, x2], bz), (ax, TOP[y1, x1], az)])
        if flip:
            vi.extend([n, n + 1, n + 2, n, n + 2, n + 3])
        else:
            vi.extend([n, n + 2, n + 1, n, n + 3, n + 2])

    for j in range(ny - 1):
        for i in range(nx - 1):
            if not capped(i, j):
                continue
            y0, x0 = iy0 + j, ix0 + i
            p0, p1 = put(y0, x0), put(y0, x0 + 1)
            p2, p3 = put(y0 + 1, x0 + 1), put(y0 + 1, x0)
            vi.extend([p0, p1, p3, p1, p2, p3])
            # Ось Z сцены смотрит против оси Y мира, оттого «вперёд по j» и
            # «назад по j» дают зеркальные намотки, а по i — нет.
            if not capped(i, j - 1):
                wall(y0, x0, y0, x0 + 1, True)
            if not capped(i, j + 1):
                wall(y0 + 1, x0, y0 + 1, x0 + 1, False)
            if not capped(i - 1, j):
                wall(y0, x0, y0 + 1, x0, False)
            if not capped(i + 1, j):
                wall(y0, x0 + 1, y0 + 1, x0 + 1, True)
    if not vi:
        return None
    return np.array(vp, np.float32), np.array(vi, np.uint32)


def normals(pos, idx):
    """Нормали усреднением по граням — то же, что делал computeVertexNormals."""
    n = np.zeros_like(pos)
    tri = idx.reshape(-1, 3)
    a, b, c = pos[tri[:, 0]], pos[tri[:, 1]], pos[tri[:, 2]]
    fn = np.cross(b - a, c - a)
    for col in range(3):
        np.add.at(n, tri[:, col], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return (n / np.maximum(ln, 1e-12)).astype(np.float32)


# --- запись GLB ---------------------------------------------------------------

def pad(raw, fill=b"\0"):
    return raw + fill * (-len(raw) % 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eye", type=float, default=6.0,
                    help="высота глаза над урезом, м")
    ap.add_argument("--dirs", type=int, default=64, help="азимутов в развёртке")
    ap.add_argument("--far", type=float, default=8000.0, help="докуда смотреть, м")
    ap.add_argument("--grow", type=int, default=2,
                    help="на сколько клеток нарастить видимое")
    ap.add_argument("--chunk", type=int, default=144,
                    help="ячеек в куске: меньше кусков — меньше вызовов")
    ap.add_argument("--no-buildings", action="store_true",
                    help="оставить кубики вместо контуров из OSM")
    ap.add_argument("--no-cull", action="store_true",
                    help="оставить весь покров (для сравнения)")
    ap.add_argument("--no-draco", action="store_true")
    ap.add_argument("--out", default=None,
                    help="куда писать; по умолчанию assets/terrain.glb. Нужно, "
                         "чтобы держать рядом вариант с другим куском и сравнивать "
                         "их на телефоне одной и той же сборкой страницы")
    args = ap.parse_args()

    if not os.path.exists(PACK):
        raise SystemExit("нет %s — сначала `make terrain-pack`"
                         % os.path.relpath(PACK, ROOT))
    p = json.load(open(PACK))

    global NX, NY, STEP, X0, Y0, LEVEL, HEIGHT, SDF, TOP, CHUNK
    CHUNK = args.chunk
    NX, NY, STEP = p["nx"], p["ny"], p["step"]
    X0, Y0, LEVEL = p["x0"], p["y0"], p["level"]

    def dec(key, dtype):
        return np.frombuffer(base64.b64decode(p[key]), dtype).reshape(NY, NX)

    HEIGHT = (dec("height_dm_b64", "<i2").astype(np.float32) / 10.0)
    SDF = dec("sdf_b64", np.uint8)
    cover = dec("cover_b64", np.uint8)
    cls = cover >> 6
    cover_h = (cover & 0x3F).astype(np.float32)
    TOP = HEIGHT + cover_h

    if args.no_cull:
        keep = cls > 0
        print("покров оставлен целиком: %d клеток" % keep.sum())
    else:
        vis = viewshed(TOP, SDF > 128, LEVEL, args.eye, args.dirs, args.far)
        # НАРАЩИВАНИЕ, и без него вся затея разваливается. Развёртка помечает
        # отдельные клетки, а крышка кладётся только на полный квадрат 2x2 —
        # значит одиночный ряд силуэта на бровке не даёт НИ ОДНОГО
        # треугольника и пропадает целиком. Первый заход именно так и облысил
        # берег: видимых клеток набралось восемнадцать тысяч, а геометрии из них
        # вышло на двадцать. Наращивание на пару клеток и восстанавливает
        # крышку, и даёт запас на грубость самой развёртки.
        if args.grow > 0:
            vis = ndimage.binary_dilation(
                vis, ndimage.generate_binary_structure(2, 2),
                iterations=args.grow)
        keep = (cls > 0) & vis
        total = int((cls > 0).sum())
        print("покров: %d клеток, видно с воды %d (%.1f %%), снято %d (%.1f %%)"
              % (total, int(keep.sum()), 100 * keep.sum() / total,
                 total - int(keep.sum()), 100 * (1 - keep.sum() / total)))

    parts, views, accs, meshes, nodes = [], [], [], [], []

    def put(arr, target):
        raw = pad(np.ascontiguousarray(arr).tobytes())
        off = sum(len(x) for x in parts)
        parts.append(raw)
        views.append({"buffer": 0, "byteOffset": off,
                      "byteLength": int(arr.nbytes), "target": target})
        return len(views) - 1

    def acc(arr, kind, comp, minmax=False):
        a = {"bufferView": put(arr, 34963 if kind == "SCALAR" else 34962),
             "componentType": comp, "count": int(len(arr)), "type": kind}
        if minmax:
            a["min"] = arr.min(0).tolist()
            a["max"] = arr.max(0).tolist()
        accs.append(a)
        return len(accs) - 1

    def add_mesh(name, pos, idx, material, col=None):
        attrs = {"POSITION": acc(pos, "VEC3", 5126, True),
                 "NORMAL": acc(normals(pos, idx), "VEC3", 5126)}
        if col is not None:
            attrs["COLOR_0"] = acc(col, "VEC3", 5126)
        # Индексы 16-битные, где влезают: у куска 48x48 вершин меньше сорока
        # тысяч, и это вдвое меньше буфера ещё до Draco.
        if idx.max() < 65536:
            idx = idx.astype(np.uint16)
            comp = 5123
        else:
            idx = idx.astype(np.uint32)
            comp = 5125
        prim = {"attributes": attrs,
                "indices": acc(idx.reshape(-1, 1), "SCALAR", comp),
                "material": material}
        meshes.append({"primitives": [prim], "name": name})
        nodes.append({"mesh": len(meshes) - 1, "name": name})
        return len(idx) // 3

    houses = None
    if not args.no_buildings:
        houses, src, n = building_meshes(p, keep & (cls == 2))
        print("зданий из OSM в видимой полосе: %d; высота — %s"
              % (n, ", ".join("%s %d (%.0f %%)" % (k, v, 100 * v / max(n, 1))
                              for k, v in src.items())))

    tris = {"земля": 0, "лес": 0, "застройка": 0, "лоды": 0}
    for iy0 in range(0, NY - 1, CHUNK):
        for ix0 in range(0, NX - 1, CHUNK):
            nx = min(CHUNK + 1, NX - ix0)
            ny = min(CHUNK + 1, NY - iy0)
            if nx < 2 or ny < 2:
                continue
            # ЛЕС ЕДЕТ В ТОТ ЖЕ БУФЕР, ЧТО И ЗЕМЛЯ. Кадр упирается в число
            # объектов, а не в геометрию (см. заголовок), — значит каждый
            # сэкономленный узел дороже сэкономленного треугольника. Материал у
            # них теперь общий: цвет леса кладётся в вершины, как и цвет земли.
            cover = cover_chunk(ix0, iy0, nx, ny, keep & (cls == 1))
            # Уровни детализации ОДНОГО КУСКА, каждый отдельной сеткой. Лес во
            # всех одинаков: он и есть силуэт дальнего берега, прореживать его
            # значит стирать опушку, а треугольников в нём десятая часть.
            for lod, stride in enumerate(LODS):
                pos, col, idx = land_chunk(ix0, iy0, nx, ny, stride)
                if lod == 0:
                    tris["земля"] += len(idx) // 3
                if cover is not None:
                    if lod == 0:
                        tris["лес"] += len(cover[1]) // 3
                    idx = np.concatenate([idx, cover[1] + len(pos)])
                    pos = np.concatenate([pos, cover[0]])
                    col = np.concatenate([
                        col, np.repeat(srgb_to_linear(hex_rgb(COVER_COLOUR[1]))[None],
                                       len(cover[0]), 0).astype(np.float32)])
                name = "land_%d_%d" % (ix0, iy0) + ("" if lod == 0 else "_l%d" % lod)
                n = add_mesh(name, pos, idx, 0, col)
                if lod:
                    tris["лоды"] += n
            # Застройка своим узлом: у неё свой цвет и своя геометрия.
            if houses is not None:
                got = houses.get((ix0, iy0))
            else:
                got = cover_chunk(ix0, iy0, nx, ny, keep & (cls == 2))
            if got is not None:
                tris["застройка"] += add_mesh(
                    "застройка_%d_%d" % (ix0, iy0), got[0], got[1], 1)

    mats = [{"name": "земля", "pbrMetallicRoughness": {
                "metallicFactor": 0.0, "roughnessFactor": 0.95}},
            {"name": "застройка", "pbrMetallicRoughness": {
                "baseColorFactor": srgb_to_linear(
                    hex_rgb(COVER_COLOUR[2])).tolist() + [1.0],
                "metallicFactor": 0.0, "roughnessFactor": 0.92}}]

    out = {
        "asset": {"version": "2.0", "generator": "sv20 build_terrain_glb.py"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": mats,
        "accessors": accs,
        "bufferViews": views,
        "buffers": [{"byteLength": sum(len(x) for x in parts)}],
    }

    blob = b"".join(parts)
    js = pad(json.dumps(out, separators=(",", ":")).encode(), b" ")
    glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    glb += struct.pack("<II", len(js), 0x4E4F534A) + js
    glb += struct.pack("<II", len(blob), 0x004E4942) + blob

    dst = args.out or DST
    if not os.path.isabs(dst):
        dst = os.path.join(ROOT, dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp"
    open(tmp, "wb").write(glb)
    print("кусков %d, треугольников %s — %.1f МБ без Draco"
          % (len(nodes),
             ", ".join("%s %.0f тыс." % (k, v / 1000) for k, v in tris.items()),
             len(glb) / 1048576))

    if args.no_draco:
        os.replace(tmp, dst)
        return
    # Draco — единственное, чего нет под рукой в Python. Инструмент официальный и
    # зовётся через npx: в репозитории его нет и ставить заранее не нужно.
    cmd = ["npx", "--yes", "@gltf-transform/cli@4", "draco", tmp, dst]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    except FileNotFoundError:
        os.replace(tmp, dst)
        print("npx не найден — оставлено без Draco", file=sys.stderr)
        return
    if r.returncode != 0:
        os.replace(tmp, dst)
        print("gltf-transform не отработал, оставлено без Draco:\n"
              + (r.stderr or r.stdout)[-800:], file=sys.stderr)
        return
    os.remove(tmp)
    print("%s — %.1f МБ" % (os.path.relpath(dst, ROOT),
                            os.path.getsize(dst) / 1048576))


if __name__ == "__main__":
    main()
