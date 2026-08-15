// Отправка профиля сессии на сервер: node scripts/serve.py, файлы в out/perf.
//
// ЗАЧЕМ. Тайминги на экране отвечают на вопрос «во что упёрлось СЕЙЧАС», и на
// телефоне это единственный доступный прибор — консоли там нет, профилировщика
// тоже. Но по фотографии экрана не видно ГЛАВНОГО: как кадр ведёт себя во
// времени. Провал при повороте, накопление при долгом ходе, спираль добора
// шагов, разогрев видеокарты на первых секундах — всё это события, а не
// состояния, и одним снимком они не ловятся.
//
// Поэтому симулятор пишет свои же числа в ленту и раз в несколько секунд
// отправляет пачку на тот сервер, с которого сам и открыт. Дальше сессию можно
// читать целиком: `out/perf/<дата>-<сессия>.jsonl`.
//
// ЧТО ОТПРАВЛЯЕТСЯ. Только то, что уже показано на экране, плюс шапка про
// устройство: сборка, размер холста, плотность пикселей, какой интерфейс.
// Ни положения лодки, ни органов управления, ни чего-либо про человека —
// профиль здесь про КАДР, а не про плавание.
//
// КУДА. На свой же источник, относительным адресом. Открыли страницу файлом с
// диска — отправлять некуда и незачем, и модуль молча выключается. Не отвечает
// сервер (открыто со статики, поднятой чем-то другим) — после нескольких
// неудач подряд модуль замолкает совсем, чтобы не сорить запросами в каждом
// кадре до конца сессии.
//
// ВЫКЛЮЧАТЕЛЬ: `?noperf`. Нужен ровно затем, чтобы замер скамьи не мешался с
// сетевой работой.

// Раз в сколько секунд снимается отсчёт и раз в сколько отправляется пачка.
// Секунда — это разрешение, на котором видны события: поворот, порыв, вход в
// узкое место. Чаще незачем: числа на экране и так сглажены, а лента станет
// вдесятеро толще без единого нового ответа.
const PERF_SAMPLE = 1.0;    // с
const PERF_SEND = 5.0;      // с
const PERF_FAILS = 3;       // столько неудач подряд — и замолкаем

const perfLogOn = typeof location !== 'undefined'
  && /^https?:$/.test(location.protocol)
  && !location.search.includes('noperf');

// Имя сессии — одно на загрузку страницы. Не хранится и не переживает
// перезагрузку нарочно: сессия это то, что человек сейчас и делает, а после
// F5 у него уже другая сборка, другие настройки и другой разговор.
const perfSession = Math.random().toString(36).slice(2, 10);

let perfBuf = [], perfLastSample = 0, perfLastSend = 0, perfFails = 0, perfSending = false;

// Шапка: с чем сравнивать числа. Собирается при первой отправке, когда всё уже
// поднято — размер холста до первого кадра ещё никакой.
function perfHead() {
  const c = renderer.domElement;
  return {
    сессия: perfSession,
    сборка: (typeof BUILD !== 'undefined' && BUILD)
      ? { rev: BUILD.rev, commit: BUILD.commit, dirty: BUILD.dirty, built: BUILD.built } : null,
    интерфейс: document.body.classList.contains('game') ? 'игровой' : 'отладка',
    холст: [c.width, c.height],
    css: [c.clientWidth, c.clientHeight],
    dpr: window.devicePixelRatio || 1,
    экран: [screen.width, screen.height],
    // Строка агента врёт про многое, но отличить телефон от настольной машины
    // по ней всё же можно, а для чтения ленты через неделю это важно.
    агент: (navigator.userAgent || '').slice(0, 120),
    пелена: !!(boat && boat.o && boat.o.wakeForces),
    // КАЧЕСТВО, а не только устройство. Без этих чисел лента не говорит, в каком
    // режиме снята: `dpr` выше — плотность экрана, а рисует рендерер в своей,
    // и на телефоне она в полтора раза меньше. Сравнивать две сессии, не зная
    // сетки воды, размера карты теней и деления пелены, значит сравнивать
    // неизвестно что с неизвестно чем — ровно это и указано в ревью (§10.2).
    качество: {
      pixelRatio: renderer.getPixelRatio ? +renderer.getPixelRatio().toFixed(3) : null,
      сглаживание: renderer.samples != null ? renderer.samples : null,
      сетка: typeof SEG !== 'undefined' ? SEG : null,
      тень: sun && sun.shadow && sun.shadow.mapSize ? sun.shadow.mapSize.width : null,
      зеркало: typeof seaRefPlanar !== 'undefined' && seaRefPlanar ? seaRefPlanar.value : null,
      волнаN: ocean && ocean.gridN != null ? ocean.gridN : null,
      волнаРаз: ocean && ocean.every != null ? ocean.every : null,
      пеленаДеление: boat && boat.o ? (boat.o.wakeSlice | 0) : null,
      интерфейсМоб: typeof MOBILE_UI !== 'undefined' ? !!MOBILE_UI : null,
    },
  };
}

