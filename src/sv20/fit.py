"""Ф3: подгонка обводов под гидростатику, форму и плавность.

Задача обратная: параметров 48, а прямых измерений подводной части нет ни
одного. Поэтому невязки собираются из трёх источников разного веса, и каждый
честно подписан, откуда он взялся:

    цели      — водоизмещение и осадка корпусом. Это данные: 590 кг серийной
                лодки и 150 мм из ТТХ конструктора. Вес наибольший.
    коридоры  — Cp, Cm, Cwp, положение ЦВ. Это не измерения, а рамка
                правдоподобия для спортбота такого размера. Штраф только за
                выход из коридора, внутри — ноль.
    плавность — изменение кривизны у кривой площадей и линии киля, вторые
                разности у законов формы. Без них оптимизатор находит формально
                верную, но бугристую поверхность: объём сойдётся, а обводы
                будут волнистыми.

Плюс два априорных условия на форму, которые для глиссирующего корпуса
выполняются практически всегда: килеватость растёт к носу, а скула к носу
поджимается. Оба заданы мягко.

Требует scipy (`.venv/bin/pip install scipy`).
"""

from . import hullmodel, hydro

# Коридоры правдоподобия: (нижняя, верхняя, масштаб невязки).
BANDS = {
    "Cp": (0.52, 0.62, 0.01),
    "Cm": (0.55, 0.80, 0.02),
    "Cwp": (0.68, 0.82, 0.02),
    "lcb_pct_lwl_from_aft": (44.0, 50.0, 1.0),
}

WEIGHTS = {
    "displacement": 1.0,     # масштаб 5 кг
    "draft": 1.0,            # масштаб 3 мм
    "band": 0.7,
    "fair_area": 0.5,
    "fair_law": 0.35,
    "fair_keel": 0.5,
    "prior": 0.6,
}

N_HYDRO = 48       # станций в гидростатике на каждом шаге оптимизатора
PENALTY = 50.0     # невязка на вырожденный шпангоут


def _hinge(value, lo, hi, scale):
    if value < lo:
        return (lo - value) / scale
    if value > hi:
        return (value - hi) / scale
    return 0.0


def _second_diff(values):
    return [values[i - 1] - 2.0 * values[i] + values[i + 1]
            for i in range(1, len(values) - 1)]


def _third_diff(values):
    """Изменение кривизны — то, что в судостроении и называют плавностью.

    Вторая разность штрафует саму кривизну, а килевая линия и кривая площадей
    обязаны быть кривыми: такой штраф тянул бы их к прямой и врал бы в отчёте,
    записывая законную кривизну в невязку. Третья разность оставляет дугу
    постоянной кривизны бесплатной и наказывает только за перегибы и волны.
    """
    return [values[i + 2] - 3.0 * values[i + 1] + 3.0 * values[i] - values[i - 1]
            for i in range(1, len(values) - 2)]


class Problem(object):
    """Невязки как функция вектора параметров."""

    def __init__(self, boundary, target_kg, draft_mm):
        self.b = boundary
        self.target_kg = target_kg
        self.draft_mm = draft_mm
        self.n_calls = 0
        self._probe_x = [boundary.x_stem * i / 24.0 for i in range(1, 24)]

    def hull(self, vec):
        return hullmodel.Hull(self.b, hullmodel.HullParams.from_vector(list(vec)))

    def residuals(self, vec):
        self.n_calls += 1
        hull = self.hull(vec)

        bad = sum(1 for x in self._probe_x if not hull.section(x).is_sane())
        if bad:
            return [PENALTY * bad] * self.size()

        h = hydro.hydrostatics(hull, 0.0, n=N_HYDRO)
        if h is None:
            return [PENALTY] * self.size()

        r = [
            WEIGHTS["displacement"] * (h["displacement_kg"] - self.target_kg) / 5.0,
            WEIGHTS["draft"] * (h["draft_canoe_mm"] - self.draft_mm) / 3.0,
        ]
        for key, (lo, hi, scale) in sorted(BANDS.items()):
            r.append(WEIGHTS["band"] * _hinge(h[key], lo, hi, scale))

        # Плавность кривой площадей: изменение кривизны, нормированное на
        # мидель. Площади берём те же, что уже посчитала гидростатика, — это
        # вдвое дешевле, чем строить шпангоуты второй раз на своей сетке.
        areas = [a for _, a in h["section_areas"]]
        amax = max(areas) or 1.0
        r += [WEIGHTS["fair_area"] * d / amax for d in _third_diff(areas)]

        # плавность самих законов формы
        p = hullmodel.HullParams.from_vector(list(vec))
        for name in hullmodel.SHAPE_LAWS:
            v = getattr(p, name)
            span = max(1e-6, max(v) - min(v))
            r += [WEIGHTS["fair_law"] * d / span for d in _second_diff(v)]

        # плавность линии киля по частой сетке, а не по контрольным точкам
        kx = [self.b.x_forefoot * i / 30.0 for i in range(31)]
        kz = [hull.z_keel(x) for x in kx]
        r += [WEIGHTS["fair_keel"] * d / 4.0 for d in _third_diff(kz)]

        # априорные условия: килеватость растёт к носу, скула поджимается
        for i in range(len(p.beta) - 1):
            r.append(WEIGHTS["prior"] * max(0.0, p.beta[i] - p.beta[i + 1]) / 2.0)
            r.append(WEIGHTS["prior"] * max(0.0, p.w[i + 1] - p.w[i]) / 0.02)

        return r

    def size(self):
        if not hasattr(self, "_size"):
            m = len(hullmodel.SHAPE_STATIONS)
            self._size = (2 + len(BANDS) + (N_HYDRO - 2)
                          + len(hullmodel.SHAPE_LAWS) * (m - 2)
                          + 28 + 2 * (m - 1))
        return self._size


