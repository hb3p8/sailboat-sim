// Раскладка полотнищ и развёртки: node scripts/panels.mjs [--json путь]
//
// ЧТО ЗДЕСЬ СЧИТАЕТСЯ И ЧЕГО ЗДЕСЬ НЕТ.
//
// Считается раскладка ПОПЕРЁК (cross-cut): полотнища идут горизонтальными
// полосами между соседними строками проектной поверхности. Каждое разворачивается
// в плоскость честной укладкой треугольников по длинам рёбер — тем же приёмом,
// что у Sailcut (`CPanel::develop`): первый треугольник кладётся, каждый
// следующий достраивается от общего ребра по двум расстояниям.
//
// Треугольная ПОЛОСА разворачивается в плоскость ТОЧНО и всегда: у неё нет
// внутренних вершин, а значит нет и гауссовой кривизны, которую развёртка
// обязана потерять. Поэтому «ошибка развёртки» здесь нулевая по построению, и
// мерить надо не её, а ФОРМУ ЛИНИЙ РЕЗА: в плоскости они выходят кривыми, и эта
// кривизна и есть broadseam — то, чем сшитые плоские полотнища набирают объём.
//
// Вся гауссова кривизна поверхности при такой раскладке уходит В ШВЫ. Её полная
// величина считается отдельно, дефектом угла в вершинах: это та «лишняя»
// геометрия, которую полосам придётся выразить кривизной своих кромок.
//
// ЧЕГО НЕТ: припусков на шов, направлений нитей, усилений, углов и лат.
// Развёртки здесь — исследовательские, не производственные.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;

function surface(twa = 140, len = 5.5, secs = 25) {
  const b = new Boat(PACK);
  b.o.crewHike = -Math.sign(twa || 1); b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = len;
  b.reset();
  b.o.windSpeed = 6; b.o.windDir = twa * D; b.u = 3;
  const cl = new Cloth(b.rig.sails[2], 2);
  for (let i = 0; i < secs * 30; i++) { b.step(1 / 30); cl.step(b, 1 / 30); }
  return cl;
}

// Дефект угла в вершине: 2π минус сумма углов сошедшихся треугольников.
// У развёртываемой поверхности он ноль всюду; у паруса — нет, и сумма по
// вершинам есть полная гауссова кривизна, которую придётся отдать швам.
function angleDefect(cl) {
  const R = cl.rows, C = cl.cols, P = [];
  for (let i = 0; i < R * C; i++) P.push([cl.dx[i], cl.dy[i], cl.dz[i]]);
  const ix = (r, c) => r * C + c;
  const ang = (o, a, b) => {
    const ax = P[a][0] - P[o][0], ay = P[a][1] - P[o][1], az = P[a][2] - P[o][2];
    const bx = P[b][0] - P[o][0], by = P[b][1] - P[o][1], bz = P[b][2] - P[o][2];
    const la = Math.hypot(ax, ay, az) || 1e-12, lb = Math.hypot(bx, by, bz) || 1e-12;
    return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb))));
  };
  let total = 0, worst = 0, at = '';
  const grid = [];
  for (let r = 1; r + 1 < R; r++) {
    for (let c = 1; c + 1 < C; c++) {
      const o = ix(r, c);
      // Шесть треугольников вокруг вершины при разбиении квадов по диагонали.
      const nb = [ix(r, c + 1), ix(r + 1, c + 1), ix(r + 1, c),
                  ix(r, c - 1), ix(r - 1, c - 1), ix(r - 1, c)];
      let s = 0;
      for (let k = 0; k < 6; k++) s += ang(o, nb[k], nb[(k + 1) % 6]);
      const d = 2 * Math.PI - s;
      total += d;
      if (Math.abs(d) > Math.abs(worst)) { worst = d; at = `строка ${r}, столбец ${c}`; }
      grid.push({ r, c, defect: d });
    }
  }
  return { total, worst, at, grid };
}

