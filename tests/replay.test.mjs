// Воспроизводимость дампа: node tests/replay.test.mjs
//
// Кнопка «Сдампать состояние» полезна ровно настолько, насколько дамп потом
// воспроизводится. Проверяется это здесь, и проверяется на том же самом коде
// записи, которым пользуется симулятор (sim/trace.js), — иначе формат дампа и
// проигрыватель разъедутся молча.
//
// Условия нарочно шевелятся по ходу записи: ветер, порывистость, откренивание,
// шкот, руль. Именно на этом первая версия и споткнулась — она писала только
// руль со шкотом, а ползунок ветра двигали в середине, и воспроизведение
// разъезжалось на четверть по скорости ветра.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { Recorder, fieldIndex, restoreFrom, replayTrace,
         dumpCore, applyDump } from '../sim/trace.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;
const HZ = 30;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

// --- записываем прогон, шевеля всем подряд ------------------------------------

const rec = new Recorder(30, HZ);
const src = new Boat(PACK);
src.o.windSpeed = 6; src.o.windDir = 70 * D; src.o.sheet = 18 * D;
src.o.twist = 6 * D; src.o.crewHike = 0; src.o.crewMass = 0;
src.wind.o.gust = 0.15; src.wind.o.shift = 7 * D;
src.u = 4;

const SECONDS = 25;
for (let i = 0; i < SECONDS * HZ; i++) {
  const t = i / HZ;
  // Ползунки и румпель ходят так же неровно, как под рукой человека.
  src.o.windSpeed = 6 + 4 * Math.min(1, Math.max(0, (t - 4) / 6));
  src.wind.o.gust = t > 10 ? 0.35 : 0.15;
  src.wind.o.shift = src.wind.o.gust * 45 * D;
  src.o.crewHike = t > 7 ? -1 : 0;      // на седьмой секунде экипаж выходит на борт
  src.o.crewMass = src.o.crewHike !== 0 ? 240 : 0;
  src.o.sheet = (18 + 10 * Math.sin(t / 5)) * D;
  src.o.twist = (6 + 12 * Math.max(0, Math.sin(t / 7))) * D;
  src.o.sailScale = t > 18 ? 1.3 : 1.0;
  src.o.rudder = 8 * Math.sin(t / 3) * D;
  src.o.rudderTarget = null;
  src.step(1 / HZ);
  rec.push(src);
}

const dump = { trace: rec.dump() };
const tr = dump.trace, F = fieldIndex(tr.fields), frames = tr.frames;
console.log('\nЗаписано ' + frames.length + ' кадров, ' +
  (frames[frames.length - 1][F.t] - frames[0][F.t]).toFixed(1) + ' с');
const span = name => {
  const a = frames.map(f => f[F[name]]);
  return Math.min(...a).toFixed(2) + '…' + Math.max(...a).toFixed(2);
};
console.log('  за время записи менялись: ветер ' + span('windSpeed') +
  ' м/с, порывы ' + span('gust') + ', экипаж ' + span('crewHike') +
  ', шкот ' + span('sheet') + ' рад, парусность ' + span('sailScale') + '\n');

check('в записи есть все нужные поля',
  ['windSpeed', 'windDir', 'gust', 'shift', 'crewHike', 'crewMass',
   'sailScale', 'rudder', 'sheet', 'twist'].every(n => F[n] != null));

// И лежат они на СВОИХ местах. Проверка по именам сдвига не ловит: она смотрит,
// что поле есть, а не что в нём лежит, — а порядок в traceFrame и порядок в
// TRACE_FIELDS это два разных списка, и разъезжаются они молча. Именно так и
// вышло, когда к записи добавляли цель перекладки: значение встало перед
// массивом запаздывающих углов вместо того чтобы встать после, всё поехало на
// одно место, и прогон разъехался на пустом месте.
//
// Ловит сдвиг тип: массив ни с чем не перепутаешь, а число не станет массивом.
check('поля лежат на своих местах, а не по соседству',
  Array.isArray(frames[0][F.lag]) &&
  frames.every(f => typeof f[F.t] === 'number' && typeof f[F.zc] === 'number' &&
                    typeof f[F.windSpeed] === 'number'),
  'массив запаздывающих углов на своём месте');

// --- проигрываем и сверяем ----------------------------------------------------

