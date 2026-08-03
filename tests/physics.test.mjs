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
import { Terrain } from '../sim/terrain.js';

import { Pool } from './lib/pool.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_PATH = join(ROOT, 'out/export/physics.json');
const PACK = JSON.parse(readFileSync(PACK_PATH, 'utf8'));
// Перебор настроек — по всем ядрам: прогоны друг от друга не зависят.
const pool = new Pool(PACK_PATH, PACK);
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
  b.o.twist = opts.twist ?? 0;
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
const SCHEDULE = [[40, 8], [50, 20], [60, 20], [90, 44],
                  [120, 76], [150, 72], [175, 48]];
const rowsRaw = await pool.map(SCHEDULE.map(([twa, sheet]) =>
  ({ twa: twa, sheet: sheet, secs: 120 })));
const rows = [];
// Шкот на каждом курсе подобран под лучший ход (в лавировку — под VMG). При
// жёстко заданном расписании таблица меряет не лодку, а то, насколько удачно
// когда-то угадали шкот, и расписание приходится пересматривать всякий раз,
// когда меняется модель паруса. После мембраны парус набирает свою подъёмную
// силу пузом, а не углом атаки, и рабочие углы стали заметно шире прежних:
// на галфвинде 44° вместо 30°, на полном 76° вместо 46°.
SCHEDULE.forEach(([twa, sheet], i) => {
  const r = { t: rowsRaw[i], headingErr: rowsRaw[i].headingErr,
              b: rowsRaw[i], finite: rowsRaw[i].finite };
  rows.push([twa, sheet, r]);
  console.log('  ' + String(twa).padStart(3) + '° ' + String(sheet).padStart(4) +
    '° ' + r.t.speedKn.toFixed(2).padStart(6) + ' ' +
    r.t.heelDeg.toFixed(1).padStart(6) + '° ' +
    r.t.leewayDeg.toFixed(1).padStart(6) + '° ' +
    r.t.awaDeg.toFixed(0).padStart(5) + '° ' +
    r.t.driveN.toFixed(0).padStart(7) + ' ' +
    r.t.vmgTel.toFixed(2).padStart(6) + ' ' +
    r.headingErr.toFixed(1).padStart(6) + '°');
});

console.log('\nПроверки:\n');

const finite = rows.every(([, , r]) => r.finite);
check('модель не расходится ни на одном курсе', finite);

const held = rows.every(([, , r]) => Math.abs(r.headingErr) < 5);
check('авторулевой держит курс', held,
  'наибольшая ошибка ' +
  Math.max(...rows.map(([, , r]) => Math.abs(r.headingErr))).toFixed(1) + '°');

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
// Якорь калибровки. Скорость на галфвинде держится на множителе WAVE_SCALE —
// на сколько занижается посчитанное по Мичеллу волновое сопротивление, — и
// подобран он под оценку владельца лодки. Проверка нужна, чтобы правка не
// проехала мимо этой оценки незамеченной.
//
// Ветер теперь имеет профиль по высоте, и «11.7 узлов» стало двусмысленным:
// на стандартных десяти метрах это одно, у центра парусности на 4.1 м — на
// восьмую часть меньше. Наблюдение владельца — про то, что он чувствовал на
// лодке, поэтому якорь ставится по ветру У РИГА, а ползунок пересчитывается.
//
// И по той же причине экипаж здесь на борту, а шкот с твистом подбираются, а
// не берутся из расписания. Владелец свои восемь с половиной узлов видел на
// лодке, которой правили: экипаж на баллере, парус настроен. Пока центр
// парусности стоял на 3.3 м, разница была невелика, и якорь этого не замечал.
// После обмера парусов центр поднялся до 4.1 м, и она выросла до узла: на
// неоткренённой лодке те же условия дают 7.4 вместо 8.4.
const RIG_WIND = 6.0;                       // м/с на высоте центра парусности
const anchorWind = RIG_WIND / new Boat(PACK).wind.profile(PACK.rig.ce_height_m);
const anchorSpecs = [];
for (const sheet of [20, 26, 32, 38, 44, 50, 56]) {
  for (const twist of [0, 8, 16]) {
    anchorSpecs.push({ twa: 90, sheet: sheet, twist: twist,
                       wind: anchorWind, hike: 1, secs: 120 });
  }
}
const anchorAll = await pool.map(anchorSpecs);
let anchor = null, anchorTrim = null;
anchorAll.forEach((r, i) => {
  if (!anchor || r.speedKn > anchor.t.speedKn) {
    anchor = { t: r };
    anchorTrim = { sheet: anchorSpecs[i].sheet, twist: anchorSpecs[i].twist };
  }
});
console.log('Якорь: у центра парусности ' + (RIG_WIND * KN).toFixed(1) +
  ' уз ветра (на 10 м это ' + (anchorWind * KN).toFixed(1) +
  ' уз), экипаж на борту, шкот ' + anchorTrim.sheet + '° твист ' +
  anchorTrim.twist + '° — галфвинд ' + anchor.t.speedKn.toFixed(2) + ' уз\n');
