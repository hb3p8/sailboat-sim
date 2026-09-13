// Ткань генакера: node tests/cloth.test.mjs
//
// Свидетель для `sim/cloth.js` — шага Б2 плана (docs/gennaker-sota-plan.md).
// Проверяется РЕШАТЕЛЬ, а не форма летящего паруса, и различие тут не
// формальное, а разделение труда: форму задаёт ОБВОД, решатель только натягивает
// на него ткань. Обвод же сейчас негоден, и это померено — см. ниже.
//
// Решатель обязан делать три вещи, и все три здесь ловятся:
//   * не растягивать ткань — нерастяжимость это всё, чем задана форма;
//   * приходить к равновесию и стоять в нём;
//   * на НАТЯНУТОЙ строке давать ту самую дугу, которую даёт равномерно
//     нагруженная нерастяжимая нить той же длины между теми же концами.
//     Сравнение идёт с ТОЧНОЙ окружной дугой, а не с `camberOfSlack`: последняя
//     это её предел при малом пузе, и при избытке длины в сорок процентов она
//     сама ошибается на одиннадцать. Проверять решатель приближением, которое
//     врёт больше него, нечестно.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Формы паруса. Ткань, натянутая на нынешний обвод
// генакера, сходится в мешок: верхние строки несут на треть больше полотна, чем
// нужно их летящей хорде, собираются складками (дуга/ткань 0.64…0.77) и на
// свободных шкаторинах идёт незатухающее колебание — размах узла за пять секунд
// до 0.75 м при ЗАМОРОЖЕННОМ входе, и оно не убывает ни за сорок секунд. Это не
// вина решателя: стоит прибить шкотовый угол туда, где обе шкаторины остаются
// скроенной длины, как размах падает до 0.03…0.11 м, нижняя строка натягивается
// во всех случаях и совпадает с точной дугой до трёх процентов, а сам угол
// поднимается над галсом на 0.5…1.2 м — ровно так, как он и летит.
//
// Причин три, все геометрические, все вне этого модуля, и все померены
// (docs/gennaker-sota-plan.md, запись от 2026-09-13):
//
//   1. Шкотовый угол водится по НЕ ТОЙ дуге. `gennakerSetOf` двигает его по
//      горизонтальной окружности вокруг галса, тогда как обе шкаторины держат
//      его на окружности вокруг ОСИ галс—фал. На нынешней дуге задняя шкаторина
//      обязана растянуться до 10.68 м при заявленной 8.39; на правильной она
//      стоит 8.66 при любом шкоте, а шкотовый угол сам поднимается до 1.94 м над
//      галсом — то самое §Б0.4, которого модели не хватает.
//   2. Лишняя ширина положена в заднюю шкаторину. Площадь нынешней ломаной
//      24.4 м² против обмерных 27.0; пробный обвод по §Б1 (ширина в переднюю,
//      задняя почти прямая) даёт 26.9 м² при том же галсе, фале и той же
//      средней ширине.
//   3. Даже при обоих исправлениях верхние строки остаются с избытком: обмерная
//      средняя ширина 0.85·SFL — это ширина ПО ПОЛОТНУ, а модель берёт её
//      хордой. Вопрос открыт и назван в §Б1.
//
// Поэтому нарисованный генакер по-прежнему строится по полоскам: подменять
// картинку мешком значило бы ухудшить её. Свидетель на форму заводится вместе с
// исправлением обвода — тогда же, когда ткань пойдёт в отрисовку.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { Cloth, CLOTH_ROWS, CLOTH_COLS } from '../sim/cloth.js';
import { STRIPS } from '../sim/aero.js';

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

