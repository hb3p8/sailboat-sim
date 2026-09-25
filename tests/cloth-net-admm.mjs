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
let solver = opt('solver', 'admm');
const dualStep = opt('dual-step', 'rows');
const compareSolver = process.argv.includes('--compare-solver');
const trace = process.argv.includes('--trace');
const maxOuter = Number(opt('outer', '400'));
const hybridSweeps = Number(opt('hybrid-sweeps', '256'));
const rhoFactor = Number(opt('rho-factor', '100'));
const relax = Number(opt('relax', '1'));
const perturb = Number(opt('perturb', '0.1'));
const clewForce = Number(opt('clew-force', '0'));
const forceDt = Number(opt('force-dt', String(1 / 30)));
const dynamicSeconds = Number(opt('dynamic-seconds', '0'));
const dynamicHz = Number(opt('dynamic-hz', '60'));
const dynamicLoad = opt('dynamic-load', 'clew');
const dampHz = Number(opt('damp-hz', '6'));
const sequence = Number(opt('sequence', '0'));
const boardMaterial = process.argv.includes('--board-material');
const rigidBoard = process.argv.includes('--rigid-board');
const freeClew = process.argv.includes('--free-clew');
const expectSheet = opt('expect-sheet', 'any');
const rhoLocal = process.argv.includes('--rho-local');
const rhoBoardPower = Number(opt('rho-board-power',
  process.argv.includes('--rho-board-lever') ? '2' : '0'));
const compareRho = process.argv.includes('--compare-rho');
const requireConverged = process.argv.includes('--require-converged');
if (!Number.isInteger(cols) || cols < 5 || cols > 65 ||
    !['admm', 'dual', 'coordinate', 'hybrid'].includes(solver) || !['rows', 'power'].includes(dualStep) ||
    !Number.isInteger(maxOuter) || maxOuter < 1 || maxOuter > 8192 ||
    !Number.isInteger(hybridSweeps) || hybridSweeps < 1 || hybridSweeps > 8192 ||
    !Number.isInteger(sequence) || sequence < 0 || sequence > 120 ||
    !(rhoFactor > 0 && rhoFactor <= 1e4) || !(perturb >= 0 && perturb <= 1) ||
    !(relax >= 1 && relax <= 1.9) ||
    (relax !== 1 && !['admm', 'hybrid'].includes(solver)) ||
    !(rhoBoardPower >= 0 && rhoBoardPower <= 2) ||
    !(clewForce >= 0 && clewForce <= 1000) || !(forceDt > 0 && forceDt <= 1) ||
    (clewForce > 0 && (!freeClew || perturb === 0)) ||
    !(dynamicSeconds >= 0 && dynamicSeconds <= 5) ||
    ![30, 60, 120].includes(dynamicHz) || !['clew', 'frozen-pressure'].includes(dynamicLoad) ||
    !(dampHz >= 0 && dampHz <= 20) ||
    (dynamicSeconds > 0 && (!freeClew || !rigidBoard ||
      (dynamicLoad === 'clew' && !clewForce) || sequence || compareRho)) ||
    (rigidBoard && !boardMaterial) ||
    (rhoBoardPower > 0 && (!rhoLocal || !rigidBoard || !['admm', 'hybrid'].includes(solver))) ||
    (compareRho && (solver !== 'admm' || !rhoLocal || sequence)) ||
    (compareSolver && (solver === 'admm' || sequence || dynamicSeconds)))
  throw new Error('Неверные параметры стенда ткани');
if (!['any', 'taut', 'slack'].includes(expectSheet) ||
    (expectSheet !== 'any' && (!freeClew || sequence || dynamicSeconds)))
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
if (dynamicSeconds && dynamicLoad === 'frozen-pressure') {
  const D = Math.PI / 180;
  b.o.crewHike = -1; b.o.crewMass = 219.9;
  b.o.sheet = 70 * D; b.o.twist = 8 * D;
}
b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * Math.PI / 180; b.u = 3;
b.psi = -40 * Math.PI / 180;
if (dynamicSeconds && dynamicLoad === 'frozen-pressure') {
  const D = Math.PI / 180;
  const wrap = x => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  for (let i = 0; i < 30 * 30; i++) {
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
      -(2.2 * wrap(-40 * D - b.psi) - 0.9 * b.r)));
    b.step(1 / 30);
  }
} else b.step(1 / 30);
const cl = new Cloth(b.rig.sails[2], 2, { rows: 11, cols, iter: 40, boardMaterial, freeClew });
if (!cl.step(b, 1 / 30)) throw new Error('Исходный шаг ткани отклонён');
const frozenNormals = cl.nrm.slice();
const frozenPressure = cl.pressureForce.slice();
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
let boardLeverLinks = 0;
if (rhoBoardPower > 0) {
  const head = cl.ix(cl.rows - 1, 0), aft = cl.ix(cl.rows - 1, cols - 1);
  for (let k = 0; k < H; k++) {
    const a = ei[k], b = ej[k];
    const inner = fixed[a] && b > head && b < aft ? b :
      fixed[b] && a > head && a < aft ? a : -1;
    if (inner < 0) continue;
    const lever = (inner - head) / (cols - 1);
    rhoEdge[k] /= lever ** rhoBoardPower;
    boardLeverLinks++;
  }
}
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