// Якорь дважды уезжал из-за исправленных в риге ошибок. Обмер парусов по
// чертежу забрал треть узла: 8.8 -> 8.4 (парусности оказалось 22.85 кв.м
// вместо принятых 25). Мембрана забрала ещё семь десятых: 8.4 -> 7.7 — плата
// за то, что индуктивное сопротивление стало считаться по пелене, а не по
// полному местному скосу, где подпор от стакселя на грот выходил тягой из
// ниоткуда.
//
// Оба раза кривую сопротивления сознательно не трогали, чтобы не смешивать
// исправление ошибки с подгонкой. Потом риг починили, кривую пересобрали, а
// затем заменили расчётом: тихая вода по Мичеллу, волнение отдельным
// слагаемым. Подгоняемых чисел осталось два, и держат они два наблюдения —
// этот якорь и лавировочный угол в соседней батарее.
//
// Если якорь снова уедет, сперва искать ошибку в риге, а не крутить множитель.
check('галфвинд в 11.7 узлах ветра у рига около восьми узлов',
  anchor.t.speedKn > 7.3 && anchor.t.speedKn < 9.2,
  anchor.t.speedKn.toFixed(2) + ' уз');

// --- балансировка руля -------------------------------------------------------
//
// Владелец лодки сказал, что на воде она так не валится под ветер, как это
// делала модель. Два теста закрепляют наблюдение: сколько руля нужно, чтобы
// держать курс, и куда лодка идёт, если руль бросить.

