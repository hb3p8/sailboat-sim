#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Развернуть манифест в каталог решателя: cfd/scripts/generate_case.py --case ...

Обёртка над `cfd/cfd.py case` — имя из §3.4 документа. Вся работа в cfd/lib/:
у `make` и у прямого вызова обязан быть один и тот же код.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from cfd.cfd import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["case"] + sys.argv[1:]))