// Один отсчёт: ровно те числа, что на экране, плюс модельное время.
function perfSample(now) {
  return {
    t: +now.toFixed(1),
    сек: +(boat && boat.t ? boat.t : 0).toFixed(1),
    кс: +perf.fps.toFixed(1),
    кадр: +perf.frame.toFixed(2),
    физ: +perf.phys.toFixed(2),
    шагов: +perf.steps.toFixed(2),
    сцена: +perf.scene.toFixed(2),
    рис: +perf.draw.toFixed(2),
    гп: +perf.gpu.toFixed(2),
    счёт: +perf.gpuCompute.toFixed(2),     // средний на показанный кадр
    пакет: +perf.gpuBatch.toFixed(2),      // и цена одного пакета волны
    брошено: +perf.dropped.toFixed(2),
    выз: perf.calls,
    тр: perf.tris,
    // Условия, от которых цена кадра действительно зависит: ветер поднимает
    // волну, а вид решает, сколько воды в кадре.
    ветер: +(boat && boat.o ? boat.o.windSpeed : 0).toFixed(1),
    вид: typeof camMode !== 'undefined' ? camMode : -1,
    отладка: typeof debugMode !== 'undefined' ? debugMode : 0,
  };
}

function perfSend(final) {
  if (!perfBuf.length || perfSending || perfFails >= PERF_FAILS) return;
  const body = JSON.stringify({
    session: perfSession,
    head: perfHead(),
    samples: perfBuf,
  });
  perfBuf = [];
  perfSending = true;
  // `keepalive` — чтобы последняя пачка ушла даже на закрытии вкладки: именно
  // в ней лежит то, из-за чего вкладку и закрыли.
  fetch('/api/perf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body,
    keepalive: !!final,
  }).then(r => { perfFails = r.ok ? 0 : perfFails + 1; })
    .catch(() => { perfFails++; })
    .finally(() => { perfSending = false; });
}

// Таблица со скамьи уходит той же дорогой, отдельным отсчётом с пометкой.
//
// Заведено ради телефона. Разобрать кадр по частям на нём можно — кнопка та же,
// — а вот прочитать вывод консоли уже нельзя, и переписывать десять строк с
// экрана от руки бессмысленно. Так таблица оказывается в той же ленте, что и
// профиль сессии, и читается тем же `scripts/perf_report.py`.
function perfLogBench(name, rows, extra) {
  if (!perfLogOn) return;
  const rec = { скамья: name, строки: rows };
  if (extra) for (const k in extra) rec[k] = extra[k];
  fetch('/api/perf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: perfSession, head: perfHead(), samples: [rec] }),
  }).catch(() => { /* нет сервера — нет и отправки */ });
}

// Зовётся из кадрового цикла. Сама решает, пора ли снимать и пора ли слать.
function perfLogTick() {
  if (!perfLogOn) return;
  const now = performance.now() / 1000;
  if (!perfLastSample) { perfLastSample = now; perfLastSend = now; return; }
  if (now - perfLastSample < PERF_SAMPLE) return;
  perfLastSample = now;
  perfBuf.push(perfSample(now));
  if (now - perfLastSend >= PERF_SEND) { perfLastSend = now; perfSend(false); }
}

// Закрывают вкладку — досылаем остаток. `pagehide` надёжнее `beforeunload` на
// телефоне: там вкладку не закрывают, а уводят, и второе событие не приходит.
if (perfLogOn) addEventListener('pagehide', () => perfSend(true));