console.log('\nБалансировка: руль для удержания курса и поведение с брошенным рулём\n');
console.log('  TWA   руль    через 10 с с брошенным рулём');
const balance = [];
for (const [twa, sheet] of [[45, 14], [60, 22], [90, 40]]) {
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
// чем бывает.
//
// Шкот на каждом курсе подбирается, и экипаж на борту: в лавировку на такой
// лодке иначе не ходят. И то и другое не мелочь. С жёстко заданным шкотом
// проверка мерила не остроту лодки, а то, насколько удачно когда-то угадали
// настройку; без откренивания лодка валится, теряет ход и «умеет» идти круче,
// чем на самом деле, — лавировочный угол выходил на десяток градусов уже.
const beatTwa = [30, 45, 60];
const beatSpecs = [];
for (const twa of beatTwa) {
  for (let sheet = 6; sheet <= 30; sheet += 6) {
    for (const twist of [0, 16]) {
      beatSpecs.push({ twa: twa, sheet: sheet, twist: twist, hike: 1, secs: 120 });
    }
  }
}
const beatAll = await pool.map(beatSpecs);
const beatRows = beatTwa.map((twa, k) => {
  let top = null;
  for (let i = k * 10; i < (k + 1) * 10; i++) {
    const r = beatAll[i];
    if (!top || r.vmg > top.vmg) top = { twa: twa, track: r.track, vmg: r.vmg };
  }
  return top;
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
  // Борт паруса — величина непрерывная (гик переходит за секунду), поэтому
  // считаются смены ЗНАКА, то есть настоящие перебросы, а не каждый шаг взмаха.
  let flips = 0, prev = Math.sign(b.rigSide || 1), jolt = 0, prevSide = null;
  for (let i = 0; i < 180 * 30; i++) {
    const err = wrapPi(0 - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * b.r)));
    b.step(1 / 30);
    if (i < 30 * 30) continue;
    const now = Math.sign(b.rigSide || 1);
    if (now !== prev) flips++;
    prev = now;
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
  check('и едет медленно', at[3] < 4.2, at[3].toFixed(2) + ' уз');
  // Стаксель на отданных шкотах складывается целиком: удержать его дальше
  // тридцати пяти градусов нечем, и он просто уходит по потоку.
  const jib = Math.max(...t.strips.slice(6).map(s => s.cl));
  check('стаксель при этом не работает', jib < 0.2,
    'наибольший cl ' + jib.toFixed(3));
  // Грот на отданном шкоте упирается в ванты и стоит поперёк — какую-то тягу
  // он даёт, потому лодка и ползёт свои неполные три узла. Но заполаскивает он
  // сверху: провисший шкот раскрывает верх сильнее всего, и до угла, ниже
  // которого ткань перестаёт держать форму, верху ближе.
  //
  // Раньше проверка стояла ровно наоборот — «работает верх». Она держалась на
  // прежнем правиле заполаскивания: пороге по модулю угла атаки, одном на весь
  // парус, который про твист ничего не знал.
  check('а грот заполаскивает сверху вниз',
    t.strips[5].cl <= t.strips[0].cl + 0.05,
    'грот: низ ' + t.strips[0].cl.toFixed(2) + ', верх ' + t.strips[5].cl.toFixed(2));
}

// --- независимость от шага ----------------------------------------------------
//
// Самая полезная проверка во всей батарее, и появилась она позже всех.
//
// Физика идёт шагом 1/30 с. Если ответ зависит от величины шага, значит это
// уже не физика, а свойство интегратора. Именно так и вылезло: момент
// откренивания брался по знаку крена, то есть экипаж мгновенно перепрыгивал с
// борта на борт каждый раз, когда крен проходил через ноль. На полных курсах,
// где крен и так около нуля, лодка мелко тряслась на четырёх герцах — вчетверо
// чаще собственной частоты качки, — и амплитуда падала в девять раз при
// уменьшении шага. У физического явления такого быть не может.
//
// Проверяются не траектории (они расходятся от накопления ошибки, и это
// нормально), а размах качки и средний ход.

console.log('\nОдин и тот же ход разным шагом интегрирования:\n');
console.log('    шаг    размах крена   средний ход   пик скорости крена');
const byStep = [];
for (const hz of [30, 240]) {
  const b = new Boat(PACK);
  b.o.windSpeed = 9; b.o.windDir = 140 * D; b.o.sheet = 72 * D;
  b.o.twist = 8 * D; b.o.crewHike = 1; b.o.crewMass = 240;
  b.wind.o.gust = 0.45; b.wind.o.shift = 0.45 * 45 * D;
  b.u = 3.2; b.o.rudder = 0; b.o.rudderTarget = null;
  let lo = 9e9, hi = -9e9, sum = 0, n = 0, peak = 0;
  for (let i = 0; i < 30 * hz; i++) {
    b.step(1 / hz);
    if (i < 8 * hz) continue;              // переходный процесс пропускаем
    const h = b.telemetry.heelDeg;
    lo = Math.min(lo, h); hi = Math.max(hi, h);
    sum += b.telemetry.speedKn; n++;
    peak = Math.max(peak, Math.abs(b.p_ / D));
  }
  byStep.push({ hz, range: hi - lo, speed: sum / n, peak });
  console.log('   1/' + String(hz).padEnd(5) + (hi - lo).toFixed(2).padStart(10) +
    '°' + (sum / n).toFixed(3).padStart(13) + ' уз' +
    peak.toFixed(1).padStart(16) + '°/с');
}
console.log('');
const [coarse, fine] = byStep;
check('размах качки не зависит от шага',
  Math.abs(coarse.range - fine.range) < 0.25 * fine.range + 0.05,
  coarse.range.toFixed(2) + '° против ' + fine.range.toFixed(2) + '°');
check('средний ход не зависит от шага',
  Math.abs(coarse.speed - fine.speed) < 0.02 * fine.speed,
  coarse.speed.toFixed(3) + ' против ' + fine.speed.toFixed(3) + ' уз');
check('скорость качки не зависит от шага',
  Math.abs(coarse.peak - fine.peak) < 0.3 * fine.peak + 0.2,
  coarse.peak.toFixed(1) + ' против ' + fine.peak.toFixed(1) + ' °/с');

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

// --- киль и руль как система -----------------------------------------------------
//
// Два крыла одно за другим, и заднее сидит в пелене переднего. Скос от киля
// съедает у пера почти весь угол дрейфа: незаложенный руль на ходу несёт мало,
// а его подъёмная сила завалена назад — это индуктивное сопротивление сверх
// собственного.
//
// Плюс сопротивление стыка киля с корпусом: в углу, где перо входит в днище,
// сливаются пограничные слои и сворачивается подковообразный вихрь. Величина
// по Хёрнеру, из снятых с чертежа толщины и хорды.
console.log('\nКиль и руль: скос от киля и стык с корпусом\n');
{
  const b = new Boat(PACK);
  b.o.windSpeed = 6; b.o.windDir = 45 * D; b.o.sheet = 14 * D; b.o.twist = 8 * D;
  b.o.crewHike = 1; b.o.crewMass = 240;
  b.u = 3; b.phi = 12 * D;
  for (let i = 0; i < 60 * 30; i++) {
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * -b.psi - 0.9 * b.r)));
    b.step(1 / 30);
  }
  const t = b.telemetry;
  const k = PACK.foils.keel, r = PACK.foils.rudder;
  console.log('  дрейф ' + t.leewayDeg.toFixed(1) + '°, руль ' +
    (b.o.rudder / D).toFixed(1) + '°, боковая киля ' + t.keelLiftN.toFixed(0) +
    ' Н, пера ' + t.rudderLiftN.toFixed(0) + ' Н');
  const jq = 0.5 * PACK.environment.rho_water * k.junction_cda_m2 * t.speed * t.speed;
  console.log('  стык киля с корпусом: cx·S ' + k.junction_cda_m2.toFixed(5) +
    ' кв.м, на этом ходу ' + jq.toFixed(1) + ' Н из ' + t.resistN.toFixed(0) + '\n');

  check('перо в пелене киля несёт много меньше киля',
    Math.abs(t.rudderLiftN) < 0.35 * Math.abs(t.keelLiftN),
    Math.abs(t.rudderLiftN).toFixed(0) + ' против ' + Math.abs(t.keelLiftN).toFixed(0) + ' Н');
  check('но не ноль: руля лодка слушается',
    Math.abs(b.o.rudder / D) > 0.5 && Math.abs(b.o.rudder / D) < 8,
    (b.o.rudder / D).toFixed(1) + '°');
  // Сопротивление стыка — не подгонка: оно целиком из геометрии сечения.
  check('стык киля даёт заметную, но не главную долю сопротивления',
    jq > 0.5 && jq < 0.1 * t.resistN,
    jq.toFixed(1) + ' Н из ' + t.resistN.toFixed(0) + ' Н');

  // Бульб. Своего сопротивления у него не было вовсе: у пера с рулём оно идёт
  // через профильный коэффициент крыла, отнесённый к площади в плане, а бульб —
  // тело вращения, и он просто выпал.
  const bl = PACK.foils.bulb;
  const re = t.speed * bl.length_m / PACK.environment.nu_water;
  const cf = 0.075 / Math.pow(Math.log10(re) - 2, 2);
  const bq = 0.5 * PACK.environment.rho_water * cf * bl.form_factor *
             bl.wetted_m2 * t.speed * t.speed;
  console.log('  бульб: ' + bl.length_m.toFixed(2) + '×' + bl.diameter_m.toFixed(2) +
    ' м, смоченная ' + bl.wetted_m2.toFixed(3) + ' м², на этом ходу ' +
    bq.toFixed(1) + ' Н\n');
  // Смоченная у торпеды обязана лежать между цилиндром тех же габаритов и
  // шаром того же объёма. Проверяется верхняя граница — она геометрическая и
  // не зависит от объёма.
  check('смоченная бульба меньше цилиндра тех же габаритов',
    bl.wetted_m2 < Math.PI * bl.diameter_m * bl.length_m &&
    bl.wetted_m2 > 0.6 * Math.PI * bl.diameter_m * bl.length_m,
    (bl.wetted_m2 / (Math.PI * bl.diameter_m * bl.length_m)).toFixed(2) + ' от цилиндра');
  check('надбавка на форму тела вращения в разумных пределах',
    bl.form_factor > 1.05 && bl.form_factor < 1.3, bl.form_factor.toFixed(3));
  check('бульб тормозит заметно, но меньше стыка с килем не выходит',
    bq > jq && bq < 0.1 * t.resistN,
    bq.toFixed(1) + ' Н против ' + jq.toFixed(1) + ' у стыка');
}

