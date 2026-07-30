"""Ф6: запись сеток в форматы, которые понимает движок.

    OBJ — читается всем подряд, удобен для Blender и для глаз
    STL — для сеточных генераторов CFD, когда до них дойдёт
    GLB — бинарный glTF 2.0, штатный формат реального времени:
          Godot, Unity, Unreal, three.js берут его без конвертации

GLB пишется руками: это заголовок, JSON-кусок и бинарный кусок. Тащить ради
двух сотен строк внешнюю библиотеку смысла нет.

Экспорт идёт в метрах и с осью Y вверх — так ждут игровые движки. Внутренняя
судостроительная система (миллиметры, Z вверх) остаётся неизменной, пересчёт
происходит только на выходе.

Зависимостей нет.
"""

import json
import struct

MM_PER_M = 1000.0


def to_engine(p):
    """Судостроительные мм с Z вверх -> метры с Y вверх и правой тройкой.

    X остаётся в нос, Z_движка = -Y_судна, Y_движка = Z_судна.
    """
    return (p[0] / MM_PER_M, p[2] / MM_PER_M, -p[1] / MM_PER_M)


def write_obj(path, bodies):
    """Один OBJ со всеми телами как отдельными группами."""
    lines = ["# SV20 / проект 610 — реверс-инжиниринг геометрии",
             "# метры, ось Y вверх, X в нос"]
    off = 1
    for name, mesh in bodies:
        lines.append("o " + name)
        for v in mesh["verts"]:
            x, y, z = to_engine(v)
            lines.append("v %.5f %.5f %.5f" % (x, y, z))
        for n in mesh.get("normals", []):
            x, y, z = n[0], n[2], -n[1]
            lines.append("vn %.4f %.4f %.4f" % (x, y, z))
        has_n = bool(mesh.get("normals"))
        for t in mesh["tris"]:
            a, b, c = t[0] + off, t[1] + off, t[2] + off
            if has_n:
                lines.append("f %d//%d %d//%d %d//%d" % (a, a, b, b, c, c))
            else:
                lines.append("f %d %d %d" % (a, b, c))
        off += len(mesh["verts"])
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return path


def write_stl(path, mesh):
    """Двоичный STL одного тела."""
    tris = mesh["tris"]
    verts = mesh["verts"]
    out = [b"\0" * 80, struct.pack("<I", len(tris))]
    for t in tris:
        a, b, c = (to_engine(verts[t[i]]) for i in range(3))
        ux, uy, uz = (b[k] - a[k] for k in range(3))
        vx, vy, vz = (c[k] - a[k] for k in range(3))
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        L = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
        out.append(struct.pack("<12fH", nx / L, ny / L, nz / L,
                               a[0], a[1], a[2], b[0], b[1], b[2],
                               c[0], c[1], c[2], 0))
    with open(path, "wb") as f:
        f.write(b"".join(out))
    return path


# ------------------------------------------------------------------------ GLB

_COMP_FLOAT = 5126
_COMP_UINT = 5125


def write_glb(path, bodies, materials=None):
    """glTF 2.0 в двоичном контейнере. Каждое тело — отдельный узел."""
    buf = bytearray()
    views, accessors, meshes, nodes = [], [], [], []
    mats = []
    mat_index = {}

    def pad4():
        while len(buf) % 4:
            buf.append(0)

    def add_view(data, target):
        pad4()
        off = len(buf)
        buf.extend(data)
        views.append({"buffer": 0, "byteOffset": off,
                      "byteLength": len(data), "target": target})
        return len(views) - 1

    for name, mesh in bodies:
        pos = [to_engine(v) for v in mesh["verts"]]
        nrm = [(n[0], n[2], -n[1]) for n in mesh.get("normals", [])]

        pdata = bytearray()
        for p in pos:
            pdata.extend(struct.pack("<3f", *p))
        p_view = add_view(pdata, 34962)
        accessors.append({
            "bufferView": p_view, "componentType": _COMP_FLOAT,
            "count": len(pos), "type": "VEC3",
            "min": [min(p[k] for p in pos) for k in range(3)],
            "max": [max(p[k] for p in pos) for k in range(3)]})
        p_acc = len(accessors) - 1

        attrs = {"POSITION": p_acc}
        if nrm:
            ndata = bytearray()
            for n in nrm:
                ndata.extend(struct.pack("<3f", *n))
            n_view = add_view(ndata, 34962)
            accessors.append({"bufferView": n_view, "componentType": _COMP_FLOAT,
                              "count": len(nrm), "type": "VEC3"})
            attrs["NORMAL"] = len(accessors) - 1

        idata = bytearray()
        for t in mesh["tris"]:
            idata.extend(struct.pack("<3I", t[0], t[1], t[2]))
        i_view = add_view(idata, 34963)
        accessors.append({"bufferView": i_view, "componentType": _COMP_UINT,
                          "count": len(mesh["tris"]) * 3, "type": "SCALAR"})
        i_acc = len(accessors) - 1

        prim = {"attributes": attrs, "indices": i_acc, "mode": 4}
        colour = (materials or {}).get(name)
        if colour:
            if name not in mat_index:
                mat_index[name] = len(mats)
                mats.append({
                    "name": name,
                    "pbrMetallicRoughness": {
                        "baseColorFactor": list(colour) + [1.0],
                        "metallicFactor": 0.05, "roughnessFactor": 0.5}})
            prim["material"] = mat_index[name]

        meshes.append({"name": name, "primitives": [prim]})
        nodes.append({"name": name, "mesh": len(meshes) - 1})

    pad4()
    gltf = {
        "asset": {"version": "2.0",
                  "generator": "sv20 reverse-engineering pipeline"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(buf)}],
    }
    if mats:
        gltf["materials"] = mats

    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(js) % 4:
        js += b" "

    with open(path, "wb") as f:
        total = 12 + 8 + len(js) + 8 + len(buf)
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(buf), 0x004E4942))
        f.write(bytes(buf))
    return path
