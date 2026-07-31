PY ?= python3
VENV := .venv/bin/python

.PHONY: all extract hull viewer export physics sim test fit clean

all: viewer export sim

extract:
	$(PY) scripts/extract.py

hull: extract
	$(PY) scripts/build_hull.py

viewer: hull
	$(PY) scripts/build_viewer.py

# Ф6: отдельные тела и физический манифест в out/export/
export: hull
	$(PY) scripts/export.py

# Пакет для симулятора: GZ, гидростатика, инерции, сетки
physics: hull
	$(PY) scripts/build_physics.py

sim: physics
	$(PY) scripts/build_sim.py

# Физика проверяется без браузера: он мешает отличить расходимость модели
# от проблем отрисовки и не запускается из Makefile.
test: physics
	node tests/wind.test.mjs
	node tests/physics.test.mjs
	node tests/upwind.test.mjs

# Ф3: оптимизатор, нужен scipy из .venv. Пишет out/params.json, который
# дальше автоматически подхватывает build_hull.
fit: extract
	$(VENV) scripts/fit_hull.py
	$(MAKE) all

clean:
	rm -rf out viewer/index.html sim/index.html src/sv20/__pycache__
