// Опытный двухмерный проектор нерастяжимых связей генакера, вне runtime.
// С --free-clew добавляется односторонний шкот; --clew-force задаёт одинаковую
// точечную силу для разных сеток через инерционный прогноз m·(x*−x)/dt²=F.
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
const clewForce = Number(opt('clew-force', '0'));
const forceDt = Number(opt('force-dt', String(1 / 30)));
const sequence = Number(opt('sequence', '0'));
const boardMaterial = process.argv.includes('--board-material');
const rigidBoard = process.argv.includes('--rigid-board');
const freeClew = process.argv.includes('--free-clew');
const expectSheet = opt('expect-sheet', 'any');
const rhoLocal = process.argv.includes('--rho-local');
const compareRho = process.argv.includes('--compare-rho');
const requireConverged = process.argv.includes('--require-converged');
if (!Number.isInteger(cols) || cols < 5 || cols > 65 ||
    !Number.isInteger(maxOuter) || maxOuter < 1 || maxOuter > 8192 ||
    !Number.isInteger(sequence) || sequence < 0 || sequence > 120 ||
    !(rhoFactor > 0 && rhoFactor <= 1e4) || !(perturb >= 0 && perturb <= 1) ||
    !(clewForce >= 0 && clewForce <= 1000) || !(forceDt > 0 && forceDt <= 1) ||
    (clewForce > 0 && (!freeClew || perturb === 0)) ||
    (rigidBoard && !boardMaterial) || (compareRho && (!rhoLocal || sequence)))
  throw new Error('Неверные параметры стенда ткани');
if (!['any', 'taut', 'slack'].includes(expectSheet) ||
    (expectSheet !== 'any' && (!freeClew || sequence)))
  throw new Error('Неверное ожидаемое состояние шкота');
const b = new Boat(pack);
b.o.freeWake = true; b.o.wakeForces = true;
b.wind.o.gust = 0; b.wind.o.shift = 0;
b.setGennaker(true);
const gen = b.p.rig.gennaker;
const sheetLen = Number(opt('sheet-len', String(0.5 * (gen.sheet_min_m + gen.sheet_max_m))));
if (!(sheetLen >= gen.sheet_min_m && sheetLen <= gen.sheet_max_m))
  throw new Error('Длина шкота вне штатного диапазона');
b.o.genSheetLen = sheetLen;
b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * Math.PI / 180; b.u = 3;
b.psi = -40 * Math.PI / 180;
b.step(1 / 30);
const cl = new Cloth(b.rig.sails[2], 2, { rows: 11, cols, iter: 40, boardMaterial, freeClew });
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
const side = Math.sign(b.rigSide || -1);
const sheetLead = [gen.sheet_lead_m[0], Math.abs(gen.sheet_lead_m[1]) * side,
  gen.sheet_lead_m[2]];
let sheetPenalty = rhoLocal ? 2 * cl.mass[cl.clew] * rhoFactor : rho;
const sheetDistance = p => {
  const k = 3 * cl.clew;
  return Math.hypot(p[k] - sheetLead[0], p[k + 1] - sheetLead[1],
    p[k + 2] - sheetLead[2]);
};
const ei = Int32Array.from(hard.map(k => cl.ci[k]));
const ej = Int32Array.from(hard.map(k => cl.cj[k]));
const rest = Float64Array.from(hard.map(k => cl.rest[k]));
const fixed = Uint8Array.from(cl.w, x => x === 0 ? 1 : 0);
const rhoEdge = Float64Array.from(ei, (a, k) => {
  const inverse = cl.w[a] + cl.w[ej[k]];
  return rhoLocal && inverse > 0 ? rhoFactor * 2 / inverse : rho;
});
const basePos = cl.pos.slice();
const base = scoreBase(basePos);
const shape = new Float64Array(3 * N);
if (!clewForce) for (let i = 0; i < N; i++) {
  if (fixed[i]) continue;
  const r = Math.floor(i / cols), c = i % cols;
  const f = Math.sin(Math.PI * r / (cl.rows - 1)) * Math.sin(Math.PI * c / (cols - 1));
  shape[3 * i + 1] = f;
  shape[3 * i + 2] = 0.5 * f;
}
if (freeClew) {
  const k = 3 * cl.clew, d = sheetDistance(basePos);
  const amplitude = clewForce ? clewForce * forceDt ** 2 / cl.mass[cl.clew] / perturb : 1;
  for (let j = 0; j < 3; j++)
    shape[k + j] = amplitude * (basePos[k + j] - sheetLead[j]) / d;
}
const makeTarget = amplitude => Float64Array.from(basePos, (x, i) => x + amplitude * shape[i]);
const target = makeTarget(perturb);

