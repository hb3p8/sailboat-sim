# Переход от прежних документов

Полные журналы до реорганизации сохранены в Git на ревизии
`c66ca9c4e7fabc8a04794d510f868d08aa530881` (`c66ca9c`, 2026-09-27). Старые страницы удалены из рабочей документации:
в них смешивались последовательные планы, временные записи и уже закрытые замечания.
Полезные действующие контракты и причины отрицательных результатов перенесены
в тематические разделы. Эта страница — индекс происхождения, не архив копий.

## Как получить исходную запись

```sh
git show c66ca9c4e7fabc8a04794d510f868d08aa530881:docs/wake.md
git show c66ca9c4e7fabc8a04794d510f868d08aa530881:docs/local-pressure.md
git show c66ca9c4e7fabc8a04794d510f868d08aa530881:docs/cfd-validation.md
```

Используйте название раздела, дату и условия из сохранённой сводки. Номера
разделов старого журнала не являются номерами новой страницы.

## Карта переноса

| Прежний документ | Основное новое место |
|---|---|
| `docs/axes.md` | [reference/coordinates.md](../reference/coordinates.md) |
| `docs/cfd-validation.md` | [research/cfd.md](../research/cfd.md) |
| `docs/fft-ocean-ssr-review.md` | [research/rendering.md](../research/rendering.md) |
| `docs/flow-plan.md` | [research/airflow.md](../research/airflow.md) |
| `docs/gennaker-planing-plan.md` | [research/gennaker.md](../research/gennaker.md) |
| `docs/gennaker-shape-literature-review-2026-09-19.md` | [research/sail-design.md](../research/sail-design.md) |
| `docs/gennaker-sota-plan.md` | [research/gennaker.md](../research/gennaker.md) |
| `docs/local-pressure.md` | [research/cloth-pressure.md](../research/cloth-pressure.md) |
| `docs/perf.md` | [research/rendering.md](../research/rendering.md) |
| `docs/planing.md` | [research/planing.md](../research/planing.md) |
| `docs/sail-polar-commits-review.md` | [research/airflow.md](../research/airflow.md) |
| `docs/sail-shape.md` | [reference/sail-measurements.md](../reference/sail-measurements.md) |
| `docs/sails-review-plan-2026-09-16.md` | [research/sail-design.md](../research/sail-design.md) |
| `docs/simulator-review.md` | [project/status.md](../project/status.md) |
| `docs/splat-from-video.md` | [research/shore-reconstruction.md](../research/shore-reconstruction.md) |
| `docs/stability.md` | [research/airflow.md](../research/airflow.md) |
| `docs/terrain-in-sim.md` | [subsystems/terrain.md](../subsystems/terrain.md) |
| `docs/wake.md` | [research/gennaker.md](../research/gennaker.md) |

README корпуса также доступен как `git show c66ca9c:README.md`; его текущие
контракты перенесены в геометрию, запуск и источники.

## Исторические ссылки внутри манифестов

Поле `notes` сохранённых `cfd/cases/*.json` может указывать на прежний путь
и номер раздела. Это происхождение исходной постановки, а не действующая
локальная ссылка. Манифесты не переписывались ради документации: изменение
содержимого меняет отпечаток и сопоставимость сохранённых результатов.
Читать такие ссылки следует на указанной выше ревизии.

Новые задания должны читать `AGENTS.md`, текущее состояние, очередь и
тематические исследования. Прежние пути больше не являются рабочими входами.
