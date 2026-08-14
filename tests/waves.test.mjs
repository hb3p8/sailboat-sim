// Волнение: node tests/waves.test.mjs
//
// Две вещи проверяются порознь. Первая — состояние моря по ветру и разгону:
// оно должно давать то, что видно на воде, а не абстракцию. Вторая —
// добавочное сопротивление: оно обязано жить у резонанса, зависеть от курса к
// волне так, как зависит на воде, и обращаться в ноль на гладкой воде.
//
// Ради последнего всё и затевалось: волна штрафует приведение сильнее
// уваливания, и без этого перекоса лодка лавирует круче, чем бывает.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { seaState, addedResistance } from '../sim/waves.js';
import { Boat } from '../sim/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

// --- состояние моря -----------------------------------------------------------

console.log('\nВолна по ветру и разгону (высота значительная, период пика):\n');
console.log('  ветер    разгон 1 км      3 км            8 км');
for (const u of [3, 6, 11, 16]) {
  let line = '  ' + (u + ' м/с').padEnd(9);
  for (const f of [1000, 3000, 8000]) {
    const s = seaState(u, f);
    line += ((100 * s.hs).toFixed(0) + ' см ' + s.tp.toFixed(2) + ' с').padEnd(16);
  }
  console.log(line);
}
console.log('');

const s6 = seaState(6, 3000);
check('на заливе в 12 узлов ветра волна по колено',
  s6.hs > 0.10 && s6.hs < 0.30, (100 * s6.hs).toFixed(0) + ' см');
check('её длина сравнима с длиной лодки',
  1.56 * s6.tp * s6.tp > 3 && 1.56 * s6.tp * s6.tp < 8,
  (1.56 * s6.tp * s6.tp).toFixed(1) + ' м при длине по КВЛ ' +
  PACK.hydrostatics.lwl_m.toFixed(1) + ' м');
check('на гладкой воде волны нет', seaState(6, 0).hs === 0);
check('волна растёт и с ветром, и с разгоном',
  seaState(11, 3000).hs > seaState(6, 3000).hs &&
  seaState(6, 8000).hs > seaState(6, 1000).hs);
check('разгон насыщается: полностью развитое волнение',
  seaState(6, 1e9).hs < 1.0, (100 * seaState(6, 1e9).hs).toFixed(0) + ' см');

// --- добавочное сопротивление -------------------------------------------------

const WN = 2 * Math.PI / PACK.seakeeping.heave_period_s;
const B = PACK.hydrostatics.bwl_m, L = PACK.hydrostatics.lwl_m;
const raw = (v, cos) => addedResistance(s6, WN, B, L, v, cos, PACK.seakeeping.wave_peak);

console.log('\nДобавочное сопротивление при 12 узлах ветра, скорость 2.6 м/с:\n');
console.log('  курс к волне            Rдоб');
const cases = [['точно в лоб', -1], ['под 45° в лоб', -0.707], ['лагом', 0],
               ['под 45° в корму', 0.707], ['точно в корму', 1]];
for (const [name, c] of cases) {
  console.log('  ' + name.padEnd(22) + raw(2.6, c).toFixed(0).padStart(5) + ' Н  ' +
    '#'.repeat(Math.round(raw(2.6, c) / 3)));
}
console.log('');
check('встречная волна тормозит сильнее всего',
  raw(2.6, -1) > raw(2.6, 0) && raw(2.6, -1) > raw(2.6, 1),
  raw(2.6, -1).toFixed(0) + ' против ' + raw(2.6, 0).toFixed(0) + ' лагом и ' +
  raw(2.6, 1).toFixed(0) + ' в корму');
check('на попутной волне почти ничего не теряется',
  raw(2.6, 1) < 0.35 * raw(2.6, -1),
  (100 * raw(2.6, 1) / raw(2.6, -1)).toFixed(0) + '% от встречной');
check('на гладкой воде добавки нет',
  addedResistance(seaState(6, 0), WN, B, L, 2.6, -1, 6) === 0);
check('добавка растёт как квадрат высоты волны', (() => {
  const a = addedResistance(seaState(6, 3000), WN, B, L, 2.6, -1, 6);
  const big = seaState(6, 3000); big.hs *= 2;
  return Math.abs(addedResistance(big, WN, B, L, 2.6, -1, 6) / a - 4) < 1e-9;
})());

