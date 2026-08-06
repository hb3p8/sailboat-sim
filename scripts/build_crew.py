#!/usr/bin/env python3
"""Сжать фигурку экипажа: `models/lego_sailor.glb` -> `assets/crew.glb`.

    python3 scripts/build_crew.py [--size 512] [--quality 88]

Исходник — тринадцать с половиной мегабайт, и почти всё это одна текстура
4096x4096. Геометрии в нём четырнадцать тысяч треугольников, то есть меньше
процента веса. Поэтому работы здесь две и они разного рода:

* текстура уменьшается и переводится в JPEG — здесь и лежат все мегабайты;
* геометрия жмётся Draco — это уже gltf-transform, он вызывается ниже.

Заодно выбрасывается то, что положил экспортёр Lighttracer и что нам не нужно:
картинка предпросмотра, карта окружения в формате Radiance (лежит с подписью
`image/png`, но PNG не является) и его собственные расширения материала.

Матрицы узлов запекаются в вершины, а масштаб делится на 39.370079 — экспортёр
переводил метры в дюймы. После этого фигурка имеет рост 1.90 м в метрах glTF,
как того требует формат. Больше ничего не запекается нарочно: как её повернуть и
куда посадить — знание симулятора, и проверяется оно там, глазами, а не здесь.
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
SRC = os.path.join(ROOT, "models", "lego_sailor.glb")
DST = os.path.join(ROOT, "assets", "crew.glb")
INCH = 39.370079                      # чем экспортёр умножил метры


def read_glb(path):
    """Разобрать GLB на JSON и двоичный кусок."""
    data = open(path, "rb").read()
    magic, ver, _ = struct.unpack("<III", data[:12])
    if magic != 0x46546C67:
        raise SystemExit("%s не GLB" % path)
    off, js, bin_ = 12, None, b""
    while off < len(data):
        clen, ctype = struct.unpack("<II", data[off:off + 8])
        chunk = data[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk)
        else:
            bin_ = chunk
        off += 8 + clen
    return js, bin_


def accessor(js, bin_, i):
    """Прочитать accessor как массив numpy, учитывая чересстрочность."""
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    kind = {5120: "i1", 5121: "u1", 5122: "i2",
            5123: "u2", 5125: "u4", 5126: "f4"}[a["componentType"]]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    item = ncomp * np.dtype(kind).itemsize
    stride = bv.get("byteStride") or item
    raw = np.frombuffer(bin_, np.uint8, count=stride * a["count"], offset=off)
    return raw.reshape(a["count"], stride)[:, :item].copy().view(kind) \
              .reshape(a["count"], ncomp)


def node_matrix(js, i):
    """Матрица узла. В glTF она хранится по столбцам, numpy ждёт по строкам."""
    n = js["nodes"][i]
    if "matrix" in n:
        return np.array(n["matrix"], float).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in n:
        m = np.diag(list(n["scale"]) + [1.0]) @ m
    if "translation" in n:
        m[:3, 3] += n["translation"]
    return m


def chain(js, i):
    """Произведение матриц от корня до узла с сеткой."""
    parent = {}
    for k, n in enumerate(js["nodes"]):
        for c in n.get("children", []):
            parent[c] = k
    m, cur = np.eye(4), i
    while True:
        m = node_matrix(js, cur) @ m
        if cur not in parent:
            return m
        cur = parent[cur]


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

    if not os.path.exists(SRC):
        raise SystemExit("нет %s" % os.path.relpath(SRC, ROOT))
    js, bin_ = read_glb(SRC)

    if len(js["meshes"]) != 1 or len(js["meshes"][0]["primitives"]) != 1:
        raise SystemExit("ожидалась одна сетка с одним примитивом")
    prim = js["meshes"][0]["primitives"][0]
    pos = accessor(js, bin_, prim["attributes"]["POSITION"]).astype(np.float32)
    nrm = accessor(js, bin_, prim["attributes"]["NORMAL"]).astype(np.float32)
    uv = accessor(js, bin_, prim["attributes"]["TEXCOORD_0"]).astype(np.float32)
    idx = accessor(js, bin_, prim["indices"]).ravel().astype(np.uint32)

    # Узел с сеткой ищется по ссылке, а не по номеру: у экспортёра сетка висит
    # третьим узлом, но полагаться на это незачем.
    node = next(k for k, n in enumerate(js["nodes"]) if n.get("mesh") == 0)
    m = chain(js, node)
    # Делятся первые три строки, а не вся матрица: они и есть преобразование
    # точки, и делить их на INCH значит перевести дюймы в метры разом и в
    # повороте с масштабом, и в переносе. Нижняя строка к точкам отношения не
    # имеет, а поделённая портит однородную координату.
    m[:3, :] /= INCH
    # errstate — не глушение ошибки, а глушение ложной тревоги: numpy 2 выдаёт
    # на matmul предупреждения о делении на ноль и переполнении, потому что BLAS
    # выставляет флаги сопроцессора на добивочных дорожках вектора. Проверено:
    # ни в исходных нормалях, ни в результате нет ни NaN, ни бесконечностей, ни
    # нулевой длины.
    with np.errstate(all="ignore"):
        pos = (np.c_[pos.astype(np.float64), np.ones(len(pos))] @ m.T)[:, :3] \
            .astype(np.float32)
        # Нормали преобразуются обратной транспонированной, иначе при
        # неравномерном масштабе они перестают быть перпендикулярны поверхности.
        nm = np.linalg.inv(m[:3, :3]).T
        nrm = (nrm.astype(np.float64) @ nm.T).astype(np.float32)
    nrm /= np.maximum(1e-9, np.linalg.norm(nrm, axis=1))[:, None]

    lo, hi = pos.min(0), pos.max(0)
    print("габарит, м: %.3f x %.3f x %.3f (рост по Y)" % tuple(hi - lo))
    print("вершин %d, треугольников %d" % (len(pos), len(idx) // 3))

    # Текстура. Альфа у неё сплошная, так что JPEG ничего не теряет, а весит он
    # против PNG в разы меньше.
    tex_i = js["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    img_i = js["textures"][tex_i]["source"]
    bv = js["bufferViews"][js["images"][img_i]["bufferView"]]
    src = bin_[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]]
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
                  "generator": "sv20 build_crew.py из %s" % os.path.basename(SRC)},
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
                           "roughnessFactor": float(
                               js["materials"][0]["pbrMetallicRoughness"]
                               .get("roughnessFactor", 0.5))}}],
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

    print("%s — %.0f КБ (было %.1f МБ)"
          % (os.path.relpath(DST, ROOT), os.path.getsize(DST) / 1024,
             os.path.getsize(SRC) / 1048576))


if __name__ == "__main__":
    main()
