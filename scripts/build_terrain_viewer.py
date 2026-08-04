#!/usr/bin/env python3
"""Собрать отдельную страницу просмотра акватории.

    python3 scripts/build_terrain_viewer.py

Берёт out/terrain.json и вклеивает его вместе с three, viewer/terrain.js,
sim/terrain.js и viewer/terrain_tools.js в viewer/terrain.html.

Рельеф вклеен, и страница открывается двойным кликом, как открывалась. А вот
поля физики и разметка акватории требуют сервера (`make serve`): пакет физики
читается по частям, разметка пишется обратно на диск, и ни того, ни другого
`file://` не позволяет. Без сервера страница про это скажет, а не промолчит.

Страница нарочно отдельная: симулятор про бесконечную воду, и пока не видно,
что выгрузка годная, ей в sim/index.html делать нечего.
"""

import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "src"))

# Склейку three держит сборщик симулятора: она одна на все страницы, и
# расходиться им незачем.
from build_sim import strip_modules, three_bundle  # noqa: E402


def _check_syntax(html):
    """Прогнать собранный модуль через `node --check`.

    Ошибка разбора в модуле не видна ниоткуда: страница открывается пустой, в
    консоли пусто, и искать причину приходится в четырёх миллионах символов
    склейки. Так и вышло с первой же сборкой — объявленное здесь имя совпало с
    именем внутри three. Пять секунд проверки дешевле этого на порядок.
    """
    m = re.search(r'<script type="module">(.*)</script>', html, re.S)
    tmp = os.path.join(ROOT, "out", ".syntax-check.mjs")
    with open(tmp, "w") as f:
        f.write(m.group(1))
    try:
        r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    except FileNotFoundError:
        return                      # node не обязателен для сборки страницы
    finally:
        os.unlink(tmp)
    if r.returncode != 0:
        raise SystemExit("модуль не разбирается:\n" + r.stderr.strip())


def main():
    src = os.path.join(ROOT, "out", "terrain.json")
    if not os.path.exists(src):
        raise SystemExit("нет out/terrain.json — сначала `make terrain`")

    tpl = open(os.path.join(ROOT, "viewer", "terrain_template.html")).read()
    # Данные вклеиваются текстом как есть: это уже компактный JSON с base64
    # внутри, разбирать и собирать его заново незачем.
    html = tpl.replace("/*__TERRAIN__*/ null", open(src).read())
    html = html.replace("/*__THREE__*/", three_bundle(strip_modules))
    # Пакет физики читает та же реализация, что и симулятор: sim/terrain.js
    # вклеивается сюда целиком. Написать для картинки «примерно то же самое»
    # было бы худшим решением из возможных — расхождение такой пары не ловится
    # ничем, а смотрят на неё именно затем, чтобы поверить числам.
    html = html.replace("/*__SIMTERRAIN__*/", strip_modules(
        open(os.path.join(ROOT, "sim", "terrain.js")).read()))
    html = html.replace("/*__VIEWER__*/", strip_modules(
        open(os.path.join(ROOT, "viewer", "terrain.js")).read()))
    html = html.replace("/*__TOOLS__*/", strip_modules(
        open(os.path.join(ROOT, "viewer", "terrain_tools.js")).read()))

    left = re.findall(r"/\*__[A-Z]+__\*/", html)
    if left:
        raise SystemExit("в шаблоне остались метки: " + ", ".join(sorted(set(left))))

    _check_syntax(html)

    dst = os.path.join(ROOT, "viewer", "terrain.html")
    with open(dst, "w") as f:
        f.write(html)
    print("%s — %.1f МБ" % (os.path.relpath(dst, ROOT),
                            os.path.getsize(dst) / 1048576))


if __name__ == "__main__":
    main()
