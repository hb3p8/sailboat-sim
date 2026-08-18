// Глиссирование — node tests/planing.test.mjs
//
// Свидетель написан ДО модели и потому сначала красный. Это не оплошность, а
// порядок: пока не сказано, чем проверять, «сделано» проверить нечем.
//
// Большинство проверок — о ФОРМЕ ответа, то есть о том, что можно утверждать
// без данных:
//
//   • ниже числа Фруда 0.5 не изменилось ничего;
//   • удельное сопротивление перестаёт расти — то есть горб есть;
//   • смоченная поверхность сокращается;
//   • дифферент уходит на корму и остаётся в единицах градусов;
//   • выход — событие: у горба малая прибавка тяги даёт большую прибавку хода.
//
// Числовая точка здесь ОДНА, и её происхождение обязано быть на виду: порог
// «выходит не позже 14 узлов истинного» взят из маркетингового заявления о
// лодке («очень хорошо выходит на глиссирование — намного быстрее SB20 или даже
// Melges»; те выходят при 14…16 узлах). Это низший класс источника, но
// единственные полевые данные: сам владелец на SV20 не глиссировал — на его
// реке 14 узлов редкость. Первое настоящее наблюдение с воды обязано заменить
// и порог, и эту запись (docs/planing.md).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { hullResistance, planing, humpSquat } from '../sim/hydro.js';
import { Buoyancy } from '../sim/buoyancy.js';
import { modeLine } from './lib/mode.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const E = PACK.environment, H = PACK.hydrostatics;
const W = PACK.mass.total_kg * E.g;
const FN = v => v / Math.sqrt(E.g * H.lwl_m);
const KN = 1.94384;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

console.log('\nГлиссирование\n');
console.log(modeLine() + '\n');
console.log('  вес %s Н, LWL %s м, BWL %s м, смоченная %s м²\n',
  W.toFixed(0), H.lwl_m.toFixed(2), H.bwl_m.toFixed(2), H.wetted_m2.toFixed(2));

// --- инвариант: вытесняющий режим не тронут ------------------------------------
//
// Самая важная проверка во всём файле, и она же самая дешёвая. Ниже Fn 0.5 лежит
// всё, что откалибровано по наблюдению владельца: лавировка, дрейф, крен, поляра.
// Любая правка глиссирования, которая сдвинула там хоть один разряд, — ошибка,
// пока не доказано обратное.
{
  const vHump = 0.5 * Math.sqrt(E.g * H.lwl_m);
  let worst = 0, at = 0;
  for (let v = 0.1; v <= vHump; v += 0.05) {
    const want = hullResistance(PACK, v, 0);
    const table = PACK.resistance.curve;
    // Прямая выборка из таблицы тем же способом, каким её читает модель на
    // нулевом крене: если глиссирование сюда не лезет, числа обязаны совпасть.
    let got = 0;
    for (let i = 0; i < table.length - 1; i++) {
      if (v <= table[i + 1].v_ms) {
        const t = (v - table[i].v_ms) / (table[i + 1].v_ms - table[i].v_ms);
        got = table[i].rt_n + t * (table[i + 1].rt_n - table[i].rt_n);
        break;
      }
    }
    const d = Math.abs(want - got);
    if (d > worst) { worst = d; at = v; }
  }
  console.log('  вытесняющий режим (Fn до 0.5, то есть до %s уз): наибольшее отличие %s Н\n',
    (vHump * KN).toFixed(1), worst.toExponential(1));
  check('ниже Fn 0.5 сопротивление не изменилось ни на разряд',
    worst < 1e-9, worst.toExponential(1) + ' Н при ' + (at * KN).toFixed(1) + ' уз');
}

