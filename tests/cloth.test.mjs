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
import { Cloth, CLOTH_ROWS, CLOTH_COLS, CLOTH_ITER } from '../sim/cloth.js';
import { STRIPS, NCHORD, gennakerClew } from '../sim/aero.js';

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
  let ms = 0, phys = 0, n = 0;
  for (let i = 0; i < secs * 30; i++) {
    hold(b);
    // Шаг физики меряется рядом и в том же процессе: он и служит меркой.
    const t0 = process.hrtime.bigint();
    b.step(1 / 30);
    const t1 = process.hrtime.bigint();
    cloth.step(b, 1 / 30);
    const t2 = process.hrtime.bigint();
    phys += Number(t1 - t0) / 1e6;
    ms += Number(t2 - t1) / 1e6; n++;
  }
  return { b, cloth, ms: ms / n, phys: phys / n };
}

// Наибольшее растяжение связи, в долях длины покоя. Печатается для памяти, но
// проверкой не служит: у фаловой дощечки рёбра по три сантиметра, и три процента
// на них это миллиметр — число, которое меряет не ткань, а разрешение сетки.
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

// Растяжение ЦЕЛОЙ строки и целого столбца: во сколько раз путь по полотну
// длиннее того, из чего он скроен. Вот это и есть нерастяжимость — сечение и
// шкаторина не могут стать длиннее своей ткани, сколько бы ни было узлов.
function stretchWhole(cl) {
  let worst = 1;
  for (let r = 0; r < CLOTH_ROWS; r++) {
    const { arc, mat } = rowLen(cl, r);
    if (mat > 0.05) worst = Math.max(worst, arc / mat);
  }
  for (let c = 0; c < CLOTH_COLS; c++) {
    let arc = 0, mat = 0;
    for (let r = 0; r + 1 < CLOTH_ROWS; r++) {
      const a = (r * CLOTH_COLS + c) * 3, b = ((r + 1) * CLOTH_COLS + c) * 3;
      arc += Math.hypot(cl.pos[b] - cl.pos[a], cl.pos[b + 1] - cl.pos[a + 1],
                        cl.pos[b + 2] - cl.pos[a + 2]);
      const i = r * CLOTH_COLS + c, j = i + CLOTH_COLS;
      mat += Math.hypot(cl.px[i] - cl.px[j], cl.py[i] - cl.py[j]);
    }
    if (mat > 0.05) worst = Math.max(worst, arc / mat);
  }
  return worst - 1;
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

let worstStretch = 0, worstEdge = 0, worstQuiver = 0, worstMs = 0, worstFold = 1, worstPhys = 0;
for (const c of CASES) {
  const { b, cloth, ms, phys } = run(c.twa, c.len);
  const st = stretch(cloth), stw = stretchWhole(cloth);
  const qv = quiver(b, cloth);
  worstStretch = Math.max(worstStretch, stw);
  worstEdge = Math.max(worstEdge, st);
  worstQuiver = Math.max(worstQuiver, qv);
  worstMs = Math.max(worstMs, ms);
  worstPhys = Math.max(worstPhys, phys);
  console.log(`TWA ${c.twa}°, шкот ${c.len} м: ход ${b.telemetry.speedKn.toFixed(2)} уз, ` +
              `${ms.toFixed(3)} мс/шаг (шаг физики ${phys.toFixed(3)}), ` +
              `растяжение ${(stw * 100).toFixed(2)} % (худшее ребро ${(st * 100).toFixed(1)} %), ` +
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

// === ФЛАТТЕР: петля ткань <-> аэродинамика при полностью замороженной лодке ===
//
// Свидетель на самовозбуждение. Шаг Б3 замкнул петлю: форма ткани задаёт летящую
// хорду и её поворот, оттуда идут угол атаки и скорость, оттуда давление, и
// давление возвращается на ткань. Петля без запаздывания, и она РАСКАЧИВАЛАСЬ:
// полотно колебалось само, размах пуза 0.0798 с периодом 1.46 с, ровно, с 28-й
// секунды до 60-й (docs/wake.md).
//
// Мерить это надо с ЗАМОРОЖЕННОЙ ЛОДКОЙ, и это главное в стенде. На свободной
// лодке мода ткани захватывает моду крена, и увиденное уже не скажет, кто кого
// качает. Здесь скорости, крен, дифферент и курс держатся на значениях
// двадцатой секунды: живут только ткань и аэродинамика, внешнего входа нет
// вовсе, и любое незатухающее колебание — целиком собственное.
//
// Порог по скорости ветра — часть стенда, а не украшение: у флаттера он есть по
// определению, и прежний разнос его показывал (на 6 м/с колебания не было
// вовсе, на 10 м/с размах 0.0798). Поэтому в наборе есть и та, и другая.
//
// Хвост в сорок восемь секунд взят не на глаз: на слабом ветре переходный
// процесс медленный, и по восьмисекундным окнам он выглядит так —
// 0.0017 0.0079 0.0102 0.0044 0.0004 0.0001 0.0000 и дальше нули. Тридцати двух
// секунд хватало на ответ, но упиралось это в самый хвост спада; сорок восемь
// дают его уже прошедшим, и проверка меряет покой, а не скорость затухания.
const FROZEN = ['u', 'v', 'r', 'phi', 'p_', 'psi', 'th', 'q', 'zc', 'w'];

function flutter(twa, len, wind, warm = 20, tail = 48) {
  const b = boatFor(twa, len);
  b.o.windSpeed = wind; b.o.windDir = 100 * D; b.psi = (100 - twa) * D;
  let frozen = null;
  const H = [];
  for (let i = 0; i < (warm + tail) * 30; i++) {
    const e = wrapPi((100 - twa) * D - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * e - 0.9 * b.r)));
    b.step(1 / 30);
    if (i === warm * 30) { frozen = {}; for (const k of FROZEN) frozen[k] = b[k]; }
    if (frozen) for (const k of FROZEN) b[k] = frozen[k];
    if (i >= warm * 30) {
      const cl = b.rig.cloth;
      H.push([i / 30 - warm, cl.rowCamber(5).camber, cl.luffSag().sag]);
    }
  }
  const sw = (a, z, i) => {
    const v = H.filter(h => h[0] >= a && h[0] < z).map(h => h[i]);
    return Math.max(...v) - Math.min(...v);
  };
  return { early: sw(0, 8, 1), late: sw(tail - 8, tail, 1),
           lateSag: sw(tail - 8, tail, 2) };
}

console.log('=== флаттер: лодка заморожена, живут только ткань и аэродинамика ===\n');

const FCASES = [
  { twa: 165, len: 5.5, wind: 6 },
  { twa: 165, len: 5.5, wind: 10 },
  { twa: 150, len: 4.5, wind: 10 },
  { twa: 120, len: 4.5, wind: 10 },
];

let worstLate = 0, worstRatio = 0;
console.log('  курс  шкот  ветер   размах пуза: первые 8 с -> последние 8 с   серп в конце');
for (const c of FCASES) {
  const f = flutter(c.twa, c.len, c.wind);
  worstLate = Math.max(worstLate, f.late);
  // Отношение считается только там, где есть чему затухать: если полотно и с
  // самого начала стоит, делить нечего и доказывать нечего.
  if (f.early > 0.005) worstRatio = Math.max(worstRatio, f.late / f.early);
  console.log(`  ${String(c.twa).padStart(3)}°   ${c.len}   ${String(c.wind).padStart(2)}      ` +
              `${f.early.toFixed(4)} -> ${f.late.toFixed(4)}` +
              `${f.early > 0.005 ? '  (' + (f.late / f.early).toFixed(2) + '\u00d7)' : '           '}` +
              `        ${f.lateSag.toFixed(3)} м`);
}
console.log('');

// === СХОДИМОСТЬ ФОРМЫ: свойство модели или свойство числа проходов ===========
//
// Ворота шага В1. У решателя ткани при КАЖДОМ числе проходов своя неподвижная
// точка: баланс встаёт там, где поправка Гаусса — Зейделя за проход равна силе
// за подшаг. Пока форма зависит от этого числа, она не свойство паруса.
//
// Мерится ЛЕТЯЩАЯ ХОРДА строки в метрах, а не пузо в долях: у коротких верхних
// строк доля скачет от самой хорды, и по ней нельзя судить, изменилась ли форма.
// Сравнивается рабочая настройка с вчетверо более густыми проходами.
//
// Замер, ради которого это заведено (TWA 140°, шкот 5.5 м, ветер 6 м/с, хорда на
// полувысоте): при десяти проходах без переслабления выходило 3.18 м против
// 3.45 у сошедшегося решения — восемь процентов. С переслаблением 1.9 и
// двадцатью проходами 3.40 против 3.42.
//
// ПРОГИБ от хорды печатается, но воротами НЕ СЛУЖИТ, и это не осторожность: он
// по проходам НЕМОНОТОНЕН (0.61 -> 0.39 -> 0.23 -> 0.43 м на полувысоте). У
// слабой ткани несколько равновесий, и какое из них займёт полотно, зависит от
// пути. Ставить сюда ворота до того, как это разобрано, значит закрепить
// случайное.
function flyingShape(twa, len, wind, opts) {
  const b = boatFor(twa, len);
  b.o.cloth = opts;
  b.o.windSpeed = wind; b.o.windDir = 100 * D; b.psi = (100 - twa) * D;
  // Ткань заводится в конструкторе, а настройки нужны до первого шага.
  b.hoistCloth();
  for (let i = 0; i < 25 * 30; i++) {
    const e = wrapPi((100 - twa) * D - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * e - 0.9 * b.r)));
    b.step(1 / 30);
  }
  const cl = b.rig.cloth, out = [];
  for (const f of [0.2, 0.5, 0.8]) {
    const rc = cl.rowCamber(f * (cl.rows - 1));
    out.push([rc.chord, rc.camber * rc.chord]);
  }
  // ОГРАНКА ПОВЕРХНОСТИ — двугранный угол между соседними ячейками, и ЗАВОРОТ
  // сечения у передней шкаторины.
  //
  // Прежде здесь стоял шаг направления хорды от строки к строке, и это была
  // НЕВЕРНАЯ МЕРКА. У генакера обвод сужается к фалу почти одной передней
  // шкаториной: между двумя верхними строками она уходит назад на 0.82 м, а
  // задняя стоит на месте (замер в осях рига: передняя 4.50 -> 3.68, задняя
  // 3.64 -> 3.57). Направление хорды при этом обязано повернуться на десятки
  // градусов, и складки в том нет никакой.
  //
  // Нормаль ячейки берётся ВЗВЕШЕННОЙ ПО ПЛОЩАДИ двух её треугольников, а не
  // средней из двух единичных. У верхней ячейки один треугольник вырожден, его
  // нормаль плохо определена, и равный вес давал на стыке с дощечкой 65…83°
  // там, где по площади выходит 12°. Складки на стыке нет — это была ошибка
  // мерки, и она записана, чтобы не повторилась.
  //
  // ЗАВОРОТ считается отдельно и по строке: у сечения паруса поворот вдоль
  // хорды обязан быть однознаковым (дуга), а у модели верхние строки сперва
  // заворачиваются у шкаторины и лишь потом идут обратно. Меряется сумма
  // поворота по ПЕРЕДНЕЙ ПОЛОВИНЕ хорды: у строки 8 при рабочей настройке это
  // 107°, при четырёхстах проходах 38°.
  const cellN = (r, c) => {
    const P = (rr, cc) => cl.ix(rr, cc) * 3;
    const tri = (i, j, k) => {
      const ux = cl.pos[j] - cl.pos[i], uy = cl.pos[j + 1] - cl.pos[i + 1],
            uz = cl.pos[j + 2] - cl.pos[i + 2];
      const vx = cl.pos[k] - cl.pos[i], vy = cl.pos[k + 1] - cl.pos[i + 1],
            vz = cl.pos[k + 2] - cl.pos[i + 2];
      return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    };
    const a = P(r, c), b2 = P(r, c + 1), e = P(r + 1, c), g = P(r + 1, c + 1);
    const n1 = tri(a, b2, e), n2 = tri(g, e, b2);
    const n = [n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]];
    const L = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / L, n[1] / L, n[2] / L];
  };
  const ang = (A, B) => Math.acos(Math.max(-1, Math.min(1,
    A[0] * B[0] + A[1] * B[1] + A[2] * B[2]))) / D;
  let span = 0, chord = 0;
  for (let r = 0; r + 2 < cl.rows; r++)
    for (let c = 0; c + 1 < cl.cols; c++)
      span = Math.max(span, ang(cellN(r, c), cellN(r + 1, c)));
  for (let r = 0; r + 1 < cl.rows; r++)
    for (let c = 0; c + 2 < cl.cols; c++)
      chord = Math.max(chord, ang(cellN(r, c), cellN(r, c + 1)));
  // Заворот: поворот сечения по передней половине хорды, наибольший по строкам.
  let curl = 0;
  for (let r = 0; r < cl.rows; r++) {
    const a = [];
    for (let c = 0; c + 1 < cl.cols; c++) {
      const i = cl.ix(r, c) * 3, j = cl.ix(r, c + 1) * 3;
      a.push(Math.atan2(cl.pos[j + 1] - cl.pos[i + 1], cl.pos[j] - cl.pos[i]) / D);
    }
    let sum = 0;
    for (let k = 1; k < Math.ceil(a.length / 2) + 1 && k < a.length; k++) {
      let d = a[k] - a[k - 1];
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      sum += d;
    }
    curl = Math.max(curl, Math.abs(sum));
  }
  return { out, sag: cl.luffSag().sag, v: b.telemetry.speedKn,
           span, chord, curl };
}

