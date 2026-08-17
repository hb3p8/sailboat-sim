#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собрать силы и погрешность в сводку: cfd/scripts/collect_case.py --run ...

Обёртка над `cfd/cfd.py collect` — имя из §3.4 документа.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from cfd.cfd import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["collect"] + sys.argv[1:]))