// --- буксировка: полное сопротивление модели --------------------------------------
//
// ЗДЕСЬ БЫЛА ОШИБКА СВИДЕТЕЛЯ, и она стоит записи: первые версии проверок горба
// и события мерили голую таблицу `hullResistance(P, v, 0)` — а Савицкий и
// просадка кормы живут в шаге физики и в таблицу не попадают. Свидетель был
// слеп к той самой модели, которую должен был принимать: он остался бы красным
// при любой правильной правке. Проверки переведены на буксировочное равновесие —
// решается посадка (всплытие и дифферент) чистого корпуса при заданном ходе, с
// собственной волной и днищем, и сопротивление снимается с РЕШЁННОЙ посадки.
// Это то же, что меряют в опытовом бассейне.
const buoy = new Buoyancy(PACK);
const cgx = PACK.mass.cg_m[0], cgz = PACK.mass.cg_m[2];
function towed(v) {
  let zc = -0.0001, th = 0;
  const hump = humpSquat(PACK, v);
  for (let it = 0; it < 400; it++) {
    const h = buoy.at(zc, 0, th, hump);
    const pl = planing(PACK, v, th, h);
    const lift = pl ? pl.lift : 0;
    const fb = E.rho_water * E.g * h.volume;
    const nx = Math.sin(th), nz = Math.cos(th);
    let mth = fb * ((h.cbx - cgx) * nz - (h.cbz - cgz) * nx);
    if (lift > 0) mth += lift * (pl.xcp - cgx) * nz;
    const kh = E.rho_water * E.g * Math.max(0.5, h.awp);
    const kp = E.rho_water * E.g * Math.max(0.5, h.ilong);
    zc += 0.6 * (fb + lift - W) / kh;
    th = Math.max(-0.3, Math.min(0.3, th + 0.6 * mth / kp));
  }
  const h = buoy.at(zc, 0, th, hump);
  const pl = planing(PACK, v, th, h);
  const rt = hullResistance(PACK, v, 0, pl ? pl.mods : null) +
             (pl && pl.lift > 0 ? pl.lift * Math.tan(pl.tau * Math.PI / 180) : 0);
  return { rt, th, pl, wetted: h.wetted };
}

// --- горб и полка ---------------------------------------------------------------
//
// У вытесняющего корпуса удельное сопротивление растёт с ходом без предела. У
// глиссирующего оно обязано пройти через горб и ПОЙТИ ВНИЗ: смоченная
// поверхность сокращается, транец осушается, волновая часть уходит.
//
// Требуется именно убывание, а не «перестало расти», и первая версия этой
// проверки на том и обожглась. У вытесняющей кривой после фрудовского горба на
// Fn 0.41 есть плечо — прирост падает вдвое и держится, — и всякая проверка вида
// «прирост сошёл на нет» зелёная на модели, где глиссирования нет вовсе.
// Убывание удельного сопротивления плечом не подделать: у вытесняющего корпуса
// его не бывает.
//
// И второе, чему нельзя верить: таблица сопротивления КОНЧАЕТСЯ на Fn 1.23, а
// `lerpTable` за краем отдаёт последнее значение. Получается ровно полка, и
// первая версия проверки радостно её нашла. Поэтому вся развёртка держится
// внутри таблицы, а то, что за её краем модели нечего сказать, — отдельная
// дыра, которую глиссирование обязано закрыть.
{
  console.log('  Удельное сопротивление по ходу (буксировка, посадка решается):\n');
  console.log('     уз     Fn    Rt, Н    Rt/W    прирост Rt/W на узел');
  const vTop = PACK.resistance.curve[PACK.resistance.curve.length - 1].v_ms;
  const rows = [];
  for (let kn = 4; kn / KN <= vTop; kn += 1) {
    const v = kn / KN;
    const rt = towed(v).rt;
    rows.push({ kn, v, fn: FN(v), rt, sp: rt / W });
  }
  for (let i = 0; i < rows.length; i++) {
    const d = i ? rows[i].sp - rows[i - 1].sp : 0;
    rows[i].d = d;
    if (rows[i].kn % 2 === 0)
      console.log('   %s  %s  %s  %s  %s', String(rows[i].kn).padStart(4),
        rows[i].fn.toFixed(2).padStart(5), rows[i].rt.toFixed(0).padStart(7),
        rows[i].sp.toFixed(3).padStart(7),
        (i ? (d >= 0 ? '+' : '') + d.toFixed(4) : '—').padStart(12));
  }
  console.log('');
  console.log('    (таблица кончается на Fn %s, дальше модели сказать нечего)\n',
    FN(vTop).toFixed(2));
  // Горб — ПЕРВЫЙ локальный максимум удельного сопротивления, а не глобальный:
  // у вытесняющей кривой максимума внутри развёртки нет вовсе (она монотонна),
  // так что существование локального горба подделать нечем. Полка — отдельным
  // пунктом: за провалом кривая не имеет права снова уйти выше горба, иначе
  // «выход» кончается стенкой.
  let hump = null;
  for (let i = 1; i < rows.length - 1; i++) {
    if (rows[i].fn > 0.45 && rows[i].sp > rows[i - 1].sp && rows[i].sp >= rows[i + 1].sp) {
      hump = rows[i]; break;
    }
  }
  const after = hump ? rows.filter(r => r.fn > hump.fn) : [];
  const dip = after.length ? Math.min(...after.map(r => r.sp)) : Infinity;
  check('горб есть: локальный максимум, за которым сопротивление идёт вниз',
    hump !== null && dip < 0.95 * hump.sp,
    hump ? 'горб Rt/W ' + hump.sp.toFixed(3) + ' при Fn ' + hump.fn.toFixed(2) +
           ', провал за ним ' + (isFinite(dip) ? dip.toFixed(3) : '—')
         : 'локального максимума нет — кривая монотонна');
  check('горб стоит там, где ему положено — Fn 0.45…0.85',
    hump !== null && hump.fn > 0.45 && hump.fn < 0.85,
    hump ? 'Fn ' + hump.fn.toFixed(2) : '');
  const wall = after.length ? Math.max(...after.map(r => r.sp)) : 0;
  check('полка держится: за провалом кривая не уходит выше горба',
    hump !== null && wall <= hump.sp,
    hump ? 'за горбом до Rt/W ' + wall.toFixed(3) + ' против горба ' + hump.sp.toFixed(3) : '');
}