function scoreBase(p) {
  let maxRel = 0, maxAbs = 0, worst = -1, worstD = 0;
  for (let k = 0; k < H; k++) {
    const a = 3 * ei[k], b = 3 * ej[k];
    const d = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1],
      p[b + 2] - p[a + 2]);
    if (d / rest[k] - 1 > maxRel) {
      maxRel = d / rest[k] - 1; worst = k; worstD = d;
    }
    maxAbs = Math.max(maxAbs, Math.max(0, d - rest[k]));
  }
  return { maxRel, maxAbs, worst, worstD };
}

function score(p, reference = target) {
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
    const j = 3 * i, dx = p[j] - reference[j], dy = p[j + 1] - reference[j + 1],
      dz = p[j + 2] - reference[j + 2];
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
  const sheetSpan = freeClew ? sheetDistance(p) : 0;
  const sheetExcess = freeClew ? Math.max(0, sheetSpan - sheetLen) : 0;
  return { maxRel, maxAbs, count, total: Math.sqrt(total),
    displacement: Math.sqrt(displacement), board, sheetSpan, sheetExcess };
}

function sweep(iter) {
  const obj = Object.create(Cloth.prototype);
  obj.pos = target.slice(); obj.w = cl.w;
  obj.ci = ei; obj.cj = ej; obj.ck = new Float64Array(H).fill(1);
  obj.rest = rest; obj.board = () => {};
  const start = performance.now();
  obj.clew = cl.clew;
  for (let j = 0; j < iter; j++) {
    obj.sweep(null, H);
    if (freeClew) obj.sheet(b, b.rigSide);
  }
  return { ...score(obj.pos), ms: performance.now() - start };
}

