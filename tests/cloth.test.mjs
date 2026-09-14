// Ткань генакера: node tests/cloth.test.mjs
//
// Свидетель для `sim/cloth.js` — шага Б2 плана (docs/gennaker-sota-plan.md):
// полотно генакера считается тканью, а не построчно.
//
// Проверяется решатель, и проверяется тем единственным, с чем его можно сверить
// помимо самого себя, — ТЕОРИЕЙ. Натянутая строка нерастяжимой ткани под
// равномерным давлением это дуга окружности, у которой отношение длины к хорде
// известно; отсюда и пузо. Сравнение идёт с ТОЧНОЙ дугой, а не с
// `camberOfSlack`: последняя — её предел при малом пузе, и при избытке длины в
// сорок процентов ошибается на одиннадцать, то есть больше проверяемого.
//
// Сверка идёт на ткани БЕЗ ЖЁСТКОСТИ НА ИЗЛОМ, и это не поблажка, а условие
// применимости: с изломом строка перестаёт быть чистой нитью, а нить и есть то,
// для чего дуга выведена. Рабочая же ткань с изломом проверяется своим — тем,
// ради чего он и заведён: полотно не должно складываться в гармошку.
//
// Что здесь НЕ проверяется: покой. У мембраны под следящей нагрузкой равновесие
// мягкое, и размах узла за пять секунд при замороженном входе держится
//сорока…сотен миллиметров против двадцати, названных планом. Числа записываются
// ниже; ставить их проверкой рано — сперва надо развести, где тут физика
// (настоящий спинакер по слабине дышит), а где недостающая связь с решёткой,
// которую даст Б3.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { Cloth, CLOTH_ROWS, CLOTH_COLS } from '../sim/cloth.js';
import { STRIPS, gennakerClew } from '../sim/aero.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;