// Скос обязан исчезать на заднем ходу: там пелена киля уходит ВПЕРЁД, и перо
// в неё не попадает. Ловится это тем, что на заднем ходу перо несёт наравне с
// килем, а не втрое меньше.
{
  const fwd = new Boat(PACK), back = new Boat(PACK);
  for (const [b, u] of [[fwd, 2.5], [back, -2.5]]) {
    b.o.windSpeed = 0.1; b.u = u; b.v = u * Math.tan(6 * D);
    b.o.rudder = 0; b.o.rudderTarget = null;
    b.step(1 / 30);
  }
  const rf = Math.abs(fwd.telemetry.rudderLiftN) / Math.abs(fwd.telemetry.keelLiftN);
  const rb = Math.abs(back.telemetry.rudderLiftN) / Math.abs(back.telemetry.keelLiftN);
  console.log('Доля пера от киля: на переднем ходу ' + rf.toFixed(2) +
    ', на заднем ' + rb.toFixed(2) + '\n');
  check('на заднем ходу скоса от киля нет', rb > rf * 2,
    rf.toFixed(2) + ' против ' + rb.toFixed(2));
}

// --- сопротивление на крене -------------------------------------------------------
//
// У этой лодки крен меняет обводы сильно: днище плоское и мелкое, осадка
// корпусом пятнадцать сантиметров при ширине больше двух метров, и наветренная
// скула выходит из воды уже на десяти градусах. Смоченная поверхность от этого
// падает — то самое, ради чего швертботы кренят в слабый ветер.
//
// Волновая часть по крену не меняется, и это записано в build_physics: интеграл
// Мичелла на накренённом корпусе выходит за пределы применимости.
console.log('\nСопротивление корпуса на крене\n');
{
  const H = PACK.resistance.heel;
  const b = new Boat(PACK);
  console.log('  крен  смоченная    LWL   сопротивление на 2.5 м/с');
  for (const h of H) {
    console.log('  ' + (h.heel_deg + '°').padStart(5) + ' ' +
      h.wetted_m2.toFixed(2).padStart(8) + ' м² ' + h.lwl_m.toFixed(2).padStart(6) +
      ' м ' + b.hullResistance(2.5, h.heel_deg).toFixed(0).padStart(12) + ' Н');
  }
  console.log('');
  check('таблица по крену есть и начинается с ровного киля',
    H && H.length >= 3 && H[0].heel_deg === 0);
  // Ровный киль обязан совпасть с основной кривой ДО ЗНАКА: иначе вся привязка
  // к наблюдениям, сделанная на ней, поедет от одного добавления крена.
  {
    let worst = 0;
    for (const row of PACK.resistance.curve) {
      worst = Math.max(worst, Math.abs(b.hullResistance(row.v_ms, 0) - row.rt_n));
    }
    check('на нуле крена кривая ровно прежняя', worst < 1e-9,
      worst.toExponential(1) + ' Н');
  }
  check('смоченная поверхность падает с креном',
    H.every((h, i) => i === 0 || h.wetted_m2 < H[i - 1].wetted_m2),
    H.map(h => h.wetted_m2.toFixed(2)).join(' → ') + ' м²');
  check('сопротивление на крене меньше, но не втрое',
    b.hullResistance(2.5, 20) < b.hullResistance(2.5, 0) &&
    b.hullResistance(2.5, 20) > 0.7 * b.hullResistance(2.5, 0),
    (b.hullResistance(2.5, 20) / b.hullResistance(2.5, 0)).toFixed(3) + ' от ровного киля');
  // Между узлами таблицы и за её краем модель обязана вести себя разумно.
  check('между углами таблицы сопротивление меняется плавно',
    [5, 15, 25].every(a => {
      const v = b.hullResistance(2.5, a);
      return v < b.hullResistance(2.5, a - 5) + 1e-9 &&
             v > b.hullResistance(2.5, a + 5) - 1e-9;
    }));
  check('за краем таблицы не разваливается',
    Math.abs(b.hullResistance(2.5, 60) - b.hullResistance(2.5, 30)) < 1e-9);
}