function project(input = target, state = null) {
  const start = performance.now();
  const p = input.slice(), z = state?.z ?? new Float64Array(3 * H);
  const u = state?.u ?? new Float64Array(3 * H);
  // При --rigid-board внутренние узлы верхней строки не имеют собственных
  // степеней свободы: x_c=(1-t)x_фал+t*x_задний_конец. Это точная линейная
  // кинематика дощечки, а не её посадка ПОСЛЕ проекции ткани.
  const map = new Int32Array(N), weight = new Float64Array(N);
  const offset = new Float64Array(3 * N), massEff = new Float64Array(N);
  const rhsMass = Array.from({ length: 3 }, () => new Float64Array(N));
  const top = cl.rows - 1, head = cl.ix(top, 0), aft = cl.ix(top, cols - 1);
  for (let i = 0; i < N; i++) {
    if (fixed[i]) { map[i] = -1; offset.set(input.subarray(3 * i, 3 * i + 3), 3 * i); }
    else if (rigidBoard && i > head && i < aft) {
      const t = (i - head) / (cols - 1);
      map[i] = aft; weight[i] = t;
      for (let j = 0; j < 3; j++) offset[3 * i + j] = (1 - t) * input[3 * head + j];
    } else { map[i] = i; weight[i] = 1; }
    if (map[i] >= 0) {
      const v = map[i], a = weight[i];
      massEff[v] += cl.mass[i] * a * a;
      for (let j = 0; j < 3; j++)
        rhsMass[j][v] += cl.mass[i] * a * (input[3 * i + j] - offset[3 * i + j]);
    }
  }
  const va = new Int32Array(H), vb = new Int32Array(H);
  const ca = new Float64Array(H), cb = new Float64Array(H);
  const edgeOffset = new Float64Array(3 * H), diag = Float64Array.from(massEff);
  for (let k = 0; k < H; k++) {
    const a = ei[k], b = ej[k];
    va[k] = map[a]; vb[k] = map[b];
    ca[k] = -weight[a]; cb[k] = weight[b];
    if (va[k] === vb[k]) { ca[k] += cb[k]; vb[k] = -1; cb[k] = 0; }
    if (va[k] >= 0) diag[va[k]] += rhoEdge[k] * ca[k] * ca[k];
    if (vb[k] >= 0) diag[vb[k]] += rhoEdge[k] * cb[k] * cb[k];
    for (let j = 0; j < 3; j++)
      edgeOffset[3 * k + j] = offset[3 * b + j] - offset[3 * a + j];
  }
  if (!state) for (let k = 0; k < H; k++) {
    const a = 3 * ei[k], b = 3 * ej[k], h = 3 * k;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const d = Math.hypot(dx, dy, dz), s = Math.min(1, rest[k] / d);
    z[h] = dx * s; z[h + 1] = dy * s; z[h + 2] = dz * s;
  }
  const y = state?.y ?? Array.from({ length: 3 }, () => new Float64Array(N));
  if (!state) for (let i = 0; i < N; i++) if (map[i] === i)
    for (let j = 0; j < 3; j++) y[j][i] = input[3 * i + j];
  const rhs = new Float64Array(N), q = new Float64Array(N);
  const r = new Float64Array(N), d = new Float64Array(N), Ap = new Float64Array(N);
  const sheetZ = state?.sheetZ ?? new Float64Array(3);
  const sheetU = state?.sheetU ?? new Float64Array(3);
  if (freeClew && !state) {
    const k = 3 * cl.clew;
    const dx = p[k] - sheetLead[0], dy = p[k + 1] - sheetLead[1],
      dz = p[k + 2] - sheetLead[2];
    const scale = Math.min(1, sheetLen / Math.hypot(dx, dy, dz));
    sheetZ[0] = dx * scale; sheetZ[1] = dy * scale; sheetZ[2] = dz * scale;
  }
  if (freeClew) diag[map[cl.clew]] += sheetPenalty * weight[cl.clew] ** 2;
  const apply = (v, out) => {
    for (let i = 0; i < N; i++) out[i] = massEff[i] * v[i];
    for (let k = 0; k < H; k++) {
      const a = va[k], b = vb[k];
      const value = (a >= 0 ? ca[k] * v[a] : 0) + (b >= 0 ? cb[k] * v[b] : 0);
      if (a >= 0) out[a] += rhoEdge[k] * ca[k] * value;
      if (b >= 0) out[b] += rhoEdge[k] * cb[k] * value;
    }
    if (freeClew) {
      const a = map[cl.clew];
      out[a] += sheetPenalty * weight[cl.clew] ** 2 * v[a];
    }
  };
  let cgCalls = 0, cgIters = 0, cgCaps = 0;
  const solve = x => {
    apply(x, Ap);
    let lim = 1;
    for (let i = 0; i < N; i++) {
      r[i] = massEff[i] ? rhs[i] - Ap[i] : 0;
      lim = Math.max(lim, Math.abs(rhs[i]));
      q[i] = massEff[i] ? r[i] / diag[i] : 0;
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
        q[i] = massEff[i] ? r[i] / diag[i] : 0;
        next += r[i] * q[i];
      }
      const beta = next / rz;
      for (let i = 0; i < N; i++) d[i] = q[i] + beta * d[i];
      rz = next;
    }
    cgCalls++; cgIters += used;
    if (residual > tol) cgCaps++;
  };
  const dualSum = new Float64Array(3 * N);
  let primal = Infinity, dual = Infinity, used = 0;
  for (let it = 0; it < maxOuter; it++) {
    used++;
    for (let j = 0; j < 3; j++) {
      rhs.set(rhsMass[j]);
      for (let k = 0; k < H; k++) {
        const a = va[k], b = vb[k], h = 3 * k + j;
        const value = rhoEdge[k] * (z[h] - u[h] - edgeOffset[h]);
        if (a >= 0) rhs[a] += ca[k] * value;
        if (b >= 0) rhs[b] += cb[k] * value;
      }
      if (freeClew) {
        const a = map[cl.clew];
        rhs[a] += sheetPenalty * weight[cl.clew] *
          (sheetLead[j] + sheetZ[j] - sheetU[j] - offset[3 * cl.clew + j]);
      }
      solve(y[j]);
      for (let i = 0; i < N; i++)
        p[3 * i + j] = offset[3 * i + j] + (map[i] >= 0 ? weight[i] * y[j][map[i]] : 0);
    }
    primal = 0; dual = 0;
    dualSum.fill(0);
    for (let k = 0; k < H; k++) {
      const a = 3 * ei[k], b = 3 * ej[k], h = 3 * k;
      const ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2];
      const tx = ex + u[h], ty = ey + u[h + 1], tz = ez + u[h + 2];
      const norm = Math.hypot(tx, ty, tz), scale = Math.min(1, rest[k] / norm);
      const nx = tx * scale, ny = ty * scale, nz = tz * scale;
      primal = Math.max(primal, Math.hypot(ex - nx, ey - ny, ez - nz));
      // Настоящая двойственная невязка в независимых координатах:
      // Aᵀ R (zⁿ−zⁿ⁻¹), включая исключённые степени свободы дощечки.
      const dx = rhoEdge[k] * (nx - z[h]);
      const dy = rhoEdge[k] * (ny - z[h + 1]);
      const dz = rhoEdge[k] * (nz - z[h + 2]);
      if (va[k] >= 0) {
        const v = 3 * va[k], a = ca[k];
        dualSum[v] += a * dx; dualSum[v + 1] += a * dy; dualSum[v + 2] += a * dz;
      }
      if (vb[k] >= 0) {
        const v = 3 * vb[k], a = cb[k];
        dualSum[v] += a * dx; dualSum[v + 1] += a * dy; dualSum[v + 2] += a * dz;
      }
      u[h] += ex - nx; u[h + 1] += ey - ny; u[h + 2] += ez - nz;
      z[h] = nx; z[h + 1] = ny; z[h + 2] = nz;
    }
    if (freeClew) {
      const k = 3 * cl.clew;
      const ex = p[k] - sheetLead[0], ey = p[k + 1] - sheetLead[1],
        ez = p[k + 2] - sheetLead[2];
      const tx = ex + sheetU[0], ty = ey + sheetU[1], tz = ez + sheetU[2];
      const scale = Math.min(1, sheetLen / Math.hypot(tx, ty, tz));
      const nx = tx * scale, ny = ty * scale, nz = tz * scale;
      primal = Math.max(primal, Math.hypot(ex - nx, ey - ny, ez - nz));
      const a = 3 * map[cl.clew], w = sheetPenalty * weight[cl.clew];
      dualSum[a] += w * (nx - sheetZ[0]);
      dualSum[a + 1] += w * (ny - sheetZ[1]);
      dualSum[a + 2] += w * (nz - sheetZ[2]);
      sheetU[0] += ex - nx; sheetU[1] += ey - ny; sheetU[2] += ez - nz;
      sheetZ[0] = nx; sheetZ[1] = ny; sheetZ[2] = nz;
    }
    for (let i = 0; i < N; i++) if (massEff[i])
      dual = Math.max(dual, Math.hypot(dualSum[3 * i], dualSum[3 * i + 1], dualSum[3 * i + 2]));
    if (primal < 1e-8 && dual < 1e-8) break;
  }
  return { ...score(p, input), ms: performance.now() - start, used, primal, dual,
    sheetMultiplier: freeClew ? sheetPenalty * Math.hypot(...sheetU) : 0,
    cgMean: cgIters / cgCalls, cgCaps, pos: p,
    state: { z, u, y, sheetZ, sheetU } };
}

