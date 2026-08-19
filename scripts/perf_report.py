#!/usr/bin/env python3
"""Прочитать сессию профиля: python3 scripts/perf_report.py [файл|последняя]

Ленты пишет сам симулятор (`sim/perflog.js`) на сервер (`scripts/serve.py`), а
лежат они в `out/perf/*.jsonl`. Здесь они превращаются в то, ради чего писались:
не в среднее по сессии, а в ход событий.

ПОЧЕМУ НЕ СРЕДНЕЕ. Среднее по кадрам врёт дважды. Оно прячет провалы — а
интересны как раз они: поворот, порыв, вход в узкое место. И оно мешает разные
режимы: первые секунды с разогревом видеокарты, ход по прямой, отладочный вид,
включённый на минуту. Поэтому здесь окна по десять секунд и медиана в каждом:
медиана не даёт одному выбросу перекрасить всё окно, а окно показывает, что
менялось.

Проценты снизу — по всей сессии: 50-й отвечает «как обычно», 95-й «как в
худшие секунды», и разница между ними и есть ровность хода.
"""

import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERF_DIR = os.path.join(ROOT, "out", "perf")

# Столбцы: ключ в ленте и подпись. Порядок — от общего к частному, как и на
# экране: сначала кадр целиком, потом из чего он сложился.
# «кадр» — ПРОЦЕССОРНАЯ часть кадра (от входа в кадр до постановки следующего),
# без ожидания развёртки и без работы видеокарты; полный кадр виден по к/с.
# «счёт» — средняя цена волны на показанный кадр, «пакет» — цена одного прогона:
# волна считается не каждый кадр, и складывать с отрисовкой можно только первое.
COLS = [("кадр", "кадрЦП"), ("кс", "к/с"), ("физ", "физ"), ("шагов", "шаг"),
        ("сцена", "сцена"), ("рис", "рис"), ("гп", "ГП"), ("счёт", "счёт"),
        ("пакет", "пакет")]

WINDOW = 10.0     # с, ширина окна


