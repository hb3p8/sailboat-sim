#!/usr/bin/env python3
"""Собрать симулятор в один самодостаточный HTML.

    python3 scripts/build_sim.py

Вклеивает three, пакет физики, сетки и код в `sim/index.html`. Как и
просмотрщик, файл открывается двойным кликом с file:// — ни сервера, ни
сборщика в проекте нет.
"""

import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def strip_modules(src):
    """Убрать import/export: код вклеивается в общий блок, а не грузится."""
    src = re.sub(r"^\s*import\s.*?;\s*$", "", src, flags=re.M)
    src = re.sub(r"^\s*export\s+(const|let|class|function)\s", r"\1 ", src, flags=re.M)
    src = re.sub(r"^\s*export\s*\{[^}]*\};?\s*$", "", src, flags=re.M)
    return src


def main():
    sim = os.path.join(ROOT, "sim")
    exp = os.path.join(ROOT, "out", "export")
    pack_path = os.path.join(exp, "physics.json")
    mesh_path = os.path.join(exp, "sim_mesh.json")
    for p in (pack_path, mesh_path):
        if not os.path.exists(p):
            raise SystemExit("нет %s — сначала `make physics`" % os.path.relpath(p, ROOT))

    pack = json.load(open(pack_path))
    mesh = json.load(open(mesh_path))
    tpl = open(os.path.join(sim, "template.html")).read()
    three = open(os.path.join(ROOT, "viewer", "vendor", "three.module.js")).read()

    html = tpl.replace("/*__PACK__*/ null",
                       json.dumps(pack, ensure_ascii=False, separators=(",", ":")))
    html = html.replace("/*__MESH__*/ null",
                        json.dumps(mesh, separators=(",", ":")))
    html = html.replace("/*__THREE__*/", three)
    html = html.replace("/*__PHYSICS__*/",
                        strip_modules(open(os.path.join(sim, "physics.js")).read()))
    html = html.replace("/*__MAIN__*/",
                        strip_modules(open(os.path.join(sim, "main.js")).read()))

    dst = os.path.join(sim, "index.html")
    with open(dst, "w") as f:
        f.write(html)
    print("%s — %.0f КБ" % (os.path.relpath(dst, ROOT), os.path.getsize(dst) / 1024))

    # Самотеста в браузере больше нет: физику гоняет node
    # (`make test`, tests/physics.test.mjs). Два источника правды на одну
    # модель — верный способ чинить не то.


if __name__ == "__main__":
    main()
