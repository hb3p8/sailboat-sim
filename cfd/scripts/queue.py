#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Очередь расчётов: cfd/scripts/queue.py [--only ...] [--dry]

Считает случаи ПО ОДНОМУ. Это не мелочь и не осторожность: OpenFOAM берёт
столько ядер, сколько ему велено, и два случая по четыре процесса на десяти
ядрах идут не вдвое быстрее, а втрое медленнее каждый. Один раз это уже стоило
двух убитых расчётов и load average под шестьдесят.

Каждый случай проходит цепочку целиком — развернуть, посчитать, собрать
сводку, — и только потом начинается следующий. Упавший случай не останавливает
очередь: он записывается в отчёт как упавший, а остальные считаются.

Порядок в списке — по возрастанию цены и по убыванию пользы: сначала то, что
проверяет саму цепочку, потом гидродинамика, потом тройки сеток.
"""

import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

PY = sys.executable
CLI = os.path.join(ROOT, "cfd", "cfd.py")
STATE = os.path.join(ROOT, "out", "cfd", "queue.json")

# Каталог геометрии на случай. У киля он свой: перо перенесено так, чтобы
# корень лёг на плоскость симметрии домена.
GEOM_KEEL = "out/cfd/geometry/keel-root"
GEOM_MAIN = "out/cfd/geometry"
GEOM_SAIL = "out/cfd/geometry/sail"

QUEUE = [
    # Порядок — по убыванию того, что случай СООБЩАЕТ, а не по цене. Считается
    # это часами, машина одна, и остановиться может понадобиться в любой
    # момент; значит к этому моменту должно быть посчитано самое нужное.
    #
    # Первым — опыт на нулевом угле: он отвечает, есть ли в постановке дефект
    # симметрии, и без ответа остальную поляру читать нельзя. Дальше две точки
    # на линейном участке (наклон), потом обе тройки сеток и размер домена.
    # Точки поляры для красоты кривой — в самом конце.
    ("keel-u200-a00-medium", GEOM_KEEL),
    # Генакер, первый этап: сечение в той самой рабочей точке, где карта
    # (курс, шкот) краснеет. Две формы на одном угле — плоская пластина, какой
    # её сейчас видит модель, и сечение с проектным пузом. Разность и есть
    # цена нулевого пуза. Стоит впереди тяжёлых троек: две плоские задачи
    # против часа за трёхмерный случай.
    ("gen-sec-flat-a35", GEOM_SAIL),
    ("gen-sec-design-a35", GEOM_SAIL),
    ("gen-sec-design-a25", GEOM_SAIL),
    ("gen-sec-design-a45", GEOM_SAIL),
    ("keel-u200-a06-medium", GEOM_KEEL),
    ("hull-db-u250-b00-medium", GEOM_MAIN),
    ("keel-u200-a04-medium", GEOM_KEEL),
    ("keel-u200-a08-medium", GEOM_KEEL),
    ("hull-db-u250-b04-medium", GEOM_MAIN),
    ("hull-db-u250-bm04-medium", GEOM_MAIN),
    ("keel-u200-a06-coarse", GEOM_KEEL),
    ("hull-db-u250-b00-coarse", GEOM_MAIN),
    ("keel-u200-a06-wide", GEOM_KEEL),
    ("keel-u200-a06-fine", GEOM_KEEL),
    ("hull-db-u250-b00-fine", GEOM_MAIN),
    ("axes-probe", GEOM_MAIN),
    ("axes-probe-mirror", GEOM_MAIN),
    ("keel-u200-a02-medium", GEOM_KEEL),
    ("keel-u200-a12-medium", GEOM_KEEL),
    ("hull-db-u150-b00-medium", GEOM_MAIN),
    ("hull-db-u350-b00-medium", GEOM_MAIN),
    ("hull-db-u250-b08-medium", GEOM_MAIN),
    ("naca0012-a10-medium", GEOM_MAIN),
    ("naca0012-a10-fine", GEOM_MAIN),
]




def load_state():
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1, sort_keys=True)


def step(args, timeout=None):
    p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                       timeout=timeout)
    return p.returncode, (p.stdout + p.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="считать только эти case_id")
    ap.add_argument("--dry", action="store_true", help="показать план")
    ap.add_argument("--redo", action="store_true", help="пересчитать готовые")
    a = ap.parse_args()

    st = load_state()
    todo = [(c, g) for c, g in QUEUE if not a.only or c in a.only]
    if not a.redo:
        todo = [(c, g) for c, g in todo
                if st.get(c, {}).get("status") != "ok"]
    if a.dry:
        for c, g in todo:
            print("  %-28s %s" % (c, g))
        print("к счёту: %d из %d" % (len(todo), len(QUEUE)))
        return 0

    for case, geom in todo:
        run_dir = os.path.join("out", "cfd", "runs", case)
        t0 = time.time()
        print("\n=== %s ===" % case, flush=True)
        rc, out = step([PY, CLI, "case", "--case", case,
                        "--geometry", geom, "--force"])
        if rc:
            st[case] = {"status": "case-failed", "log": out[-2000:]}
            save_state(st)
            print("  развернуть не удалось:\n%s" % out[-800:], flush=True)
            continue
        rc, out = step([PY, CLI, "run", "--case", case, "--geometry", geom])
        took = time.time() - t0
        if rc:
            st[case] = {"status": "run-failed", "seconds": took,
                        "log": out[-2000:]}
            save_state(st)
            print("  расчёт упал за %.0f с:\n%s" % (took, out[-800:]), flush=True)
            continue
        rc, out = step([PY, CLI, "collect", "--run", run_dir])
        st[case] = {"status": "ok" if rc == 0 else "collect-failed",
                    "seconds": time.time() - t0}
        save_state(st)
        print("  готово за %.0f с\n%s" % (time.time() - t0, out[-900:]),
              flush=True)

    done = sum(1 for v in st.values() if v.get("status") == "ok")
    print("\nсчитано успешно: %d" % done)
    return 0


if __name__ == "__main__":
    sys.exit(main())
