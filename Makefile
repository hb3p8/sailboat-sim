PY ?= python3
VENV := .venv/bin/python

.PHONY: all extract hull viewer fit clean

all: viewer

extract:
	$(PY) scripts/extract.py

hull: extract
	$(PY) scripts/build_hull.py

viewer: hull
	$(PY) scripts/build_viewer.py

# Ф3: оптимизатор, нужен scipy из .venv. Пишет out/params.json, который
# дальше автоматически подхватывает build_hull.
fit: extract
	$(VENV) scripts/fit_hull.py
	$(MAKE) viewer

clean:
	rm -rf out viewer/index.html src/sv20/__pycache__
