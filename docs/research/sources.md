# Источники и доступность данных

Ссылки перенесены из исследований проекта до 2026-09-27; это реестр происхождения,
а не новое подтверждение доступности внешних сайтов. Внешняя публикация не
означает, что её исходные CAD, измерения или выкройка получены проектом.

## Основные данные проекта

- `data/raw/610.pdf` — чертёж проекта «610»; отличается по году и части параметров от серийной SV20.
- `data/sail/` — оцифрованные силы/геометрия; источник и ограничение хранятся в самих таблицах.
- `data/sail/asymmetrics_geometry.json` — пропорции обмеренных асимметричных парусов.
- `data/sail/deparday_j80_2016.json` — геометрия измеренного J/80; не раскрой SV20.
- Сведения владельца — вылет бушприта и отдельные наблюдения; это не полный синхронный контрольный ряд.
- OpenStreetMap и Copernicus DEM — берег/рельеф; не промеры речного дна.
- [Видеоисточник](../../data/video/SOURCES.md) — автор, идентификатор и информация о лицензии.

Локальные статьи в `pdfs/` могут присутствовать в рабочей копии, но не являются
обязательной поставкой репозитория. Ссылки на публичные публикации приведены ниже.

## Ключевые ограничения переноса

Измеренная летящая форма не задаёт единственную ненагруженную выкройку.
Чужие абсолютные силы, частоты и оптимальные настройки не становятся целями SV20.
Для сравнений сопоставляйте станции, координаты, форму, размер, число Reynolds,
нормировку и условия измерения. Указывайте, получен ли полный материал или только описание.

## Первичные сведения о яхте