function constraintStats(p, z = null) {
  const names = ['хорда', 'высота', 'поводки'];
  const limits = [cl.rows * (cols - 1), cl.rows * (cols - 1) + (cl.rows - 1) * cols];
  const groups = names.map(name => ({ name, maxExcess: 0, maxPrimal: 0,
    stretched: 0, nearActive: 0, total: 0, worst: -1 }));
  for (let k = 0; k < H; k++) {
    const group = groups[hard[k] < limits[0] ? 0 : hard[k] < limits[1] ? 1 : 2];
    const a = 3 * ei[k], b = 3 * ej[k], h = 3 * k;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const len = Math.hypot(dx, dy, dz), excess = Math.max(0, len - rest[k]);
    const primal = z ? Math.hypot(dx - z[h], dy - z[h + 1], dz - z[h + 2]) : 0;
    group.total++;
    if (excess > 1e-8) group.stretched++;
    if (len >= rest[k] - 1e-6) group.nearActive++;
    if (primal > group.maxPrimal) { group.maxPrimal = primal; group.worst = k; }
    group.maxExcess = Math.max(group.maxExcess, excess);
  }
  return groups;
}

function printConstraintStats(result) {
  const groups = constraintStats(result.pos, result.state.z);
  for (const g of groups) {
    let where = '';
    if (g.worst >= 0) {
      const k = g.worst;
      const head = cl.ix(cl.rows - 1, 0), aft = cl.ix(cl.rows - 1, cols - 1);
      const boardNode = [ei[k], ej[k]].find(i => i > head && i < aft);
      const lever = boardNode == null ? '' : `, плечо дощечки ${(boardNode - head) / (cols - 1)}`;
      where = `, худшая первичная связь ${ei[k]}→${ej[k]} (${k}), ` +
        `rho ${rhoEdge[k].toFixed(4)} кг${lever}`;
    }
    console.log(`Связи ${g.name}: активных ≤1 мкм ${g.nearActive}/${g.total}, ` +
      `растянутых >10 нм ${g.stretched}, max превышение ${(1000 * g.maxExcess).toExponential(3)} мм, ` +
      `max первичная ${(1000 * g.maxPrimal).toExponential(3)} мм${where}`);
  }
}