// Развёртка одной полосы: укладка треугольников по длинам рёбер.
//
// СТОРОНА, НА КОТОРУЮ КЛАДЁТСЯ ВЕРШИНА, НЕ ПОСТОЯННА. Каждый следующий
// треугольник строится на общем ребре с предыдущим, и его новая вершина обязана
// лечь ПО ДРУГУЮ СТОРОНУ этого ребра, чем уже уложенная третья вершина соседа.
// При постоянном знаке полоса складывается гармошкой: рельсы идут зигзагом, и
// стрелка кривизны выходит метровой при ширине полотнища в метр.
function develop(cl, r) {
  const C = cl.cols, ix = (rr, cc) => rr * C + cc;
  const d = (i, j) => cl.matDist(i, j);
  const cross = (p, q, z) =>
    (q[0] - p[0]) * (z[1] - p[1]) - (q[1] - p[1]) * (z[0] - p[0]);
  // Точка на расстоянии lp от p и lq от q, с противоположной стороны от z.
  const place = (p, q, lp, lq, z) => {
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const L = Math.hypot(ex, ey) || 1e-12;
    const ux = ex / L, uy = ey / L;
    const t = (L * L + lp * lp - lq * lq) / (2 * L);
    const h = Math.sqrt(Math.max(0, lp * lp - t * t));
    const sgn = cross(p, q, z) > 0 ? -1 : 1;
    return [p[0] + ux * t - sgn * uy * h, p[1] + uy * t + sgn * ux * h];
  };
  const A = new Array(C), B = new Array(C);
  A[0] = [0, 0];
  A[1] = [d(ix(r, 0), ix(r, 1)), 0];
  // У первого треугольника соседа нет: сторона выбирается произвольно и задаёт
  // лицевую сторону полотнища.
  B[0] = place(A[0], A[1], d(ix(r, 0), ix(r + 1, 0)), d(ix(r, 1), ix(r + 1, 0)),
               [A[0][0], A[0][1] - 1]);
  for (let c = 0; c + 1 < C; c++) {
    if (c > 0) A[c + 1] = place(A[c], B[c], d(ix(r, c), ix(r, c + 1)),
                                d(ix(r + 1, c), ix(r, c + 1)), B[c - 1]);
    B[c + 1] = place(A[c + 1], B[c], d(ix(r, c + 1), ix(r + 1, c + 1)),
                     d(ix(r + 1, c), ix(r + 1, c + 1)), A[c]);
  }
  return { A, B };
}

// Стрелка кривизны рельса: наибольший отход от прямой между его концами.
function sagitta(P) {
  const a = P[0], b = P[P.length - 1];
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const L = Math.hypot(ex, ey) || 1e-12;
  let worst = 0, at = 0, sign = 0;
  for (let i = 1; i + 1 < P.length; i++) {
    const s = ((P[i][0] - a[0]) * ey - (P[i][1] - a[1]) * ex) / L;
    if (Math.abs(s) > Math.abs(worst)) { worst = s; at = i / (P.length - 1); sign = Math.sign(s); }
  }
  return { sag: worst, at, chord: L, sign };
}