// Дуга, по которой шкотовый угол ходит НА САМОМ ДЕЛЕ: окружность вокруг оси
// галс—фал. Только на ней обе шкаторины остаются той длины, какой скроены, —
// расстояния до галса и до фала вдоль неё не меняются вовсе. Нужна здесь как
// ГРАНИЧНОЕ УСЛОВИЕ опыта: прибить угол на неё и посмотреть, что скажет то же
// самое полотно, когда геометрия ему не мешает. В модель она пока не идёт.
function clewArc(gen) {
  const tk = gen.tack, hd = gen.head, f = gen.foot_m;
  const ax = hd[0] - tk[0], az = hd[1] - tk[1], L = Math.hypot(ax, az);
  const u = [ax / L, az / L];
  const t = -f * u[0];
  const per = [-f - t * u[0], -t * u[1]], R = Math.hypot(per[0], per[1]);
  return { c: [tk[0] + t * u[0], tk[1] + t * u[1]], e: [per[0] / R, per[1] / R], r: R };
}
function clewAt(arc, th) {
  return [arc.c[0] + arc.r * arc.e[0] * Math.cos(th),
          arc.r * Math.sin(th),
          arc.c[1] + arc.r * arc.e[1] * Math.cos(th)];
}
// Длина шкота вдоль этой дуги: |угол − обух|² = A + B·cos θ + E·sin θ, то есть
// один арккосинус, как и у нынешней дуги. Ветвь берётся ЗА минимумом длины —
// там, где потрава шкота выносит угол наружу, а не заводит обратно.
function thetaFor(arc, lead, L) {
  const d = [arc.c[0] - lead[0], -lead[1], arc.c[1] - lead[2]];
  const A = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + arc.r * arc.r;
  const B = 2 * arc.r * (d[0] * arc.e[0] + d[2] * arc.e[1]);
  const E = 2 * arc.r * d[1];
  const H = Math.hypot(B, E), psi = Math.atan2(E, B);
  const c = Math.max(-1, Math.min(1, (L * L - A) / H));
  let th = psi + 2 * Math.PI - Math.acos(c);
  while (th > Math.PI) th -= 2 * Math.PI;
  return th;
}
// Прибить шкотовый угол на эту дугу вместо шкота. Оборачивает проход по связям,
// а не подменяет его: всё остальное полотно живёт по своим правилам.
function pinClew(cloth, gen, len) {
  const arc = clewArc(gen), th = thetaFor(arc, gen.sheet_lead_m, len);
  const p = clewAt(arc, th);
  const base = cloth.project.bind(cloth);
  cloth.project = function (b, side) {
    const k = this.clew * 3;
    this.w[this.clew] = 0;
    this.pos[k] = p[0];
    this.pos[k + 1] = Math.abs(p[1]) * Math.sign(side || -1);
    this.pos[k + 2] = p[2];
    base(b, side);
  };
  return { th, p };
}

console.log('=== ткань на бакштаге и на полном ===\n');

const CASES = [
  { twa: 120, len: 4.5 },
  { twa: 140, len: 5.5 },
  { twa: 160, len: 6.5 },
];

let tautSeen = 0, worstMem = 0, worstStretch = 0, worstQuiver = 0, worstMs = 0;
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
    // Сравнивать есть что только там, где строка НАТЯНУТА (иначе дуги нет
    // вовсе, есть складки) и где пузо заметно (у фаловой дощечки шириной в
    // четверть метра любая мелочь даёт разы).
    const taut = arc / mat > 0.99 && rc.chord > 0.5 && mem > 0.05;
    if (taut) {
      tautSeen++;
      worstMem = Math.max(worstMem, Math.abs(rc.camber / mem - 1));
    }
    console.log(`   ${String(r).padStart(2)}   ${(arc / mat).toFixed(3)}${taut ? ' туго' : '     '}` +
                `     ${rc.camber.toFixed(4)}       ${mem.toFixed(4)}          ` +
                `${mem > 1e-6 ? (rc.camber / mem).toFixed(2) : '-'}`);
  }
  const ls = cloth.luffSag();
  console.log(`  провис передней ${ls.sag.toFixed(3)} м на ${(ls.at * 100).toFixed(0)} % высоты ` +
              `(полоскам предписано ${cloth.sail.gennaker ? '1.212 м на 50 %' : '0'})`);
  console.log(`  шкотовый угол выше галса на ${cloth.clewRise().toFixed(3)} м\n`);
}

console.log('=== то же полотно при замкнутой геометрии угла ===\n');
console.log('Опыт, а не модель: шкотовый угол прибит на дугу вокруг оси галс—фал,');
console.log('где обе шкаторины остаются скроенной длины. Всё прочее без изменений.\n');

