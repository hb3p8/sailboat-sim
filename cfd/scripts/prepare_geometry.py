#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Пересобрать геометрию выгрузки в CFD-оси: cfd/scripts/prepare_geometry.py

Обёртка над `cfd/cfd.py geometry`. Имя скрипта названо в §3.4 документа,
поэтому оно есть; работа же вся в одном месте, чтобы `make` и прямой вызов не
разошлись в поведении.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from cfd.cfd import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["geometry"] + sys.argv[1:]))
