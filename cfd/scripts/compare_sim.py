#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сравнить сводки с realtime-моделью: cfd/scripts/compare_sim.py [--family ...]

Обёртка над `cfd/cfd.py compare` — имя из §3.4 документа. Сами вопросы к
симулятору задаются в cfd/lib/simbridge.py, а отвечает на них не питон, а node
теми же функциями, которыми считает лодка (§6).
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from cfd.cfd import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["compare"] + sys.argv[1:]))
