# -*- coding: utf-8 -*-
"""Разбор истории сил решателя и статистика по окну усреднения (§3.7, §4.3).

Главное правило раздела: сошедшиеся residuals не означают сошедшихся сил.
Residuals меряют, насколько решатель доволен собой на текущей сетке; сила —
единственное, что мы потом сравниваем с симулятором. Поэтому каждая величина
отдаётся не числом, а числом с окном, разбросом и признаком дрейфа: среднее по
окну, на котором сила монотонно ползёт, ничего не значит, и отчёт обязан это
показывать, а не прятать.
"""

import math
import os
import re

import numpy as np


# --- чтение -------------------------------------------------------------------

def _numbers(line):
    return [float(x) for x in re.findall(r"[-+0-9.eE]+", line.replace("(", " ")
                                         .replace(")", " ")) if _isnum(x)]


def _isnum(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


def read_dat(path):
    """`force.dat` / `moment.dat` любого из форматов OpenFOAM.

    Форматы разных версий отличаются числом групп в строке: сумма отдельно,
    сумма с давлением и вязкостью, иногда ещё пористость. Разбирается по числу
    столбцов, а не по версии решателя: версия записана в манифесте образа, но
    файл читается и от чужого расчёта тоже.
    """
    t, groups = [], []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.lstrip().startswith("#"):
                continue
            v = _numbers(line)
            if len(v) < 4:
                continue
            t.append(v[0])
            groups.append(v[1:])
    if not t:
        raise ValueError("%s: нет ни одной строки данных" % path)
    n = min(len(g) for g in groups)
    n -= n % 3
    arr = np.asarray([g[:n] for g in groups], dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)
    ng = n // 3
    if ng == 1:
        total, pressure, viscous = arr, None, None
    elif ng == 2:
        # Старый формат: давление и вязкость, суммы нет.
        pressure, viscous = arr[:, 0:3], arr[:, 3:6]
        total = pressure + viscous
    else:
        total, pressure, viscous = arr[:, 0:3], arr[:, 3:6], arr[:, 6:9]
    return {"t": t, "total": total, "pressure": pressure, "viscous": viscous}


def read_run(post_dir, name="forces"):
    """Все временные каталоги одной функции-объекта, склеенные по времени.

    OpenFOAM после перезапуска заводит новый каталог со временем старта, и
    куски перекрываются. Склейка идёт по возрастанию времени с выбрасыванием
    повторов: иначе окно усреднения посчитает один и тот же кусок дважды.
    """
    root = os.path.join(post_dir, name)
    if not os.path.isdir(root):
        raise ValueError("нет каталога %s" % root)
    parts = []
    for sub in sorted(os.listdir(root), key=_as_float):
        d = os.path.join(root, sub)
        if not os.path.isdir(d):
            continue
        f = _first_of(d, ("force.dat", "forces.dat"))
        m = _first_of(d, ("moment.dat", "moments.dat"))
        if not f:
            continue
        parts.append((read_dat(f), read_dat(m) if m else None))
    if not parts:
        raise ValueError("в %s нет ни force.dat, ни forces.dat" % root)
    return {"force": _concat([p[0] for p in parts]),
            "moment": _concat([p[1] for p in parts if p[1]]) if parts[0][1] else None}


def _as_float(s):
    try:
        return float(s)
    except ValueError:
        return math.inf


def _first_of(d, names):
    for n in names:
        p = os.path.join(d, n)
        if os.path.exists(p):
            return p
    return None


def _concat(series):
    t = np.concatenate([s["t"] for s in series])
    order = np.argsort(t, kind="stable")
    t = t[order]
    keep = np.concatenate([[True], np.diff(t) > 0])
    out = {"t": t[keep]}
    for k in ("total", "pressure", "viscous"):
        if series[0][k] is None:
            out[k] = None
            continue
        a = np.concatenate([s[k] for s in series])[order][keep]
        out[k] = a
    return out


# --- окно и статистика --------------------------------------------------------

def window(t, start=None, frac=0.5):
    """Индексы окна усреднения.

    Без явного `start` берётся хвост длиной `frac` от всего расчёта. Это
    умолчание, а не измерение: настоящее начало окна выбирается по исчезновению
    начального перехода и записывается в манифест (`numerics.average_from`).
    Умолчание существует только чтобы черновой прогон вообще что-то показал.
    """
    if start is None:
        start = t[0] + (1.0 - frac) * (t[-1] - t[0])
    idx = np.nonzero(t >= start)[0]
    if len(idx) < 2:
        idx = np.arange(max(0, len(t) - 2), len(t))
    return idx, float(start)


def stats(t, x, start=None, frac=0.5):
    """Среднее, разброс, размах и дрейф одной компоненты на окне.

    `drift` — во сколько раз линейный тренд по окну больше самого разброса.
    Величина безразмерная и нарочно сравнивается не со средним: у боковой силы
    на нулевом дрейфе среднее близко к нулю, и любая нормировка на него даёт
    бесконечность там, где всё в порядке.
    """
    idx, start = window(t, start, frac)
    tw, xw = t[idx], np.asarray(x)[idx]
    mean = float(xw.mean())
    std = float(xw.std(ddof=1)) if len(xw) > 1 else 0.0
    span = tw[-1] - tw[0]
    slope = 0.0
    if len(xw) > 2 and span > 0:
        slope = float(np.polyfit(tw, xw, 1)[0])
    trend = abs(slope) * span
    # Порог, ниже которого тренд не считается дрейфом вовсе.
    #
    # Дрейф сравнивается с разбросом, но у почти постоянной силы разброс —
    # это уже не физика, а последний разряд записи. Решатель пишет силы с
    # восемью знаками; на установившемся режиме и тренд, и разброс садятся в
    # это квантование, их отношение становится случайным числом порядка
    # единицы, и совершенно сошедшийся случай объявляется дрейфующим.
    # Обе версии этого порога — сначала машинное эпсилон, потом миллионная
    # доля — поставила батарея, а не соображения: сначала «постоянная сила
    # дрейфует бесконечно», потом «сошедшаяся тройка не проходит ворота».
    #
    # Миллионная доля от самой величины заведомо ниже любого дрейфа, который
    # что-то значит для сравнения с симулятором, и заведомо выше квантования.
    floor = 1e-6 * max(abs(mean), 1.0)
    return {
        "mean": mean, "std": std,
        "rms": float(np.sqrt(np.mean((xw - mean) ** 2))),
        "min": float(xw.min()), "max": float(xw.max()),
        "range": float(xw.max() - xw.min()),
        "slope_per_s": slope,
        "trend_over_window": trend,
        "drift": (0.0 if trend <= floor
                  else (trend / std if std > floor else math.inf)),
        "window": [float(tw[0]), float(tw[-1])],
        "window_start": start,
        "samples": int(len(xw)),
    }


def dominant_frequency(t, x, start=None, frac=0.5):
    """Основная частота колебаний на окне, Гц, и её доля в мощности.

    Нужна для §4.3: случай с заметной периодикой обязан хранить не только
    среднее. Ряд решателя неравномерен по времени (шаг плавает по Куранту),
    поэтому перед спектром он пересаживается на равномерную сетку.
    """
    idx, _start = window(t, start, frac)
    tw, xw = t[idx], np.asarray(x)[idx]
    if len(tw) < 8 or tw[-1] <= tw[0]:
        return {"hz": None, "power_fraction": None}
    n = len(tw)
    te = np.linspace(tw[0], tw[-1], n)
    xe = np.interp(te, tw, xw)
    xe = xe - xe.mean()
    if not np.any(xe):
        return {"hz": 0.0, "power_fraction": 0.0}
    sp = np.abs(np.fft.rfft(xe * np.hanning(n))) ** 2
    freq = np.fft.rfftfreq(n, d=(te[1] - te[0]))
    k = int(np.argmax(sp[1:]) + 1)
    total = float(sp[1:].sum())
    return {"hz": float(freq[k]),
            "power_fraction": float(sp[k] / total) if total > 0 else 0.0}


def summarise(series, start=None, frac=0.5, labels=("Fx", "Fy", "Fz")):
    """Полная сводка по трём компонентам одной величины."""
    t = series["t"]
    out = {}
    for i, name in enumerate(labels):
        s = stats(t, series["total"][:, i], start, frac)
        s["frequency"] = dominant_frequency(t, series["total"][:, i], start, frac)
        for part in ("pressure", "viscous"):
            if series.get(part) is not None:
                s[part] = float(np.asarray(series[part])[window(t, start, frac)[0], i].mean())
        out[name] = s
    return out


# --- residuals ----------------------------------------------------------------

_RES = re.compile(r"Solving for (\w+), Initial residual = ([-+0-9.eE]+)")


def read_residuals(log_path, keys=None):
    """История начальных невязок из лога решателя.

    Читается лог, а не `postProcessing/residuals`: функция-объект невязок
    включена не во всех шаблонах, а лог есть всегда. История нужна не сама по
    себе, а чтобы отличить «сошлось» от «остановлено по числу итераций».
    """
    hist = {}
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = _RES.search(line)
            if not m:
                continue
            k, v = m.group(1), float(m.group(2))
            if keys and k not in keys:
                continue
            hist.setdefault(k, []).append(v)
    return {k: {"first": v[0], "last": v[-1], "min": min(v), "steps": len(v)}
            for k, v in hist.items()}


_CONT = re.compile(r"time step continuity errors : sum local = ([-+0-9.eE]+), "
                   r"global = ([-+0-9.eE]+), cumulative = ([-+0-9.eE]+)")


def read_continuity(log_path):
    """Баланс массы: последняя накопленная невязка неразрывности (§4.2)."""
    last = None
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = _CONT.search(line)
            if m:
                last = {"sum_local": float(m.group(1)),
                        "global": float(m.group(2)),
                        "cumulative": float(m.group(3))}
    return last


_CELLS = re.compile(r"^\s*cells:\s*(\d+)")
_NONORTHO = re.compile(r"Max non-orthogonality = ([-+0-9.eE]+)")
_SKEW = re.compile(r"Max skewness = ([-+0-9.eE]+)")
_ASPECT = re.compile(r"Max aspect ratio = ([-+0-9.eE]+)")


def read_mesh_stats(log_path):
    """Число ячеек и качество сетки из лога `checkMesh` (§3.7).

    Число ячеек — не украшение отчёта: по нему считается отношение сгущения в
    оценке сеточной сходимости. Без него тройка сеток превращается в три
    несравнимых расчёта.
    """
    out = {}
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            for key, rx in (("cells", _CELLS), ("max_non_ortho", _NONORTHO),
                            ("max_skewness", _SKEW), ("max_aspect", _ASPECT)):
                m = rx.search(line)
                if m:
                    v = float(m.group(1))
                    out[key] = int(v) if key == "cells" else v
            if "Mesh OK" in line:
                out["mesh_ok"] = True
            if "Failed" in line and "mesh checks" in line:
                out["mesh_ok"] = False
    return out


_YPLUS = re.compile(r"[Yy]\+ .*min: ([-+0-9.eE]+) max: ([-+0-9.eE]+) "
                    r"average: ([-+0-9.eE]+)")


def read_yplus(log_path):
    """Диапазон y+ из лога `yPlus`. Последняя запись — на сошедшемся поле."""
    last = None
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = _YPLUS.search(line)
            if m:
                last = {"min": float(m.group(1)), "max": float(m.group(2)),
                        "avg": float(m.group(3))}
    return last