// РАДИАЛЬНАЯ РАСКЛАДКА НИЗА: веер из шкотового угла.
//
// Поперечная раскладка внизу упирается в собственную геометрию, а не в форму:
// нижнее полотнище идёт от НАКЛОННОЙ И КРИВОЙ нижней шкаторины к ГОРИЗОНТАЛЬНОЙ
// строке, то есть полоса у него перекручена по всей длине. У настоящих парусов
// такой полосы не бывает — внизу полотнища кладут веером от угла, и шов идёт
// вдоль натяжения, а не поперёк него.
//
// Веер строится в координатах поверхности (номер строки, доля хорды): из угла
// (0, 1) лучи расходятся на дальнюю границу области — нижнюю шкаторину от t = 1
// до 0, переднюю от строки 0 до rTop и строку rTop от t = 0 до 1. Точки берутся
// `cutAt`, то есть с той же проектной поверхности, что и всё остальное: новой
// геометрии не заводится, меняется только разрез.
function radialFoot(cl, rTop, N) {
  const clew = [0, 1];
  // Дальняя граница: три отрезка в координатах (строка, доля), по длине дуги.
  const seg = [];
  const M = 40;
  for (let i = 0; i <= M; i++) seg.push([0, 1 - i / M]);            // нижняя, от угла
  for (let i = 1; i <= M; i++) seg.push([rTop * i / M, 0]);          // передняя вверх
  for (let i = 1; i <= M; i++) seg.push([rTop, i / M]);              // строка rTop
  // Длины по НАСТОЯЩЕЙ поверхности, чтобы веер делил границу поровну по ткани.
  const pt = (uv) => { const o = [0, 0, 0]; cl.cutAt(uv[0], uv[1], o); return o; };
  const XY = seg.map(pt);
  const acc = [0];
  for (let i = 1; i < XY.length; i++)
    acc.push(acc[i - 1] + Math.hypot(XY[i][0] - XY[i-1][0], XY[i][1] - XY[i-1][1], XY[i][2] - XY[i-1][2]));
  const total = acc[acc.length - 1];
  const at = (f) => {
    const want = f * total;
    let i = 1; while (i < acc.length - 1 && acc[i] < want) i++;
    const t = (want - acc[i-1]) / Math.max(1e-12, acc[i] - acc[i-1]);
    return [seg[i-1][0] + (seg[i][0] - seg[i-1][0]) * t,
            seg[i-1][1] + (seg[i][1] - seg[i-1][1]) * t];
  };
  // Лучи: от угла к точке границы, равномерно по параметру, K точек на луч.
  // ВЕРШИНА ОБРЕЗАНА, и это не косметика. Если вести лучи от самой точки угла,
  // у каждой полосы первое ребро нулевой длины: вершина вырождена, укладка
  // треугольников там опирается на ничто, и мера шва теряет смысл. Замер:
  // без обрезки худший шов шёл 291 мм при четырёх лучах и 1503 при восьми,
  // то есть РОС с числом полотнищ, чего быть не может. У настоящих парусов в
  // угол полотнища тоже не сводят — там угловая заплата.
  const T0 = 0.10;
  const K = 9, rays = [];
  for (let k = 0; k <= N; k++) {
    const e = at(k / N), line = [];
    for (let j = 0; j < K; j++) {
      const t = T0 + (1 - T0) * j / (K - 1);
      line.push(pt([clew[0] + (e[0] - clew[0]) * t, clew[1] + (e[1] - clew[1]) * t]));
    }
    rays.push(line);
  }
  return rays;
}

// Развёртка полосы, заданной двумя рядами точек в пространстве.
function developPair(A3, B3) {
  const n = A3.length;
  const d = (p, q) => Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]);
  const cross = (p, q, z) => (q[0]-p[0])*(z[1]-p[1]) - (q[1]-p[1])*(z[0]-p[0]);
  const place = (p, q, lp, lq, z) => {
    const ex = q[0]-p[0], ey = q[1]-p[1];
    const L = Math.hypot(ex, ey) || 1e-12, ux = ex/L, uy = ey/L;
    const t = (L*L + lp*lp - lq*lq) / (2*L);
    const h = Math.sqrt(Math.max(0, lp*lp - t*t));
    const sgn = cross(p, q, z) > 0 ? -1 : 1;
    return [p[0] + ux*t - sgn*uy*h, p[1] + uy*t + sgn*ux*h];
  };
  const A = new Array(n), B = new Array(n);
  A[0] = [0, 0]; A[1] = [d(A3[0], A3[1]), 0];
  B[0] = place(A[0], A[1], d(A3[0], B3[0]), d(A3[1], B3[0]), [A[0][0], A[0][1]-1]);
  for (let c = 0; c + 1 < n; c++) {
    if (c > 0) A[c+1] = place(A[c], B[c], d(A3[c], A3[c+1]), d(B3[c], A3[c+1]), B[c-1]);
    B[c+1] = place(A[c+1], B[c], d(A3[c+1], B3[c+1]), d(B3[c], B3[c+1]), A[c]);
  }
  return { A, B };
}

const cl = surface();
const R = cl.rows;
const kg = angleDefect(cl);
const panels = [];
let worstEdge = 0;
for (let r = 0; r + 1 < R; r++) {
  const { A, B } = develop(cl, r);
  // Сверка: все рёбра развёртки обязаны совпасть с длинами по материалу.
  for (let c = 0; c + 1 < cl.cols; c++) {
    const e1 = Math.hypot(A[c + 1][0] - A[c][0], A[c + 1][1] - A[c][1]);
    worstEdge = Math.max(worstEdge, Math.abs(e1 / cl.matDist(r * cl.cols + c, r * cl.cols + c + 1) - 1));
  }
  const sa = sagitta(A), sb = sagitta(B);
  panels.push({ r, A, B, sagA: sa, sagB: sb,
                lenA: A.reduce((s, p, i) => i ? s + Math.hypot(p[0] - A[i-1][0], p[1] - A[i-1][1]) : 0, 0),
                lenB: B.reduce((s, p, i) => i ? s + Math.hypot(p[0] - B[i-1][0], p[1] - B[i-1][1]) : 0, 0),
                wLo: Math.hypot(B[0][0] - A[0][0], B[0][1] - A[0][1]),
                wHi: Math.hypot(B[cl.cols-1][0] - A[cl.cols-1][0], B[cl.cols-1][1] - A[cl.cols-1][1]) });
}