def fit(boundary, start, target_kg, draft_mm, max_nfev=None, verbose=0):
    """Подогнать параметры. Возвращает (параметры, отчёт)."""
    try:
        from scipy.optimize import least_squares
    except ImportError:
        raise RuntimeError(
            "нужен scipy: python3 -m venv .venv && "
            ".venv/bin/pip install numpy scipy, затем запускать .venv/bin/python")

    prob = Problem(boundary, target_kg, draft_mm)
    x0 = start.to_vector()
    bounds = start.bounds()
    lo = [b[0] for b in bounds]
    hi = [b[1] for b in bounds]
    x0 = [min(max(v, l + 1e-9), u - 1e-9) for v, l, u in zip(x0, lo, hi)]

    # характерные величины: без них шаг по погиби (0.02) теряется рядом с
    # линией киля (100 мм), и якобиан выходит вырожденным
    n_keel = len(hullmodel.KEEL_STATIONS)
    n_shape = len(hullmodel.SHAPE_STATIONS)
    scale = [40.0] * n_keel
    for name in hullmodel.SHAPE_LAWS:
        typical = {"beta": 4.0, "w": 0.06, "b0": 0.02, "b1": 0.02, "r": 0.08}[name]
        scale += [typical] * n_shape

    res = least_squares(
        prob.residuals, x0, bounds=(lo, hi), x_scale=scale,
        # Допуски намеренно не жёсткие: шестого знака здесь хватает с запасом —
        # входные данные известны с точностью процента, — а на восьмом
        # оптимизатор долго бродит по плоскому дну без пользы для формы.
        diff_step=1e-2, xtol=1e-6, ftol=1e-6, gtol=1e-8,
        max_nfev=max_nfev or 1200, verbose=verbose)

    params = hullmodel.HullParams.from_vector(list(res.x))
    report = {
        "success": bool(res.success),
        "status": int(res.status),
        "message": str(res.message),
        "cost_start": float(0.5 * sum(v * v for v in prob.residuals(x0))),
        "cost_end": float(res.cost),
        "evaluations": int(prob.n_calls),
        "residuals": int(prob.size()),
        "parameters": len(x0),
    }
    return params, report


def breakdown(boundary, params, target_kg, draft_mm):
    """Разложить итоговую невязку по группам — чтобы видеть, кто чему мешает."""
    prob = Problem(boundary, target_kg, draft_mm)
    r = prob.residuals(params.to_vector())
    m = len(hullmodel.SHAPE_STATIONS)
    layout = [
        ("водоизмещение и осадка", 2),
        ("коридоры Cp/Cm/Cwp/ЦВ", len(BANDS)),
        ("плавность кривой площадей (изменение кривизны)", N_HYDRO - 2),
        ("плавность законов формы", len(hullmodel.SHAPE_LAWS) * (m - 2)),
        ("плавность линии киля (изменение кривизны)", 28),
        ("априорные условия формы", 2 * (m - 1)),
    ]
    out, i = [], 0
    for name, count in layout:
        chunk = r[i:i + count]
        out.append({"group": name, "terms": count,
                    "cost": 0.5 * sum(v * v for v in chunk)})
        i += count
    return out
