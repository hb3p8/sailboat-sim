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
import { Recorder, fieldIndex, restoreFrom, applyFrom } from '../sim/trace.js';

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

// --- проигрываем и сверяем ----------------------------------------------------

const boat = new Boat(PACK);
restoreFrom(boat, frames[0], F);
boat.o.rudderTarget = null;
let worst = { speed: 0, heel: 0, psi: 0, drive: 0, at: 0 };
for (let i = 1; i < frames.length; i++) {
  applyFrom(boat, frames[i], F);
  boat.step(1 / tr.hz);
  const w = frames[i], t = boat.telemetry;
  const d = {
    speed: Math.abs(t.speedKn - w[F.speedKn]),
    heel: Math.abs(t.heelDeg - w[F.heelDeg]),
    psi: Math.abs(boat.psi - w[F.psi]) / D,
    drive: Math.abs(t.driveN - w[F.driveN]),
  };
  if (d.speed + d.heel + d.psi > worst.speed + worst.heel + worst.psi) {
    worst = Object.assign(d, { at: w[F.t] });
  }
}
console.log('Наибольшее расхождение: скорость ' + worst.speed.toExponential(1) +
  ' уз, крен ' + worst.heel.toExponential(1) + '°, курс ' +
  worst.psi.toExponential(1) + '°, тяга ' + worst.drive.toExponential(1) + ' Н\n');

// Запись округляется до четвёртого знака, поэтому «точно» — это в пределах
// округления, а не побитово. Курс лежит в записи в радианах, и четвёртый знак
// там стоит 0.0057° — отсюда и допуск по нему на порядок шире, чем по
// остальному: он задан форматом записи, а не поведением модели.
check('прогон воспроизводится по записи',
  worst.speed < 2e-3 && worst.heel < 2e-3 && worst.psi < 2e-2,
  'худший момент на ' + worst.at.toFixed(1) + ' с');

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
