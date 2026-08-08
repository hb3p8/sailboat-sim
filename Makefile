PY ?= python3
VENV := .venv/bin/python

.PHONY: all extract hull viewer export physics sim terrain terrain-pack terrain-glb crew serve test slow all-tests fit clean

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

# Пакет акватории собирается из выгрузки (`make terrain`) и в сборку страницы
# входит необязательно: `wildcard` подставит его, только если он есть. Без него
# страница собирается и работает — лодка ходит по бесконечной воде.
TERRAIN_PACK := out/export/terrain_pack.json

$(TERRAIN_PACK): scripts/build_terrain_pack.py out/terrain.json
	$(VENV) scripts/build_terrain_pack.py

terrain-pack: $(TERRAIN_PACK)

# Карта для отрисовки — отдельным жатым файлом, а не вклейкой в страницу: она
# одна и та же от запуска к запуску, и строить её каждый раз в браузере значит
# платить за это и весом, и паузой на открытии. Заодно из неё выброшен покров,
# которого с воды не видно, — подробности в заголовке скрипта.
TERRAIN_GLB := assets/terrain.glb

$(TERRAIN_GLB): scripts/build_terrain_glb.py $(TERRAIN_PACK)
	$(VENV) scripts/build_terrain_glb.py

terrain-glb: $(TERRAIN_GLB)

sim/index.html: scripts/build_sim.py $(PACK) $(MESH) $(wildcard sim/*.js) \
                sim/template.html $(wildcard $(TERRAIN_PACK))
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

# Реальная речная акватория: рельеф Copernicus DEM и берег OSM. В `all` не
# входит нарочно — цель ходит в сеть, а сборка проекта обязана собираться и без
# неё. Скачанное оседает в data/terrain/ и переиспользуется, так что повторная
# сборка укладывается в полсекунды. Нужен numpy со scipy и pillow, то есть
# .venv, а не системный python.
out/terrain.json: scripts/build_terrain.py src/sv20/terrain.py
	$(VENV) scripts/build_terrain.py

viewer/terrain.html: scripts/build_terrain_viewer.py out/terrain.json \
                     viewer/terrain.js viewer/terrain_tools.js sim/terrain.js \
                     viewer/terrain_template.html
	$(VENV) scripts/build_terrain_viewer.py

terrain: viewer/terrain.html

# Фигурка экипажа: тринадцать мегабайт исходника в сто килобайт ассета. В `all`
# не входит: исходник в репозитории не лежит (велик), а результат лежит и меняться
# ему незачем. Нужен pillow с numpy, то есть .venv, и npx для Draco.
assets/crew.glb: scripts/build_crew.py models/lego_sailor.glb
	$(VENV) scripts/build_crew.py

crew: assets/crew.glb

# Локальный сервер. Нужен просмотрщику акватории: поля физики он читает по
# частям, а разметку пишет обратно на диск, и ни того, ни другого `file://` не
# позволяет. Симулятор как открывался двойным кликом, так и открывается.
serve: viewer/terrain.html $(TERRAIN_PACK)
	$(PY) scripts/serve.py

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
FAST := axes buoyancy membrane vlm waves ocean wind terrain replay physics sailcoeffs
SLOW := upwind

# Батареи на питоне стоят особняком: они проверяют не симулятор, а то, что
# считается ДО него и уезжает в пакет. Поэтому и запускаются интерпретатором из
# .venv — им нужен numpy, которого системному питону никто не обещал.
PYTESTS := section bl panel milgram

.PHONY: $(addprefix t-,$(FAST) $(SLOW) $(PYTESTS)) slow all-tests

$(addprefix t-,$(FAST) $(SLOW)): t-%:
	@node tests/$*.test.mjs

$(addprefix t-,$(PYTESTS)): t-%:
	@$(VENV) tests/$*.test.py

test: physics $(addprefix t-,$(PYTESTS)) $(addprefix t-,$(FAST))

slow: physics $(addprefix t-,$(SLOW))

all-tests: test slow

# Ф3: оптимизатор, нужен scipy из .venv. Пишет out/params.json, который
# дальше автоматически подхватывает build_hull.
fit: extract
	$(VENV) scripts/fit_hull.py
	$(MAKE) all

# data/terrain/ не трогается: это кэш скачанного, а не результат сборки.
clean:
	rm -rf out viewer/index.html viewer/terrain.html sim/index.html \
	       src/sv20/__pycache__