console.log('=== сходимость формы по числу проходов решателя ===\n');
console.log('  вариант              хорда/прогиб на 20 %   на 50 %         на 80 %       серп    ход   огранка  заворот');
const CONV = [
  { name: 'рабочая настройка', o: undefined },
  { name: 'вчетверо проходов', o: { iter: 4 * CLOTH_ITER } },
];
const convOut = CONV.map(c => flyingShape(140, 5.5, 6, c.o));
CONV.forEach((c, i) => {
  const r = convOut[i];
  console.log(`  ${c.name.padEnd(20)} ` +
    r.out.map(([ch, dv]) => `${ch.toFixed(2)}/${dv.toFixed(3)}`).join('  ') +
    `   ${r.sag.toFixed(3)}  ${r.v.toFixed(2)}   ${r.span.toFixed(0)}°/${r.chord.toFixed(0)}°  ${r.curl.toFixed(0)}°`);
});
let worstChord = 0;
for (let k = 0; k < 3; k++) {
  const a = convOut[0].out[k][0], b2 = convOut[1].out[k][0];
  if (b2 > 0.05) worstChord = Math.max(worstChord, Math.abs(a / b2 - 1));
}
console.log('');

// === АУДИТ ПЕРЕНОСА НАГРУЗКИ: два пути к одной силе ============================
//
// Шаг В0 нового порядка (docs/gennaker-sota-plan.md, часть В). Нагрузка
// генакера считается ДВАЖДЫ и по-разному:
//
//   ткань   — перепад давления по панельной циркуляции, Δp = ρ·V·Γ/Δx,
//             на площадях выкройки, по одной нормали на строку;
//   полоски — сила сечения из поляры со всеми поправками, она и уходит в лодку.
//
// Это два вычислительных пути к одной физической величине, то есть прямое
// нарушение «одной реализации одной вещи». Пока они расходятся, любое суждение о
// летящей форме опирается на нагрузку, которой лодка не видит, и наоборот.
//
// Сравниваются: сила по составляющим (вдоль корпуса, поперёк в плоскости,
// перпендикулярной мачте, и ВДОЛЬ МАЧТЫ — у полосок такой нет вовсе) и момент
// крена вокруг центра тяжести, потому что совпадение сумм ещё не означает
// совпадения точек приложения.
//
// ПОКА БЕЗ ВОРОТ. Сперва число, потом порог: назначать предел до того, как
// известен разброс по режимам, — это подгонка. Числа печатаются, чтобы правка,
// сводящая два пути в один, мерялась ими же.
function loadAudit(b) {
  const cl = b.rig.cloth, calc = b.rig.stripCalc, st = b.rig.stripState;
  const base = 2 * STRIPS;
  const cphi = Math.cos(b.phi), sphi = Math.sin(b.phi);
  const cgz = b.p.mass.cg_m[2];
  // --- полоски: сила, уходящая в лодку, и её НОРМАЛЬНАЯ к полотну доля
  let full = [0, 0], norm = [0, 0], gmx = 0, nmx = 0, gArea = 0;
  for (let i = base; i < 3 * STRIPS; i++) {
    const g = calc[i], d = st[i];
    if (!g || !g.live) continue;
    gArea += g.area;
    full[0] += d.drive; full[1] += d.side;
    gmx += g.yi * (d.side * sphi) - (g.zi - cgz) * (d.side * cphi);
    const cd0 = g.chordDir || 0, nc = -Math.sin(cd0), ns = Math.cos(cd0);
    const fn = d.drive * nc + d.side * ns;
    norm[0] += fn * nc; norm[1] += fn * ns;
    nmx += g.yi * (fn * ns * sphi) - (g.zi - cgz) * (fn * ns * cphi);
  }
  // --- ткань: то, что она ДЕЙСТВИТЕЛЬНО приложила (отдаётся из `Cloth.advance`)
  const L = cl.load || { fx: 0, fy: 0, fz: 0, mx: 0 };
  let areaCut = 0;
  for (let i = 0; i < cl.n; i++) areaCut += cl.area[i];
  const A = cl.flyingAreas();
  let areaNow = 0;
  for (let i = 0; i < cl.n; i++) areaNow += A[i];
  return { F: [L.fx, L.fy, L.fz], mx: L.mx, full, norm, gmx, nmx,
           areaCut, areaNow, gArea };
}

