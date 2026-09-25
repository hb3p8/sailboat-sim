// Опытный двухмерный проектор нерастяжимых связей генакера, вне runtime.
// node tests/cloth-net-admm.mjs --cols=9
import { readFileSync } from 'node:fs';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url), 'utf8'));
const opt = (name, fallback) => process.argv.find(s => s.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const cols = Number(opt('cols', '9'));
const maxOuter = Number(opt('outer', '400'));
const rhoFactor = Number(opt('rho-factor', '100'));
const perturb = Number(opt('perturb', '0.1'));
const boardMaterial = process.argv.includes('--board-material');
const requireConverged = process.argv.includes('--require-converged');
if (!Number.isInteger(cols) || cols < 5 || cols > 65 ||
    !Number.isInteger(maxOuter) || maxOuter < 1 || maxOuter > 8192 ||
    !(rhoFactor > 0 && rhoFactor <= 1e4) || !(perturb >= 0 && perturb <= 1))
  throw new Error('Неверные параметры стенда ткани');
const b = new Boat(pack);
b.o.freeWake = true; b.o.wakeForces = true;
b.wind.o.gust = 0; b.wind.o.shift = 0;
b.setGennaker(true);
b.o.genSheetLen = 0.5 * (b.p.rig.gennaker.sheet_min_m + b.p.rig.gennaker.sheet_max_m);
b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * Math.PI / 180; b.u = 3;
b.psi = -40 * Math.PI / 180;
b.step(1 / 30);
const cl = new Cloth(b.rig.sails[2], 2, { rows: 11, cols, iter: 40, boardMaterial });
if (!cl.step(b, 1 / 30)) throw new Error('Исходный шаг ткани отклонён');
// У начального подшага остаётся собственная невязка у фаловой дощечки;
// доводим общий исходник ДО внесения одинакового возмущения.
cl.iter = 640;
cl.project(b, b.rigSide);
const hard = [];
for (let k = 0; k < cl.ci.length; k++) if (cl.ck[k] === 1) hard.push(k);
const freeMass = Array.from(cl.mass).filter((_, i) => cl.w[i] > 0).sort((a, z) => a - z);
const median = freeMass[Math.floor(freeMass.length / 2)];
console.log(`Генакер ${cl.rows}×${cl.cols}: узлов ${cl.n}, жёстких нерастяжимых связей ${hard.length}, остальных ${cl.ci.length - hard.length}; масса свободного узла ${freeMass[0].toFixed(5)}…${freeMass.at(-1).toFixed(5)} кг, медиана ${median.toFixed(5)} кг`);

const N = cl.n, H = hard.length, rho = median * rhoFactor;
const ei = Int32Array.from(hard.map(k => cl.ci[k]));
const ej = Int32Array.from(hard.map(k => cl.cj[k]));
const rest = Float64Array.from(hard.map(k => cl.rest[k]));
const fixed = Uint8Array.from(cl.w, x => x === 0 ? 1 : 0);
const degree = new Float64Array(N);
for (let k = 0; k < H; k++) { degree[ei[k]]++; degree[ej[k]]++; }
const diag = Float64Array.from(cl.mass, (m, i) => fixed[i] ? 1 : m + rho * degree[i]);
const target = cl.pos.slice();
const base = scoreBase();
for (let i = 0; i < N; i++) {
  if (fixed[i]) continue;
  const r = Math.floor(i / cols), c = i % cols;
  const f = Math.sin(Math.PI * r / (cl.rows - 1)) * Math.sin(Math.PI * c / (cols - 1));
  target[3 * i + 1] += perturb * f;
  target[3 * i + 2] += perturb * 0.5 * f;
}

function scoreBase() {
  let maxRel = 0, maxAbs = 0, worst = -1, worstD = 0;
  for (let k = 0; k < H; k++) {
    const a = 3 * ei[k], b = 3 * ej[k];
    const d = Math.hypot(target[b] - target[a], target[b + 1] - target[a + 1],
      target[b + 2] - target[a + 2]);
    if (d / rest[k] - 1 > maxRel) {
      maxRel = d / rest[k] - 1; worst = k; worstD = d;
    }
    maxAbs = Math.max(maxAbs, Math.max(0, d - rest[k]));
  }
  return { maxRel, maxAbs, worst, worstD };
}

function score(p) {
  let maxRel = 0, maxAbs = 0, count = 0, total = 0;
  for (let k = 0; k < H; k++) {
    const a = 3 * ei[k], b = 3 * ej[k];
    const d = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    const excess = Math.max(0, d - rest[k]);
    if (excess > 1e-8) count++;
    maxRel = Math.max(maxRel, excess / rest[k]);
    maxAbs = Math.max(maxAbs, excess);
    total += excess * excess;
  }
  let displacement = 0;
  for (let i = 0; i < N; i++) if (!fixed[i]) {
    const j = 3 * i, dx = p[j] - target[j], dy = p[j + 1] - target[j + 1],
      dz = p[j + 2] - target[j + 2];
    displacement += cl.mass[i] * (dx * dx + dy * dy + dz * dz);
  }
  const R = cl.rows - 1, a = 3 * cl.ix(R, 0), z = 3 * cl.ix(R, cols - 1);
  const width = cl.rowW[R];
  let board = 0;
  for (let c = 1; c + 1 < cols; c++) {
    const t = boardMaterial ? c / (cols - 1)
      : (cl.px[cl.ix(R, 0)] - cl.px[cl.ix(R, c)]) / width;
    const j = 3 * cl.ix(R, c);
    board = Math.max(board, Math.hypot(
      p[j] - p[a] - (p[z] - p[a]) * t,
      p[j + 1] - p[a + 1] - (p[z + 1] - p[a + 1]) * t,
      p[j + 2] - p[a + 2] - (p[z + 2] - p[a + 2]) * t));
  }
  return { maxRel, maxAbs, count, total: Math.sqrt(total), displacement: Math.sqrt(displacement), board };
}

function sweep(iter) {
  const obj = Object.create(Cloth.prototype);
  obj.pos = target.slice(); obj.w = cl.w;
  obj.ci = ei; obj.cj = ej; obj.ck = new Float64Array(H).fill(1);
  obj.rest = rest; obj.board = () => {};
  const start = performance.now();
  for (let j = 0; j < iter; j++) obj.sweep(null, H);
  return { ...score(obj.pos), ms: performance.now() - start };
}

function project() {
  const p = target.slice(), z = new Float64Array(3 * H), u = new Float64Array(3 * H);
  for (let k = 0; k < H; k++) {
    const a = 3 * ei[k], b = 3 * ej[k], h = 3 * k;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const d = Math.hypot(dx, dy, dz), s = Math.min(1, rest[k] / d);
    z[h] = dx * s; z[h + 1] = dy * s; z[h + 2] = dz * s;
  }
  const delta = Array.from({ length: 3 }, () => new Float64Array(N));
  const rhs = new Float64Array(N), q = new Float64Array(N);
  const r = new Float64Array(N), d = new Float64Array(N), Ap = new Float64Array(N);
  const apply = (v, out) => {
    for (let i = 0; i < N; i++) out[i] = fixed[i] ? 0 : cl.mass[i] * v[i];
    for (let k = 0; k < H; k++) {
      const a = ei[k], b = ej[k], diff = v[a] - v[b];
      if (!fixed[a]) out[a] += rho * diff;
      if (!fixed[b]) out[b] -= rho * diff;
    }
  };
  let cgCalls = 0, cgIters = 0, cgCaps = 0;
  const solve = x => {
    apply(x, Ap);
    let lim = 1;
    for (let i = 0; i < N; i++) {
      r[i] = fixed[i] ? 0 : rhs[i] - Ap[i];
      lim = Math.max(lim, Math.abs(rhs[i]));
      q[i] = fixed[i] ? 0 : r[i] / diag[i];
      d[i] = q[i];
    }
    const tol = lim * 1e-10;
    let rz = 0;
    for (let i = 0; i < N; i++) rz += r[i] * q[i];
    let used = 0, residual = Math.max(...r.map(Math.abs));
    while (residual > tol && used < 4 * N) {
      apply(d, Ap);
      let dAd = 0;
      for (let i = 0; i < N; i++) dAd += d[i] * Ap[i];
      if (!(dAd > 0)) throw new Error('Не положительно определена система сети');
      const alpha = rz / dAd;
      for (let i = 0; i < N; i++) { x[i] += alpha * d[i]; r[i] -= alpha * Ap[i]; }
      residual = 0;
      for (let i = 0; i < N; i++) residual = Math.max(residual, Math.abs(r[i]));
      used++;
      if (residual <= tol) break;
      let next = 0;
      for (let i = 0; i < N; i++) {
        q[i] = fixed[i] ? 0 : r[i] / diag[i];
        next += r[i] * q[i];
      }
      const beta = next / rz;
      for (let i = 0; i < N; i++) d[i] = q[i] + beta * d[i];
      rz = next;
    }
    cgCalls++; cgIters += used;
    if (residual > tol) cgCaps++;
  };
  const start = performance.now();
  let primal = Infinity, dual = Infinity, used = 0;
  for (let it = 0; it < maxOuter; it++) {
    used++;
    for (let j = 0; j < 3; j++) {
      rhs.fill(0);
      for (let k = 0; k < H; k++) {
        const a = ei[k], b = ej[k], h = 3 * k + j;
        const v = rho * (z[h] - u[h] - target[3 * b + j] + target[3 * a + j]);
        if (!fixed[a]) rhs[a] -= v;
        if (!fixed[b]) rhs[b] += v;
      }
      solve(delta[j]);
      for (let i = 0; i < N; i++) p[3 * i + j] = target[3 * i + j] + delta[j][i];
    }
    primal = 0; dual = 0;
    for (let k = 0; k < H; k++) {
      const a = 3 * ei[k], b = 3 * ej[k], h = 3 * k;
      const ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2];
      const tx = ex + u[h], ty = ey + u[h + 1], tz = ez + u[h + 2];
      const norm = Math.hypot(tx, ty, tz), scale = Math.min(1, rest[k] / norm);
      const nx = tx * scale, ny = ty * scale, nz = tz * scale;
      primal = Math.max(primal, Math.hypot(ex - nx, ey - ny, ez - nz));
      dual = Math.max(dual, rho * Math.hypot(nx - z[h], ny - z[h + 1], nz - z[h + 2]));
      u[h] += ex - nx; u[h + 1] += ey - ny; u[h + 2] += ez - nz;
      z[h] = nx; z[h + 1] = ny; z[h + 2] = nz;
    }
    if (primal < 1e-8 && dual < 1e-8) break;
  }
  return { ...score(p), ms: performance.now() - start, used, primal, dual,
    cgMean: cgIters / cgCalls, cgCaps };
}