let bad = 0;
function check(ok, what, got) {
  if (!ok) bad++;
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${what}${got != null ? ': ' + got : ''}`);
}

function wrapPi(a) {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
function hold(b) {
  const e = wrapPi(0 - b.psi);
  b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * e - 0.9 * b.r)));
}

// Установившийся ход с генакером и ткань на нём.
function boatFor(twa, len) {
  const b = new Boat(PACK);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.crewHike = -1; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = len;
  b.reset();
  b.o.windSpeed = 6; b.o.windDir = twa * D; b.u = 3;
  return b;
}

function run(twa, len, secs = 25) {
  const b = boatFor(twa, len);
  const cloth = new Cloth(b.rig.sails[2], 2);
  let ms = 0, n = 0;
  for (let i = 0; i < secs * 30; i++) {
    hold(b); b.step(1 / 30);
    const t = process.hrtime.bigint();
    cloth.step(b, 1 / 30);
    ms += Number(process.hrtime.bigint() - t) / 1e6; n++;
  }
  return { b, cloth, ms: ms / n };
}

// Наибольшее растяжение связи, в долях длины покоя.
function stretch(cl) {
  let worst = 0;
  for (let k = 0; k < cl.ci.length; k++) {
    const a = cl.ci[k] * 3, c = cl.cj[k] * 3;
    const d = Math.hypot(cl.pos[c] - cl.pos[a], cl.pos[c + 1] - cl.pos[a + 1],
                         cl.pos[c + 2] - cl.pos[a + 2]);
    worst = Math.max(worst, (d - cl.rest[k]) / cl.rest[k]);
  }
  return worst;
}

// Длина строки по полотну и по выкройке.
function rowLen(cl, r) {
  let arc = 0, mat = 0;
  for (let c = 0; c + 1 < CLOTH_COLS; c++) {
    const a = (r * CLOTH_COLS + c) * 3, b = (r * CLOTH_COLS + c + 1) * 3;
    arc += Math.hypot(cl.pos[b] - cl.pos[a], cl.pos[b + 1] - cl.pos[a + 1],
                      cl.pos[b + 2] - cl.pos[a + 2]);
    const i = r * CLOTH_COLS + c, j = i + 1;
    mat += Math.hypot(cl.px[i] - cl.px[j], cl.py[i] - cl.py[j]);
  }
  return { arc, mat };
}

// Пузо равномерно нагруженной нити: дуга окружности, у которой отношение длины
// к хорде равно k. θ/sin θ = k находится делением пополам, дальше
// пузо/хорда = (1 − cos θ)/(2 sin θ). Точная задача, приближений нет.
function arcCamber(k) {
  if (!(k > 1.0000001)) return 0;
  let lo = 1e-6, hi = Math.PI - 1e-6;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (m / Math.sin(m) < k) lo = m; else hi = m;
  }
  const t = (lo + hi) / 2;
  return (1 - Math.cos(t)) / (2 * Math.sin(t));
}

// Размах узла за пять секунд при ЗАМОРОЖЕННОМ входе: лодка стоит, полоски не
// меняются, и всё, что осталось двигаться, — это собственная жизнь ткани.
function quiver(b, cl, secs = 5) {
  const N = cl.n;
  for (let i = 0; i < 5 * 30; i++) cl.step(b, 1 / 30);   // отстояться
  const lo = new Float64Array(N * 3).fill(1e9), hi = new Float64Array(N * 3).fill(-1e9);
  for (let i = 0; i < secs * 30; i++) {
    cl.step(b, 1 / 30);
    for (let k = 0; k < N * 3; k++) {
      if (cl.pos[k] < lo[k]) lo[k] = cl.pos[k];
      if (cl.pos[k] > hi[k]) hi[k] = cl.pos[k];
    }
  }
  let sw = 0;
  for (let i = 0; i < N; i++)
    sw = Math.max(sw, Math.hypot(hi[i * 3] - lo[i * 3], hi[i * 3 + 1] - lo[i * 3 + 1],
                                 hi[i * 3 + 2] - lo[i * 3 + 2]));
  return sw;
}

console.log('=== ткань на бакштаге и на полном ===\n');

const CASES = [
  { twa: 120, len: 4.5 },
  { twa: 140, len: 5.5 },
  { twa: 160, len: 6.5 },
];

let worstStretch = 0, worstQuiver = 0, worstMs = 0, worstFold = 1;
for (const c of CASES) {
  const { b, cloth, ms } = run(c.twa, c.len);
  const st = stretch(cloth);
  const qv = quiver(b, cloth);
  worstStretch = Math.max(worstStretch, st);
  worstQuiver = Math.max(worstQuiver, qv);
  worstMs = Math.max(worstMs, ms);
  console.log(`TWA ${c.twa}°, шкот ${c.len} м: ход ${b.telemetry.speedKn.toFixed(2)} уз, ` +
              `${ms.toFixed(3)} мс/шаг, растяжение ${(st * 100).toFixed(2)} %, ` +
              `дрожь ${(qv * 1000).toFixed(1)} мм`);
  console.log('  стр  дуга/ткань   пузо ткани   пузо дуги из запаса   отнош');
  for (let r = 0; r < CLOTH_ROWS; r++) {
    const { arc, mat } = rowLen(cloth, r);
    const rc = cloth.rowCamber(r);
    if (rc.chord < 0.05) continue;
    // Мембрана из ТОГО ЖЕ запаса: строка натянута дугой, длина дуги равна длине
    // ткани, хорда известна. Сравнивать надо именно так — у полоски свой запас
    // и своя хорда, а тут проверяется решатель, а не согласие двух моделей.
    const mem = arcCamber(mat / rc.chord);
    if (rc.chord > 0.3) worstFold = Math.min(worstFold, arc / mat);
    const taut = arc / mat > 0.99;
    console.log(`   ${String(r).padStart(2)}   ${(arc / mat).toFixed(3)}${taut ? ' туго' : '     '}` +
                `     ${rc.camber.toFixed(4)}       ${mem.toFixed(4)}          ` +
                `${mem > 1e-6 ? (rc.camber / mem).toFixed(2) : '-'}`);
  }
  const ls = cloth.luffSag();
  console.log(`  провис передней ${ls.sag.toFixed(3)} м на ${(ls.at * 100).toFixed(0)} % высоты ` +
              `(полоскам предписано ${cloth.sail.gennaker ? '1.212 м на 50 %' : '0'})`);
  console.log(`  шкотовый угол выше галса на ${cloth.clewRise().toFixed(3)} м\n`);
}

console.log('=== та же ткань без жёсткости на излом: сверка с теорией ===\n');
console.log('Без излома натянутая строка — равномерно нагруженная нить, и её дуга');
console.log('известна точно. Это единственная сверка решателя не с самим собой.\n');

let tautSeen = 0, worstMem = 0;
for (const c of CASES) {
  const b = boatFor(c.twa, c.len);
  const cloth = new Cloth(b.rig.sails[2], 2, { bend: 0 });
  for (let i = 0; i < 25 * 30; i++) { hold(b); b.step(1 / 30); cloth.step(b, 1 / 30); }
  const line = [];
  for (let r = 0; r < CLOTH_ROWS; r++) {
    const { arc, mat } = rowLen(cloth, r);
    const rc = cloth.rowCamber(r);
    const mem = arcCamber(mat / rc.chord);
    if (!(arc / mat > 0.99 && rc.chord > 0.5 && mem > 0.05)) continue;
    tautSeen++;
    worstMem = Math.max(worstMem, Math.abs(rc.camber / mem - 1));
    line.push(`${r}: ${(rc.camber / mem).toFixed(2)}`);
  }
  console.log(`TWA ${c.twa}°: пузо ткани к точной дуге по натянутым строкам — ` +
              (line.length ? line.join(', ') : 'натянутых строк нет'));
}
console.log('');

// --- что проверяется ---------------------------------------------------------

check(worstStretch < 0.03, 'ткань не растягивается (предел 3 %)',
      (worstStretch * 100).toFixed(2) + ' %');

check(worstFold > 0.97, 'ткань не складывается в гармошку (дуга/ткань не ниже 0.97)',
      worstFold.toFixed(3));

// По одной строке на случай: без излома натягивается только нижняя — у неё оба
// конца закреплены и нагрузка наибольшая, — а всё, что выше, складывается. Это
// не бедность свидетеля, а ровно то, ради чего излом и заведён; сама складчатость
// проверена выше.
check(tautSeen >= CASES.length,
      'натянутых строк без излома, на которых есть что сравнивать', tautSeen);
check(worstMem < 0.20, 'натянутая строка совпадает с точной дугой (предел 20 %)',
      (worstMem * 100).toFixed(1) + ' %');

// Цена меряется стенными часами, и это единственная здесь проверка, которая
// зависит от машины. На свободной выходит 0.29…0.39 мс; если гонять пять батарей
// разом, она доходит до предела и краснеет — не от правки, а от соседей. Батареи
// в `make test` идут по очереди, так что в штатном прогоне это не случается.
check(worstMs < 0.6, 'цена шага ткани (предел 0.6 мс)', worstMs.toFixed(3) + ' мс');

// --- что осталось открытым: числа записываются, проверкой не являются --------
{
  const g = PACK.rig.gennaker;
  const dd = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const built = dd([g.head[0], 0, g.head[1]], gennakerClew({ genSheetLen: 5.5 }, g));
  console.log('\n--- открыто: числа записываются, проверкой не являются ---');
  console.log(`колебание на замороженном входе: размах узла до ` +
              `${(worstQuiver * 1000).toFixed(0)} мм за 5 с (цель §Б2 — 20 мм)`);
  console.log(`задняя шкаторина по крою ${g.leech_m.toFixed(3)} м при прямой ` +
              `фал—шкот ${built.toFixed(3)} м; у построчной сборки та же шкаторина ` +
              `выходит 10.7 м — на 17 % длиннее, чем на парусе ткани. Это и есть`);
  console.log('то, ради чего заведён Б3: пока полоски разложены горизонтальным');
  console.log('веером, две поверхности несовместимы, и ткань платит за это складкой.');
}

console.log(bad ? `\nПЛОХО: ${bad}` : '\nвсё ок');
process.exit(bad ? 1 : 0);
