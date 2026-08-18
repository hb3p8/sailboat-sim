PY ?= python3
VENV := .venv/bin/python

.PHONY: all extract hull viewer export physics sim terrain terrain-pack terrain-glb crew sky serve test slow all-tests fit clean

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

# Небо. Исходник — Radiance HDR на пятнадцать мегабайт, в репозитории его нет
# (см. .gitignore): большой динамический диапазон нужен тому, кто светит этой
# картой сцену, а у нас светит аналитическое солнце. В сборку идут только
# перепакованная карта и положение солнца, снятое с неё же.
assets/sky.jpg assets/sky.json: scripts/build_sky.py assets/sky_clouds.hdr
	$(VENV) scripts/build_sky.py

sky: assets/sky.jpg

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
# качества на отдельных курсах. `make slow` — перебор настроек
# по всей поляре и по силе ветра, тысяча установившихся ходов, ещё пятьдесят.
#
# Правило: гоняются те батареи, которые правку ВИДЯТ, и в регрессионном режиме.
# Полный прогон (`--full`) и вся батарея — когда есть основания думать, что
# сломалось. Подробнее и почему именно так — в CLAUDE.md.
# Отдельную батарею можно позвать по имени: `make t-wind`, `make t-upwind`.
FAST := axes buoyancy membrane vlm waves ocean wind terrain replay physics sailcoeffs kernel
# Пелена в медленных: две сорокапятисекундные прогонки подряд, восемнадцать
# секунд. Проверка там при этом самая важная — что пелена не трогает силы.
SLOW := upwind wake wing
# Медленное на питоне: совместный вязко-невязкий расчёт, десятки секунд.
PYSLOW := coupled

# Батареи на питоне стоят особняком: они проверяют не симулятор, а то, что
# считается ДО него и уезжает в пакет. Поэтому и запускаются интерпретатором из
# .venv — им нужен numpy, которого системному питону никто не обещал.
PYTESTS := section bl panel milgram polar cfd

.PHONY: $(addprefix t-,$(FAST) $(SLOW) $(PYTESTS) $(PYSLOW)) slow all-tests

$(addprefix t-,$(FAST) $(SLOW)): t-%:
	@node tests/$*.test.mjs

$(addprefix t-,$(PYTESTS) $(PYSLOW)): t-%:
	@$(VENV) tests/$*.test.py

test: physics $(addprefix t-,$(PYTESTS)) $(addprefix t-,$(FAST))

slow: physics $(addprefix t-,$(PYSLOW)) $(addprefix t-,$(SLOW))

all-tests: test slow

# Кернел Био — Савара: wasm для симулятора, dylib для нативного замера.
#
# Тулчейн — llvm и lld из Homebrew, а НЕ системный clang: у эппловского нет
# wasm-бэкенда вовсе. Обе сборки идут с `-ffp-contract=off`, и это не
# перестраховка: без него clang на ARM сливает a*b+c в FMA, нативная сборка
# расходится с wasm (там инструкции FMA нет), и побитовая сверка перестаёт быть
# возможной. Проверяет её `make t-kernel`.
LLVM := /opt/homebrew/opt/llvm/bin
LLD  := /opt/homebrew/opt/lld/bin
CFLAGS_FP := -O3 -ffp-contract=off -fno-fast-math

.PHONY: kernel
kernel: sim/biotwasm.js kernel/biot.dylib kernel/lattice.wasm

# Блоб — ЧАСТЬ цели, а не отдельный шаг. Собранный .wasm без пересобранного
# блоба это симулятор со старым кернелом, и узнаётся это падением на не
# экспортированной функции, а не сообщением сборщика.
sim/biotwasm.js: kernel/biot.wasm kernel/lattice.wasm
	$(PY) scripts/wasm_blob.py

kernel/biot.wasm: kernel/biot.c kernel/vec.h
	PATH=$(LLVM):$(LLD):$$PATH $(LLVM)/clang --target=wasm32 $(CFLAGS_FP) -msimd128 \
	  -nostdlib -Wl,--no-entry -Wl,--export-dynamic -Wl,--initial-memory=16777216 \
	  -o $@ $<