const fmt = x => `макс. растяжение ${(100 * x.maxRel).toFixed(3)} % / ${(1000 * x.maxAbs).toFixed(3)} мм; ` +
  `связей >10 нм ${x.count}; L2 остаток ${(1000 * x.total).toFixed(3)} мм; ` +
  `взвешенное смещение ${x.displacement.toFixed(3)} кг^1/2·м; ` +
  `дощечка ${(1000 * x.board).toFixed(2)} мм; ${x.ms.toFixed(1)} мс`;
console.log(`Цель: возмущение ${perturb} м; rho = ${rhoFactor} × медианная масса = ${rho.toFixed(3)} кг`);
console.log(`Исходник после 640 штатных проходов: макс. растяжение ${(100 * base.maxRel).toFixed(4)} % / ${(1000 * base.maxAbs).toFixed(4)} мм`);
if (base.worst >= 0) {
  const k = base.worst, a = ei[k], z = ej[k];
  console.log(`Худшая связь ${a} (стр. ${Math.floor(a / cols)}, стлб. ${a % cols}) → ${z} (стр. ${Math.floor(z / cols)}, стлб. ${z % cols}): ` +
    `задано ${rest[k].toFixed(6)} м, в исходной форме ${base.worstD.toFixed(6)} м`);
}
const top = cl.rows - 1, head = cl.ix(top, 0), aft = cl.ix(top, cols - 1);
let topMaterial = 0, directRest = null;
for (let k = 0; k < H; k++) {
  if (ei[k] === head && ej[k] === aft) directRest = rest[k];
}
for (let c = 0; c + 1 < cols; c++) topMaterial += cl.rest[top * (cols - 1) + c];
const h0 = 3 * head, h1 = 3 * aft;
const topSpan = Math.hypot(cl.pos[h1] - cl.pos[h0], cl.pos[h1 + 1] - cl.pos[h0 + 1],
  cl.pos[h1 + 2] - cl.pos[h0 + 2]);
console.log(`Дощечка ${boardMaterial ? 'по материальным долям' : 'штатная'}: длина последовательных связей ${topMaterial.toFixed(6)} м, ` +
  `прямое ограничение ${directRest?.toFixed(6) ?? 'нет'} м, ` +
  `расстояние концов ${topSpan.toFixed(6)} м, rowW ${cl.rowW[top].toFixed(6)} м`);
console.log(`Вход: ${fmt({ ...score(target), ms: 0 })}`);
for (const iter of [40, 160, 640]) console.log(`ГЗ ${iter}: ${fmt(sweep(iter))}`);
const result = project();
console.log(`ADMM ${maxOuter}: ${fmt(result)}; итераций ${result.used}; ` +
  `остатки ${result.primal.toExponential(2)}/${result.dual.toExponential(2)} м; ` +
  `CG сред. ${result.cgMean.toFixed(1)}, лимитных ${result.cgCaps}`);
if (requireConverged && (result.primal >= 1e-8 || result.dual >= 1e-8 || result.cgCaps))
  process.exitCode = 1;