console.log('=== аудит переноса нагрузки: ткань против полосок ===\n');
console.log('Полотно надувает только НОРМАЛЬНАЯ к нему доля силы сечения:');
console.log('касательная (трение вдоль ткани) мембрану не растягивает. Поэтому');
console.log('сравнивается ткань с нормальной долей, а полная сила полосок');
console.log('печатается рядом — по разнице видно, сколько уходит в касательную.\n');
console.log('  курс шкот ветер | вдоль: ткань/норм./полная | поперёк: ткань/норм./полная' +
            ' | вдоль мачты | Mx: ткань/норм.');
const AUDIT = [
  { twa: 120, len: 4.5, wind: 6 }, { twa: 140, len: 5.5, wind: 6 },
  { twa: 160, len: 6.5, wind: 6 }, { twa: 165, len: 5.5, wind: 10 },
  { twa: 180, len: 6.5, wind: 10 },
];
let worstLoad = 0, worstMom = 0, areaLine = '';
for (const a of AUDIT) {
  const b = boatFor(a.twa, a.len);
  b.o.windSpeed = a.wind; b.o.windDir = 100 * D; b.psi = (100 - a.twa) * D;
  for (let i = 0; i < 25 * 30; i++) {
    const e = wrapPi((100 - a.twa) * D - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * e - 0.9 * b.r)));
    b.step(1 / 30);
  }
  const z = loadAudit(b);
  const fc = Math.hypot(z.F[0], z.F[1]), fn = Math.hypot(z.norm[0], z.norm[1]);
  if (fn > 1) worstLoad = Math.max(worstLoad, Math.abs(fc / fn - 1));
  if (Math.abs(z.nmx) > 10) worstMom = Math.max(worstMom, Math.abs(z.mx / z.nmx - 1));
  const n3 = v => v.toFixed(0).padStart(5);
  console.log(`  ${String(a.twa).padStart(3)}° ${a.len} ${String(a.wind).padStart(2)}  |` +
    ` ${n3(z.F[0])}/${n3(z.norm[0])}/${n3(z.full[0])} |` +
    ` ${n3(z.F[1])}/${n3(z.norm[1])}/${n3(z.full[1])} |` +
    ` ${n3(z.F[2])} / 0 |` +
    ` ${n3(z.mx)}/${n3(z.nmx)}`);
  if (!areaLine) areaLine = `выкройка ${z.areaCut.toFixed(2)} м², ` +
    `полотно в полёте ${z.areaNow.toFixed(2)} м², полоски ${z.gArea.toFixed(2)} м²`;
}
console.log(`\n  площади (первая клетка): ${areaLine}`);
console.log(`  расхождение с нормальной долей: по силе до ` +
            `${(100 * worstLoad).toFixed(0)} %, по моменту крена до ` +
            `${(100 * worstMom).toFixed(0)} %\n`);