kernel/lattice.wasm: kernel/lattice.c kernel/vec.h
	PATH=$(LLVM):$(LLD):$$PATH $(LLVM)/clang --target=wasm32 $(CFLAGS_FP) -msimd128 \
	  -nostdlib -Wl,--no-entry -Wl,--export-dynamic -Wl,--initial-memory=16777216 \
	  -o $@ $<

kernel/biot.dylib: kernel/biot.c
	$(LLVM)/clang $(CFLAGS_FP) -dynamiclib -o $@ $<

# Ф3: оптимизатор, нужен scipy из .venv. Пишет out/params.json, который
# дальше автоматически подхватывает build_hull.
fit: extract
	$(VENV) scripts/fit_hull.py
	$(MAKE) all

# Офлайн-контур CFD (docs/cfd-validation.md, cfd/README.md).
#
# В `all` и в `test` расчёт не входит и войти не может: один случай корпуса —
# это десятки миллионов ячеек и часы на чужой машине. В `test` входит только
# батарея `t-cfd`, которая проверяет всё вокруг решателя за полсекунды.
#
# Цели — однострочные обёртки: §3.6 требует, чтобы то же самое работало и без
# make, а на счётной машине его может не быть вовсе.
.PHONY: cfd-validate cfd-image cfd-geometry cfd-case cfd-run cfd-collect \
        cfd-slices cfd-queue cfd-convergence cfd-compare cfd-report cfd-html

CFD := $(VENV) cfd/cfd.py

cfd-validate:
	@$(CFD) validate

# Образ решателя. Собирается редко, а digest из него уходит в каждый манифест:
# закреплённый тег через полгода означает другую версию решателя, и расхождение
# с эталоном спишут на физику (§3.1).
cfd-image:
	docker build -t sv20-openfoam:2306 cfd/images
	@echo "digest в манифесты брать отсюда:"
	@docker inspect --format='{{index .RepoDigests 0}}' sv20-openfoam:2306 \
	  || echo "  образ ещё не отправлен в registry — digest появится после push"

# Геометрия в связанных осях CFD плюс канонические тела этапа 0.
cfd-geometry: export
	@$(CFD) geometry --canonical

cfd-case:
	@$(CFD) case --case $(CASE) --force

cfd-run:
	@$(CFD) run --case $(CASE) --runner $(or $(RUNNER),local)

cfd-collect:
	@$(CFD) collect --run $(RUN)

# Поля на плоскостях для картинок в отчёте. Отдельной целью и ПОСЛЕ расчёта:
# функция-объект писала бы только то, о чём её попросили заранее, а `postProcess`
# режет уже сохранённые поля — в том числе у случая, посчитанного неделю назад.
cfd-slices:
	@$(CFD) slices --run $(RUN)

# Очередь: развернуть, посчитать и собрать сводку по каждому случаю ПО ОДНОМУ.
# Один за другим, а не разом: OpenFOAM берёт столько ядер, сколько ему велено,
# и два случая по четыре процесса на десяти ядрах идут не вдвое быстрее, а
# втрое медленнее каждый.
cfd-queue:
	@$(VENV) cfd/scripts/queue.py $(if $(ONLY),--only $(ONLY),)

cfd-convergence:
	@$(CFD) convergence $(if $(FAMILY),--family $(FAMILY),)

cfd-compare: physics
	@$(CFD) compare $(if $(FAMILY),--family $(FAMILY),)

cfd-report: physics
	@$(CFD) report $(if $(FAMILY),--family $(FAMILY),)

# HTML-отчёт: один самодостаточный файл с графиками и полями течения.
# Открывается двойным щелчком, в сеть не ходит.
cfd-html: physics
	@$(CFD) html $(if $(OUT),--out $(OUT),)

# data/terrain/ не трогается: это кэш скачанного, а не результат сборки.
clean:
	rm -rf out viewer/index.html viewer/terrain.html sim/index.html \
	       src/sv20/__pycache__
