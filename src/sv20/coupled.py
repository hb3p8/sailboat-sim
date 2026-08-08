# -*- coding: utf-8 -*-
"""Совместный вязко-невязкий расчёт сечения через транспирацию.

Зачем. Невязкий расчёт (`panel.py`) даёт подъёмную силу заметно выше измеренной:
у изогнутой пластины с пузом 8% на нулевом угле опыт даёт 0.68 от теории тонкого
профиля, у 12% — 0.66 (Уоллис 1946 и Милгрэм 1971, независимо друг от друга).
Часть этого недобора — вязкое РАСКАМБЕРИВАНИЕ: пограничный слой к задней кромке
толстеет, наружный поток видит тело толще и «менее изогнутым», чем оно есть, и
циркуляция падает. Прямой расчёт (`bl.py`) этого не видит вовсе — он читает поле
и на поле не влияет.

Здесь связь замыкается. Приём стандартный и называется транспирацией: слой
оттесняет наружный поток на толщину вытеснения δ*, и это в точности равносильно
тому, что тело выдувает сквозь поверхность со скоростью

    v = d(U_e·δ*)/ds

Панельный метод такое условие принимает без переделок — меняется только правая
часть. Дальше итерации с недорелаксацией: поле → слой → выдув → поле.

Чего этим НЕ взять, и это надо знать заранее. Прямой марш слоя не имеет решения
за точкой отрыва (особенность Гольдштейна), поэтому сходится только режим с
прилипшим потоком. Значит область применения — линейный участок и подход к
срыву; ни Cl_max, ни поведение за срывом отсюда не выйдут. Ради Cl_max нужна
полуобратная или совместная постановка, как у Дрелы, и это отдельная работа.

Следа за задней кромкой здесь тоже нет: выдув ставится только на самом обводе.
След добавляет к раскамбериванию свою долю, так что полученное здесь падение
подъёмной силы — оценка СНИЗУ.
"""

import numpy as np

from .bl import head, thwaites
from .panel import Panels, sail_contour

__all__ = ["couple", "CoupledResult"]


class CoupledResult:
    """Итог совместного расчёта: коэффициенты, сходимость и распределения."""

    def __init__(self, **kw):
        self.__dict__.update(kw)

    def __repr__(self):
        return ("<совместный: Cl=%.4f (невязкий %.4f, %.1f%%), невязка %.2e, "
                "итераций %d, %s>"
                % (self.cl, self.cl_inviscid, 100 * self.cl / self.cl_inviscid,
                   self.residual, self.iters,
                   'сошёлся' if self.converged else 'НЕ сошёлся'))


def _side_blow(s, ue, nu, s_tr, prev_theta=None):
    """Толщина вытеснения и выдув вдоль одной стороны.

    Ламинарный кусок по Твейтсу, дальше по Хеду — тот же марш, что и в `bl.py`,
    но здесь нужны сами распределения, а не только точка отрыва.
    """
    itr = max(int(np.searchsorted(s, s_tr)), 2)
    itr = min(itr, s.size - 2)
    th_l, h_l, _, lam, sep_l = thwaites(s[:itr + 1], ue[:itr + 1], nu)
    if sep_l is not None and sep_l >= 2:
        itr = sep_l
        th_l, h_l, _, lam, _ = thwaites(s[:itr + 1], ue[:itr + 1], nu)
    th_t, h_t, _, sep_t = head(s[itr:], ue[itr:], nu, theta0=th_l[-1], h0=1.4)
    th = np.concatenate((th_l, th_t[1:]))
    hh = np.concatenate((h_l, h_t[1:]))
    # За отрывом марш обрывается и дальше идут NaN. Их надо чем-то закрыть, иначе
    # выдув станет нечислом и решение развалится молча. Закрываются последним
    # осмысленным значением: это не физика, это признак, что мы вышли за область
    # применимости, и наружу он выносится флагом `separated`.
    bad = ~np.isfinite(th)
    if bad.any():
        good = np.flatnonzero(~bad)
        last = good[-1] if good.size else 0
        th[bad] = th[last]
        hh[bad] = hh[last]
    # Два ограничителя, и оба — признаки выхода за область применимости, а не
    # физика. Первый: толщина вытеснения не может быть в разы больше хорды —
    # у самого отрыва явный марш успевает выдать и такое за один шаг. Второй:
    # выдув в полскорости набегающего потока означает, что тела уже нет, и
    # итерация всё равно ничего осмысленного не даст. Оба выносятся наружу
    # флагом, чтобы результат нельзя было принять за сошедшийся.
    dstar = np.minimum(hh * th, 0.05)
    m = ue * dstar                       # дефект массы
    v = np.gradient(m, s)
    clipped = bool(np.any(np.abs(v) > 0.2))
    return dstar, np.clip(v, -0.2, 0.2), bool(bad.any()) or clipped, int(itr)


def couple(f=0.08, p=0.5, t=0.02, alpha=0.0, re=6e5, n=300,
           s_tr=0.03, relax=0.15, iters=200, tol=1e-5, nose=None, contour=None):
    """Прогнать итерации поле ↔ слой до сходимости.

    `relax` — недорелаксация выдува. Без неё итерации расходятся: выдув меняет
    поле, поле меняет выдув, и петля идёт вразнос. 0.15 подобрано так, чтобы
    сходилось на всех пузах до десяти процентов; медленнее, зато без надзора.
    """
    x, y = contour if contour is not None else sail_contour(f=f, p=p, t=t, n=n, nose=nose)
    pan = Panels(x, y)
    nu = 1.0 / re
    blow = np.zeros(pan.n)
    cl_inv = None
    hist = []
    separated = False
    for it in range(iters):
        pan.solve(alpha, blow=blow)
        if cl_inv is None:
            cl_inv = pan.cl                      # первая итерация — чисто невязкая
        (sb, ub, ib), (sf, uf, iff) = pan.sides(with_index=True)
        new = np.zeros(pan.n)
        sep = False
        for s_, u_, idx in ((sb, ub, ib), (sf, uf, iff)):
            if s_.size < 6:
                continue
            _, v, bad, _ = _side_blow(s_, np.maximum(u_, 1e-6), nu, s_tr)
            new[idx] = v
            sep = sep or bad
        separated = sep
        step = float(np.max(np.abs(new - blow)))
        blow = (1 - relax) * blow + relax * new
        hist.append(step)
        if step < tol:
            break
    pan.solve(alpha, blow=blow)
    return CoupledResult(cl=pan.cl, cl_inviscid=cl_inv, panels=pan, blow=blow,
                         residual=hist[-1] if hist else 0.0, iters=len(hist),
                         converged=bool(hist and hist[-1] < tol * 20),
                         separated=separated, history=hist)
