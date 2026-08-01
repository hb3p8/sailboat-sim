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
  // Старт с ходом и уже с креном. Прямостоящая лодка на полном ходу в
  // бейдевинд — состояние, которого на воде не бывает: парус там работает на
  // полную, и её резко уваливает раньше, чем она успевает накрениться.
  // Проверять переходный процесс из невозможного состояния бессмысленно.
  b.u = opts.u ?? 3.5;
  b.phi = (opts.heel ?? 18) * D * (twaDeg > 0 ? 1 : -1);
  const target = 0;
  const secs = opts.secs ?? 120;
  for (let i = 0; i < secs * 30; i++) {
    const err = wrapPi(target - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * b.r)));
    b.step(1 / 30);
  }
  return { b, t: b.telemetry, headingErrDeg: wrapPi(target - b.psi) / D };
}

console.log("\nУстановившийся ход, истинный ветер 6 м/с (11.7 уз) на стандартных 10 м:\n");
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
//
// Ветер теперь имеет профиль по высоте, и «11.7 узлов» стало двусмысленным:
// на стандартных десяти метрах это одно, у центра парусности на 3.3 м — на
// восьмую часть меньше. Наблюдение владельца — про то, что он чувствовал на
// лодке, поэтому якорь ставится по ветру У РИГА, а ползунок пересчитывается.
const RIG_WIND = 6.0;                       // м/с на высоте центра парусности
const anchor = sail(90, 24,
  { wind: RIG_WIND / new Boat(PACK).wind.profile(PACK.rig.ce_height_m) });
console.log('Якорь: у центра парусности ' + (RIG_WIND * KN).toFixed(1) +
  ' уз ветра (на 10 м это ' +
  (RIG_WIND / new Boat(PACK).wind.profile(PACK.rig.ce_height_m) * KN).toFixed(1) +
  ' уз) — галфвинд ' + anchor.t.speedKn.toFixed(2) + ' уз\n');
check('галфвинд в 11.7 узлах ветра у рига около восьми с половиной узлов',
  anchor.t.speedKn > 7.6 && anchor.t.speedKn < 9.2,
  anchor.t.speedKn.toFixed(2) + ' уз');

// --- балансировка руля -------------------------------------------------------
//
// Владелец лодки сказал, что на воде она так не валится под ветер, как это
// делала модель. Два теста закрепляют наблюдение: сколько руля нужно, чтобы
// держать курс, и куда лодка идёт, если руль бросить.

console.log('\nБалансировка: руль для удержания курса и поведение с брошенным рулём\n');
console.log('  TWA   руль    через 10 с с брошенным рулём');
const balance = [];
for (const [twa, sheet] of [[45, 13], [60, 16], [90, 24]]) {
  const b = new Boat(PACK);
  b.o.windSpeed = 6; b.o.windDir = twa * D; b.o.sheet = sheet * D; b.u = 3.5;
  for (let i = 0; i < 120 * 30; i++) {
    const err = wrapPi(0 - b.psi);
    b.o.rudderTarget = Math.max(-30 * D, Math.min(30 * D, -(2.2 * err - 0.9 * b.r)));
    b.step(1 / 30);
  }
  const helm = b.o.rudder / D;
  const twa0 = Math.abs(b.trueWindAngle()) / D;
  b.o.rudderTarget = 0;
  for (let i = 0; i < 10 * 30; i++) b.step(1 / 30);
  const drift = twa0 - Math.abs(b.trueWindAngle()) / D;
  balance.push({ twa, helm, drift });
  console.log('  ' + String(twa).padStart(3) + '° ' + helm.toFixed(1).padStart(6) +
    '°   ' + (drift >= 0 ? 'привелась на +' : 'увалилась на ') +
    drift.toFixed(0) + '°');
}
console.log('');
check('руля для удержания курса нужно немного',
  balance.every(b => Math.abs(b.helm) < 8),
  'наибольший ' + Math.max(...balance.map(b => Math.abs(b.helm))).toFixed(1) + '°');
check('с брошенным рулём лодка не валится под ветер',
  balance.every(b => b.drift > -3),
  'худший случай ' + Math.min(...balance.map(b => b.drift)).toFixed(0) + '°');

// --- острота -----------------------------------------------------------------
//
// Лавировка целиком разбирается в tests/upwind.test.mjs: там поляра с
// подобранным шкотом, разная сила ветра, откренивание, оверштаг и левентик.
// Здесь остаётся одна грубая проверка — что лодка вообще не умеет идти круче,
// чем бывает; сравнивать курсы при жёстко заданном шкоте бессмысленно, шкот
// на каждом курсе свой.
const beatRows = [[30, 10], [45, 13], [60, 16]].map(([twa, sheet]) => {
  const r = sail(twa, sheet);
  const track = twa + Math.abs(r.t.leewayDeg);
  return { twa, track, vmg: r.t.speedKn * Math.cos(track * D) };
});
console.log('Курс к ветру с учётом дрейфа: ' +
  beatRows.map(r => r.twa + '°→' + r.track.toFixed(0) + '° (VMG ' +
    r.vmg.toFixed(2) + ')').join(',  ') + '\n');
check('лавировочный угол не уже семидесяти градусов',
  2 * beatRows[0].track > 70, (2 * beatRows[0].track).toFixed(0) + '°');