// --- выход на глиссирование — событие -------------------------------------------
//
// По этому признаку глиссирование и узнают на воде: лодка упирается в горб, а
// потом небольшая прибавка тяги даёт большую прибавку хода. У вытесняющего
// корпуса такого нет — там прибавка хода на прибавку тяги везде примерно одна.
//
// Меряется прямо: для каждой тяги ищется установившийся ход, и смотрится
// производная dV/dT. У неё обязан быть выраженный максимум, а не полка.
{
  const speedAt = drive => {
    // Установившийся ход: сопротивление равно тяге. У кривой С ГОРБОМ корней
    // может быть три (до горба, в провале, на стенке) — берётся НАИБОЛЬШИЙ ход,
    // при котором сопротивление ещё не превышает тягу: разогнавшаяся лодка
    // остаётся на дальней ветви, в этом и есть выход.
    let best = 0;
    for (let v = 0.2; v <= 12; v += 0.05) {
      if (towed(v).rt <= drive) best = v;
    }
    return best;
  };
  console.log('  Ход от тяги (сколько узлов даёт лишняя сотня ньютонов):\n');
  console.log('    тяга, Н    ход, уз    прибавка на 100 Н');
  // Верх развёртки — сопротивление на последней точке таблицы: дальше искать
  // установившийся ход бессмысленно, там у модели данных нет.
  const vTop = PACK.resistance.curve[PACK.resistance.curve.length - 1].v_ms;
  const tTop = towed(vTop).rt;
  const rows = [];
  for (let T = 200; T <= tTop; T += 100) rows.push({ T, v: speedAt(T) });
  for (let i = 1; i < rows.length; i++)
    rows[i].g = (rows[i].v - rows[i - 1].v) * KN;
  for (const r of rows) if (r.T % 400 === 0)
    console.log('    %s   %s     %s', String(r.T).padStart(6),
      (r.v * KN).toFixed(2).padStart(7),
      (r.g === undefined ? '—' : r.g.toFixed(2)).padStart(6));
  console.log('');
  const gs = rows.slice(1);
  const best = gs.reduce((a, r) => (r.g > a.g ? r : a), gs[0]);
  const base = gs.filter(r => r.v * KN < 6).reduce((a, r) => a + r.g, 0) /
               Math.max(1, gs.filter(r => r.v * KN < 6).length);
  // Втрое, а не вдвое, и это тоже урок первой версии: у вытесняющей кривой за
  // фрудовским горбом прибавка сама по себе вырастает вдвое (0.58 -> 1.18 узла
  // на сотню ньютонов), и порога «вдвое» ей хватало. Выход на глиссирование —
  // это не плечо, это скачок.
  check('выход на глиссирование — событие, а не плавность',
    best.g > 3 * base,
    'лучшая прибавка ' + best.g.toFixed(2) + ' уз на 100 Н при ' +
    (best.v * KN).toFixed(1) + ' уз против ' + base.toFixed(2) + ' в вытеснении');
}