// Воспроизведение начинается с ОПОРНОГО кадра — того, где есть пелена.
//
// В обычный кадр её не положить: полторы тысячи чисел против полусотни, и
// запись раздулась бы в тридцать раз. Поэтому она пишется снимком раз в пару
// секунд, и в кольцевом буфере таких снимков живёт один-два.
//
// Опорный кадр восстанавливает состояние ЦЕЛИКОМ — и лодку, и пелену. Иначе
// толку мало: до него лодка идёт с пустой пеленой, успевает разойтись, и
// поставленная на место пелена этого уже не исправит. Проверено: только пелена
// давала 0.047° по крену, состояние вместе с ней — на порядок меньше.
// Проход — тот самый, которым воспроизводит `scripts/replay.mjs`. Своей копии
// здесь стояло достаточно, чтобы батарея была зелёной, а инструмент при этом
// опорных кадров не читал вовсе.
const boat = new Boat(PACK);
let worst = { speed: 0, heel: 0, psi: 0, drive: 0, at: 0 };
const from = replayTrace(boat, tr, F, (i, b, w) => {
  const t = b.telemetry;
  const d = {
    speed: Math.abs(t.speedKn - w[F.speedKn]),
    heel: Math.abs(t.heelDeg - w[F.heelDeg]),
    psi: Math.abs(b.psi - w[F.psi]) / D,
    drive: Math.abs(t.driveN - w[F.driveN]),
  };
  if (d.speed + d.heel + d.psi > worst.speed + worst.heel + worst.psi) {
    worst = Object.assign(d, { at: w[F.t] });
  }
});
console.log('Наибольшее расхождение: скорость ' + worst.speed.toExponential(1) +
  ' уз, крен ' + worst.heel.toExponential(1) + '°, курс ' +
  worst.psi.toExponential(1) + '°, тяга ' + worst.drive.toExponential(1) + ' Н\n');

// Запись округляется до четвёртого знака, поэтому «точно» — это в пределах
// округления, а не побитово. Курс и крен лежат в записи в радианах, и
// четвёртый знак там стоит 0.0057° — отсюда допуск по углам шире, чем по
// скорости: он задан форматом записи.
//
// Со свободной пеленой у модели появилась память, и её пришлось класть в
// запись опорными кадрами (см. выше). Сделано это было не из аккуратности: без
// них воспроизведение расходилось на 0.085° по крену вместо прежних 0.02°.
// С опорными кадрами получается 1.7e-4° — на два порядка точнее старого
// допуска, потому что опорный кадр это настоящий рестарт, а не прогрев.
//
// Допуск поэтому оставлен прежним, доеленовским. Ослаблять его не понадобилось.
check('прогон воспроизводится по записи',
  worst.speed < 2e-3 && worst.heel < 2e-2 && worst.psi < 2e-2,
  'худший момент на ' + worst.at.toFixed(1) + ' с, крен ' +
  worst.heel.toExponential(1) + '°');

// Без подачи условий из записи воспроизведение обязано развалиться — иначе
// проверка выше ничего не значит и прошла бы на любых полях.
{
  const naive = new Boat(PACK);
  restoreFrom(naive, frames[0], F);
  naive.o.rudderTarget = null;
  Object.assign(naive.o, {
    windSpeed: frames[frames.length - 1][F.windSpeed],
    crewHike: frames[frames.length - 1][F.crewHike],
    crewMass: frames[frames.length - 1][F.crewMass],
  });
  let off = 0;
  for (let i = 1; i < frames.length; i++) {
    naive.o.rudder = frames[i][F.rudder];
    naive.o.sheet = frames[i][F.sheet];
    naive.step(1 / tr.hz);
    off = Math.max(off, Math.abs(naive.telemetry.speedKn - frames[i][F.speedKn]));
  }
  console.log('Если подать только руль и шкот, а условия взять конечные: ' +
    'расхождение по скорости до ' + off.toFixed(2) + ' уз\n');
  check('проверка не проходит сама собой', off > 0.3, off.toFixed(2) + ' уз');
}