def median(a):
    if not a:
        return 0.0
    b = sorted(a)
    return b[len(b) // 2]


def pct(a, p):
    if not a:
        return 0.0
    b = sorted(a)
    return b[min(len(b) - 1, int(round(p / 100 * (len(b) - 1))))]


def load(path):
    head, rows, benches = None, [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if "head" in o:
                head = o["head"]
            elif "скамья" in o:
                # Замер скамьи — не отсчёт хода: у него нет ни времени, ни к/с, и
                # в окна с медианами он попадать не должен.
                benches.append(o)
            else:
                rows.append(o)
    return head, rows, benches


def print_bench(b):
    rows = b.get("строки") or []
    base = rows[0][1] if rows else 0
    print("\n%s (случай «%s»%s):\n"
          % (b.get("скамья", "скамья"), b.get("случай", "?"),
             "" if b.get("осушение", True) else ", БЕЗ ОСУШЕНИЯ"))
    for name, t in rows:
        save = base - t
        tail = "" if not base or name == rows[0][0] else \
            "   снятие вернёт %5.2f мс (%3.0f%%)" % (save, 100 * save / base)
        print("  %-24s %6.2f мс%s" % (name, t, tail))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    files = sorted(glob.glob(os.path.join(PERF_DIR, "*.jsonl")))
    if not files:
        raise SystemExit("сессий нет: " + os.path.relpath(PERF_DIR, ROOT))
    if arg and arg != "последняя":
        path = arg if os.path.exists(arg) else os.path.join(PERF_DIR, arg)
    else:
        path = max(files, key=os.path.getmtime)
        if len(files) > 1 and not arg:
            print("сессий %d, взята последняя; остальные:" % len(files))
            for f in files[-6:-1]:
                print("   " + os.path.relpath(f, ROOT))
            print()

    head, rows, benches = load(path)
    if not rows and not benches:
        raise SystemExit("в ленте нет отсчётов: " + path)

    print("сессия %s — %d отсчётов" % (os.path.relpath(path, ROOT), len(rows)))
    if head:
        b = head.get("сборка") or {}
        print("  сборка r%s %s%s, %s" % (b.get("rev", "?"), b.get("commit", "?"),
                                         "*" if b.get("dirty") else "", b.get("built", "?")))
        print("  %s, холст %s при dpr %s, пелена в силах: %s"
              % (head.get("интерфейс", "?"),
                 "×".join(str(v) for v in head.get("холст", [])),
                 head.get("dpr", "?"), "да" if head.get("пелена") else "нет"))
        q = head.get("качество") or {}
        if q:
            print("  качество: рендерер×%s, сглаживание %s, сетка %s, тень %s, "
                  "волна N=%s раз в %s, деление пелены %s%s"
                  % (q.get("pixelRatio", "?"), q.get("сглаживание", "?"),
                     q.get("сетка", "?"), q.get("тень", "?"),
                     q.get("волнаN", "?"), q.get("волнаРаз", "?"),
                     q.get("пеленаДеление", "?"),
                     ", мобильный интерфейс" if q.get("интерфейсМоб") else ""))
            if q.get("карта"):
                print("  карта: %s" % q["карта"])
        print("  " + (head.get("агент") or "")[:96])

    # Состав рига — отдельной строкой и с разбором, МЕНЯЛСЯ ЛИ ОН.
    #
    # Генакер поднимают по ходу, а он это плюс шесть полосок и плюс семь нитей,
    # то есть цена шага в полтора-два раза. Сессия со сменой рига посередине —
    # это две разные сессии, и складывать их медианой нельзя; отчёт обязан
    # сказать об этом сам, а не оставить читателю гадать по расхождению.
    rig = [r.get("полосок") for r in rows if r.get("полосок")]
    if rig:
        vals = sorted(set(rig))
        if len(vals) == 1:
            fil = next((r.get("нитей") for r in rows if r.get("полосок")), "?")
            print("  риг: %d полосок, %s нитей пелены — весь прогон" % (vals[0], fil))
        else:
            # Где переключились: первый отсчёт, где состав стал не таким, как в начале.
            first = rig[0]
            at = next((r.get("t") for r in rows
                       if r.get("полосок") and r["полосок"] != first), None)
            print("  риг: МЕНЯЛСЯ по ходу — %s полосок, смена около %.0f с."
                  % ("→".join(str(v) for v in vals), at or 0))
            print("       медианы ниже смешивают два разных рига, читать их нельзя")
    else:
        print("  риг: в ленте не записан (сборка старее r294)")
    print()

    if not rows:
        for b in benches:
            print_bench(b)
        return

    t0 = rows[0].get("t", 0)
    print("Ход сессии, медиана в окне по %d с:\n" % WINDOW)
    print("   время  " + "".join("%7s" % c[1] for c in COLS) + "   вид  отладка")
    win, wstart = [], t0
    def flush(win, wstart):
        if not win:
            return
        line = "  %4d с  " % (wstart - t0)
        line += "".join("%7.1f" % median([r.get(k, 0) for r in win]) for k, _ in COLS)
        line += "  %4d %6d" % (median([r.get("вид", -1) for r in win]),
                               median([r.get("отладка", 0) for r in win]))
        print(line)
    for r in rows:
        if r.get("t", 0) - wstart >= WINDOW:
            flush(win, wstart)
            win, wstart = [], r.get("t", 0)
        win.append(r)
    flush(win, wstart)

    print("\nПо всей сессии:\n")
    print("            " + "".join("%7s" % c[1] for c in COLS))
    for name, p in (("медиана", 50), ("95-й проц", 95), ("худшее", 100)):
        print("  %-10s" % name + "".join("%7.1f" % pct([r.get(k, 0) for r in rows], p)
                                         for k, _ in COLS))

    # Худшие секунды — с временем, чтобы можно было спросить «а что ты там делал».
    worst = sorted(rows, key=lambda r: -r.get("кадр", 0))[:5]
    print("\nСамые долгие кадры:")
    for r in worst:
        print("  %5.0f с   кадр %6.1f мс   физ %5.1f (шагов %.1f)   ГП %6.1f + счёт %5.1f"
              % (r.get("t", 0) - t0, r.get("кадр", 0), r.get("физ", 0),
                 r.get("шагов", 0), r.get("гп", 0), r.get("счёт", 0)))

    for b in benches:
        print_bench(b)


if __name__ == "__main__":
    main()