function printTrace(label, result) {
  if (result.progress)
    console.log(`${label}: итерация / первичная м / двойственная кг·м / сред. CG: ` +
      result.progress.map(x => `${x[0]}/${x[1].toExponential(2)}/${x[2].toExponential(2)}/${x[3].toFixed(1)}`).join('  '));
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

function seedAdmm(p, lambda, map) {
  const z = new Float64Array(3 * H), u = new Float64Array(3 * H);
  for (let k = 0; k < H; k++) {
    const a = 3 * ei[k], b = 3 * ej[k], h = 3 * k;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const d = Math.hypot(dx, dy, dz), scale = Math.min(1, rest[k] / d);
    z[h] = dx * scale; z[h + 1] = dy * scale; z[h + 2] = dz * scale;
    u[h] = lambda[h] / rhoEdge[k];
    u[h + 1] = lambda[h + 1] / rhoEdge[k];
    u[h + 2] = lambda[h + 2] / rhoEdge[k];
  }
  const y = Array.from({ length: 3 }, () => new Float64Array(N));
  for (let i = 0; i < N; i++) if (map[i] === i)
    for (let j = 0; j < 3; j++) y[j][i] = p[3 * i + j];
  const sheetZ = new Float64Array(3), sheetU = new Float64Array(3);
  if (freeClew) {
    const k = 3 * cl.clew;
    const dx = p[k] - sheetLead[0], dy = p[k + 1] - sheetLead[1],
      dz = p[k + 2] - sheetLead[2];
    const scale = Math.min(1, sheetLen / Math.hypot(dx, dy, dz));
    sheetZ[0] = dx * scale; sheetZ[1] = dy * scale; sheetZ[2] = dz * scale;
    for (let j = 0; j < 3; j++) sheetU[j] = lambda[3 * H + j] / sheetPenalty;
  }
  return { z, u, y, sheetZ, sheetU };
}

function project(input = target, state = null, method = solver) {
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
  if (method === 'dual') return projectDual({ input, start, state, map, weight,
    offset, massEff, rhsMass, va, vb, ca, cb, edgeOffset });
  if (method === 'coordinate') return projectCoordinate({ input, start, state, map,
    weight, offset, massEff, rhsMass, va, vb, ca, cb, edgeOffset });
  if (method === 'hybrid') {
    const coarse = projectCoordinate({ input, start: performance.now(),
      state: state?.lambda ? { lambda: state.lambda } : null,
      map, weight, offset, massEff, rhsMass, va, vb, ca, cb, edgeOffset },
    hybridSweeps);
    const refined = project(input, seedAdmm(coarse.pos, coarse.state.lambda, map), 'admm');
    const lambda = new Float64Array(3 * (H + (freeClew ? 1 : 0)));
    for (let k = 0; k < H; k++)
      for (let j = 0; j < 3; j++) lambda[3 * k + j] = rhoEdge[k] * refined.state.u[3 * k + j];
    if (freeClew) for (let j = 0; j < 3; j++)
      lambda[3 * H + j] = sheetPenalty * refined.state.sheetU[j];
    return { ...refined, ms: coarse.ms + refined.ms,
      used: coarse.used + refined.used, coordUsed: coarse.used,
      admmUsed: refined.used, state: { ...refined.state, lambda } };
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
  const progress = [];
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
      const hx = relax * ex + (1 - relax) * z[h];
      const hy = relax * ey + (1 - relax) * z[h + 1];
      const hz = relax * ez + (1 - relax) * z[h + 2];
      const tx = hx + u[h], ty = hy + u[h + 1], tz = hz + u[h + 2];
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
      u[h] += hx - nx; u[h + 1] += hy - ny; u[h + 2] += hz - nz;
      z[h] = nx; z[h + 1] = ny; z[h + 2] = nz;
    }
    if (freeClew) {
      const k = 3 * cl.clew;
      const ex = p[k] - sheetLead[0], ey = p[k + 1] - sheetLead[1],
        ez = p[k + 2] - sheetLead[2];
      const hx = relax * ex + (1 - relax) * sheetZ[0];
      const hy = relax * ey + (1 - relax) * sheetZ[1];
      const hz = relax * ez + (1 - relax) * sheetZ[2];
      const tx = hx + sheetU[0], ty = hy + sheetU[1], tz = hz + sheetU[2];
      const scale = Math.min(1, sheetLen / Math.hypot(tx, ty, tz));
      const nx = tx * scale, ny = ty * scale, nz = tz * scale;
      primal = Math.max(primal, Math.hypot(ex - nx, ey - ny, ez - nz));
      const a = 3 * map[cl.clew], w = sheetPenalty * weight[cl.clew];
      dualSum[a] += w * (nx - sheetZ[0]);
      dualSum[a + 1] += w * (ny - sheetZ[1]);
      dualSum[a + 2] += w * (nz - sheetZ[2]);
      sheetU[0] += hx - nx; sheetU[1] += hy - ny; sheetU[2] += hz - nz;
      sheetZ[0] = nx; sheetZ[1] = ny; sheetZ[2] = nz;
    }
    for (let i = 0; i < N; i++) if (massEff[i])
      dual = Math.max(dual, Math.hypot(dualSum[3 * i], dualSum[3 * i + 1], dualSum[3 * i + 2]));
    if (trace && ([1, 40, 160, 640, 1024, 2048, 4096, 8192].includes(used) ||
        (primal < 1e-8 && dual < 1e-8)))
      progress.push([used, primal, dual, cgIters / cgCalls]);
    if (primal < 1e-8 && dual < 1e-8) break;
  }
  return { ...score(p, input), ms: performance.now() - start, used, primal, dual,
    sheetMultiplier: freeClew ? sheetPenalty * Math.hypot(...sheetU) : 0,
    cgMean: cgIters / cgCalls, cgCaps, pos: p,
    state: { z, u, y, sheetZ, sheetU }, progress };
}

