#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тройка сеток по сводкам: cfd/scripts/convergence.py [--family ...]

Обёртка над `cfd/cfd.py convergence` — имя из §3.4 документа. Сама оценка —
в cfd/lib/convergence.py, там же пороги §4.2.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from cfd.cfd import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["convergence"] + sys.argv[1:]))
