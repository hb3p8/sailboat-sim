PY ?= python3
VENV := .venv/bin/python

.PHONY: all extract hull viewer export physics sim test slow all-tests fit clean

all: viewer export sim

# Стадии связаны файлами, а не именами. Раньше здесь стояли фиктивные цели, и
# `make test` каждый раз перегонял разбор чертежа, обводы и пакет — тридцать две
# секунды на то, что не менялось. Теперь пересобирается только устаревшее.
SRC := $(wildcard src/sv20/*.py)

FRAME := out/frame.json
HULL := out/hull.json
PACK := out/export/physics.json
MESH := out/export/sim_mesh.json

$(FRAME): scripts/extract.py $(SRC) data/raw/610.pdf
	$(PY) scripts/extract.py

$(HULL): scripts/build_hull.py $(SRC) $(FRAME) out/params.json
	$(PY) scripts/build_hull.py

$(PACK) $(MESH) &: scripts/build_physics.py $(SRC) $(FRAME) out/params.json
	$(PY) scripts/build_physics.py

sim/index.html: scripts/build_sim.py $(PACK) $(MESH) $(wildcard sim/*.js) sim/template.html
	$(PY) scripts/build_sim.py

extract: $(FRAME)

hull: $(HULL)

viewer: $(HULL)
	$(PY) scripts/build_viewer.py

# Ф6: отдельные тела и физический манифест в out/export/
export: $(HULL)
	$(PY) scripts/export.py

# Пакет для симулятора: GZ, гидростатика, инерции, сетки
physics: $(PACK)

sim: sim/index.html

# Физика проверяется без браузера: он мешает отличить расходимость модели
# от проблем отрисовки и не запускается из Makefile.
#
# Батареи разделены по стоимости, а не по теме. `make test` — то, что гоняют
# после каждой правки: устройство модели, воспроизводимость записи и ходовые
# качества на отдельных курсах, тридцать секунд. `make slow` — перебор настроек
# по всей поляре и по силе ветра, тысяча установившихся ходов, ещё пятьдесят.
#
# Правило простое: правил модель — гони `test`, собрался коммитить — `all-tests`.
# Отдельную батарею можно позвать по имени: `make t-wind`, `make t-upwind`.
FAST := membrane vlm waves wind replay physics
SLOW := upwind

.PHONY: $(addprefix t-,$(FAST) $(SLOW)) slow all-tests

$(addprefix t-,$(FAST) $(SLOW)): t-%:
	@node tests/$*.test.mjs

test: physics $(addprefix t-,$(FAST))

slow: physics $(addprefix t-,$(SLOW))

all-tests: test slow

# Ф3: оптимизатор, нужен scipy из .venv. Пишет out/params.json, который
# дальше автоматически подхватывает build_hull.
fit: extract
	$(VENV) scripts/fit_hull.py
	$(MAKE) all

clean:
	rm -rf out viewer/index.html sim/index.html src/sv20/__pycache__