// Точная блочная минимизация двойственной задачи по одной связи за раз.
// После каждой усадки импульса обновляются только затронутые степени свободы;
// общий линейный шаг и штраф ADMM отсутствуют. Это диагностический кандидат,
// а не изменение физического кроя или штатного решателя.
function projectCoordinate({ input, start, state, map, weight, offset, massEff,
  rhsMass, va, vb, ca, cb, edgeOffset }, outerLimit = maxOuter) {
  const E = H + (freeClew ? 1 : 0);
  const a = new Int32Array(E), b = new Int32Array(E);
  const u = new Float64Array(E), v = new Float64Array(E);
  const limit = new Float64Array(E), off = new Float64Array(3 * E);
  const q = new Float64Array(E);
  for (let e = 0; e < H; e++) {
    a[e] = va[e]; b[e] = vb[e]; u[e] = ca[e]; v[e] = cb[e];
    limit[e] = rest[e];
    off.set(edgeOffset.subarray(3 * e, 3 * e + 3), 3 * e);
  }
  if (freeClew) {
    const e = H, k = 3 * cl.clew;
    a[e] = map[cl.clew]; b[e] = -1; u[e] = weight[cl.clew];
    limit[e] = sheetLen;
    for (let j = 0; j < 3; j++) off[3 * e + j] = offset[k + j] - sheetLead[j];
  }
  for (let e = 0; e < E; e++)
    q[e] = (a[e] >= 0 ? u[e] ** 2 / massEff[a[e]] : 0) +
      (b[e] >= 0 ? v[e] ** 2 / massEff[b[e]] : 0);
  const lambda = state?.lambda?.slice() ?? new Float64Array(3 * E);
  if (lambda.length !== 3 * E) throw new Error('Неверное состояние координатного решателя');
  const y = new Float64Array(3 * N), p = new Float64Array(3 * N);
  for (let i = 0; i < N; i++) if (massEff[i])
    for (let j = 0; j < 3; j++) y[3 * i + j] = rhsMass[j][i] / massEff[i];
  for (let e = 0; e < E; e++) {
    const k = 3 * e;
    for (let j = 0; j < 3; j++) {
      if (a[e] >= 0) y[3 * a[e] + j] -= u[e] * lambda[k + j] / massEff[a[e]];
      if (b[e] >= 0) y[3 * b[e] + j] -= v[e] * lambda[k + j] / massEff[b[e]];
    }
  }
  const edgeAt = (e, j) => off[3 * e + j] +
    (a[e] >= 0 ? u[e] * y[3 * a[e] + j] : 0) +
    (b[e] >= 0 ? v[e] * y[3 * b[e] + j] : 0);
  let primal = Infinity, dual = Infinity, kkt = Infinity, used = 0;
  for (let it = 0; it < outerLimit; it++) {
    used++;
    dual = 0;
    for (let n = 0; n < E; n++) {
      const e = it % 2 ? E - 1 - n : n, h = q[e], k = 3 * e;
      if (!h) continue;
      const tx = lambda[k] + edgeAt(e, 0) / h;
      const ty = lambda[k + 1] + edgeAt(e, 1) / h;
      const tz = lambda[k + 2] + edgeAt(e, 2) / h;
      const norm = Math.hypot(tx, ty, tz);
      const scale = norm > 0 ? Math.max(0, 1 - limit[e] / (h * norm)) : 0;
      const dx = scale * tx - lambda[k];
      const dy = scale * ty - lambda[k + 1];
      const dz = scale * tz - lambda[k + 2];
      dual = Math.max(dual, Math.hypot(dx, dy, dz));
      lambda[k] += dx; lambda[k + 1] += dy; lambda[k + 2] += dz;
      if (a[e] >= 0) {
        const i = 3 * a[e], factor = u[e] / massEff[a[e]];
        y[i] -= factor * dx; y[i + 1] -= factor * dy; y[i + 2] -= factor * dz;
      }
      if (b[e] >= 0) {
        const i = 3 * b[e], factor = v[e] / massEff[b[e]];
        y[i] -= factor * dx; y[i + 1] -= factor * dy; y[i + 2] -= factor * dz;
      }
    }
    primal = 0; kkt = 0;
    for (let e = 0; e < E; e++) {
      const h = q[e], k = 3 * e;
      const ex = edgeAt(e, 0), ey = edgeAt(e, 1), ez = edgeAt(e, 2);
      primal = Math.max(primal, Math.max(0, Math.hypot(ex, ey, ez) - limit[e]));
      if (!h) continue;
      const tx = lambda[k] + ex / h, ty = lambda[k + 1] + ey / h,
        tz = lambda[k + 2] + ez / h;
      const norm = Math.hypot(tx, ty, tz);
      const scale = norm > 0 ? Math.max(0, 1 - limit[e] / (h * norm)) : 0;
      kkt = Math.max(kkt, h * Math.hypot(scale * tx - lambda[k],
        scale * ty - lambda[k + 1], scale * tz - lambda[k + 2]));
    }
    if (primal < 1e-8 && dual < 1e-8 && kkt < 1e-8) break;
  }
  for (let i = 0; i < N; i++)
    for (let j = 0; j < 3; j++)
      p[3 * i + j] = offset[3 * i + j] +
        (map[i] >= 0 ? weight[i] * y[3 * map[i] + j] : 0);
  const sheetMultiplier = freeClew
    ? Math.hypot(lambda[3 * H], lambda[3 * H + 1], lambda[3 * H + 2]) : 0;
  return { ...score(p, input), ms: performance.now() - start, used,
    primal, dual, kkt, sheetMultiplier, cgMean: 0, cgCaps: 0,
    pos: p, state: { lambda } };
}

