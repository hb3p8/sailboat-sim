#!/usr/bin/env python3
"""Собрать симулятор в один самодостаточный HTML.

    python3 scripts/build_sim.py

Вклеивает three, пакет физики, сетки и код в `sim/index.html`. Как и
просмотрщик, файл открывается двойным кликом с file:// — ни сервера, ни
сборщика в проекте нет.
"""

import datetime
import json
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


# Вендорится один файл: сборка three.webgpu, прогнанная через esbuild.
# Подробности и порядок обновления — в viewer/vendor/README.md. Коротко: у
# три­х исходных сборок three между собой перекрёстные импорты с
# переименованием (`log as log$1`), и простая склейка на них ломается.
THREE_BUNDLE = "three.webgpu.js"
# Загрузчик glTF с распаковкой Draco — те же examples/jsm, прогнанные esbuild с
# `--external:three`: импорты у него остаются к именам, которые уже в области
# видимости после вклейки ядра. Нужен ради ассетов, которые страница берёт с
# сервера, — фигурки экипажа и всего, что появится дальше.
GLTF_BUNDLE = "three.gltf.js"

# Всё, что вклеивается в страницу, в порядке объявления.
MODULES = ["util.js", "terrain.js", "axes.js", "wind.js", "vlm.js",
           "membrane.js", "waves.js", "buoyancy.js", "ocean.js", "wake.js",
           "aero.js", "hydro.js", "telemetry.js", "trace.js", "physics.js",
           "main.js", "debug.js", "controls.js", "bench.js"]


def alias_three_imports(src):
    """Превратить `import { A as A2 } from "three"` в `const A2 = A;`.

    Загрузчик собран с `--external:three`, поэтому импорты в нём остаются. Просто
    снять их, как у ядра, нельзя: esbuild переименовывает то, что столкнулось у
    него внутри, — `Quaternion as Quaternion2`, — и после снятия импорта имя
    `Quaternion2` не объявлено нигде. Страница падает на первой же строке
    загрузчика. Ровно эта ловушка описана в viewer/vendor/README.md, только там
    она случилась внутри самого three.

    Непереименованные имена не трогаем: после вклейки ядра они уже в области
    видимости.
    """
    seen = set()

    def repl(m):
        out = []
        for part in m.group(1).split(","):
            part = part.strip()
            if " as " not in part:
                continue
            src_name, dst = (x.strip() for x in part.split(" as "))
            if dst in seen:
                continue
            seen.add(dst)
            out.append("const %s = %s;" % (dst, src_name))
        return "\n".join(out)

    src, n = re.subn(r"import\s*\{([^}]*)\}\s*from\s*[\'\"]three[\'\"];",
                     repl, src)
    if not n:
        raise SystemExit("в %s не найдено импортов из three — сборка изменилась"
                         % GLTF_BUNDLE)
    return src


def three_bundle(strip):
    """Прочитать вендоренный three с загрузчиком и снять с них import/export."""
    core = os.path.join(ROOT, "viewer", "vendor", THREE_BUNDLE)
    gltf = os.path.join(ROOT, "viewer", "vendor", GLTF_BUNDLE)
    return strip(open(core).read()) + "\n" + \
        strip(alias_three_imports(open(gltf).read()))


