// Тесты физики хода без браузера: node tests/physics.test.mjs
//
// Браузер для этого не нужен и вреден: он мешает отличить расходимость модели
// от проблем отрисовки, а ещё его нельзя запустить из Makefile.
//
// Проверяется не «похоже на правду», а конкретные утверждения: лодка держит
// курс под авторулевым, идёт быстрее с попутным ветром, кренится в нужную
// сторону, разворачивается за разумный радиус и качается с тем периодом,
// который независимо посчитан по геометрии.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;
const KN = 1.94384;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

function wrapPi(a) {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Авторулевой: без него лодка просто уваливается под ветер и все курсы
// вырождаются в фордевинд — ровно это и показал первый прогон.
function sail(twaDeg, sheetDeg, opts = {}) {
  const b = new Boat(PACK);
  b.o.windSpeed = opts.wind ?? 6.0;
  b.o.windDir = twaDeg * D;          // курс ноль, значит истинный ветер = TWA
  b.o.sheet = sheetDeg * D;
  b.o.crewHike = opts.hike ?? 0;
  b.o.crewMass = b.o.crewHike > 0 ? 240 : 0;
  const target = 0;
  const secs = opts.secs ?? 120;
  for (let i = 0; i < secs * 30; i++) {
    const err = wrapPi(target - b.psi);
    b.o.rudder = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * b.r)));
    b.step(1 / 30);
  }
  return { b, t: b.telemetry, headingErrDeg: wrapPi(target - b.psi) / D };
}

console.log('\nУстановившийся ход, истинный ветер 6 м/с (11.7 уз):\n');
console.log('  TWA  шкот   узлы   крен   дрейф    AWA   тяга,Н   VMG   курс');
const rows = [];
for (const [twa, sheet] of [[40, 12], [50, 14], [60, 16], [90, 24],
                            [120, 40], [150, 60], [175, 80]]) {
  const r = sail(twa, sheet);
  rows.push([twa, sheet, r]);
  console.log('  ' + String(twa).padStart(3) + '° ' + String(sheet).padStart(4) +
    '° ' + r.t.speedKn.toFixed(2).padStart(6) + ' ' +
    r.t.heelDeg.toFixed(1).padStart(6) + '° ' +
    r.t.leewayDeg.toFixed(1).padStart(6) + '° ' +
    r.t.awaDeg.toFixed(0).padStart(5) + '° ' +
    r.t.driveN.toFixed(0).padStart(7) + ' ' +
    r.t.vmg.toFixed(2).padStart(6) + ' ' +
    r.headingErrDeg.toFixed(1).padStart(6) + '°');
}

console.log('\nПроверки:\n');

const finite = rows.every(([, , r]) =>
  [r.b.u, r.b.v, r.b.r, r.b.phi, r.b.psi].every(Number.isFinite));
check('модель не расходится ни на одном курсе', finite);

const held = rows.every(([, , r]) => Math.abs(r.headingErrDeg) < 5);
check('авторулевой держит курс', held,
  'наибольшая ошибка ' +
  Math.max(...rows.map(([, , r]) => Math.abs(r.headingErrDeg))).toFixed(1) + '°');

const awaOk = rows.every(([twa, , r]) => r.t.awaDeg < twa + 2);
check('кажущийся ветер острее истинного', awaOk);

const beat = rows[1][2].t, reach = rows[3][2].t, run = rows[6][2].t;
check('на галфвинде быстрее, чем в бейдевинд', reach.speedKn > beat.speedKn,
  reach.speedKn.toFixed(2) + ' против ' + beat.speedKn.toFixed(2) + ' уз');
check('в бейдевинд лодка кренится', Math.abs(beat.heelDeg) > 3,
  beat.heelDeg.toFixed(1) + '°');
check('на фордевинде крен почти нулевой', Math.abs(run.heelDeg) < 6,
  run.heelDeg.toFixed(1) + '°');
check('дрейф в бейдевинд в разумных пределах',
  Math.abs(beat.leewayDeg) > 0.5 && Math.abs(beat.leewayDeg) < 12,
  beat.leewayDeg.toFixed(1) + '°');
check('скорость в бейдевинд правдоподобна',
  beat.speedKn > 3.0 && beat.speedKn < 7.5, beat.speedKn.toFixed(2) + ' уз');
check('крен в бейдевинд не запредельный', Math.abs(beat.heelDeg) < 35,
  beat.heelDeg.toFixed(1) + '°');
// Якорь калибровки. Скорость на галфвинде задаётся не расчётом, а кривой
// RESIDUARY, и она подогнана под оценку владельца лодки. Проверка нужна,
// чтобы правка кривой не проехала мимо этой оценки незамеченной.
check('галфвинд в 11.7 узлах ветра около восьми с половиной узлов',
  reach.speedKn > 7.6 && reach.speedKn < 9.2, reach.speedKn.toFixed(2) + ' уз');

// --- разворот -------------------------------------------------------------
const turn = new Boat(PACK);
turn.o.windSpeed = 6; turn.o.windDir = 90 * D; turn.o.sheet = 24 * D;
for (let i = 0; i < 60 * 30; i++) {
  const err = wrapPi(0 - turn.psi);
  turn.o.rudder = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * turn.r)));
  turn.step(1 / 30);
}
const v0 = Math.hypot(turn.u, turn.v);
turn.o.rudder = 15 * D;
let rates = [];
for (let i = 0; i < 20 * 30; i++) {
  turn.step(1 / 30);
  if (i > 15 * 30) rates.push(turn.r);
}
const rSteady = rates.reduce((a, b) => a + b, 0) / rates.length;
const vTurn = Math.hypot(turn.u, turn.v);
const radius = Math.abs(rSteady) > 1e-4 ? vTurn / Math.abs(rSteady) : Infinity;
console.log('\nРазворот при руле 15°: угловая скорость ' +
  (rSteady / D).toFixed(1) + ' °/с, скорость ' + (vTurn * KN).toFixed(2) +
  ' уз (было ' + (v0 * KN).toFixed(2) + '), радиус ' + radius.toFixed(1) +
  ' м = ' + (radius / 6.1).toFixed(1) + ' корпуса\n');
check('радиус циркуляции от полутора до восьми длин корпуса',
  radius > 1.5 * 6.1 && radius < 8 * 6.1, (radius / 6.1).toFixed(1) + ' L');
check('в развороте лодка теряет ход, но не встаёт', vTurn > 0.3 * v0);

// --- свободная качка ------------------------------------------------------
const roll = new Boat(PACK);
roll.o.windSpeed = 0; roll.o.sheet = 90 * D;
roll.phi = 20 * D;
let crossings = [], prevPhi = roll.phi;
for (let i = 0; i < 30 * 30; i++) {
  roll.step(1 / 30);
  if (prevPhi > 0 && roll.phi <= 0) crossings.push(i / 30);
  prevPhi = roll.phi;
}
let period = null;
if (crossings.length >= 2) {
  const gaps = [];
  for (let i = 1; i < crossings.length; i++) gaps.push(crossings[i] - crossings[i - 1]);
  period = gaps.reduce((a, b) => a + b, 0) / gaps.length;
}
const expected = 2.40;
console.log('Свободная качка от 20°: период ' +
  (period ? period.toFixed(2) : '—') + ' с, ожидался ' + expected + ' с\n');
check('период качки совпадает с расчётом по геометрии',
  period != null && Math.abs(period - expected) / expected < 0.15,
  period ? ((period - expected) / expected * 100).toFixed(1) + '%' : 'нет колебаний');

console.log('\n' + (failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