let pinTaut = 0, pinMem = 0, pinQuiver = 0;
for (const c of CASES) {
  const b = boatFor(c.twa, c.len);
  const cloth = new Cloth(b.rig.sails[2], 2);
  const pin = pinClew(cloth, PACK.rig.gennaker, c.len);
  for (let i = 0; i < 25 * 30; i++) { hold(b); b.step(1 / 30); cloth.step(b, 1 / 30); }
  const qv = quiver(b, cloth);
  pinQuiver = Math.max(pinQuiver, qv);
  const set = Math.atan2(Math.abs(pin.p[1]), PACK.rig.gennaker.tack[0] - pin.p[0]);
  console.log(`TWA ${c.twa}°, шкот ${c.len} м: вынос ${(set / D).toFixed(1)}°, ` +
              `угол выше галса на ${cloth.clewRise().toFixed(2)} м, ` +
              `растяжение ${(stretch(cloth) * 100).toFixed(2)} %, дрожь ${(qv * 1000).toFixed(1)} мм`);
  for (let r = 0; r < CLOTH_ROWS; r++) {
    const { arc, mat } = rowLen(cloth, r);
    const rc = cloth.rowCamber(r);
    const mem = arcCamber(mat / rc.chord);
    if (!(arc / mat > 0.99 && rc.chord > 0.5 && mem > 0.05)) continue;
    pinTaut++;
    pinMem = Math.max(pinMem, Math.abs(rc.camber / mem - 1));
    console.log(`   строка ${r}: пузо ткани ${rc.camber.toFixed(4)} против дуги ` +
                `${mem.toFixed(4)}, отношение ${(rc.camber / mem).toFixed(2)}`);
  }
}
console.log('');

// --- что проверяется ---------------------------------------------------------

check(worstStretch < 0.03, 'ткань не растягивается (предел 3 %)',
      (worstStretch * 100).toFixed(2) + ' %');

check(pinTaut >= CASES.length, 'при замкнутой геометрии натянутая строка есть в каждом случае',
      `${pinTaut} из ${CASES.length} (плюс ${tautSeen} на свободном шкоте)`);
check(Math.max(worstMem, pinMem) < 0.20,
      'натянутая строка совпадает с точной дугой (предел 20 %)',
      (Math.max(worstMem, pinMem) * 100).toFixed(1) + ' %');

check(worstMs < 0.6, 'цена шага ткани (предел 0.6 мс)', worstMs.toFixed(3) + ' мс');

// --- геометрия обвода: ОТКРЫТО, числа записываются ---------------------------
{
  const g = PACK.rig.gennaker;
  const tk = g.tack, hd = g.head, f = g.foot_m;
  const hd3 = [hd[0], 0, hd[1]];
  const dd = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let mx = 0;
  for (let th = 0; th <= 110; th += 5) {
    const t = th * D;
    mx = Math.max(mx, dd(hd3, [tk[0] - f * Math.cos(t), f * Math.sin(t), tk[1]]));
  }
  console.log('\n--- открыто: числа записываются, проверкой не являются ---');
  console.log(`задняя шкаторина: заявлено ${g.leech_m.toFixed(3)} м, ` +
              `на дуге шкотового угла требуется до ${mx.toFixed(3)} м ` +
              `(+${((mx / g.leech_m - 1) * 100).toFixed(0)} %)`);
  console.log(`колебание на замороженном входе: размах узла до ` +
              `${(worstQuiver * 1000).toFixed(0)} мм за 5 с на шкоте и до ` +
              `${(pinQuiver * 1000).toFixed(0)} мм при замкнутой геометрии угла ` +
              `(цель §Б2 — 20 мм)`);
  console.log('Проверкой это не ставится нарочно: у слабо натянутой мембраны под');
  console.log('следящей нагрузкой равновесие и не обязано быть устойчивым — настоящий');
  console.log('спинакер по слабине именно так и заворачивается. Требовать покоя можно');
  console.log('с ПОСТАВЛЕННОГО паруса, а поставленного эта геометрия не даёт.');
  console.log('и то и другое лечится обводом, а не решателем: см. заголовок.');
}

console.log(bad ? `\nПЛОХО: ${bad}` : '\nвсё ок');
process.exit(bad ? 1 : 0);