// --- полные курсы и отданные шкоты -------------------------------------------
//
// Всё, что здесь проверяется, разъехалось на попутных курсах: парус
// перекидывался с борта на борт от каждого колебания ветра, шкот держал полотно
// как жёсткую пластину, а «сорванный» парус выдавался за ошибку настройки,
// хотя в фордевинд он ровно так и работает.

console.log('\nФордевинд, шкот от добранного до отданного:\n');
console.log('  шкот    α°   состояние потока   тяга,Н   скорость,уз');
const runRows = [];
for (const sheet of [15, 35, 55, 75, 90]) {
  const b = new Boat(PACK);
  b.o.windSpeed = 7; b.o.windDir = 180 * D; b.o.sheet = sheet * D; b.u = 3;
  for (let i = 0; i < 150 * 30; i++) {
    const err = wrapPi(0 - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * b.r)));
    b.step(1 / 30);
  }
  const t = b.telemetry;
  // Поток прилипает и у нулевого угла, и у ста восьмидесяти: во втором
  // случае парус просто стоит вдоль потока задом наперёд, как флаг.
  const eff = Math.min(Math.abs(t.alphaDeg), 180 - Math.abs(t.alphaDeg));
  const state = eff < 3 ? 'полощет' : eff <= 18 ? 'прилип' : 'сорван';
  runRows.push({ sheet, t, state });
  console.log('  ' + String(sheet).padStart(4) + '° ' +
    t.alphaDeg.toFixed(0).padStart(5) + '   ' + state.padEnd(16) +
    t.driveN.toFixed(0).padStart(7) + ' ' + t.speedKn.toFixed(2).padStart(13));
}
console.log('');
const bestRun = runRows.reduce((a, b) => (b.t.speedKn > a.t.speedKn ? b : a));
// Ответ на «почему при красных индикаторах быстрее, чем при зелёных»: в
// фордевинд нужна не подъёмная сила, а сопротивление вдоль движения, и даёт
// его именно сорванный парус. Индикатор состояния потока тут ни при чём.
check('в фордевинд быстрее всего идёт сорванный парус',
  bestRun.state === 'сорван',
  'лучший шкот ' + bestRun.sheet + '°, ' + bestRun.state + ', ' +
  bestRun.t.speedKn.toFixed(2) + ' уз');
check('добранный в фордевинд парус почти не везёт',
  runRows[0].t.speedKn < bestRun.t.speedKn * 0.8,
  runRows[0].t.speedKn.toFixed(2) + ' против ' + bestRun.t.speedKn.toFixed(2) + ' уз');

// Парус стоит на своём борту, пока не перекинется по-настоящему.
{
  const b = new Boat(PACK);
  b.o.windSpeed = 7; b.o.windDir = 180 * D; b.o.sheet = 75 * D; b.u = 3;
  b.wind.o.gust = 0.25; b.wind.o.shift = 0.25 * 45 * D;
  let flips = 0, prev = b.rigSide, jolt = 0, prevSide = null;
  for (let i = 0; i < 180 * 30; i++) {
    const err = wrapPi(0 - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * b.r)));
    b.step(1 / 30);
    if (i < 30 * 30) continue;
    if (b.rigSide !== prev) flips++;
    prev = b.rigSide;
    if (prevSide !== null) jolt = Math.max(jolt, Math.abs(b.telemetry.sideN - prevSide));
    prevSide = b.telemetry.sideN;
  }
  console.log('Чистый фордевинд в порывистый ветер: борт паруса менялся ' + flips +
    ' раз, наибольший скачок боковой силы ' + jolt.toFixed(0) + ' Н за шаг\n');
  // Раньше здесь было по десятку перекидываний с рывком в две сотни ньютонов —
  // именно это выглядело как мелкая неестественная дрожь лодки.
  check('боковая сила не прыгает скачком', jolt < 25, jolt.toFixed(0) + ' Н за шаг');
}

// Отданные шкоты и брошенный руль.
{
  const b = new Boat(PACK);
  b.o.windSpeed = 6; b.o.windDir = 90 * D; b.o.sheet = 90 * D; b.o.rudder = 0;
  const at = [];
  for (let i = 0; i < 600 * 30; i++) {
    b.step(1 / 30);
    if ((i + 1) % (150 * 30) === 0) at.push(b.telemetry.speedKn);
  }
  const t = b.telemetry;
  console.log('Всё отдано, десять минут: ' +
    at.map(v => v.toFixed(2)).join(' → ') + ' уз, TWA ' +
    t.twaAbsDeg.toFixed(0) + '°\n');
  check('с отданными шкотами лодка не разгоняется без конца',
    at[3] - at[1] < 0.05, 'за последние пять минут ' +
    (at[3] - at[1]).toFixed(2) + ' уз');
  check('и едет медленно', at[3] < 3.6, at[3].toFixed(2) + ' уз');
  check('верх паруса при этом заполаскивает',
    t.strips[5].cl < 0.05 && t.strips[0].cl > 0.1,
    'cl низ ' + t.strips[0].cl.toFixed(2) + ', верх ' + t.strips[5].cl.toFixed(2));
}

// --- разворот -------------------------------------------------------------
const turn = new Boat(PACK);
turn.o.windSpeed = 6; turn.o.windDir = 90 * D; turn.o.sheet = 24 * D;
for (let i = 0; i < 60 * 30; i++) {
  const err = wrapPi(0 - turn.psi);
  turn.o.rudder = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * turn.r)));
  turn.step(1 / 30);
}
const v0 = Math.hypot(turn.u, turn.v);
turn.o.rudderTarget = 15 * D;
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