- [Проект 610, Tihonov Yacht Design](http://tihonovdesign.ru/610/610_r.html) — чертёж и ТТХ
- [Ракета 610 (SV20), ВФПС](https://www.parusniy-sport.org/klassy-yacht-kilevye/raketa610)
- [SV20, «Сила ветра»](https://silavetra.com/magazine/sv20)
- [SV20 в магазине «Силы ветра»](https://shop.silavetra.com/product/yahta-sv20) — ТТХ серийной лодки

## Публикации, методики и практические инструменты

- [Kim, Chentanez, Müller, Long Range Attachments (2012), §3.2](https://matthias-research.github.io/pages/publications/sca2012cloth.pdf) — различие пространственной хорды и пути вдоль исходной ткани. Текст проверен 2026-10-01; применение и границы — в [исследовании механики](cloth-pressure.md).
- [Macklin, Müller, Chentanez, XPBD (2016), §3–4](https://mmacklin.com/xpbd.pdf) — заданная энергия и накопленный множитель податливой связи; ограничения простой доли исправления за проход. Повторно проверено 2026-10-01; [контроль и границы переноса](cloth-pressure.md).

Названия исходных записей ниже относятся к ревизии `c66ca9c`; восстановление
и новые места описаны в [индексе истории](history.md).

- [OpenFOAM `interFoam`: VOF, несжимаемые двухфазные течения и турбулентность](https://doc.openfoam.com/2306/tools/processing/solvers/rtm/multiphase/interFoam/). Исходная запись: `cfd-validation.md`.
- [OpenFOAM: верификационный случай NACA 0012](https://doc.openfoam.com/2306/examples/verification-validation/turbulent/naca0012/). Исходная запись: `cfd-validation.md`.
- [SU2: несжимаемый RANS и модели турбулентности](https://su2code.github.io/docs_v7/Theory/). Исходная запись: `cfd-validation.md`.
- [NASA: пример анализа сеточной сходимости RANS](https://turbmodels.larc.nasa.gov/NACA0012numerics_val/NASA-TM-2018-220106-Atkins-convergenceanalysis.pdf). Исходная запись: `cfd-validation.md`.
- [DualSPHysics: назначение и возможности SPH](https://dual.sphysics.org/features/). Исходная запись: `cfd-validation.md`.
- [Milgram, NASA CR-1767](https://ntrs.nasa.gov/api/citations/19710020417/downloads/19710020417.pdf). Исходная запись: `cfd-validation.md`.
- [10.1016/j.oceaneng.2016.09.043](https://doi.org/10.1016/j.oceaneng.2016.09.043). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [10.1016/j.oceaneng.2014.07.023](https://doi.org/10.1016/j.oceaneng.2014.07.023). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [10.3940/rina.ijsct.2009.b2.98](https://doi.org/10.3940/rina.ijsct.2009.b2.98). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [официальное руководство, §§7 и 9](https://www.sailcut.org/handbook/en/). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [DOI 10.1016/j.cad.2004.09.006](https://doi.org/10.1016/j.cad.2004.09.006). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [первичная публикация](https://content.yudu.com/web/60wf/0A1pccv/IJSCTB22017/html/5.html). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [DOI 10.3940/rina.ijsct.2017.b2.199](https://doi.org/10.3940/rina.ijsct.2017.b2.199). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [адрес набора данных](https://fluidengineeringsolutions.com/downwindsailvalidationdata/). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Ранняя работа авторов 2013 года](https://fluidengineeringsolutions.com/wp-content/uploads/2013/11/CSYS_HR_final.pdf). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [MakeSail: учебный проект](https://makesail.nl/docs/guide/getting-started.html). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Sailcut CAD: исходники](https://github.com/sailcut/sailcut). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Sailcut 6.10: переписка пользователей 2016 года](https://sourceforge.net/p/sailcut/mailman/sailcut-users/thread/CAK6k-QL61TRxYmQWvJ%2BGZD8pXXjfqP7f-LqLCY7KD65X48yNdg%40mail.gmail.com/). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [ProSail: описание продуктов](https://www.prosailcutter.com/3d-sail-design.html). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [SailPack: открытая справка](https://www.bsgdev.com/SailPack-Help/SailPack-Help.htm). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Sailrite: сборка асимметрика](https://www.sailrite.com/Building-a-Asymmetrical-Cruising-Spinnaker-Online-Streaming-Video). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Sail7](https://xflr5.com/sail7/sail7.html). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [`CSailMould::interpol`](https://github.com/sailcut/sailcut/blob/e2ccafac220e4e763171826a216eae492ebabdcb/src/sailcpp/sailmould.cpp#L249-L290). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [`CSailWorker::makeSail`](https://github.com/sailcut/sailcut/blob/e2ccafac220e4e763171826a216eae492ebabdcb/src/sailcpp/sailworker.cpp#L162-L221). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [`CPanel::develop`](https://github.com/sailcut/sailcut/blob/e2ccafac220e4e763171826a216eae492ebabdcb/src/sailcpp/panel.cpp#L188-L322). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [About](https://makesail.nl/docs/about.html). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [разделение параметров формы](https://makesail.nl/docs/guide/fullness.html). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Broadseam](https://makesail.nl/docs/guide/broadseam.html). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Spinnaker 4 Manual, July 2017, 35 страниц](https://www.prosailcutter.com/uploads/2/4/3/1/24311133/spinnaker_manual.pdf). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Sailrite](https://www.sailrite.com/sailmaking). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [Ali Meller, How Sails are Designed and Made, And How the KSL 505 Spinnaker Was Designed](https://505.ca/wp-content/uploads/2024/10/Sail-Design-and-505-Spinnaker-Design.pdf). Исходная запись: `gennaker-shape-literature-review-2026-09-19.md`.
- [дискретно-вихревой постановке для меняющейся кривизны](https://link.springer.com/article/10.1007/s00162-023-00678-7). Исходная запись: `local-pressure.md`.
- [Ramesh и соавт., 2014](https://eprints.gla.ac.uk/99370/). Исходная запись: `local-pressure.md`.
- [уравнению (18) Macklin, Müller, Chentanez (2016)](https://mmacklin.com/xpbd.pdf). Исходная запись: `local-pressure.md`, `sails-review-plan-2026-09-16.md`.
- [Deparday et al., 2018](https://www.juliendeparday.com/wp-content/uploads/2023/03/Deparday2018_JFS_FullScaleFlapping.pdf). Исходная запись: `local-pressure.md`, `wake.md`.
- [North Sails, How our sails are made](https://www.northsails.com/en-nl/blogs/north-sails-blog/how-our-sails-are-made). Исходная запись: `sails-review-plan-2026-09-16.md`.
- [Deparday et al., Full-scale flying shape measurement of offwind yacht sails with photogrammetry (2016)](https://sam.ensam.eu/handle/10985/11250?locale-attribute=fr). Исходная запись: `sails-review-plan-2026-09-16.md`.
- [Durand et al., FSI Investigation on Stability of Downwind Sails with an Automatic Dynamic Trimming (2013)](https://sam.ensam.eu/bitstream/handle/10985/14917/IRENAV_INNOVSAIL_16_2013_HAUVILLE.pdf?isAllowed=y&sequence=1). Исходная запись: `sails-review-plan-2026-09-16.md`.
- [Brush](https://github.com/ArthurBrussee/brush). Исходная запись: `splat-from-video.md`.
- [Viola & Flay, 2009](https://www.pure.ed.ac.uk/ws/portalfiles/portal/14074681/Viola_Flay_2009IJSCT.pdf). Исходная запись: `wake.md`.
- [Motta et al., 2014](https://sam.ensam.eu/bitstream/handle/10985/8690/IRENAV_OE_2014_BOT2.pdf?sequence=1). Исходная запись: `wake.md`.
- [Deparday et al., 2014](https://sam.ensam.eu/handle/10985/15137). Исходная запись: `wake.md`.
- [Deparday et al., 2017](https://sam.ensam.eu/bitstream/handle/10985/12535/Deparday2017_JST_PODPressureSpi.pdf?isAllowed=y&sequence=3). Исходная запись: `wake.md`.
- [Arredondo-Galeana & Viola, 2018](https://strathprints.strath.ac.uk/73623/). Исходная запись: `wake.md`.
- [Ramesh и соавт., уравнения 26–30](https://eprints.gla.ac.uk/99368/1/99368.pdf). Исходная запись: `wake.md`.
- [Nitsche, Physical Review Fluids 2, 124702 (2017), §III.B](https://www.math.unm.edu/~nitsche/pubs/2017-prf-nitsche.pdf). Исходная запись: `wake.md`.
- [Красного](https://ntrs.nasa.gov/citations/19860063688). Исходная запись: `wake.md`.
- [Xia и Mohseni, §2](https://arxiv.org/pdf/1611.05729). Исходная запись: `wake.md`.
- [обзор метода вихревого разреза](https://www.cambridge.org/core/journals/aeronautical-journal/article/vortex-shedding-and-induced-forces-in-unsteady-flow/6987958DEB49403304C6406B8F33BF57). Исходная запись: `wake.md`.
- [DeVoria и Mohseni, 2019](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/abs/vortexentrainment-sheet-in-an-inviscid-fluid-theory-and-separation-at-a-sharp-edge/495367513DD3896B76E5A76704203F0D). Исходная запись: `wake.md`.
- [DeVoria и Mohseni, §5–6](https://arxiv.org/pdf/1801.07346). Исходная запись: `wake.md`.
- [Viola–Flay, 2009](https://www.research.ed.ac.uk/en/publications/force-and-pressure-investigation-of-modern-asymmetric-spinnakers-2/). Исходная запись: `wake.md`.
- [Bot et al., 2014](https://www.research.ed.ac.uk/en/publications/wind-tunnel-pressure-measurements-on-model-scale-rigid-downwind-s-2/). Исходная запись: `wake.md`.

Ограничения доступности научных наборов и практических инструментов описаны в
[исследовании раскроя](sail-design.md). Для нового параметра фиксируйте также
конкретную таблицу/страницу, единицы и применимый диапазон; одного URL недостаточно.