// --- что проверяется ---------------------------------------------------------

check(worstStretch < 0.01,
      'ткань не растягивается: строка и столбец не длиннее своего кроя (предел 1 %)',
      (worstStretch * 100).toFixed(2) + ' %, худшее отдельное ребро ' +
      (worstEdge * 100).toFixed(1) + ' %');

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

// ЦЕНА. Порог грубый и стоит затем, чтобы заметить обвал, а не чтобы ловить
// проценты: цена шага зависит от машины и от того, чем машина ещё занята. Тот же
// довод и тот же приём, что у проверки шага физики в `tests/kernel.test.mjs`.
//
// Числа для памяти: на свободной машине ткань стоит 0.29…0.39 мс при бюджете
// §Б2 в +0.3 мс к кадру, а шаг физики рядом — 1.3 мс. Прогон трёх тяжёлых
// батарей разом растягивает обе величины вчетверо, и абсолютный порог в 0.6 мс
// на этом краснел — мерил загрузку, а не правку.
check(worstMs < 2, 'ткань не обваливает бюджет кадра (порог 2 мс, грубый)',
      worstMs.toFixed(3) + ' мс при шаге физики ' + worstPhys.toFixed(3) + ' мс');

// ФЛАТТЕР. Два порога, и оба обоснованы, а не подогнаны.
//
// Абсолютный: 0.01 по пузу это 5 % от проектных 0.20 — ниже той точности, с
// которой форму паруса вообще кто-либо заявляет. Он ловит предельный цикл, а не
// шум решателя.
//
// Относительный: у предельного цикла отношение конца к началу около единицы, у
// затухающей моды оно мало. Проверяется ФОРМА ответа, а не его уровень, поэтому
// полоса широкая. Собственное затухание ткани (по нормали e^-2.6 за период,
// вязкое PBD e^-8.8) обязано съесть свободное колебание за пару секунд, а здесь
// дано двадцать четыре.
check(worstLate < 0.01,
      'полотно приходит в покой на замороженной лодке (предел 0.01 по пузу)',
      worstLate.toFixed(4));