// Резонанс: он и есть причина, по которой малая лодка так проваливается на
// встречной волне. Частота встречи обязана проходить через собственную.
{
  console.log('Частота встречи и добавка по скорости, волна в лоб:\n');
  console.log('  скорость   ω встречи   Rдоб');
  const rows = [];
  for (const v of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    const w = s6.omega, k = w * w / 9.80665;
    const we = w + k * v;
    rows.push({ v, we, r: raw(v, -1) });
    console.log('  ' + (v + ' м/с').padEnd(11) + we.toFixed(2).padStart(7) + '  ' +
      raw(v, -1).toFixed(0).padStart(6) + ' Н');
  }
  console.log('\n  собственная частота вертикальной качки ' + WN.toFixed(2) +
    ' рад/с (период ' + PACK.seakeeping.heave_period_s.toFixed(2) + ' с)\n');
  const peak = rows.reduce((a, b) => (b.r > a.r ? b : a));
  check('пик добавки стоит там, где частота встречи близка к собственной',
    Math.abs(peak.we / WN - 1) < 0.35,
    'на пике ω встречи ' + peak.we.toFixed(2) + ' против собственной ' + WN.toFixed(2));
}

// --- что это делает с лодкой --------------------------------------------------
//
// Главная проверка: волна должна штрафовать приведение сильнее уваливания.
// Иначе она не тронет лавировочный угол, а ради него всё и делалось.

{
  const wrapPi = a => { a %= 2 * Math.PI; if (a > Math.PI) a -= 2 * Math.PI;
                        if (a < -Math.PI) a += 2 * Math.PI; return a; };
  const run = (twa, sheet, twist, fetch) => {
    const b = new Boat(PACK);
    b.o.windSpeed = 6; b.o.windDir = twa * D; b.o.sheet = sheet * D;
    b.o.twist = twist * D; b.o.crewHike = -1; b.o.crewMass = 240;  // наветренный
    b.o.fetch = fetch; b.u = 3; b.phi = 10 * D;
    for (let i = 0; i < 90 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
        -(2.2 * wrapPi(0 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    return b.telemetry.speedKn;
  };
  console.log('Потеря хода от волны, ветер 12 узлов, разгон 3 км:\n');
  console.log('  курс     гладкая   с волной   потеря');
  const loss = [];
  for (const [twa, sh, tw] of [[35, 3, 16], [50, 6, 24], [90, 32, 16], [150, 70, 8]]) {
    const flat = run(twa, sh, tw, 0), wavy = run(twa, sh, tw, 3000);
    loss.push({ twa, pct: 100 * (flat - wavy) / flat });
    console.log('  TWA ' + String(twa).padStart(3) + '° ' +
      flat.toFixed(2).padStart(8) + ' ' + wavy.toFixed(2).padStart(10) + ' ' +
      (100 * (flat - wavy) / flat).toFixed(1).padStart(7) + '%');
  }
  console.log('');
  check('в лавировку волна отнимает больше, чем на полном курсе',
    loss[0].pct > loss[3].pct + 3,
    loss[0].pct.toFixed(1) + '% против ' + loss[3].pct.toFixed(1) + '%');
  check('потеря в лавировку в разумных пределах',
    loss[0].pct > 3 && loss[0].pct < 25, loss[0].pct.toFixed(1) + '%');
  // Проверяется, что с уваливанием потеря падает — но не по соседним острым
  // курсам. Между 35 и 50 градусами она у модели почти одинакова, и это не
  // сбой: на пятидесяти лодка идёт быстрее, частота встречи уходит дальше от
  // резонанса, зато сама лодка сидит на более крутом участке кривой
  // сопротивления, и одно почти точно гасит другое. Разница там в десятые доли
  // процента, и требовать от неё знака — значит проверять шум.
  //
  // Настоящее убывание видно на полных курсах, и вот его и проверяем: острый
  // курс против галфвинда и галфвинд против фордевинда.
  check('с уваливанием потеря от волны падает',
    loss[1].pct > loss[2].pct + 2 && loss[2].pct > loss[3].pct,
    loss.map(l => l.twa + '° ' + l.pct.toFixed(1) + '%').join(', '));
}

console.log((failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