// Независимый численный кандидат для той же выпуклой проекции. Двойственная
// переменная — импульс каждой нерастяжимой связи. Исключение координат даёт
// выпуклую квадратичную функцию плюс L·|λ|; её prox — векторная усадка.
// Диагональные шаги масштабируются строгой оценкой нормы через суммы строк,
// а не подбираются под конкретную сетку или давление.
function projectDual({ input, start, state, map, weight, offset, massEff,
  rhsMass, va, vb, ca, cb, edgeOffset }) {
  const E = H + (freeClew ? 1 : 0);
  const a = new Int32Array(E), b = new Int32Array(E);
  const u = new Float64Array(E), v = new Float64Array(E);
  const limit = new Float64Array(E), off = new Float64Array(3 * E);
  for (let e = 0; e < H; e++) {
    a[e] = va[e]; b[e] = vb[e]; u[e] = ca[e]; v[e] = cb[e];
    limit[e] = rest[e];
    off.set(edgeOffset.subarray(3 * e, 3 * e + 3), 3 * e);
  }
  if (freeClew) {
    const e = H, k = 3 * cl.clew;
    a[e] = map[cl.clew]; b[e] = -1; u[e] = weight[cl.clew];
    limit[e] = sheetLen;
    for (let j = 0; j < 3; j++) off[3 * e + j] = offset[k + j] - sheetLead[j];
  }
  const step = new Float64Array(E), nodeAbs = new Float64Array(N);
  for (let e = 0; e < E; e++) {
    const diag = (a[e] >= 0 ? u[e] ** 2 / massEff[a[e]] : 0) +
      (b[e] >= 0 ? v[e] ** 2 / massEff[b[e]] : 0);
    step[e] = diag > 0 ? 1 / diag : 0;
    const w = Math.sqrt(step[e]);
    if (a[e] >= 0) nodeAbs[a[e]] += Math.abs(u[e]) * w;
    if (b[e] >= 0) nodeAbs[b[e]] += Math.abs(v[e]) * w;
  }
  let rowBound = 0;
  for (let e = 0; e < E; e++) {
    const bound = Math.sqrt(step[e]) *
      ((a[e] >= 0 ? Math.abs(u[e]) * nodeAbs[a[e]] / massEff[a[e]] : 0) +
       (b[e] >= 0 ? Math.abs(v[e]) * nodeAbs[b[e]] / massEff[b[e]] : 0));
    rowBound = Math.max(rowBound, bound);
  }
  if (!(rowBound > 0)) throw new Error('Двойственная сеть не имеет свободных связей');
  let spectral = rowBound;
  if (dualStep === 'power') {
    const eigenVec = new Float64Array(E), nextVec = new Float64Array(E);
    const node = new Float64Array(N);
    let norm = 0;
    for (let e = 0; e < E; e++) {
      eigenVec[e] = Math.sin(0.73 * (e + 1)) + 0.31 * Math.cos(1.17 * (e + 1));
      norm += eigenVec[e] ** 2;
    }
    norm = Math.sqrt(norm);
    for (let e = 0; e < E; e++) eigenVec[e] /= norm;
    for (let it = 0; it < 80; it++) {
      node.fill(0);
      for (let e = 0; e < E; e++) {
        const value = Math.sqrt(step[e]) * eigenVec[e];
        if (a[e] >= 0) node[a[e]] += u[e] * value;
        if (b[e] >= 0) node[b[e]] += v[e] * value;
      }
      for (let i = 0; i < N; i++) if (massEff[i]) node[i] /= massEff[i];
      norm = 0;
      for (let e = 0; e < E; e++) {
        nextVec[e] = Math.sqrt(step[e]) *
          ((a[e] >= 0 ? u[e] * node[a[e]] : 0) +
           (b[e] >= 0 ? v[e] * node[b[e]] : 0));
        norm += nextVec[e] ** 2;
      }
      norm = Math.sqrt(norm);
      if (!(norm > 0)) throw new Error('Спектральная оценка двойственной сети вырождена');
      for (let e = 0; e < E; e++) eigenVec[e] = nextVec[e] / norm;
    }
    spectral = norm;
  }
  for (let e = 0; e < E; e++) step[e] *= 0.9 / spectral;
  let lambda = state?.lambda?.slice() ?? new Float64Array(3 * E);
  if (lambda.length !== 3 * E) throw new Error('Неверное состояние двойственного решателя');
  const extrap = lambda.slice();
  let next = new Float64Array(3 * E);
  const nodeSum = new Float64Array(3 * N), p = new Float64Array(3 * N);
  const edge = new Float64Array(3 * E), trial = new Float64Array(3 * N);
  const trialEdge = new Float64Array(3 * E), y = new Float64Array(3 * N);
  const primalAt = (dual, pos, edges) => {
    nodeSum.fill(0);
    for (let e = 0; e < E; e++) {
      const k = 3 * e;
      if (a[e] >= 0) {
        const i = 3 * a[e], w = u[e];
        nodeSum[i] += w * dual[k];
        nodeSum[i + 1] += w * dual[k + 1];
        nodeSum[i + 2] += w * dual[k + 2];
      }
      if (b[e] >= 0) {
        const i = 3 * b[e], w = v[e];
        nodeSum[i] += w * dual[k];
        nodeSum[i + 1] += w * dual[k + 1];
        nodeSum[i + 2] += w * dual[k + 2];
      }
    }
    for (let i = 0; i < N; i++) if (massEff[i])
      for (let j = 0; j < 3; j++)
        y[3 * i + j] = (rhsMass[j][i] - nodeSum[3 * i + j]) / massEff[i];
    for (let i = 0; i < N; i++)
      for (let j = 0; j < 3; j++)
        pos[3 * i + j] = offset[3 * i + j] +
          (map[i] >= 0 ? weight[i] * y[3 * map[i] + j] : 0);
    for (let e = 0; e < E; e++)
      for (let j = 0; j < 3; j++)
        edges[3 * e + j] = off[3 * e + j] +
          (a[e] >= 0 ? u[e] * y[3 * a[e] + j] : 0) +
          (b[e] >= 0 ? v[e] * y[3 * b[e] + j] : 0);
  };
  const shrink = (source, edges, output) => {
    for (let e = 0; e < E; e++) {
      const k = 3 * e, h = step[e];
      if (!h) { output[k] = 0; output[k + 1] = 0; output[k + 2] = 0; continue; }
      const x = source[k] + h * edges[k],
        z = source[k + 1] + h * edges[k + 1],
        w = source[k + 2] + h * edges[k + 2];
      const norm = Math.hypot(x, z, w);
      const factor = norm > 0 ? Math.max(0, 1 - h * limit[e] / norm) : 0;
      output[k] = factor * x; output[k + 1] = factor * z; output[k + 2] = factor * w;
    }
  };
  const fixedPoint = new Float64Array(3 * E);
  let primal = Infinity, dual = Infinity, kkt = Infinity, momentum = 1, used = 0;
  for (let it = 0; it < maxOuter; it++) {
    used++;
    primalAt(extrap, trial, trialEdge);
    shrink(extrap, trialEdge, next);
    primalAt(next, p, edge);
    shrink(next, edge, fixedPoint);
    primal = 0; dual = 0; kkt = 0;
    for (let e = 0; e < E; e++) {
      const i = 3 * e;
      primal = Math.max(primal, Math.max(0,
        Math.hypot(edge[i], edge[i + 1], edge[i + 2]) - limit[e]));
      const residual = Math.hypot(fixedPoint[i] - next[i],
        fixedPoint[i + 1] - next[i + 1], fixedPoint[i + 2] - next[i + 2]);
      dual = Math.max(dual, residual);
      if (step[e]) kkt = Math.max(kkt, residual / step[e]);
    }
    if (primal < 1e-8 && dual < 1e-8 && kkt < 1e-8) {
      lambda = next.slice();
      break;
    }
    const newer = (1 + Math.sqrt(1 + 4 * momentum * momentum)) / 2;
    const beta = (momentum - 1) / newer;
    for (let i = 0; i < 3 * E; i++) extrap[i] = next[i] + beta * (next[i] - lambda[i]);
    momentum = newer;
    if (it + 1 === maxOuter) { lambda = next.slice(); break; }
    const swap = lambda; lambda = next; next = swap;
  }
  const sheetMultiplier = freeClew
    ? Math.hypot(lambda[3 * H], lambda[3 * H + 1], lambda[3 * H + 2]) : 0;
  return { ...score(p, input), ms: performance.now() - start, used,
    primal, dual, kkt, sheetMultiplier, cgMean: 0, cgCaps: 0,
    pos: p, state: { lambda }, rowBound, spectral };
}

