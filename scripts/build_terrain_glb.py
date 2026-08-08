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
"""

import argparse
import base64
import json
import os
import struct
import subprocess
import sys

import numpy as np
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PACK = os.path.join(ROOT, "out", "export", "terrain_pack.json")
DST = os.path.join(ROOT, "assets", "terrain.glb")

# Ячеек в куске сетки. То же число, что стояло в браузере: куски нужны не для
# сжатия, а для того, чтобы three мог выбросить из отрисовки то, что за спиной.
CHUNK = 48

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


# --- геометрия ----------------------------------------------------------------
#
# Оси: мир физики (X на восток, Y на север, Z вверх) в сцену three переводится
# как (x, z, -y). Здесь это делается один раз, при записи вершин, — тем же
# отображением, что и в sim/axes.js.

def land_chunk(ix0, iy0, nx, ny):
    j, i = np.meshgrid(np.arange(ny), np.arange(nx), indexing="ij")
    k = (iy0 + j) * NX + ix0 + i
    x = X0 + (k % NX) * STEP
    y = Y0 + (k // NX) * STEP
    z = HEIGHT[iy0:iy0 + ny, ix0:ix0 + nx]
    pos = np.stack([x, z, -y], -1).reshape(-1, 3).astype(np.float32)

    wet = SDF[iy0:iy0 + ny, ix0:ix0 + nx] > 128
    col = land_tint((z - LEVEL).ravel())
    col[wet.ravel()] = srgb_to_linear(hex_rgb(BED))

    a = (j[:-1, :-1] * nx + i[:-1, :-1]).ravel()
    b, d, e = a + 1, a + nx, a + nx + 1
    # Намотка против часовой при взгляде сверху. Проверять это надо на бумаге:
    # «очевидный» порядок обхода даёт нормали вниз, вся суша уходит в отбраковку
    # задних граней, и экран показывает пустую воду, а не вывернутый рельеф.
    idx = np.stack([a, b, d, b, e, d], -1).ravel()
    return pos, col.astype(np.float32), idx


def cover_chunk(ix0, iy0, nx, ny, cls, mask):
    """Крышка по верху слоя и вертикальные стенки там, где массив кончается.

    С воды квартал и опушка читаются сплошной стеной, а не набором коробок, —
    ради этого стенки и нужны.
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

    def wall(y1, x1, y2, x2):
        n = len(vp)
        ax, az = scene_xz(y1, x1)
        bx, bz = scene_xz(y2, x2)
        vp.extend([(ax, HEIGHT[y1, x1], az), (bx, HEIGHT[y2, x2], bz),
                   (bx, TOP[y2, x2], bz), (ax, TOP[y1, x1], az)])
        vi.extend([n, n + 2, n + 1, n, n + 3, n + 2])

    for j in range(ny - 1):
        for i in range(nx - 1):
            if not capped(i, j):
                continue
            y0, x0 = iy0 + j, ix0 + i
            p0, p1 = put(y0, x0), put(y0, x0 + 1)
            p2, p3 = put(y0 + 1, x0 + 1), put(y0 + 1, x0)
            vi.extend([p0, p1, p3, p1, p2, p3])
            if not capped(i, j - 1):
                wall(y0, x0, y0, x0 + 1)
            if not capped(i, j + 1):
                wall(y0 + 1, x0, y0 + 1, x0 + 1)
            if not capped(i - 1, j):
                wall(y0, x0, y0 + 1, x0)
            if not capped(i + 1, j):
                wall(y0, x0 + 1, y0 + 1, x0 + 1)
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
    ap.add_argument("--no-cull", action="store_true",
                    help="оставить весь покров (для сравнения)")
    ap.add_argument("--no-draco", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(PACK):
        raise SystemExit("нет %s — сначала `make terrain-pack`"
                         % os.path.relpath(PACK, ROOT))
    p = json.load(open(PACK))

    global NX, NY, STEP, X0, Y0, LEVEL, HEIGHT, SDF, TOP
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

    tris = {"земля": 0, "лес": 0, "застройка": 0}
    for iy0 in range(0, NY - 1, CHUNK):
        for ix0 in range(0, NX - 1, CHUNK):
            nx = min(CHUNK + 1, NX - ix0)
            ny = min(CHUNK + 1, NY - iy0)
            if nx < 2 or ny < 2:
                continue
            pos, col, idx = land_chunk(ix0, iy0, nx, ny)
            tris["земля"] += add_mesh("land_%d_%d" % (ix0, iy0), pos,
                                      idx.astype(np.uint32), 0, col)
            for c in (1, 2):
                got = cover_chunk(ix0, iy0, nx, ny, c, keep & (cls == c))
                if got is None:
                    continue
                tris[COVER_NAME[c]] += add_mesh(
                    "%s_%d_%d" % (COVER_NAME[c], ix0, iy0), got[0], got[1], c)

    mats = [{"name": "земля", "pbrMetallicRoughness": {
                "metallicFactor": 0.0, "roughnessFactor": 0.95}}]
    for c in (1, 2):
        rgb = srgb_to_linear(hex_rgb(COVER_COLOUR[c])).tolist()
        # doubleSided намеренно: намотка стенок зависит от того, с какой стороны
        # ячейки они выросли, и разбираться с восемью случаями ради отбраковки,
        # которая тут ничего не экономит, — не та цена.
        mats.append({"name": COVER_NAME[c], "doubleSided": True,
                     "pbrMetallicRoughness": {
                         "baseColorFactor": rgb + [1.0],
                         "metallicFactor": 0.0, "roughnessFactor": 0.92}})

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

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    tmp = DST + ".tmp"
    open(tmp, "wb").write(glb)
    print("кусков %d, треугольников %s — %.1f МБ без Draco"
          % (len(nodes),
             ", ".join("%s %.0f тыс." % (k, v / 1000) for k, v in tris.items()),
             len(glb) / 1048576))

    if args.no_draco:
        os.replace(tmp, DST)
        return
    # Draco — единственное, чего нет под рукой в Python. Инструмент официальный и
    # зовётся через npx: в репозитории его нет и ставить заранее не нужно.
    cmd = ["npx", "--yes", "@gltf-transform/cli@4", "draco", tmp, DST]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    except FileNotFoundError:
        os.replace(tmp, DST)
        print("npx не найден — оставлено без Draco", file=sys.stderr)
        return
    if r.returncode != 0:
        os.replace(tmp, DST)
        print("gltf-transform не отработал, оставлено без Draco:\n"
              + (r.stderr or r.stdout)[-800:], file=sys.stderr)
        return
    os.remove(tmp)
    print("%s — %.1f МБ" % (os.path.relpath(DST, ROOT),
                            os.path.getsize(DST) / 1048576))


if __name__ == "__main__":
    main()
