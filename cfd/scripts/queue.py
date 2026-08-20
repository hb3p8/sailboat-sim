#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Очередь расчётов: cfd/scripts/queue.py [--only ...] [--dry]

Трёхмерные случаи считаются ПО ОДНОМУ. Это не мелочь и не осторожность:
OpenFOAM берёт столько ядер, сколько ему велено, и два случая по четыре
процесса на десяти ядрах идут не вдвое быстрее, а втрое медленнее каждый. Один
раз это уже стоило двух убитых расчётов и load average под шестьдесят.

Двумерные — ПОЛОСОЙ по три случая на трёх процессах каждый. Правило то же
самое, что и выше, — ограничена СУММА процессов, — только применено честно:
сетка сечения в двадцать шесть тысяч ячеек не масштабируется дальше трёх-
четырёх ядер, и держать под неё всю машину значит утроить стену очереди на
ровном месте. Девять процессов полосы занимают ту же ёмкость, что один
трёхмерный случай. Порядок приоритетов не ломается: параллелятся только
ПОДРЯД идущие двумерные, первый же трёхмерный дожидается конца полосы.

Каждый случай проходит цепочку целиком — развернуть, посчитать, собрать
сводку. Упавший случай не останавливает очередь: он записывается в отчёт как
упавший, а остальные считаются.

Порядок в списке — по возрастанию цены и по убыванию пользы: сначала то, что
проверяет саму цепочку, потом гидродинамика, потом тройки сеток.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
# ThreadPoolExecutor здесь не выжил: этот файл называется queue.py, и
# concurrent.futures при импорте берёт ЕГО вместо стандартного модуля queue —
# циркулярный импорт. Голому threading стандартный queue не нужен.

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
    # Тройка сеток опорной точки генакера: без неё у пары flat/design нет
    # сеточной оценки, и по §13.4 её строки не имеют права на вердикт.
    ("gen-sec-design-a35-coarse", GEOM_SAIL),
    ("gen-sec-design-a35-fine", GEOM_SAIL),
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
    ("naca0012-a10-coarse", GEOM_MAIN),
    ("naca0012-a10-medium", GEOM_MAIN),
    ("naca0012-a10-fine", GEOM_MAIN),
    # Живой VOF-покой — последняя незакрытая часть этапа 0: паразитные скорости,
    # уровень воды и гидростатика на теле известны заранее.
    ("still-water", GEOM_MAIN),
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


def step(args, timeout=None, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                       timeout=timeout, env=e)
    return p.returncode, (p.stdout + p.stderr)


# Сколько двумерных случаев идёт в полосе и по сколько процессов каждому.
LANE_2D = 3
NPROC_2D = 3


def is_2d(case):
    """Двумерный ли случай — по шаблону манифеста, а не по имени."""
    for fam in os.listdir(os.path.join(ROOT, "cfd", "cases")):
        p = os.path.join(ROOT, "cfd", "cases", fam, case + ".json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)["template"].startswith("openfoam-2d")
    return False


def run_case(case, geom, nproc=None):
    """Полная цепочка одного случая; возвращает запись для queue.json."""
    run_dir = os.path.join("out", "cfd", "runs", case)
    env = {"SV20_CFD_NPROC": str(nproc)} if nproc else None
    t0 = time.time()
    rc, out = step([PY, CLI, "case", "--case", case,
                    "--geometry", geom, "--force"], env=env)
    if rc:
        return {"status": "case-failed", "log": out[-2000:]}, out
    rc, out = step([PY, CLI, "run", "--case", case, "--geometry", geom],
                   env=env)
    if rc:
        return {"status": "run-failed", "seconds": time.time() - t0,
                "log": out[-2000:]}, out
    rc, out = step([PY, CLI, "collect", "--run", run_dir], env=env)
    return {"status": "ok" if rc == 0 else "collect-failed",
            "seconds": time.time() - t0}, out


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

    lock = threading.Lock()

    def finish(case, rec, out):
        with lock:
            st[case] = rec
            save_state(st)
            tail = out[-900:] if rec["status"] == "ok" else out[-800:]
            print("\n=== %s: %s за %.0f с ===\n%s"
                  % (case, rec["status"], rec.get("seconds", 0), tail),
                  flush=True)

    i = 0
    while i < len(todo):
        case, geom = todo[i]
        if is_2d(case):
            lane = []
            while i < len(todo) and is_2d(todo[i][0]) and len(lane) < LANE_2D:
                lane.append(todo[i]); i += 1
            print("\n--- полоса 2D: %s" % ", ".join(c for c, _g in lane),
                  flush=True)
            threads = []
            for c, g in lane:
                def work(c=c, g=g):
                    rec, out = run_case(c, g, NPROC_2D)
                    finish(c, rec, out)
                t = threading.Thread(target=work)
                t.start()
                threads.append(t)
            for t in threads:
                t.join()
        else:
            print("\n=== %s ===" % case, flush=True)
            rec, out = run_case(case, geom)
            finish(case, rec, out)
            i += 1

    done = sum(1 for v in st.values() if v.get("status") == "ok")
    print("\nсчитано успешно: %d" % done)
    return 0


if __name__ == "__main__":
    sys.exit(main())
