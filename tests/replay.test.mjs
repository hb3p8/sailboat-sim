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
import { Recorder, fieldIndex, restoreFrom, replayTrace } from '../sim/trace.js';

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
  src.o.crewHike = t > 7 ? 1 : 0;
  src.o.crewMass = src.o.crewHike > 0 ? 240 : 0;
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

console.log((failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
