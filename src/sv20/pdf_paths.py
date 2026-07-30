"""Ф0, шаг 1: содержимое векторного PDF -> полилинии.

Чертёж 610 нарисован исключительно операторами `m`/`l`/`h`/`re` — ни кривых
Безье, ни матриц `cm`, ни `q`/`Q`. Проверено на исходнике: см. `verify_dialect`.
Поэтому парсер не аппроксимирует ничего: координаты выходят ровно те, что
конструктор положил в файл.

Зависимостей нет — только стандартная библиотека.
"""

import re
import zlib
from collections import Counter

# Операторы, которые завершают текущий путь (закраска/обводка/отмена).
PAINT_OPS = {"S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"}

# Операторы, которые парсер игнорирует, но которые безопасны: они не меняют
# систему координат и не влияют на геометрию.
IGNORED_OPS = {
    "J", "j", "M", "d", "i", "ri", "gs",
    "CS", "cs", "SC", "SCN", "sc", "scn", "G", "g", "RG", "rg", "K", "k",
    "W", "W*",
}

# Операторы, которых в этом файле быть не должно. Если они появятся (например,
# конструктор перевыложит чертёж из другой версии CAD), парсер обязан упасть,
# а не молча выдать искажённую геометрию.
UNSUPPORTED_OPS = {"c", "v", "y", "cm", "q", "Q", "Do", "BT", "ET", "Tj", "TJ"}

_NUM_RE = re.compile(rb"^[+-]?(?:\d+\.?\d*|\.\d+)$")


class Subpath(object):
    """Одна непрерывная полилиния с атрибутами состояния графики."""

    __slots__ = ("points", "width", "closed", "filled", "group")

    def __init__(self, points, width, closed, filled, group):
        self.points = points
        self.width = width
        self.closed = closed
        self.filled = filled
        self.group = group  # id операции закраски: субпути одной операции связаны

    def to_dict(self):
        return {
            "points": [[round(x, 4), round(y, 4)] for x, y in self.points],
            "width": self.width,
            "closed": self.closed,
            "filled": self.filled,
            "group": self.group,
        }

    @property
    def bbox(self):
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        return (min(xs), min(ys), max(xs), max(ys))

    def length(self):
        pts = self.points
        return sum(
            ((pts[i + 1][0] - pts[i][0]) ** 2 + (pts[i + 1][1] - pts[i][1]) ** 2) ** 0.5
            for i in range(len(pts) - 1)
        )

    def __repr__(self):
        x0, y0, x1, y1 = self.bbox
        return "<Subpath n=%d w=%.2f x[%.2f,%.2f] y[%.2f,%.2f]>" % (
            len(self.points), self.width, x0, x1, y0, y1
        )


def _iter_objects(data):
    """Грубый обход `N 0 obj ... endobj`. Файл линеаризован и без object streams."""
    for m in re.finditer(rb"(\d+)\s+0\s+obj(.*?)endobj", data, re.S):
        yield int(m.group(1)), m.group(2)


def _page_content(data):
    """Склеенное содержимое единственной страницы, распакованное из FlateDecode."""
    objs = dict(_iter_objects(data))

    page = None
    for body in objs.values():
        if b"/Type /Page" in body and b"/Contents" in body:
            page = body
            break
    if page is None:
        raise ValueError("в PDF не найден объект страницы")

    refs = re.search(rb"/Contents\s*\[(.*?)\]", page, re.S)
    if refs:
        nums = [int(n) for n in re.findall(rb"(\d+)\s+0\s+R", refs.group(1))]
    else:
        one = re.search(rb"/Contents\s+(\d+)\s+0\s+R", page)
        if not one:
            raise ValueError("у страницы не найден /Contents")
        nums = [int(one.group(1))]

    chunks = []
    for n in nums:
        body = objs[n]
        head, _, tail = body.partition(b"stream")
        raw = tail.lstrip(b"\r\n")
        end = raw.rfind(b"endstream")
        raw = raw[:end] if end >= 0 else raw
        if b"/FlateDecode" in head:
            raw = zlib.decompress(raw)
        elif b"/Filter" in head:
            raise ValueError("неподдерживаемый фильтр потока: %r" % head[:120])
        chunks.append(raw)

    return b"\n".join(chunks)


def media_box(data):
    """MediaBox страницы в пунктах: (x0, y0, x1, y1)."""
    for _, body in _iter_objects(data):
        m = re.search(rb"/MediaBox\s*\[\s*([\d.\s+-]+?)\]", body)
        if m:
            vals = [float(v) for v in m.group(1).split()]
            if len(vals) == 4:
                return tuple(vals)
    raise ValueError("MediaBox не найден")


def verify_dialect(content):
    """Убедиться, что в потоке нет операторов, которые парсер молча исказил бы."""
    used = set(re.findall(rb"(?<![\w.])([A-Za-z][A-Za-z]?\*?)(?![\w.])", content))
    used = set(t.decode("latin1") for t in used)
    bad = sorted(used & UNSUPPORTED_OPS)
    if bad:
        raise ValueError(
            "в потоке встретились неподдерживаемые операторы %s — "
            "парсер рассчитан только на полилинии без трансформаций" % bad
        )
    return sorted(used)


def parse(pdf_bytes):
    """Разобрать PDF в список Subpath в пунктах PDF (Y направлен вверх)."""
    content = _page_content(pdf_bytes)
    verify_dialect(content)

    tokens = content.split()
    out = []
    stack = []          # операнды текущего оператора
    width = 1.0         # состояние графики: толщина линии
    current = []        # точки текущего субпути
    pending = []        # субпути, накопленные до операции закраски
    closed = False
    group = 0

    def flush_subpath():
        if len(current) >= 2:
            pending.append((list(current), closed))
        del current[:]

    for raw in tokens:
        if _NUM_RE.match(raw):
            stack.append(float(raw))
            continue

        op = raw.decode("latin1")

        if op == "m":
            flush_subpath()
            closed = False
            current.append((stack[-2], stack[-1]))
        elif op == "l":
            current.append((stack[-2], stack[-1]))
        elif op == "re":
            flush_subpath()
            x, y, w, h = stack[-4:]
            current.extend([(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)])
            closed = True
            flush_subpath()
            closed = False
        elif op == "h":
            if current:
                if current[0] != current[-1]:
                    current.append(current[0])
                closed = True
        elif op == "w":
            width = stack[-1]
        elif op in PAINT_OPS:
            if op in ("s", "b", "b*") and current and current[0] != current[-1]:
                current.append(current[0])
                closed = True
            flush_subpath()
            filled = op in ("f", "F", "f*", "B", "B*", "b", "b*")
            for pts, was_closed in pending:
                out.append(Subpath(pts, width, was_closed, filled, group))
            group += 1
            del pending[:]
            closed = False
        elif op in IGNORED_OPS:
            pass
        elif op in UNSUPPORTED_OPS:
            raise ValueError("неподдерживаемый оператор %r" % op)
        # прочие токены (имена ресурсов /GS1, /Cs6) просто пропускаем

        del stack[:]

    flush_subpath()
    for pts, was_closed in pending:
        out.append(Subpath(pts, width, was_closed, False, group))

    return out


def operator_histogram(pdf_bytes):
    """Гистограмма операторов — для отчёта и для контроля при смене исходника."""
    content = _page_content(pdf_bytes)
    toks = [t.decode("latin1") for t in content.split()]
    ops = [t for t in toks if not _NUM_RE.match(t.encode("latin1")) and not t.startswith("/")]
    return Counter(ops)
