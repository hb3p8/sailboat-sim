#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Блоб wasm в исходник: python3 scripts/wasm_blob.py

Симулятор собирается в один html и обязан открываться двойным кликом, поэтому
модуль не лежит отдельным файлом, а вклеивается в исходник строкой base64.

Заводится целью `make kernel` вместе с самим .wasm, и это не удобство: собранный
.wasm без пересобранного блоба означает симулятор со СТАРЫМ кернелом. Один раз
это уже стоило падения на не экспортированной функции — .wasm был новый, блоб
прошлый.
"""
import base64
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNC_LIMIT = 4096


def emit(name, const, sync):
    src = os.path.join(ROOT, "kernel", name + ".wasm")
    dst = os.path.join(ROOT, "sim", name + "wasm.js")
    size = os.path.getsize(src)
    b64 = base64.b64encode(open(src, "rb").read()).decode()
    lines = [b64[i:i + 96] for i in range(0, len(b64), 96)]
    with open(dst, "w") as f:
        f.write(
        "// СГЕНЕРИРОВАНО `make kernel` из kernel/%s.wasm. Руками не правят.\n" % name
        + "//\n"
        + "// Блоб лежит в исходнике, а не отдельным файлом: симулятор собирается в один\n"
        + "// html (scripts/build_sim.py) и обязан открываться двойным кликом, а отдельный\n"
        + "// файл пришлось бы тянуть запросом.\n"
        + "//\n"
        + "// Размер решает способ загрузки. Браузеры запрещают синхронную компиляцию в\n"
        + "// главном потоке на буферах больше ЧЕТЫРЁХ килобайт: кто под лимитом — грузится\n"
        + "// сразу, кто нет — асинхронно, а до готовности считает откат на JS. Стоит это\n"
        + "// ровно ничего, потому что откат даёт побитово тот же ответ.\n"
        + "export const %s =\n  '" % const + "' +\n  '".join(lines) + "';\n")
    print("  sim/%swasm.js — %d байт wasm, загрузка %s" %
          (name, size, "синхронная" if size < SYNC_LIMIT else "АСИНХРОННАЯ (за 4 КБ)"))


emit("biot", "BIOT_WASM_B64", True)
emit("lattice", "LATTICE_WASM_B64", False)
