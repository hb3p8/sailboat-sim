PY ?= python3
VENV := .venv/bin/python

.PHONY: all extract hull viewer export fit clean

all: viewer export

extract:
	$(PY) scripts/extract.py

hull: extract
	$(PY) scripts/build_hull.py

viewer: hull
	$(PY) scripts/build_viewer.py

# Ф6: отдельные тела и физический манифест в out/export/
export: hull
	$(PY) scripts/export.py

# Ф3: оптимизатор, нужен scipy из .venv. Пишет out/params.json, который
# дальше автоматически подхватывает build_hull.
fit: extract
	$(VENV) scripts/fit_hull.py
	$(MAKE) all

clean:
	rm -rf out viewer/index.html src/sv20/__pycache__