// СХОДИМОСТЬ. Три процента — это не «столько получилось», а порог, за которым
// форма перестаёт быть свойством модели: летящая хорда входит в аэродинамику
// напрямую (панели строятся на ней), и трёхпроцентная неопределённость хорды
// уже сравнима с тем, что меряют эталоны по силам.
check(worstChord < 0.03,
      'летящая хорда не зависит от числа проходов (предел 3 %)',
      (100 * worstChord).toFixed(1) + ' %');

// ОГРАНКА — справкой, без ворот, и это осознанно.
//
// Наблюдение с картинки верное: полотно у модели заламывается, и настоящий SV20
// на фотографиях гладкий. Померено двугранным углом — и оказалось, что огранена
// ВСЯ поверхность, а не только верх: поперёк размаха 24…31° при 6…10° у
// сошедшегося решения, вдоль хорды 27…40° при 12…15°, а на стыке с фаловой
// дощечкой 65…83° при 27°.
//
// То есть отдельного изъяна «залом у фала» нет: это та же несходимость, что уже
// стоит воротами выше, и второго порога на неё заводить незачем. Числа
// печатаются, чтобы правка решателя мерялась и ими тоже.
console.log(`  огранка и заворот при вчетверо более густых проходах: ` +
            `${convOut[1].span.toFixed(0)}°/${convOut[1].chord.toFixed(0)}° и ` +
            `${convOut[1].curl.toFixed(0)}° — против ${convOut[0].span.toFixed(0)}°/` +
            `${convOut[0].chord.toFixed(0)}° и ${convOut[0].curl.toFixed(0)}° ` +
            `при рабочей настройке\n`);
check(worstRatio < 0.3,
      'колебание затухает, а не держится предельным циклом (конец к началу ниже 0.3)',
      worstRatio.toFixed(2) + '\u00d7');



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
