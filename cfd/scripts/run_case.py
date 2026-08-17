#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Посчитать случай: cfd/scripts/run_case.py --case ... [--runner ...]

Обёртка над `cfd/cfd.py run` — имя из §3.4 документа.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from cfd.cfd import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["run"] + sys.argv[1:]))