console.log('РАСКЛАДКА ПОПЕРЁК: %d полотнищ из проектной поверхности %d × %d\n', panels.length, R, cl.cols);
console.log('  полот.  длина низ  длина верх  ширина низ/верх    серп низа    серп верха');
for (const p of panels) {
  console.log('   ' + String(p.r).padStart(3) + '     ' + p.lenA.toFixed(3).padStart(7)
    + '    ' + p.lenB.toFixed(3).padStart(7)
    + '     ' + p.wLo.toFixed(3) + ' / ' + p.wHi.toFixed(3)
    + '     ' + ((1000 * p.sagA.sag).toFixed(1) + ' мм').padStart(10)
    + '  ' + ((1000 * p.sagB.sag).toFixed(1) + ' мм').padStart(10));
}
console.log('\nШВЫ. Одна и та же строка разворачивается ПО-РАЗНОМУ в двух');
console.log('соседних полотнищах — разность их стрелок и есть broadseam, то,');
console.log('что сшивают. Совпадали бы они только у развёртываемой поверхности.\n');
console.log('   шов   снизу      сверху     broadseam');
for (let k = 1; k < panels.length; k++) {
  const lo = 1000 * panels[k - 1].sagB.sag, hi = 1000 * panels[k].sagA.sag;
  console.log('   ' + String(k).padStart(3) + '   ' + (lo.toFixed(1) + ' мм').padStart(9)
    + '  ' + (hi.toFixed(1) + ' мм').padStart(9)
    + '  ' + (Math.abs(hi - lo).toFixed(1) + ' мм').padStart(10));
}
console.log('\nразвёртка сохраняет длины рёбер: худшее расхождение ' + worstEdge.toExponential(1));
console.log('гауссова кривизна: полный дефект угла ' + kg.total.toFixed(4) + ' рад ('
  + (kg.total / D).toFixed(1) + '°), худшая вершина ' + kg.worst.toFixed(4) + ' рад — ' + kg.at);
// --- СВЕРКА ДВУХ РАСКЛАДОК НА ОДНОЙ И ТОЙ ЖЕ НИЗОВОЙ ОБЛАСТИ
const R_TOP = 3;
console.log('\nНИЗ ПАРУСА (строки 0…' + R_TOP + '): поперёк против веера из шкотового угла\n');
const cross0 = [];
for (let k = 1; k <= R_TOP; k++)
  cross0.push(Math.abs(1000 * panels[k].sagA.sag - 1000 * panels[k - 1].sagB.sag));
console.log('  поперёк: швов ' + cross0.length + ', broadseam '
  + cross0.map(v => v.toFixed(0)).join(' / ') + ' мм, худший ' + Math.max(...cross0).toFixed(0) + ' мм');

for (const N of [4, 6, 8]) {
  const rays = radialFoot(cl, R_TOP, N);
  const sags = [];
  for (let k = 0; k + 1 < rays.length; k++) {
    const { A, B } = developPair(rays[k], rays[k + 1]);
    sags.push([sagitta(A), sagitta(B)]);
  }
  const seams = [];
  for (let k = 1; k < sags.length; k++)
    seams.push(Math.abs(1000 * sags[k][0].sag - 1000 * sags[k - 1][1].sag));
  console.log('  веер ' + String(N).padStart(2) + ': швов ' + seams.length + ', broadseam '
    + seams.map(v => v.toFixed(0)).join(' / ') + ' мм, худший ' + Math.max(...seams).toFixed(0) + ' мм');
}

const out = process.argv.indexOf('--json');
if (out > 0 && process.argv[out + 1]) {
  writeFileSync(process.argv[out + 1], JSON.stringify({ panels, kg: { total: kg.total, worst: kg.worst, at: kg.at, grid: kg.grid }, rows: R, cols: cl.cols }, null, 1));
  console.log('записано: ' + process.argv[out + 1]);
}
