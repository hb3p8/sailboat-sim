#!/usr/bin/env python3
"""Сжать фигурку экипажа: `models/obj/` -> `assets/crew.glb`.

    python3 scripts/build_crew.py [--size 512] [--quality 88]

Исходник — двадцать пять мегабайт, и почти всё это текстуры 4096x4096, четыре
штуки. Геометрии в нём четырнадцать тысяч треугольников, то есть меньше процента
веса. Отсюда и работы разного рода:

* берётся одна текстура из четырёх — цвет; металличность, шероховатость и
  нормали для фигурки в полтора метра ростом, которую видно с десяти, не дают
  ничего, кроме веса;
* она уменьшается и переводится в JPEG — здесь и лежат все мегабайты;
* геометрия жмётся Draco — это уже gltf-transform, он вызывается ниже.

Раньше входом был GLB, сохранённый из Lighttracer. От него пришлось отказаться:
текстура на фигурке оказалась перепутана — атлас из мелких лоскутов, и стоит
разъехаться развёртке, как каждый треугольник берёт цвет с чужого лоскута.
Выглядит это не как поломка, а как грязная раскраска, и на глаз ловится плохо.
OBJ — то, что отдал исходный конвейер, до всякого редактора.

Нормалей в OBJ нет вовсе, они считаются здесь усреднением по позиции: файл
помечен `s 0`, но плоские нормали на скруглённой фигурке дают гранёный шар
вместо головы.

Ничего, кроме этого, не запекается нарочно: как фигурку повернуть и куда
посадить — знание симулятора, и проверяется оно там, глазами.
"""

import argparse
import io
import json
import os
import struct
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "models", "obj")
DST = os.path.join(ROOT, "assets", "crew.glb")


def read_obj(path):
    """Разобрать OBJ: позиции, развёртка, треугольники и имя карты цвета.

    Грани в файле бывают четырёх- и пятиугольные, поэтому режутся веером.
    Вершина в OBJ — пара «позиция/точка развёртки», и одна позиция входит в
    несколько пар: на швах развёртки её приходится раздваивать. Поэтому пары
    сводятся в свой список, а нормали считаются ДО раздвоения, по позициям, —
    иначе шов развёртки становится ещё и швом освещения.
    """
    v, vt, faces = [], [], []
    mtl = None
    for line in open(path, encoding="utf-8", errors="replace"):
        w = line.split()
        if not w:
            continue
        if w[0] == "v":
            v.append([float(x) for x in w[1:4]])
        elif w[0] == "vt":
            vt.append([float(x) for x in w[1:3]])
        elif w[0] == "mtllib":
            mtl = w[1]
        elif w[0] == "f":
            poly = []
            for tok in w[1:]:
                a = tok.split("/")
                poly.append((int(a[0]) - 1,
                             int(a[1]) - 1 if len(a) > 1 and a[1] else -1))
            for k in range(1, len(poly) - 1):
                faces.append((poly[0], poly[k], poly[k + 1]))
    return np.array(v, float), np.array(vt, float), faces, mtl


def map_kd(path, mtl):
    """Найти в MTL карту цвета. Остальные карты нам не нужны."""
    if not mtl:
        return None
    for line in open(os.path.join(path, mtl), encoding="utf-8", errors="replace"):
        w = line.split()
        if w and w[0] == "map_Kd":
            return w[-1]
    return None