def _git(*args):
    """Спросить git, молча вернув пустую строку, если его нет."""
    try:
        out = subprocess.run(("git",) + args, cwd=ROOT, capture_output=True,
                             text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def strip_modules(src):
    """Убрать import/export: код вклеивается в общий блок, а не грузится.

    Импорт может занимать несколько строк — поэтому DOTALL и нежадный поиск до
    первой точки с запятой. С построчным разбором такой импорт оставался в
    тексте и ронял всю сборку синтаксической ошибкой, причём молча: страница
    открывалась пустой, а ошибка была на семьдесят восьмой тысяче строк.
    """
    src = re.sub(r"^[ \t]*import\s[^;]*?;[ \t]*$", "", src, flags=re.M | re.S)
    src = re.sub(r"^\s*export\s+(const|let|class|function)\s", r"\1 ", src, flags=re.M)
    # Реэкспорт `export {...} from './three.core.js';` — у three.webgpu.js такой
    # есть, и он длиной в шестьдесят тысяч символов. Во вклеенном виде он не
    # нужен и не имеет смысла: ядро уже здесь же, в той же области видимости.
    src = re.sub(r"^\s*export\s*\{[^}]*\}\s*(from\s*['\"][^'\"]*['\"])?;?\s*$",
                 "", src, flags=re.M)
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
    three = three_bundle(strip_modules)

    # Отметка сборки: по ней дамп состояния можно привязать к коду, который
    # его породил. Без этого «воспроизведи вот этот случай» через неделю
    # означает «воспроизведи неизвестно на какой версии».
    build = {"commit": _git("rev-parse", "--short", "HEAD"),
             "branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
             "dirty": bool(_git("status", "--porcelain")),
             "built": datetime.datetime.now().astimezone().isoformat(timespec="seconds")}

    tpl = tpl.replace("/*__BUILD__*/ null",
                      json.dumps(build, ensure_ascii=False, separators=(",", ":")))
    html = tpl.replace("/*__PACK__*/ null",
                       json.dumps(pack, ensure_ascii=False, separators=(",", ":")))
    html = html.replace("/*__MESH__*/ null",
                        json.dumps(mesh, separators=(",", ":")))
    # Пакет акватории необязателен: без него страница собирается и работает,
    # лодка ходит по бесконечной воде. Это не запасной путь, а полноправный —
    # см. docs/terrain-in-sim.md.
    terr_path = os.path.join(exp, "terrain_pack.json")
    if os.path.exists(terr_path):
        html = html.replace(
            "/*__TERRAIN_PACK__*/ null",
            json.dumps(json.load(open(terr_path)), separators=(",", ":")))
    # Разметка акватории — стартовые точки, буи, судовой ход. Ставится она
    # руками в просмотрщике (`make serve`) и лежит в репозитории, а не в пакете:
    # пакет пересобирается из открытых источников, разметка нет, и мешать их
    # значило бы терять её при каждой сборке. Файла может не быть — тогда
    # страница работает как раньше, со своими знаками на воде.
    marks_path = os.path.join(ROOT, "data", "marks.json")
    if os.path.exists(marks_path):
        html = html.replace(
            "/*__MARKS__*/ null",
            json.dumps(json.load(open(marks_path, encoding="utf-8")),
                       ensure_ascii=False, separators=(",", ":")))
    html = html.replace("/*__THREE__*/", three)
    # Порядок важен: physics.js берёт WindField из wind.js, а импорты при
    # вклейке снимаются — значит поле ветра должно быть объявлено раньше.
    # Порядок важен: импорты при вклейке снимаются, значит то, что берут
    # другие, должно быть объявлено раньше. Список полный и проверяется ниже:
    # забыть в нём новый модуль — значит собрать страницу, которая падает на
    # первом же обращении к нему, и узнать об этом только в браузере. Так уже
    # дважды и вышло.
    for name in MODULES:
        html = html.replace("/*__%s__*/" % name.split(".")[0].upper(),
                            strip_modules(open(os.path.join(sim, name)).read()))

    have = set(f for f in os.listdir(sim) if f.endswith(".js"))
    missed = have - set(MODULES)
    if missed:
        raise SystemExit("в сборку не попали модули: " + ", ".join(sorted(missed)))

    # Незаполненные метки — это молча выпавший из сборки модуль. Проверяется
    # здесь, а не в браузере: пустая страница с синтаксической ошибкой на
    # семидесятой тысяче строк — не то, по чему такое ищут.
    left = re.findall(r"/\*__[A-Z]+__\*/", html)
    if left:
        raise SystemExit("в шаблоне остались метки: " + ", ".join(sorted(set(left))))

    dst = os.path.join(sim, "index.html")
    with open(dst, "w") as f:
        f.write(html)
    print("%s — %.0f КБ" % (os.path.relpath(dst, ROOT), os.path.getsize(dst) / 1024))

    # Самотеста в браузере больше нет: физику гоняет node
    # (`make test`, tests/physics.test.mjs). Два источника правды на одну
    # модель — верный способ чинить не то.


if __name__ == "__main__":
    main()
