#!/bin/sh
# Разовый внеочередной запуск решающего опыта. Не часть контура.
cd "$(dirname "$0")/../.."
.venv/bin/python cfd/cfd.py case --case keel-u200-a00-medium \
    --geometry out/cfd/geometry/keel-root --force
.venv/bin/python cfd/cfd.py run --case keel-u200-a00-medium \
    --geometry out/cfd/geometry/keel-root
.venv/bin/python cfd/cfd.py collect --run out/cfd/runs/keel-u200-a00-medium