const fmt = x => `макс. растяжение ${(100 * x.maxRel).toFixed(3)} % / ${(1000 * x.maxAbs).toFixed(3)} мм; ` +
  `связей >10 нм ${x.count}; L2 остаток ${(1000 * x.total).toFixed(3)} мм; ` +
  `взвешенное смещение ${x.displacement.toFixed(3)} кг^1/2·м; ` +
  `дощечка ${(1000 * x.board).toFixed(2)} мм; ` +
  (freeClew ? `шкот ${x.sheetSpan.toFixed(6)}/${sheetLen.toFixed(6)} м, превышение ${(1000 * x.sheetExcess).toFixed(4)} мм; ` : '') +
  `${x.ms.toFixed(1)} мс`;
console.log(`Цель: возмущение ${perturb} м; rho ${rhoLocal ? 'по приведённой массе связи' : 'единый'}: множитель ${rhoFactor}, диапазон ${Math.min(...rhoEdge).toFixed(4)}…${Math.max(...rhoEdge).toFixed(4)} кг`);
if (freeClew)
  console.log(`Свободный угол: шкот ${sheetLen.toFixed(4)} м, исходное расстояние ${(sheetDistance(basePos)).toFixed(4)} м, rho шкота ${sheetPenalty.toFixed(4)} кг`);
