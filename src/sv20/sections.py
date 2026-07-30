"""Ф2: модель поперечного сечения — днище, скула, борт.

Первая версия описывала шпангоут одной кубической кривой от киля к линии борта.
Она не прошла проверку числами: при осадке корпусом 150 мм и длине по КВЛ
5469 мм такая форма выдаёт максимум ~435 кг вместо 590. Причина видна из
геометрии — единственная кубика не может одновременно держать длинное плоское
днище и высокий борт: управляющие точки тянут кривую вверх слишком рано, и
ватерлиния выходит вдвое уже нужного.

Чтобы посадить 590 кг на 150 мм осадки при ширине по палубе 2200 мм, борт
обязан ломаться примерно на уровне воды. Это не подгонка под цифру, а ровно то,
чего ждёшь от глиссирующего спортбота: плоское днище с малой килеватостью,
скула у ватерлинии, развалистый борт над ней.

Поэтому шпангоут теперь составной:

    K --- днище --- C --- борт --- S
    киль          скула        линия борта

Параметры:

    beta — килеватость: наклон днищевой панели у киля к горизонту, град.
    w    — положение скулы: её полуширота в долях полушироты линии борта.
           Высота скулы отсюда следует сама: zc = zk + w·ys·tg(beta).
    b0   — погибь днищевой панели: стрелка прогиба в долях её длины.
           Ноль — прямая панель, плюс — выпуклая наружу, минус — вогнутая.
    b1   — то же для бортовой панели.
    r    — скругление скулы в долях длины меньшей из панелей.
           Ноль — жёсткая скула, 0.5 — практически круглая.

Развал борта здесь не параметр, а следствие: угол определён тем, где лежит
скула и где линия борта. Это одним числом меньше и одной степенью свободы
меньше у оптимизатора.

Зависимостей нет.
"""

import math

# Пределы: за ними панели самопересекаются или шпангоут вырождается.
BOUNDS = {
    "beta": (1.0, 46.0),
    "w": (0.22, 0.96),
    "b0": (-0.06, 0.10),
    "b1": (-0.06, 0.12),
    "r": (0.0, 0.55),
}

SAMPLES = 72


def _quad(p0, p1, p2, t):
    u = 1.0 - t
    return (u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1])