// --- ДАМП С ГЕНАКЕРОМ: обход по кругу ------------------------------------------
//
// Состав дампа задавался в браузере, и стенд его не видел: здесь собирался свой
// объект из одной записи, а `scripts/replay.mjs` разбирал настоящий. Совпадали
// они, пока совпадали, и разошлись на генакере — его подъём ПЕРЕСТРАИВАЕТ РИГ, а
// дамп нёс только флаг. Загруженный дамп вставал в лодку с двенадцатью полосками
// вместо восемнадцати и врал молча: ни одна проверка этого не видела.
//
// Теперь сбор и разбор — одна пара функций на страницу, проигрыватель и стенд
// (`dumpCore`/`applyDump`), и проверяется она обходом по кругу: лодка с
// генакером -> дамп -> ДРУГАЯ лодка -> шаг обеих -> сошлись ли.
{
  const a = new Boat(PACK);
  a.o.freeWake = true; a.o.wakeForces = true;
  a.o.windSpeed = 6; a.o.windDir = 140 * D;
  a.o.crewHike = -1; a.o.crewMass = 219.9;
  a.setGennaker(true);
  a.o.genSheetLen = 6.5; a.o.sheet = 65 * D;
  a.reset();
  a.u = 3;
  for (let i = 0; i < 12 * HZ; i++) { a.o.rudderTarget = 0; a.step(1 / HZ); }

  const d = dumpCore(a);
  // Через JSON, а не ссылкой: дамп ездит текстом, и типизированные массивы в
  // нём становятся обычными. Ровно на этом переходе всё и ломается тихо.
  const wire = JSON.parse(JSON.stringify(d));

  const b = new Boat(PACK);
  const got = applyDump(b, wire);

  check('дамп поднимает генакер, а не только флаг',
    b.rig.strips.length === a.rig.strips.length,
    b.rig.strips.length + ' полосок против ' + a.rig.strips.length);
  check('полотно генакера в дампе есть и встаёт на место', got.cloth && !!wire.cloth,
    wire.cloth ? wire.cloth.rows + '×' + wire.cloth.cols : 'нет');
  let clothOff = 0;
  if (a.rig.cloth && b.rig.cloth) {
    for (let i = 0; i < a.rig.cloth.pos.length; i++) {
      clothOff = Math.max(clothOff, Math.abs(a.rig.cloth.pos[i] - b.rig.cloth.pos[i]));
    }
  }
  check('узлы полотна встали туда же', clothOff < 1e-8,
    clothOff.toExponential(1) + ' м');

  // Главное: шаг обеих лодок из одного состояния обязан дать один ответ. Форма
  // паруса приходит не за шаг, и заново посаженное на крой полотно даёт другую
  // хорду, другой угол атаки и другую силу — это и ловится.
  a.o.rudderTarget = 0; b.o.rudderTarget = 0;
  for (let i = 0; i < HZ; i++) { a.step(1 / HZ); b.step(1 / HZ); }
  const dv = Math.abs(a.telemetry.speedKn - b.telemetry.speedKn);
  const dd = Math.abs(a.telemetry.driveN - b.telemetry.driveN);
  const rv = dv / Math.max(1e-6, Math.abs(a.telemetry.speedKn));
  const rd = dd / Math.max(1e-6, Math.abs(a.telemetry.driveN));
  console.log('\nПосле секунды хода из дампа: скорость расходится на ' +
    dv.toExponential(1) + ' уз (' + (100 * rv).toExponential(1) + ' %), тяга на ' +
    dd.toExponential(1) + ' Н (' + (100 * rd).toExponential(1) + ' %)');
  // Допуск — сотая доля процента, и он стоит МЕЖДУ ДВУМЯ ИЗМЕРЕННЫМИ ВЕЛИЧИНАМИ,
  // а не назначен на глаз.
  //
  // Снизу его подпирает собственная точность дампа: состояние пишется девятью
  // знаками, пелена четырьмя, и на этом полу расхождение за секунду хода
  // выходит 1.5e-5 % по скорости и 1.4e-4 % по тяге (замерено подстановкой
  // неокруглённых массивов — ответ тот же). Сверху — самый мелкий из шести
  // найденных пропусков состояния: нагрузка на ткань давала 0.02 % по скорости
  // и 0.03 % по тяге. Сотая доля процента лежит на два порядка выше пола и
  // вдвое ниже самого мелкого настоящего пропуска.
  //
  // Остальные пять были крупнее и на порядки: полотно генакера — 18 %, память
  // перехода — 4 %, пузо с наполнением — 0.4 %. Искались все шесть одинаково:
  // снять дамп, разобрать в другую лодку, шагнуть обеих ОДИН раз и сравнить всё
  // поле за полем — риг, решётку, пелену, полотно, полоски; расходящееся и есть
  // пропущенное, а дальше тем же способом внутрь.
  check('лодка из дампа идёт так же, как та, с которой он снят',
    rv < 1e-4 && rd < 1e-4,
    (100 * rv).toExponential(1) + ' % по ходу, ' + (100 * rd).toExponential(1) + ' % по тяге');

  // Запись тоже обязана нести генакер: без этого воспроизведение шло бы с тем
  // парусом, какой стоял в лодке к началу.
  check('пелена в дампе есть и встаёт на место', got.wake && !!wire.wakeState,
    wire.wakeState ? wire.wakeState.n + ' узлов на нить' : 'нет');
  check('в записи есть поля генакера',
    F.gennakerUp != null && F.genSheetLen != null,
    'gennakerUp ' + F.gennakerUp + ', genSheetLen ' + F.genSheetLen);
}

console.log((failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
