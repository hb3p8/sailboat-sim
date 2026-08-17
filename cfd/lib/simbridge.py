# -*- coding: utf-8 -*-
"""Питонья сторона моста к realtime-модели (§6).

Запросы копятся и уходят в node одним пакетом: запуск интерпретатора стоит
дороже, чем весь расчёт поляры внутри него.

Что здесь НЕ делается: формулы симулятора не повторяются. Ни одной. Как только
рядом с `hullResistance` появится её питонья копия, сравнение начнёт мерить
расхождение копии с оригиналом, а расхождение с CFD станет суммой двух.
"""

import json
import os
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BRIDGE = os.path.join(ROOT, "cfd", "bridge", "sim_query.mjs")
PACK = os.path.join(ROOT, "out", "export", "physics.json")


class BridgeError(RuntimeError):
    pass


def available():
    """Есть ли чем звать симулятор: node и собранный физический пакет."""
    if not os.path.exists(PACK):
        return False, "нет %s — сначала `make physics`" % os.path.relpath(PACK, ROOT)
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return False, "не найден node"
    return True, ""


def query(requests, node="node"):
    """Пакет запросов -> список ответов той же длины и того же порядка."""
    ok, why = available()
    if not ok:
        raise BridgeError(why)
    p = subprocess.run([node, BRIDGE], input=json.dumps(requests),
                       capture_output=True, text=True, cwd=ROOT)
    if p.returncode != 0:
        raise BridgeError("мост вернул %d: %s" % (p.returncode, p.stderr.strip()))
    try:
        out = json.loads(p.stdout)
    except ValueError:
        raise BridgeError("мост ответил не JSON: %s" % p.stdout[:400])
    if len(out) != len(requests):
        raise BridgeError("мост вернул %d ответов на %d запросов"
                          % (len(out), len(requests)))
    for q, a in zip(requests, out):
        if isinstance(a, dict) and "error" in a:
            raise BridgeError("запрос %s: %s" % (q.get("fn"), a["error"]))
    return out


def one(request, node="node"):
    return query([request], node)[0]


# --- перевод случая в запрос --------------------------------------------------

def request_for(m):
    """Какой вопрос задать симулятору для этого случая (§6, таблица семейств).

    Возвращает (запрос, что_сравнивать). Второе — список троек
    (имя, ключ в ответе симулятора, ключ в сводке CFD), по которым потом
    строится строка отчёта. Список нужен потому, что «сравнить» для поляры и
    для корпуса значит разное, а формат таблицы обязан быть один.
    """
    c, f = m["condition"], m["family"]
    if f == "sail-2d":
        return ({"fn": "polar", "alpha_deg": c.get("alpha_deg", 0.0),
                 "camber": c.get("camber", 0.1)},
                [("Cl", "cl", "Cl"), ("Cd", "cd", "Cd")])
    if f == "rig-3d":
        return ({"fn": "rig", "aws_ms": c.get("aws_ms", c.get("speed_ms")),
                 "awa_deg": c.get("awa_deg", 0.0),
                 "heel_deg": c.get("heel_deg", 0.0),
                 "sheet_deg": c.get("sheet_deg", 0.0),
                 "twist_deg": c.get("twist_deg", 0.0)},
                [("Fx", "fx_n", "Fx"), ("Fy", "fy_n", "Fy"),
                 ("Mx", "mx_nm", "Mx"), ("Mz", "mz_nm", "Mz"),
                 ("ЦП по высоте", "ce_z_m", "cop_z_m")])
    if f == "appendages":
        return ({"fn": "foilForce", "foil": c.get("body", "keel"),
                 "speed_ms": c["speed_ms"],
                 "leeway_deg": c.get("leeway_deg", 0.0),
                 "deflect_deg": c.get("rudder_deg", 0.0)},
                [("Fx", "fx", "Fx"), ("Fy", "fy", "Fy")])
    if f == "hull-resistance":
        return ({"fn": "hullResistance", "speed_ms": c["speed_ms"],
                 "heel_deg": c.get("heel_deg", 0.0)},
                [("Rt", "rt_n", "Rt_n")])
    if f == "hull-lateral":
        return ({"fn": "hullLateral", "speed_ms": c["speed_ms"],
                 "heel_deg": c.get("heel_deg", 0.0),
                 "leeway_deg": c.get("leeway_deg", 0.0),
                 "yaw_rate_nd": c.get("yaw_rate_nd", 0.0)},
                [("Fy", "fy_n", "Fy"), ("Mz", "mz_nm", "Mz")])
    if f == "waves":
        # §5, этап 6: добавочное сопротивление и RAO. В realtime-модели
        # отдельной функции для них пока нет, и выдумывать её здесь нельзя.
        return (None, [])
    if f == "verification":
        # Проверка инфраструктуры сравнивается не с симулятором, а с
        # опубликованным эталоном; он лежит рядом со случаем.
        return (None, [])
    raise BridgeError("для семейства %s не задан вопрос симулятору" % f)