if (clewForce)
  console.log(`Одношаговый опыт с силой у шкотового угла ${clewForce.toFixed(3)} Н, шаг ${forceDt.toFixed(6)} с, масса узла ${cl.mass[cl.clew].toFixed(6)} кг; остальные узлы не возмущены`);
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
if (sequence) {
  if (!rigidBoard) throw new Error('Для последовательности требуется точная дощечка');
  let warmState = null, coldMs = 0, warmMs = 0, coldIter = 0, warmIter = 0;
  let coldCaps = 0, warmCaps = 0, maxDiff = 0, maxBoard = 0, maxStretch = 0;
  let sheetTautFrames = 0, sheetBranchDiffs = 0, maxSheetExcess = 0;
  console.log(`Последовательность ${sequence} кадров: плавный выход 0→${perturb} м и возврат, одна и та же цель для холодного/тёплого решения`);
  console.log('кадр | амплитуда м | холодный/тёплый: итераций | тёплые остатки: м / кг·м | расхождение координат мм');
  for (let k = 0; k < sequence; k++) {
    const phase = (k + 1) / sequence;
    const amplitude = perturb * (phase <= 0.5 ? 2 * phase : 2 * (1 - phase));
    const input = makeTarget(amplitude);
    const cold = project(input);
    const warm = k ? project(input, warmState) : cold;
    warmState = warm.state;
    coldMs += cold.ms; warmMs += warm.ms;
    coldIter += cold.used; warmIter += warm.used;
    if (cold.primal >= 1e-8 || cold.dual >= 1e-8 || cold.cgCaps) coldCaps++;
    if (warm.primal >= 1e-8 || warm.dual >= 1e-8 || warm.cgCaps) warmCaps++;
    maxBoard = Math.max(maxBoard, cold.board, warm.board);
    maxStretch = Math.max(maxStretch, cold.maxRel, warm.maxRel);
    if (freeClew) {
      const coldTaut = cold.sheetMultiplier > 1e-8;
      const warmTaut = warm.sheetMultiplier > 1e-8;
      if (warmTaut) sheetTautFrames++;
      if (coldTaut !== warmTaut) sheetBranchDiffs++;
      maxSheetExcess = Math.max(maxSheetExcess, cold.sheetExcess, warm.sheetExcess);
    }
    let diff = 0;
    for (let i = 0; i < 3 * N; i++) diff = Math.max(diff, Math.abs(cold.pos[i] - warm.pos[i]));
    maxDiff = Math.max(maxDiff, diff);
    console.log(`${k + 1} | ${amplitude.toFixed(4)} | ${cold.used}/${warm.used} | ` +
      `${warm.primal.toExponential(2)}/${warm.dual.toExponential(2)} | ${(1000 * diff).toFixed(4)}`);
  }
  console.log(`Итого: холодный/тёплый ${coldIter}/${warmIter} итераций, ` +
    `${coldMs.toFixed(1)}/${warmMs.toFixed(1)} мс; недоведённых кадров ${coldCaps}/${warmCaps}; ` +
    `макс. расхождение ${(1000 * maxDiff).toFixed(4)} мм, ` +
    `дощечка ${(1000 * maxBoard).toFixed(4)} мм, растяжение ${(100 * maxStretch).toFixed(5)} %` +
    (freeClew ? `; шкот натянут ${sheetTautFrames}/${sequence} кадров, ` +
      `разных ветвей ${sheetBranchDiffs}, макс. превышение ${(1000 * maxSheetExcess).toFixed(6)} мм` : ''));
  if (requireConverged && (coldCaps || warmCaps || maxBoard > 1e-9 ||
      maxSheetExcess > 1e-8)) process.exitCode = 1;
} else {
  for (const iter of [40, 160, 640]) console.log(`ГЗ ${iter}: ${fmt(sweep(iter))}`);
  const result = project();
  console.log(`ADMM ${rigidBoard ? 'с точной дощечкой' : 'без дощечки'} ${maxOuter}: ${fmt(result)}; итераций ${result.used}; ` +
    `остатки ${result.primal.toExponential(2)} м / ${result.dual.toExponential(2)} кг·м; ` +
    `CG сред. ${result.cgMean.toFixed(1)}, лимитных ${result.cgCaps}` +
    (freeClew ? `; множитель шкота ${result.sheetMultiplier.toExponential(3)} кг·м` +
      (clewForce ? ` = ${(result.sheetMultiplier / forceDt ** 2).toFixed(3)} Н` : '') : ''));
  if (requireConverged && (result.primal >= 1e-8 || result.dual >= 1e-8 || result.cgCaps))
    process.exitCode = 1;
  if (requireConverged && ((rigidBoard && result.board > 1e-9) || result.sheetExcess > 1e-8 ||
      (freeClew && result.sheetMultiplier > 1e-8 && Math.abs(result.sheetSpan - sheetLen) > 1e-6)))
    process.exitCode = 1;
  if (expectSheet === 'taut' && !(Math.abs(result.sheetSpan - sheetLen) < 1e-6 &&
      result.sheetMultiplier > 1e-8)) process.exitCode = 1;
  if (expectSheet === 'slack' && !(result.sheetSpan < sheetLen - 1e-6 &&
      result.sheetMultiplier < 1e-8)) process.exitCode = 1;
  if (compareRho) {
    const localPenalty = rhoEdge.slice();
    const localSheetPenalty = sheetPenalty;
    rhoEdge.fill(rho);
    sheetPenalty = rho;
    const control = project();
    rhoEdge.set(localPenalty);
    sheetPenalty = localSheetPenalty;
    let maxDiff = 0;
    for (let i = 0; i < 3 * N; i++)
      maxDiff = Math.max(maxDiff, Math.abs(result.pos[i] - control.pos[i]));
    console.log(`Единый rho: ${control.used} итераций, ${control.ms.toFixed(1)} мс, ` +
      `остатки ${control.primal.toExponential(2)} м / ${control.dual.toExponential(2)} кг·м; ` +
      `макс. разность координат ${(1000 * maxDiff).toFixed(6)} мм` +
      (freeClew ? `, множитель шкота ${control.sheetMultiplier.toExponential(3)} кг·м` : ''));
    if (requireConverged && (control.primal >= 1e-8 || control.dual >= 1e-8 || control.cgCaps))
      process.exitCode = 1;
  }
}