const converged = x => x.primal < 1e-8 && x.dual < 1e-8 && !x.cgCaps &&
  (['admm', 'hybrid'].includes(solver) || x.kkt < 1e-8);
const solverName = () => solver === 'admm' ? 'ADMM' :
  solver === 'dual' ? 'Двойственный prox' :
  solver === 'coordinate' ? 'Координатный двойственный' : 'Координатный + ADMM';

const fmt = x => `макс. растяжение ${(100 * x.maxRel).toFixed(3)} % / ${(1000 * x.maxAbs).toFixed(3)} мм; ` +
  `связей >10 нм ${x.count}; L2 остаток ${(1000 * x.total).toFixed(3)} мм; ` +
  `взвешенное смещение ${x.displacement.toFixed(3)} кг^1/2·м; ` +
  `дощечка ${(1000 * x.board).toFixed(2)} мм; ` +
  (freeClew ? `шкот ${x.sheetSpan.toFixed(6)}/${sheetLen.toFixed(6)} м, превышение ${(1000 * x.sheetExcess).toFixed(4)} мм; ` : '') +
  `${x.ms.toFixed(1)} мс`;
console.log(['admm', 'hybrid'].includes(solver)
  ? `Цель: возмущение ${perturb} м; rho ${rhoLocal ? 'по приведённой массе связи' : 'единый'}: множитель ${rhoFactor}, диапазон ${Math.min(...rhoEdge).toFixed(4)}…${Math.max(...rhoEdge).toFixed(4)} кг`
  : `Цель: возмущение ${perturb} м; ${solverName()}, без rho`);