// --- посадка: дифферент и смоченная поверхность ---------------------------------
//
// Оба видны в приборах, и оба должны вести себя так, как на воде: нос кверху на
// единицы градусов, смоченная поверхность заметно меньше стояночной.
{
  const D = Math.PI / 180;
  const run = wind => {
    const b = new Boat(PACK);
    b.o.windSpeed = wind; b.o.windDir = 140 * D; b.o.sheet = 70 * D;
    b.o.twist = 8 * D; b.o.crewHike = -1; b.o.crewMass = 240;
    b.setGennaker(true);
    b.reset();
    b.o.windSpeed = wind; b.o.windDir = 140 * D; b.u = 3;
    b.psi = -40 * D;
    for (let i = 0; i < 60 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * (-40 * D - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    return { kn: b.telemetry.speedKn, trim: b.th / D, wet: b.telemetry.wettedM2 };
  };
  console.log('  Бакштаг под генакером, посадка:\n');
  console.log('    ветер     ход      дифферент   смоченная');
  const got = [];
  for (const wind of [6, 10, 14]) {
    const r = run(wind);
    got.push(Object.assign({ wind }, r));
    console.log('    %s м/с  %s уз   %s°     %s м²',
      String(wind).padStart(4), r.kn.toFixed(2).padStart(6),
      r.trim.toFixed(2).padStart(7),
      (r.wet === undefined ? '—' : r.wet.toFixed(2)).padStart(6));
  }
  console.log('');
  const fast = got[got.length - 1], slow = got[0];
  check('на разгоне лодка встаёт носом кверху', fast.trim > slow.trim + 0.5,
    fast.trim.toFixed(2) + '° против ' + slow.trim.toFixed(2) + '°');
  check('и дифферент остаётся в единицах градусов', Math.abs(fast.trim) < 8,
    fast.trim.toFixed(2) + '°');
  check('смоченная поверхность сокращается',
    fast.wet !== undefined && fast.wet < 0.85 * H.wetted_m2,
    (fast.wet === undefined ? 'приборы её не отдают' :
      fast.wet.toFixed(2) + ' против ' + H.wetted_m2.toFixed(2) + ' м²'));
  // Полтора корпусных — не назначенное число, а признак: вытесняющий корпус за
  // свою корпусную скорость выходит на считанные проценты, глиссирующий уходит
  // в полтора-два раза. Конкретную полку сюда впишет первое наблюдение.
  const hull = 1.34 * Math.sqrt(H.lwl_m / 0.3048);
  check('в свежий ветер лодка уходит за полторы корпусных скорости',
    fast.kn > 1.5 * hull,
    fast.kn.toFixed(2) + ' уз при корпусной ' + hull.toFixed(2));
}

// --- порог выхода: единственная числовая точка -----------------------------------
//
// Происхождение порога — в шапке файла. Проверяется не скорость (её источник не
// называет), а сам ФАКТ выхода: при 14 узлах истинного под генакером на бакштаге
// днище несёт заметную долю веса, и лодка идёт быстрее полутора корпусных.
{
  const D2 = Math.PI / 180;
  const b = new Boat(PACK);
  b.o.windSpeed = 7.2; b.o.windDir = 140 * D2; b.o.sheet = 70 * D2;
  b.o.twist = 12 * D2; b.o.crewHike = -1; b.o.crewMass = 240;
  b.setGennaker(true); b.reset();
  b.o.windSpeed = 7.2; b.o.windDir = 140 * D2; b.u = 4; b.psi = 0;
  let frac = 0;
  for (let i = 0; i < 90 * 30; i++) {
    b.o.rudderTarget = Math.max(-25 * D2, Math.min(25 * D2,
      -(2.2 * (0 - b.psi) - 0.9 * b.r)));
    b.step(1 / 30);
    if (i > 45 * 30) frac = Math.max(frac, b.telemetry.planeFrac || 0);
  }
  const t = b.telemetry;
  const hull = 1.34 * Math.sqrt(H.lwl_m / 0.3048);
  console.log('  Порог выхода: 14 уз истинного, бакштаг под генакером —');
  console.log('    ход %s уз (полторы корпусных: %s), днище несёт до %s%% веса, дифферент %s°\n',
    t.speedKn.toFixed(2), (1.5 * hull).toFixed(2),
    (100 * frac).toFixed(0), t.trimDeg.toFixed(2));
  check('при 14 узлах истинного лодка выходит на глиссирование',
    frac > 0.25 && t.speedKn > 1.5 * hull,
    'днище ' + (100 * frac).toFixed(0) + '% веса, ход ' + t.speedKn.toFixed(2) + ' уз');
}

console.log(failures ? '\n' + failures + ' проверок провалено' : '\nвсе проверки прошли');
process.exit(failures ? 1 : 0);