def _bulged(a, b, bulge, n):
    """Квадратичная кривая от a к b со стрелкой прогиба `bulge`·|ab| наружу."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy)
    if L <= 0:
        return [a] * (n + 1)
    # нормаль наружу от ДП: панель выгибается в сторону увеличения Y
    nx, ny = dy / L, -dx / L
    if nx < 0:
        nx, ny = -nx, -ny
    off = 2.0 * bulge * L
    # На почти горизонтальной панели (нос, где шпангоут вырождается в полоску)
    # перпендикулярная стрелка легко перевешивает подъём панели и разворачивает
    # кривую вниз. Ограничиваем её долей этого подъёма — форма сохраняется,
    # монотонность по Z не ломается.
    if ny != 0 and abs(off * ny) > 0.4 * abs(dy):
        off = (0.4 * abs(dy) / abs(ny)) * (1.0 if off >= 0 else -1.0)
    mid = (0.5 * (a[0] + b[0]) + off * nx, 0.5 * (a[1] + b[1]) + off * ny)
    return [_quad(a, mid, b, i / float(n)) for i in range(n + 1)]


class Section(object):
    """Полушпангоут от ДП до линии борта, снятый в точки один раз при создании."""

    __slots__ = ("zk", "ys", "zs", "beta", "w", "b0", "b1", "r",
                 "chine", "pts", "_acc")

    def __init__(self, zk, ys, zs, beta, w, b0, b1, r):
        self.zk, self.ys, self.zs = zk, ys, zs
        self.beta, self.w, self.b0, self.b1, self.r = beta, w, b0, b1, r

        h = zs - zk
        if h < 20.0:
            # У самого форштевня шпангоут вырождается в полоску палубной кромки.
            # Панели и скула там не имеют смысла — просто отрезок.
            self.chine = (ys, zs)
            self.pts = [(ys * i / float(SAMPLES), zk + (zs - zk) * i / float(SAMPLES))
                        for i in range(SAMPLES + 1)]
            self._acc = None
            return

        yc = max(1.0, min(w, 0.99) * ys)
        rise = yc * math.tan(beta * math.pi / 180.0)
        zc = zk + min(rise, 0.85 * h)          # скула не может залезть на борт
        self.chine = (yc, zc)

        n = SAMPLES // 2
        bottom = _bulged((0.0, zk), (yc, zc), b0, n)
        topside = _bulged((yc, zc), (ys, zs), b1, n)
        self.pts = self._join(bottom, topside, r)
        self._acc = None

    @staticmethod
    def _join(bottom, topside, r):
        """Сшить панели, при r>0 подменив угол сопряжением с касанием."""
        if r <= 1e-4:
            return bottom + topside[1:]

        def seglen(pts):
            return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
                       for i in range(len(pts) - 1))

        d = r * min(seglen(bottom), seglen(topside)) * 0.5
        corner = bottom[-1]

        def trim(pts, from_end):
            """Отрезать участок длиной d от угла; вернуть остаток и точку стыка."""
            seq = list(reversed(pts)) if from_end else list(pts)
            acc = 0.0
            for i in range(len(seq) - 1):
                step = math.hypot(seq[i + 1][0] - seq[i][0], seq[i + 1][1] - seq[i][1])
                if acc + step >= d:
                    u = (d - acc) / step if step > 0 else 0.0
                    p = (seq[i][0] + u * (seq[i + 1][0] - seq[i][0]),
                         seq[i][1] + u * (seq[i + 1][1] - seq[i][1]))
                    rest = seq[i + 1:]
                    return (list(reversed(rest)) + [p] if from_end else [p] + rest), p
                acc += step
            return ([seq[-1]] if from_end else [seq[-1]]), seq[-1]

        b_rest, a = trim(bottom, True)
        t_rest, c = trim(topside, False)
        m = max(4, int(round(12 * r)) + 4)
        fillet = [_quad(a, corner, c, i / float(m)) for i in range(m + 1)]
        return b_rest[:-1] + fillet + t_rest[1:]

    # ---------------------------------------------------------------- выборка

    def _arc(self):
        if self._acc is None:
            acc = [0.0]
            p = self.pts
            for i in range(len(p) - 1):
                acc.append(acc[-1] + math.hypot(p[i + 1][0] - p[i][0],
                                                p[i + 1][1] - p[i][1]))
            self._acc = acc
        return self._acc

    def polyline(self):
        return self.pts

    def by_arclength(self, n=48):
        """n+1 точка, равномерно по длине дуги."""
        acc = self._arc()
        total = acc[-1]
        p = self.pts
        if total <= 0:
            return [p[0]] * (n + 1)
        out, j = [], 0
        for i in range(n + 1):
            target = total * i / float(n)
            while j < len(acc) - 2 and acc[j + 1] < target:
                j += 1
            span = acc[j + 1] - acc[j]
            u = 0.0 if span <= 0 else (target - acc[j]) / span
            out.append((p[j][0] + u * (p[j + 1][0] - p[j][0]),
                        p[j][1] + u * (p[j + 1][1] - p[j][1])))
        return out

    @property
    def flare_deg(self):
        """Развал борта — не параметр, а следствие положения скулы."""
        yc, zc = self.chine
        dy, dz = self.ys - yc, self.zs - zc
        return math.degrees(math.atan2(dy, dz)) if dz != 0 else 90.0

    # ---------------------------------------------------------- гидростатика

    def half_area_below(self, z_wl=0.0):
        """Погружённая площадь полушпангоута ниже уровня, мм²."""
        if self.zk >= z_wl:
            return 0.0
        area = 0.0
        p = self.pts
        prev = p[0]
        for cur in p[1:]:
            z0, z1 = prev[1], cur[1]
            if z0 >= z_wl:
                break
            if z1 > z_wl:
                u = (z_wl - z0) / (z1 - z0)
                cur = (prev[0] + u * (cur[0] - prev[0]), z_wl)
                z1 = z_wl
            area += 0.5 * (prev[0] + cur[0]) * (z1 - z0)
            prev = cur
            if z1 >= z_wl:
                break
        return area

    def half_beam_at(self, z_wl=0.0):
        if self.zk >= z_wl:
            return 0.0
        if self.zs <= z_wl:
            return self.ys
        p = self.pts
        prev = p[0]
        for cur in p[1:]:
            if prev[1] <= z_wl <= cur[1] and cur[1] != prev[1]:
                u = (z_wl - prev[1]) / (cur[1] - prev[1])
                return prev[0] + u * (cur[0] - prev[0])
            prev = cur
        return 0.0

    def girth_below(self, z_wl=0.0):
        if self.zk >= z_wl:
            return 0.0
        total = 0.0
        p = self.pts
        prev = p[0]
        for cur in p[1:]:
            if cur[1] > z_wl:
                if cur[1] != prev[1]:
                    u = (z_wl - prev[1]) / (cur[1] - prev[1])
                    cut = (prev[0] + u * (cur[0] - prev[0]), z_wl)
                    total += math.hypot(cut[0] - prev[0], cut[1] - prev[1])
                break
            total += math.hypot(cur[0] - prev[0], cur[1] - prev[1])
            prev = cur
        return total

    def is_sane(self):
        """Монотонность по Z и неотрицательность Y. На этом держатся интегралы."""
        p = self.pts
        for i in range(len(p) - 1):
            if p[i + 1][1] < p[i][1] - 1e-6 or p[i][0] < -1e-6:
                return False
        return self.ys > 0 and self.zs > self.zk
