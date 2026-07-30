"""Интерполяция для продольных параметрических кривых.

Естественный кубический сплайн (C²) — им задаются законы изменения параметров
обводов по длине. C² здесь не роскошь: разрывы кривизны на стыках вылезают
на поверхности видимыми плоскими пятнами и портят и CFD-сетку, и блики
в игровом рендере.

PCHIP (C¹, без выбросов) — для величин, где выброс за пределы контрольных
значений физически недопустим: толщина, неотрицательные коэффициенты.

Зависимостей нет.
"""

import bisect


class Spline(object):
    """Естественный кубический сплайн через заданные точки."""

    def __init__(self, xs, ys):
        if len(xs) != len(ys) or len(xs) < 2:
            raise ValueError("нужно не меньше двух узлов и равные длины")
        if any(xs[i] >= xs[i + 1] for i in range(len(xs) - 1)):
            raise ValueError("узлы должны строго возрастать по X")
        self.x = list(xs)
        self.y = list(ys)
        self.m = self._second_derivatives()

    def _second_derivatives(self):
        x, y = self.x, self.y
        n = len(x)
        if n == 2:
            return [0.0, 0.0]
        h = [x[i + 1] - x[i] for i in range(n - 1)]
        # трёхдиагональная система для вторых производных, прогонка
        a = [0.0] * n
        b = [1.0] * n
        c = [0.0] * n
        d = [0.0] * n
        for i in range(1, n - 1):
            a[i] = h[i - 1]
            b[i] = 2.0 * (h[i - 1] + h[i])
            c[i] = h[i]
            d[i] = 6.0 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1])
        for i in range(1, n):
            w = a[i] / b[i - 1]
            b[i] -= w * c[i - 1]
            d[i] -= w * d[i - 1]
        m = [0.0] * n
        m[n - 1] = d[n - 1] / b[n - 1]
        for i in range(n - 2, -1, -1):
            m[i] = (d[i] - c[i] * m[i + 1]) / b[i]
        return m

    def __call__(self, t):
        x, y, m = self.x, self.y, self.m
        n = len(x)
        if t <= x[0]:                       # линейная экстраполяция по касательной
            s = self.deriv(x[0])
            return y[0] + s * (t - x[0])
        if t >= x[-1]:
            s = self.deriv(x[-1])
            return y[-1] + s * (t - x[-1])
        i = bisect.bisect_right(x, t) - 1
        i = max(0, min(n - 2, i))
        h = x[i + 1] - x[i]
        A = (x[i + 1] - t) / h
        B = (t - x[i]) / h
        return (A * y[i] + B * y[i + 1]
                + ((A ** 3 - A) * m[i] + (B ** 3 - B) * m[i + 1]) * h * h / 6.0)

    def deriv(self, t):
        x, y, m = self.x, self.y, self.m
        i = bisect.bisect_right(x, t) - 1
        i = max(0, min(len(x) - 2, i))
        h = x[i + 1] - x[i]
        A = (x[i + 1] - t) / h
        B = (t - x[i]) / h
        return ((y[i + 1] - y[i]) / h
                + ((-3 * A * A + 1) * m[i] + (3 * B * B - 1) * m[i + 1]) * h / 6.0)


class Pchip(object):
    """Кубический Эрмит с наклонами по Фрицшу–Карлсону: без выбросов за узлы."""

    def __init__(self, xs, ys):
        self.x = list(xs)
        self.y = list(ys)
        n = len(xs)
        if n < 2:
            raise ValueError("нужно не меньше двух узлов")
        h = [self.x[i + 1] - self.x[i] for i in range(n - 1)]
        d = [(self.y[i + 1] - self.y[i]) / h[i] for i in range(n - 1)]
        s = [0.0] * n
        for i in range(1, n - 1):
            if d[i - 1] * d[i] <= 0:
                s[i] = 0.0
            else:
                w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
                s[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
        s[0] = self._end(d[0], d[1] if n > 2 else d[0], h[0], h[1] if n > 2 else h[0])
        s[-1] = self._end(d[-1], d[-2] if n > 2 else d[-1],
                          h[-1], h[-2] if n > 2 else h[-1])
        self.s = s

    @staticmethod
    def _end(d0, d1, h0, h1):
        v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
        if v * d0 <= 0:
            return 0.0
        if abs(v) > 3 * abs(d0):
            return 3 * d0
        return v

    def __call__(self, t):
        x, y, s = self.x, self.y, self.s
        if t <= x[0]:
            return y[0] + s[0] * (t - x[0])
        if t >= x[-1]:
            return y[-1] + s[-1] * (t - x[-1])
        i = max(0, min(len(x) - 2, bisect.bisect_right(x, t) - 1))
        h = x[i + 1] - x[i]
        u = (t - x[i]) / h
        h00 = 2 * u ** 3 - 3 * u * u + 1
        h10 = u ** 3 - 2 * u * u + u
        h01 = -2 * u ** 3 + 3 * u * u
        h11 = u ** 3 - u * u
        return h00 * y[i] + h10 * h * s[i] + h01 * y[i + 1] + h11 * h * s[i + 1]


class Polyline(object):
    """Кусочно-линейная функция по снятой с чертежа полилинии."""

    def __init__(self, pts):
        pts = sorted(pts)
        self.x = [p[0] for p in pts]
        self.y = [p[1] for p in pts]

    def __call__(self, t):
        x, y = self.x, self.y
        if t <= x[0]:
            if len(x) == 1:
                return y[0]
            k = (y[1] - y[0]) / (x[1] - x[0])
            return y[0] + k * (t - x[0])
        if t >= x[-1]:
            if len(x) == 1:
                return y[0]
            k = (y[-1] - y[-2]) / (x[-1] - x[-2])
            return y[-1] + k * (t - x[-1])
        i = max(0, min(len(x) - 2, bisect.bisect_right(x, t) - 1))
        u = (t - x[i]) / (x[i + 1] - x[i])
        return y[i] + u * (y[i + 1] - y[i])
