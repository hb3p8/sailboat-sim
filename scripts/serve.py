#!/usr/bin/env python3
"""Локальный сервер для страниц проекта.

    python3 scripts/serve.py [--port 8020] [--no-open] [--lan] [--tls]

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

Исключение — `--lan`, и оно нужно ровно за одним: потрогать игровой интерфейс на
настоящем телефоне. Тогда слушается вся сеть, а запись разметки выключается —
писать на диск по просьбе неизвестно кого нельзя, а отдавать файлы репозитория
в домашний Wi-Fi можно.

**Для симулятора одного `--lan` мало, нужен ещё `--tls`.** Симулятор рисует через
WebGPU, а его браузер выдаёт только в ЗАЩИЩЁННОМ контексте: `https://` или
`localhost`. Обычный `http://` на адрес вида 192.168.х.х защищённым не считается,
`navigator.gpu` там не существует вовсе, three.js откатывается на WebGL2 — и
падает на первом же вычислительном шейдере волны. Выглядит это как
«builder.getScopedArray is not a function» и к телефону отношения не имеет:
то же самое в любом браузере по тому же адресу.

**Отдавать ассеты.** Сюда переехало всё, что весит и что незачем вклеивать:
фигурки экипажа и то, что появится дальше. Модели лежат в `assets/`, распаковщик
Draco — в `viewer/vendor/draco/`.

Страницы по-прежнему открываются двойным кликом, но уже не в полном составе:
`sim/index.html` без сервера покажет лодку без экипажа, `viewer/terrain.html` —
без полей физики и разметки. Обе об этом скажут, а не сломаются.
"""

import argparse
import http.server
import json
import os
import re
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
import time
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
    # Типы, которых нет в системной таблице python: без них .glb приезжает
    # как text/html и загрузчик спотыкается на первой же строке разбора.
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map,
                          **{".glb": "model/gltf-binary",
                             ".gltf": "model/gltf+json",
                             ".wasm": "application/wasm"})
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
        # Наружу — только чтение. Разметка пишется на диск без всякой проверки,
        # кто просит; законно это ровно до тех пор, пока просить может одна эта
        # машина. Открыли сеть (`--lan`) — запись закрывается, и переключателя
        # «открыть сеть И писать» здесь нет нарочно.
        if getattr(self.server, "read_only", False):
            self._json(403, {"error": "сервер открыт в сеть, запись выключена"})
            return
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
    read_only = False


def lan_addresses():
    """Адреса, по которым эту машину видно из своей сети.

    Спрашивается ДВУМЯ способами, и это не перестраховка: каждый по отдельности
    врёт, и врёт по-разному.

    Маршрут наружу (датаграммный сокет ничего не шлёт, он только заставляет
    систему выбрать путь и показать, с какого адреса тот пойдёт) отдаёт адрес
    того интерфейса, через который машина ходит в интернет. Поднят VPN — это
    будет туннель, и вышло у меня ровно так: `169.254.19.0` на `utun4`, то есть
    самоназначенный адрес, по которому с телефона не открывается ничего.

    Имя машины (`hb3p8.local` -> `getaddrinfo`) отдаёт адрес в своей сети, тот
    самый `192.168.1.62`, — но на машине без mDNS не отдаёт ничего.

    Поэтому берутся оба, выбрасываются петля и самоназначенные `169.254.*`, а
    что осталось — печатается ЦЕЛИКОМ. Какая из двух сетей та, в которой стоит
    телефон, знает человек, а не скрипт.
    """
    found = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 53))
        found.append(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    out = []
    for ip in found:
        if ip.startswith("127.") or ip.startswith("169.254."):
            continue
        if ip not in out:
            out.append(ip)
    return out


CERT_DIR = os.path.join(ROOT, "out", "dev-cert")


def dev_cert(names):
    """Самоподписанный сертификат для локальной разработки.

    Лежит в `out/`, то есть не коммитится и переживает пересборку. Годен год;
    просроченный или выписанный на другой адрес перевыпускается сам — адрес в
    сети меняется вместе с сетью, а сертификат обязан его называть, иначе
    браузер не пустит и после согласия.

    Ключ пишется с правами 600: это ключ, пусть и одноразовый.
    """
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    san = ",".join(["DNS:localhost", "IP:127.0.0.1"] +
                   ["IP:%s" % n for n in names])
    stamp = os.path.join(CERT_DIR, "for.txt")
    fresh = (os.path.exists(cert) and os.path.exists(key)
             and os.path.exists(stamp)
             and open(stamp).read() == san
             and time.time() - os.path.getmtime(cert) < 300 * 86400)
    if not fresh:
        os.makedirs(CERT_DIR, exist_ok=True)
        cmd = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
               "-keyout", key, "-out", cert, "-days", "365",
               "-subj", "/CN=sv20 dev", "-addext", "subjectAltName=" + san]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit("не вышло выписать сертификат:\n" + r.stderr)
        os.chmod(key, 0o600)
        with open(stamp, "w") as f:
            f.write(san)
        print("выписан самоподписанный сертификат на %s" % san)
    return cert, key


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8020)
    ap.add_argument("--no-open", action="store_true", help="не открывать браузер")
    ap.add_argument("--lan", action="store_true",
                    help="слушать всю сеть, чтобы открыть с телефона; "
                         "запись разметки при этом выключается")
    ap.add_argument("--tls", action="store_true",
                    help="по https с самоподписанным сертификатом: без него "
                         "симулятору не дадут WebGPU нигде, кроме localhost")
    a = ap.parse_args()

    # Открыли сеть — значит хотят открыть симулятор с другого устройства, а ему
    # нужен WebGPU, а тому — защищённый контекст. Поэтому `--lan` включает https
    # сам: связка «сеть без TLS» не работает никогда, и наступать на неё каждый
    # раз заново незачем. Отдельно `--tls` остаётся для петли.
    if a.lan and not a.tls:
        a.tls = True
        print("к --lan включён https: без него браузер не выдаст WebGPU")

    # По умолчанию — только петля (см. do_PUT о том, почему). `--lan` открывает
    # сеть и тем же движением закрывает запись: отдаётся корень репозитория, и
    # всякий в этой сети сможет его ЧИТАТЬ. Для домашнего Wi-Fi это разумная
    # цена за то, чтобы потрогать игровой интерфейс пальцем; в чужой сети
    # включать не стоит.
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    ips = lan_addresses() if a.lan else []
    with Server((host, a.port), Handler) as srv:
        srv.read_only = a.lan
        proto = "http"
        if a.tls:
            cert, key = dev_cert(ips)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
            proto = "https"
        shown = ips[0] if ips else "127.0.0.1"
        print("сервер на %s://%s:%d/viewer/terrain.html" % (proto, shown, a.port))
        if a.lan:
            if ips:
                print("с телефона:")
                for ip in ips:
                    print("    %s://%s:%d/sim/index.html" % (proto, ip, a.port))
                if len(ips) > 1:
                    print("  (адресов несколько — нужен тот, в чьей сети телефон)")
            else:
                print("адрес в сети определить не удалось: посмотрите `ifconfig`")
            print("запись разметки выключена: сеть открыта")
        else:
            print("пишется только %s; Ctrl-C чтобы остановить"
                  % os.path.relpath(MARKS, ROOT))
        if a.tls:
            print("сертификат самоподписанный: браузер один раз спросит согласия")
        if not a.no_open:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nостановлен")


if __name__ == "__main__":
    main()