if (solver === 'hybrid') console.log(`Координатный разогрев: ${hybridSweeps} проходов перед ADMM`);
if (rhoBoardPower > 0) console.log(`Нормировка штрафа по плечу дощечки в степени ${rhoBoardPower}: ${boardLeverLinks} связей`);
if (relax !== 1) console.log(`Сверхрелаксация ADMM: ${relax}`);
if (freeClew)
  console.log(`Свободный угол: шкот ${sheetLen.toFixed(4)} м, исходное расстояние ${(sheetDistance(basePos)).toFixed(4)} м` +
    (['admm', 'hybrid'].includes(solver) ? `, rho шкота ${sheetPenalty.toFixed(4)} кг` : ''));
if (clewForce && !dynamicSeconds)
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
if (!dynamicSeconds) console.log(`Вход: ${fmt({ ...score(target), ms: 0 })}`);
if (dynamicSeconds) {
  const steps = Math.round(dynamicSeconds * dynamicHz), h = 1 / dynamicHz;
  if (Math.abs(steps * h - dynamicSeconds) > 1e-9)
    throw new Error('Горизонт динамики не кратен шагу');
  const initial = project(basePos);
  if (trace && solver === 'admm') {
    printTrace('Исходная проекция', initial);
    printConstraintStats(initial);
  }
  if (!converged(initial))
    throw new Error(`Исходная форма не доведена до запуска динамики: ` +
      `${initial.used} итераций, ${initial.primal.toExponential(2)} м / ` +
      `${initial.dual.toExponential(2)} кг·м` +
      (solver === 'dual' ? `, KKT ${initial.kkt.toExponential(2)} м` : ''));
  let p = initial.pos, prev = p.slice(), state = initial.state;
  const k = 3 * cl.clew, d0 = sheetDistance(p);
  const direction = [(p[k] - sheetLead[0]) / d0,
    (p[k + 1] - sheetLead[1]) / d0, (p[k + 2] - sheetLead[2]) / d0];
  const force = new Float64Array(3 * N), forceSum = [0, 0, 0];
  if (dynamicLoad === 'clew') {
    for (let j = 0; j < 3; j++) force[k + j] = clewForce * direction[j];
  } else {
    for (let a = 0; a < N; a++)
      for (let j = 0; j < 3; j++)
        force[3 * a + j] = frozenPressure[a] * frozenNormals[3 * a + j];
  }
  for (let a = 0; a < N; a++)
    for (let j = 0; j < 3; j++) forceSum[j] += force[3 * a + j];
  let maxAcceleration = 0, maxAccelNode = -1;
  for (let a = 0; a < N; a++) if (!fixed[a]) {
    const q = Math.hypot(force[3 * a], force[3 * a + 1], force[3 * a + 2]) / cl.mass[a];
    if (q > maxAcceleration) { maxAcceleration = q; maxAccelNode = a; }
  }
  const decay = Math.exp(-dampHz * h);
  let sum = 0, sum2 = 0, nWindow = 0, totalMs = 0, totalIter = 0;
  let maxBoard = 0, maxSheet = 0, maxStretch = 0, failed = 0;
  console.log(`Динамика: ${steps} подшагов по ${h.toFixed(6)} с, горизонт ${dynamicSeconds} с, ` +
    `нагрузка ${dynamicLoad === 'clew' ? `точечная ${clewForce} Н от обуха` : 'замороженное давление'} ` +
    `(сумма ${forceSum.map(x => x.toFixed(3)).join('/')} Н), затухание ${dampHz} 1/с; ` +
    `нулевая начальная скорость, исходная проекция ${initial.used} итераций`);
  console.log(`Макс. ускорение свободного узла ${maxAcceleration.toFixed(3)} м/с² ` +
    `(строка ${Math.floor(maxAccelNode / cols)}, столбец ${maxAccelNode % cols}), ` +
    `свободный прогноз за один шаг ${(1000 * h * h * maxAcceleration).toFixed(3)} мм`);
  console.log('время с | реакция шкота Н | зазор шкота мм | узел середины строки 5: x/y/z м | итераций');
  for (let i = 1; i <= steps; i++) {
    const input = p.slice();
    for (let a = 0; a < N; a++) {
      if (fixed[a]) continue;
      for (let j = 0; j < 3; j++)
        input[3 * a + j] += decay * (p[3 * a + j] - prev[3 * a + j]) +
          h * h * force[3 * a + j] / cl.mass[a];
    }
    const result = project(input, state);
    if (!converged(result)) {
      failed = i;
      console.log(`Остановка на шаге ${i}: остатки ${result.primal.toExponential(2)} м / ` +
        `${result.dual.toExponential(2)} кг·м, ${result.used} итераций, ` +
        `${result.ms.toFixed(1)} мс, ` +
        (['admm', 'hybrid'].includes(solver) ? `CG лимитных ${result.cgCaps}` : `KKT ${result.kkt.toExponential(2)} м`));
      if (trace && solver === 'admm') {
        printTrace('Недоведённый шаг', result);
        printConstraintStats(result);
      }
      break;
    }
    totalMs += result.ms; totalIter += result.used;
    maxBoard = Math.max(maxBoard, result.board);
    maxSheet = Math.max(maxSheet, result.sheetExcess);
    maxStretch = Math.max(maxStretch, result.maxAbs);
    prev = p; p = result.pos; state = result.state;
    const reaction = result.sheetMultiplier / (h * h);
    if (i > steps / 2) { sum += reaction; sum2 += reaction * reaction; nWindow++; }
    if (i === Math.round(steps / 2) || i === steps) {
      const m = 3 * cl.ix(5, (cols - 1) / 2);
      console.log(`${(i * h).toFixed(3)} | ${reaction.toFixed(3)} | ` +
        `${(1000 * (sheetLen - result.sheetSpan)).toFixed(4)} | ` +
        `${p[m].toFixed(6)}/${p[m + 1].toFixed(6)}/${p[m + 2].toFixed(6)} | ${result.used}`);
    }
  }
  if (!failed) {
    const mean = sum / nWindow, rms = Math.sqrt(Math.max(0, sum2 / nWindow - mean * mean));
    const m = 3 * cl.ix(5, (cols - 1) / 2);
    console.log(`Итого: средняя реакция за вторую половину ${mean.toFixed(3)} Н, ` +
      `RMS ${rms.toFixed(3)} Н; центр строки 5 ` +
      `${p[m].toFixed(6)}/${p[m + 1].toFixed(6)}/${p[m + 2].toFixed(6)} м; ` +
      `макс. растяжение ${(1000 * maxStretch).toFixed(6)} мм, ` +
      `дощечка ${(1000 * maxBoard).toFixed(6)} мм, ` +
      `шкот +${(1000 * maxSheet).toFixed(6)} мм; ` +
      `${totalIter} итераций, ${totalMs.toFixed(1)} мс`);
  }
  if (failed || (requireConverged && (maxBoard > 1e-9 || maxSheet > 1e-8 || maxStretch > 1e-8)))
    process.exitCode = 1;
} else if (sequence) {
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
    if (!converged(cold)) coldCaps++;
    if (!converged(warm)) warmCaps++;
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
  console.log(`${solverName()} ${rigidBoard ? 'с точной дощечкой' : 'без дощечки'} ${maxOuter}: ${fmt(result)}; итераций ${result.used}; ` +
    `остатки ${result.primal.toExponential(2)} м / ${result.dual.toExponential(2)} кг·м; ` +
    (['admm', 'hybrid'].includes(solver) ? `CG сред. ${result.cgMean.toFixed(1)}, лимитных ${result.cgCaps}` :
      `KKT ${result.kkt.toExponential(2)} м` +
      (solver === 'dual' ? `, оценка спектра ${result.spectral.toFixed(3)} ` +
        `(строки ${result.rowBound.toFixed(3)})` : '')) +
    (freeClew ? `; множитель шкота ${result.sheetMultiplier.toExponential(3)} кг·м` +
      (clewForce ? ` = ${(result.sheetMultiplier / forceDt ** 2).toFixed(3)} Н` : '') : ''));
  if (requireConverged && !converged(result))
    process.exitCode = 1;
  if (trace && solver === 'admm') {
    printTrace('Статическая проекция', result);
    printConstraintStats(result);
  }
  if (requireConverged && ((rigidBoard && result.board > 1e-9) || result.sheetExcess > 1e-8 ||
      (freeClew && result.sheetMultiplier > 1e-8 && Math.abs(result.sheetSpan - sheetLen) > 1e-6)))
    process.exitCode = 1;
  if (expectSheet === 'taut' && !(Math.abs(result.sheetSpan - sheetLen) < 1e-6 &&
      result.sheetMultiplier > 1e-8)) process.exitCode = 1;
  if (expectSheet === 'slack' && !(result.sheetSpan < sheetLen - 1e-6 &&
      result.sheetMultiplier < 1e-8)) process.exitCode = 1;
  if (compareSolver) {
    solver = 'admm';
    const control = project();
    const controlOk = converged(control);
    solver = opt('solver', 'dual');
    let maxDiff = 0;
    for (let i = 0; i < 3 * N; i++)
      maxDiff = Math.max(maxDiff, Math.abs(result.pos[i] - control.pos[i]));
    console.log(`Контроль ADMM: ${control.used} итераций, ${control.ms.toFixed(1)} мс, ` +
      `остатки ${control.primal.toExponential(2)} м / ${control.dual.toExponential(2)} кг·м, ` +
      `разность координат ${(1000 * maxDiff).toFixed(6)} мм` +
      (freeClew ? `, разность множителя шкота ${(control.sheetMultiplier - result.sheetMultiplier).toExponential(3)} кг·м` : ''));
    if (requireConverged && !controlOk) process.exitCode = 1;
  }
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
    if (requireConverged && !converged(control))
      process.exitCode = 1;
  }
}
