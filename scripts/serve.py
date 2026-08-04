#!/usr/bin/env python3
"""Локальный сервер для страниц проекта.

    python3 scripts/serve.py [--port 8020] [--no-open]

Нужен ровно для двух вещей, которых самодостаточная страница не умеет.

**Читать файлы по частям.** С `file://` политика источника запрещает `fetch()`,
и потому всё, что странице нужно, приходится вклеивать в неё саму. Для
симулятора это осознанная цена — он обязан открываться двойным кликом. Для
просмотра акватории цена бессмысленная: пакет физики там нужен целиком, а
пересобирать пять мегабайт ради одной правки в разметке — занятие на любителя.

**Писать файлы обратно.** Разметка акватории — стартовые точки, буи, судовой
ход — делается глазами и мышью, а хранится в репозитории. Без сервера её
пришлось бы выгружать в файл и класть на место руками, каждый раз.

Отдаётся корень репозитория как есть; пишется ровно один файл, `data/marks.json`,
и никакой другой. Слушается только петля: наружу это не смотрит и смотреть не
должно.

Самодостаточные страницы никуда не деваются. `sim/index.html` открывается
двойным кликом как открывался, `viewer/terrain.html` — тоже; без сервера у него
просто не будет полей физики и разметки, о чём страница и скажет.
"""

import argparse
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Единственный путь, который сервер пишет. Не список и не префикс: писать
# больше нечего, а всякое расширение этого места — уже дыра.
MARKS = os.path.join(ROOT, "data", "marks.json")
MARKS_URL = "/api/marks"

EMPTY = {"starts": [], "buoys": [], "fairway": []}


def read_marks():
    if not os.path.exists(MARKS):
        return dict(EMPTY)
    with open(MARKS, encoding="utf-8") as f:
        m = json.load(f)
    for k, v in EMPTY.items():
        m.setdefault(k, list(v))
    return m


def write_marks(data):
    """Записать разметку. Только известные разделы и только числа.

    Проверка тут не от злого умысла, а от ошибки на своей же стороне: страница
    правит файл, который лежит в репозитории, и мусор в нём обнаружится через
    неделю в самом неудобном месте. Дешевле не пустить его сразу.
    """
    if not isinstance(data, dict):
        raise ValueError("ожидался объект")
    out = {}
    for key in ("starts", "buoys"):
        items = data.get(key, [])
        if not isinstance(items, list):
            raise ValueError("%s: ожидался список" % key)
        out[key] = [_point(key, it) for it in items]
    lines = data.get("fairway", [])
    if not isinstance(lines, list):
        raise ValueError("fairway: ожидался список")
    out["fairway"] = [_line(it) for it in lines]

    os.makedirs(os.path.dirname(MARKS), exist_ok=True)
    tmp = MARKS + ".tmp"
    text = json.dumps(out, ensure_ascii=False, indent=2)
    # Пары координат — в одну строку. Файл этот читают и правят глазами, а
    # столбик из двух чисел на четыре строки читать невозможно.
    text = re.sub(r"\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]", r"[\1, \2]", text)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    os.replace(tmp, MARKS)          # замена целиком: половины файла не бывает
    return out


def _num(v):
    v = float(v)
    if v != v or v in (float("inf"), float("-inf")):
        raise ValueError("не число")
    return round(v, 2)


def _name(v):
    s = str(v or "").strip()[:60]
    return s


def _point(key, it):
    out = {"name": _name(it.get("name")),
           "x": _num(it.get("x")), "y": _num(it.get("y"))}
    if key == "starts":
        out["heading_deg"] = _num(it.get("heading_deg", 0))
        # Ветер — часть стартовой обстановки, а не свойство места: одна и та же
        # точка при разном ветре — разные задачи. Отсчёт тот же, что у курса и у
        # `windDir` в физике: от оси X против часовой, и «откуда дует».
        out["wind_deg"] = _num(it.get("wind_deg", 0))
    else:
        kind = str(it.get("kind", "fairway"))
        if kind not in ("left", "right", "danger", "fairway"):
            raise ValueError("буй: неизвестный вид %r" % kind)
        out["kind"] = kind
    return out


def _line(it):
    pts = it.get("points", [])
    if not isinstance(pts, list) or len(pts) < 2:
        raise ValueError("судовой ход: нужно хотя бы две точки")
    return {"name": _name(it.get("name")),
            "points": [[_num(p[0]), _num(p[1])] for p in pts]}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        # Тихо про статику, громко про запись: в консоли должно быть видно
        # только то, что меняет файлы.
        if self.path.startswith("/api/"):
            sys.stderr.write("  %s %s\n" % (self.command, self.path))

    def end_headers(self):
        # Страница и данные правятся прямо во время работы, и закэшированная
        # прошлая версия тут не помощник, а источник получаса недоумения.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == MARKS_URL:
            try:
                self._json(200, read_marks())
            except Exception as e:
                self._json(500, {"error": str(e)})
            return
        super().do_GET()

    def do_PUT(self):
        if self.path.split("?")[0] != MARKS_URL:
            self._json(404, {"error": "писать сюда нельзя"})
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1 << 20:
            self._json(413, {"error": "слишком большой файл разметки"})
            return
        try:
            data = json.loads(self.rfile.read(n).decode("utf-8"))
            saved = write_marks(data)
        except Exception as e:
            self._json(400, {"error": str(e)})
            return
        self._json(200, {"saved": os.path.relpath(MARKS, ROOT),
                         "counts": {k: len(v) for k, v in saved.items()}})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8020)
    ap.add_argument("--no-open", action="store_true", help="не открывать браузер")
    a = ap.parse_args()

    # Только петля. Разметка пишется на диск без всякой проверки, кто просит, —
    # это законно ровно до тех пор, пока просить может только эта машина.
    with Server(("127.0.0.1", a.port), Handler) as srv:
        url = "http://127.0.0.1:%d/viewer/terrain.html" % a.port
        print("сервер на %s" % url)
        print("пишется только %s; Ctrl-C чтобы остановить"
              % os.path.relpath(MARKS, ROOT))
        if not a.no_open:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nостановлен")


if __name__ == "__main__":
    main()