// --- бесконечная вода --------------------------------------------------------
//
// Главная проверка всей затеи с акваторией, и самая дешёвая. Лодка обязана
// ходить без неё: на бесконечной воде гоняются батареи, воспроизводятся прежние
// записи и меряются ходовые качества лодки, а не места.
//
// Проверяется не «примерно так же», а ПОБИТОВО. Отсутствие акватории — это не
// режим со своими коэффициентами, а отсутствие данных: все выборки отвечают
// «не знаю», течение равно точному нулю, и сложение с ним не меняет ни одного
// разряда мантиссы. Если когда-нибудь разойдётся хоть в последнем знаке —
// значит в горячий путь просочилась ветка, которой там быть не должно.
console.log('\nБесконечная вода: акватория выключаема\n');
{
  const run = terrain => {
    const b = new Boat(PACK, terrain);
    b.o.windSpeed = 7; b.o.windDir = 55 * D; b.o.sheet = 18 * D;
    b.o.twist = 8 * D; b.o.crewHike = 1; b.o.crewMass = 240;
    b.wind.o.gust = 0.25; b.wind.o.shift = 8 * D;
    b.u = 3.5; b.phi = 10 * D;
    for (let i = 0; i < 90 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * wrapPi(0 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    return [b.x, b.y, b.psi, b.u, b.v, b.r, b.phi, b.p_, b.hike, b.t,
            b.telemetry.speedKn, b.telemetry.driveN, b.telemetry.sideN];
  };
  const none = run(undefined);          // акватории нет вовсе
  const empty = run(new Terrain(null)); // акватория есть, данных в ней нет
  let worst = 0;
  for (let i = 0; i < none.length; i++) worst = Math.max(worst, Math.abs(none[i] - empty[i]));
  console.log('  90 с хода в порывистый ветер, ' + none.length +
    ' величин состояния: расхождение ' + worst.toExponential(1) + '\n');
  check('пустая акватория не меняет ни одного разряда', worst === 0,
    worst.toExponential(1));
  check('пустая акватория не считается готовой',
    !(new Terrain(null).ready) && !(new Boat(PACK, new Terrain(null)).terrain));
  // Течение обязано быть точным нулём, а не «около нуля»: оно складывается со
  // скоростью каждый шаг, и любой мусор в нём немедленно уедет в положение.
  {
    const v = new Terrain(null).current({ x: 1, y: 1 });
    check('без данных течение — точный ноль',
      Object.is(v.x, 0) && Object.is(v.y, 0), v.x + ', ' + v.y);
  }
  check('выборки без данных отвечают «не знаю»',
    new Terrain(null).shore() === null && new Terrain(null).fetch() === null &&
    new Terrain(null).wind() === null);
}

console.log('\n' + (failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