def pad(b, fill=b"\0"):
    """GLB требует, чтобы куски были кратны четырём байтам."""
    return b + fill * ((4 - len(b) % 4) % 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=512,
                    help="сторона текстуры, пикселей (по умолчанию 512)")
    ap.add_argument("--quality", type=int, default=88, help="качество JPEG")
    ap.add_argument("--no-draco", action="store_true",
                    help="не звать gltf-transform (для отладки)")
    args = ap.parse_args()

    objs = [f for f in sorted(os.listdir(SRC))] if os.path.isdir(SRC) else []
    obj = next((f for f in objs if f.endswith(".obj")), None)
    if not obj:
        raise SystemExit("нет .obj в %s" % os.path.relpath(SRC, ROOT))
    v, vt, faces, mtl = read_obj(os.path.join(SRC, obj))
    print("%s: позиций %d, точек развёртки %d, треугольников %d"
          % (obj, len(v), len(vt), len(faces)))

    # Нормали по позициям, с весом по площади: длина векторного произведения и
    # есть удвоенная площадь, поэтому ничего нормировать до сложения не нужно.
    tri = np.array([[a[0], b[0], c[0]] for a, b, c in faces])
    fn = np.cross(v[tri[:, 1]] - v[tri[:, 0]], v[tri[:, 2]] - v[tri[:, 0]])
    vn = np.zeros_like(v)
    for k in range(3):
        np.add.at(vn, tri[:, k], fn)
    vn /= np.maximum(1e-12, np.linalg.norm(vn, axis=1))[:, None]

    # Пары «позиция/развёртка» — это и есть вершины glTF.
    pairs = {}
    idx = np.empty(len(faces) * 3, np.uint32)
    for f, face in enumerate(faces):
        for k, pair in enumerate(face):
            j = pairs.get(pair)
            if j is None:
                j = pairs[pair] = len(pairs)
            idx[f * 3 + k] = j
    order = sorted(pairs, key=pairs.get)
    pos = np.array([v[a] for a, _ in order], np.float32)
    nrm = np.array([vn[a] for a, _ in order], np.float32)
    # Развёртка в OBJ считается снизу вверх, в glTF сверху вниз.
    uv = np.array([[vt[b][0], 1.0 - vt[b][1]] for _, b in order], np.float32)

    # Никаких матриц узлов: в OBJ их нет, а сама сетка уже стоит вертикально
    # (Y вверх) и в метрах — ровно то, чего требует glTF. Прежний GLB приходилось
    # ещё и делить на 39.370079: экспортёр переводил метры в дюймы.

    lo, hi = pos.min(0), pos.max(0)
    print("габарит: %.3f x %.3f x %.3f (рост по Y), вершин %d"
          % (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], len(pos)))

    # Текстура. Альфы у неё нет, так что JPEG ничего не теряет, а весит он
    # против PNG в разы меньше.
    kd = map_kd(SRC, mtl)
    if not kd:
        raise SystemExit("в %s не нашлось map_Kd" % mtl)
    src_path = os.path.join(SRC, os.path.basename(kd))
    src = open(src_path, "rb").read()
    im = Image.open(io.BytesIO(src))
    was = im.size
    im = im.convert("RGB").resize((args.size, args.size), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=args.quality, optimize=True)
    tex = buf.getvalue()
    print("текстура %dx%d -> %dx%d, %.1f МБ -> %.0f КБ"
          % (was[0], was[1], args.size, args.size,
             len(src) / 1048576, len(tex) / 1024))

    # Собираем новый GLB с нуля: так в нём заведомо не останется ни лишних
    # картинок, ни расширений экспортёра, ни узлов с чужими матрицами.
    if idx.max() < 65536:
        idx = idx.astype(np.uint16)
    parts, views, accs = [], [], []

    def put(arr, target=None):
        raw = pad(arr.tobytes())
        off = sum(len(p) for p in parts)
        parts.append(raw)
        v = {"buffer": 0, "byteOffset": off, "byteLength": arr.nbytes}
        if target:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    def acc(arr, kind, comp, minmax=False):
        a = {"bufferView": put(arr, 34962 if kind != "SCALAR" else 34963),
             "componentType": comp, "count": len(arr), "type": kind}
        if minmax:
            a["min"] = arr.min(0).tolist()
            a["max"] = arr.max(0).tolist()
        accs.append(a)
        return len(accs) - 1

    a_pos = acc(pos, "VEC3", 5126, True)
    a_nrm = acc(nrm, "VEC3", 5126)
    a_uv = acc(uv, "VEC2", 5126)
    a_idx = acc(idx.reshape(-1, 1), "SCALAR",
                5123 if idx.dtype == np.uint16 else 5125)
    tex_view = put(np.frombuffer(tex, np.uint8))

    out = {
        "asset": {"version": "2.0",
                  "generator": "sv20 build_crew.py из %s" % obj},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "crew"}],
        "meshes": [{"primitives": [{
            "attributes": {"POSITION": a_pos, "NORMAL": a_nrm,
                           "TEXCOORD_0": a_uv},
            "indices": a_idx, "material": 0}]}],
        "materials": [{"name": "crew", "doubleSided": True,
                       "pbrMetallicRoughness": {
                           "baseColorTexture": {"index": 0},
                           "metallicFactor": 0.0,
                           # Шероховатость одним числом: карту мы не берём, а
                       # пластик у фигурки везде один.
                       "roughnessFactor": 0.55}}],
        "textures": [{"source": 0, "sampler": 0}],
        "images": [{"bufferView": tex_view, "mimeType": "image/jpeg"}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987,
                      "wrapS": 10497, "wrapT": 10497}],
        "accessors": accs,
        "bufferViews": views,
        "buffers": [{"byteLength": sum(len(p) for p in parts)}],
    }

    blob = b"".join(parts)
    js_bytes = pad(json.dumps(out, separators=(",", ":")).encode(), b" ")
    glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js_bytes) + 8 + len(blob))
    glb += struct.pack("<II", len(js_bytes), 0x4E4F534A) + js_bytes
    glb += struct.pack("<II", len(blob), 0x004E4942) + blob

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    tmp = DST + ".tmp"
    open(tmp, "wb").write(glb)
    print("без Draco: %.0f КБ" % (len(glb) / 1024))

    if args.no_draco:
        os.replace(tmp, DST)
    else:
        # Draco — единственное, чего нет под рукой в Python. Инструмент
        # официальный и вызывается через npx, то есть в репозитории его нет и
        # ставить его заранее не нужно: пересжимают фигурку раз в жизни.
        cmd = ["npx", "--yes", "@gltf-transform/cli@4", "draco", tmp, DST]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        except FileNotFoundError:
            os.replace(tmp, DST)
            print("npx не найден — оставлено без Draco", file=sys.stderr)
            return
        if r.returncode != 0:
            os.replace(tmp, DST)
            print("gltf-transform не отработал, оставлено без Draco:\n" +
                  (r.stderr or r.stdout)[-800:], file=sys.stderr)
            return
        os.remove(tmp)

    was_mb = sum(os.path.getsize(os.path.join(SRC, f))
                 for f in os.listdir(SRC)) / 1048576
    print("%s — %.0f КБ (было %.1f МБ)"
          % (os.path.relpath(DST, ROOT), os.path.getsize(DST) / 1024, was_mb))


if __name__ == "__main__":
    main()
