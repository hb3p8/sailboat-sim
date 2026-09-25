// Модельная 3D-поверхность с заранее заданной кривизной и вертикальной
// нагрузкой. Это контроль совместимости связей, не крой генакера SV20.
import { area3d, dihedral, dihedralAngle, distance, shear,
  solveConstraint } from './cloth-compliance.mjs';

const opt = (name, fallback) => process.argv.find(s => s.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const n = Number(opt('n', '5'));
const hz = Number(opt('hz', '30'));
const passes = Number(opt('passes', '16'));
const seconds = Number(opt('seconds', '2'));
const solver = opt('solver', 'dynamic');
const staticStart = opt('start', 'rest');
const maxInner = Number(opt('inner', '400'));
const maxOuter = Number(opt('outer', '20'));
if (![5, 9, 17].includes(n) || ![30, 120].includes(hz) ||
    ![1, 4, 16, 64, 256, 1024].includes(passes) || ![1, 2, 3].includes(seconds) ||
    !['dynamic', 'static'].includes(solver) ||
    !['rest', 'raised', 'lowered'].includes(staticStart) ||
    ![400, 1600].includes(maxInner) ||
    ![20, 40].includes(maxOuter))
  throw new Error('Неверные параметры стенда 3D-поверхности');

const G = 50, K = 1000, B = 1, pressure = 1;
// G и K — модельные Н/м, B — Н·м, давление — Н/м².
const index = (r, c) => r * n + c, count = n * n, cell = 1 / (n - 1);
const p = new Float64Array(3 * count), prev = new Float64Array(3 * count);
const mass = new Float64Array(count), w = new Float64Array(count);
const force = new Float64Array(3 * count);
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  const x = c * cell, y = r * cell, i = index(r, c);
  p[3 * i] = x; p[3 * i + 1] = y;
  p[3 * i + 2] = 0.12 * Math.sin(Math.PI * x) * Math.sin(Math.PI * y);
}
prev.set(p);
const initial = p.slice();
const xyz = i => [initial[3 * i], initial[3 * i + 1], initial[3 * i + 2]];
const sub = (a, b) => a.map((x, j) => x - b[j]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, x, j) => s + x * b[j], 0);
const triangles = [];
for (let r = 0; r + 1 < n; r++) for (let c = 0; c + 1 < n; c++) {
  const ll = index(r, c), lr = index(r, c + 1);
  const ul = index(r + 1, c), ur = index(r + 1, c + 1);
  triangles.push([ll, lr, ul], [ur, ul, lr]);
}
const hard = [], soft = [], areas = [], hinges = [];
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  const a = index(r, c);
  if (c + 1 < n) {
    const b = index(r, c + 1);
    hard.push(distance(a, b, Math.hypot(...sub(xyz(b), xyz(a))), 0, true));
  }
  if (r + 1 < n) {
    const b = index(r + 1, c);
    hard.push(distance(a, b, Math.hypot(...sub(xyz(b), xyz(a))), 0, true));
  }
}
const edgeMap = new Map(), referenceNormals = [];
for (const tri of triangles) {
  const [a, b, c] = tri, e = sub(xyz(b), xyz(a)), f = sub(xyz(c), xyz(a));
  const normal = cross(e, f), area2 = Math.hypot(...normal), area = area2 / 2;
  if (!(area > 0)) throw new Error('Вырожденная выкройка');
  referenceNormals.push(normal);
  for (const i of tri) { mass[i] += area / 3; force[3 * i + 2] += pressure * area / 3; }
  soft.push(shear(a, b, c, dot(e, f), 2 * area2 / G));
  areas.push(area3d(a, b, c, area2, 2 * area2 / K));
  for (let t = 0; t < 3; t++) {
    const first = tri[(t + 2) % 3], left = tri[t], right = tri[(t + 1) % 3];
    const key = [left, right].sort((x, y) => x - y).join(':');
    const prior = edgeMap.get(key);
    if (!prior) edgeMap.set(key, { first, left, right, area });
    else {
      if (prior.left !== right || prior.right !== left)
        throw new Error('Несогласованная ориентация треугольников');
      const length = Math.hypot(...sub(xyz(right), xyz(left)));
      const alpha = (prior.area + area) / (B * length * length);
      hinges.push(dihedral(prior.first, prior.left, prior.right, first,
        dihedralAngle(initial, prior.first, prior.left, prior.right, first), alpha));
    }
  }
}
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  const i = index(r, c), boundary = r === 0 || c === 0 || r === n - 1 || c === n - 1;
  w[i] = boundary ? 0 : 1 / mass[i];
}
const constraints = [...hard, ...soft, ...areas, ...hinges];
const center = index((n - 1) / 2, (n - 1) / 2);
const measure = () => {
  let stretch = 0, minArea = Infinity, minFacing = Infinity;
  let minDz = Infinity, maxDz = -Infinity, sumDz = 0, moving = 0, work = 0;
  for (const c of hard) stretch = Math.max(stretch, c.value(p).C);
  for (let i = 0; i < count; i++) if (w[i]) {
    const dz = p[3 * i + 2] - initial[3 * i + 2];
    minDz = Math.min(minDz, dz); maxDz = Math.max(maxDz, dz);
    sumDz += dz; moving++; work += force[3 * i + 2] * dz;
  }
  for (let t = 0; t < triangles.length; t++) {
    const [a, b, c] = triangles[t];
    const A = Array.from(p.subarray(3 * a, 3 * a + 3));
    const B = Array.from(p.subarray(3 * b, 3 * b + 3));
    const C = Array.from(p.subarray(3 * c, 3 * c + 3));
    const v = cross(sub(B, A), sub(C, A)), ref = referenceNormals[t];
    minArea = Math.min(minArea, Math.hypot(...v) / Math.hypot(...ref));
    minFacing = Math.min(minFacing, dot(v, ref) / dot(ref, ref));
  }
  const residual = force.slice();
  for (const c of [...soft, ...areas, ...hinges]) {
    const { C, grad } = c.value(p), load = -C / c.alpha;
    for (const [i, g] of grad) for (let j = 0; j < 3; j++)
      residual[3 * i + j] += load * g[j];
  }
  for (const c of hard) {
    const { grad } = c.value(p), load = c.lambda / (h * h);
    for (const [i, g] of grad) for (let j = 0; j < 3; j++)
      residual[3 * i + j] += load * g[j];
  }
  let residualSquared = 0, maxResidual = 0;
  for (let i = 0; i < count; i++) if (w[i]) {
    const norm = Math.hypot(...residual.subarray(3 * i, 3 * i + 3));
    residualSquared += norm * norm;
    maxResidual = Math.max(maxResidual, norm);
  }
  return { z: p[3 * center + 2], stretch, minArea, minFacing,
    meanDz: sumDz / moving, minDz, maxDz, work,
    rmsResidual: Math.sqrt(residualSquared / moving), maxResidual };
};
const shapeAudit = () => {
  const displacement = i => Array.from(p.subarray(3 * i, 3 * i + 3),
    (x, j) => x - initial[3 * i + j]);
  const areaXY = cell * cell / 2;
  let meanZ = 0, squaredZ = 0, squaredVector = 0, maxVector = 0;
  for (const [a, b, c] of triangles) {
    const u = displacement(a), v = displacement(b), q = displacement(c);
    meanZ += areaXY * (u[2] + v[2] + q[2]) / 3;
    squaredZ += areaXY * (u[2] ** 2 + v[2] ** 2 + q[2] ** 2 +
      u[2] * v[2] + v[2] * q[2] + q[2] * u[2]) / 6;
    squaredVector += areaXY * (dot(u, u) + dot(v, v) + dot(q, q) +
      dot(u, v) + dot(v, q) + dot(q, u)) / 6;
  }
  for (let i = 0; i < count; i++) maxVector = Math.max(maxVector,
    Math.hypot(...displacement(i)));
  const stride = (n - 1) / 4;
  const slice = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++)
    slice.push(displacement(index(r * stride, c * stride))
      .map(x => Number((1000 * x).toFixed(9))));
  return { meanZ, rmsZ: Math.sqrt(squaredZ),
    rmsVector: Math.sqrt(squaredVector), maxVector, slice };
};
const auditShapeQuadrature = () => {
  const amplitude = 0.001;
  for (let i = 0; i < count; i++) p[3 * i + 2] += amplitude * initial[3 * i];
  const sample = shapeAudit();
  p.set(initial);
  const error = Math.max(Math.abs(sample.meanZ - amplitude / 2),
    Math.abs(sample.rmsZ - amplitude / Math.sqrt(3)),
    Math.abs(sample.rmsVector - amplitude / Math.sqrt(3)),
    Math.abs(sample.maxVector - amplitude));
  if (!(error < 1e-12)) throw new Error('Неверный интеграл линейной формы');
};
auditShapeQuadrature();
const show = (t, m) => console.log(`${typeof t === 'number' ? `${t.toFixed(3)} с` : t}: ` +
  `высота середины ${m.z.toFixed(9)} м, ` +
  `Δz ${(1000 * (m.z - initial[3 * center + 2])).toFixed(6)} мм, ` +
  `внутренние Δz ср./мин./макс. ${(1000 * m.meanDz).toFixed(6)}/` +
  `${(1000 * m.minDz).toFixed(6)}/${(1000 * m.maxDz).toFixed(6)} мм, ` +
  `работа ${m.work.toExponential(3)} Дж, ` +
  `ребро +${(1000 * m.stretch).toFixed(5)} мм, ` +
  `мин. площадь ${m.minArea.toFixed(5)}, направление ${m.minFacing.toFixed(5)}, ` +
  `невязка силы RMS/макс. ${m.rmsResidual.toExponential(3)}/` +
  `${m.maxResidual.toExponential(3)} Н`);
const h = 1 / hz, decay = Math.exp(-6 * h), steps = seconds * hz;
let minFacingEver = Infinity, maxStretchEver = 0;
const start = performance.now();
console.log(`3D-поверхность ${n}×${n}: ${triangles.length} треугольников, ` +
  `${hard.length}/${soft.length}/${areas.length}/${hinges.length} ` +
  `жёстких/сдвиговых/площадных/изгибных связей, ` +
  (solver === 'dynamic' ? `${hz} Гц, ${passes} проходов, ${seconds} с` :
    'статический минимум') + '; общая нагрузка ' +
  `${force.filter((_, i) => i % 3 === 2).reduce((a, z) => a + z, 0).toFixed(5)} Н`);
const isOriented = state => triangles.every(([a, b, c], t) => {
  const A = Array.from(state.subarray(3 * a, 3 * a + 3));
  const B = Array.from(state.subarray(3 * b, 3 * b + 3));
  const C = Array.from(state.subarray(3 * c, 3 * c + 3));
  return dot(cross(sub(B, A), sub(C, A)), referenceNormals[t]) > 0;
});
const fullDot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const physicalEnergy = state => {
  if (!isOriented(state)) return { energy: Infinity, gradient: null };
  const gradient = new Float64Array(state.length);
  let material = 0, work = 0;
  for (let i = 0; i < count; i++) if (w[i]) for (let j = 0; j < 3; j++) {
    const q = 3 * i + j;
    work += force[q] * (state[q] - initial[q]);
    gradient[q] -= force[q];
  }
  for (const c of [...soft, ...areas, ...hinges]) {
    const { C, grad } = c.value(state), load = C / c.alpha;
    material += C * load / 2;
    for (const [i, g] of grad) if (w[i]) for (let j = 0; j < 3; j++)
      gradient[3 * i + j] += load * g[j];
  }
  return { energy: material - work, material, work, gradient };
};
const staticEnergy = (state, multipliers, rho) => {
  const physical = physicalEnergy(state);
  if (!physical.gradient) return physical;
  const gradient = physical.gradient;
  let energy = physical.energy;
  for (let k = 0; k < hard.length; k++) {
    const { C, grad } = hard[k].value(state), shifted = multipliers[k] + rho * C;
    energy += (Math.max(0, shifted) ** 2 - multipliers[k] ** 2) / (2 * rho);
    if (shifted > 0) for (const [i, g] of grad) if (w[i])
      for (let j = 0; j < 3; j++) gradient[3 * i + j] += shifted * g[j];
  }
  return { energy, gradient };
};
const minimize = (state, multipliers, rho) => {
  let current = staticEnergy(state, multipliers, rho), iterations = 0;
  const history = [];
  for (; iterations < maxInner; iterations++) {
    const g = current.gradient;
    if (!g || Math.sqrt(fullDot(g, g) / ((n - 2) ** 2)) < 1e-7) break;
    let direction = Float64Array.from(g);
    const coefficients = [];
    for (let k = history.length - 1; k >= 0; k--) {
      const item = history[k], coefficient = item.inverse * fullDot(item.s, direction);
      coefficients[k] = coefficient;
      for (let j = 0; j < direction.length; j++) direction[j] -= coefficient * item.y[j];
    }
    if (history.length) {
      const last = history.at(-1);
      const gamma = Math.max(1e-8, Math.min(1e6,
        fullDot(last.s, last.y) / fullDot(last.y, last.y)));
      for (let j = 0; j < direction.length; j++) direction[j] *= gamma;
    }
    for (let k = 0; k < history.length; k++) {
      const item = history[k];
      const coefficient = item.inverse * fullDot(item.y, direction);
      for (let j = 0; j < direction.length; j++)
        direction[j] += item.s[j] * (coefficients[k] - coefficient);
    }
    for (let j = 0; j < direction.length; j++) direction[j] = -direction[j];
    let slope = fullDot(g, direction);
    if (!(slope < -1e-20)) {
      direction = Float64Array.from(g, x => -x);
      slope = -fullDot(g, g);
    }
    let next, candidate, step = 1;
    for (let trial = 0; trial < 50; trial++) {
      candidate = Float64Array.from(state, (x, j) => x + step * direction[j]);
      try { next = staticEnergy(candidate, multipliers, rho); }
      catch { next = { energy: Infinity, gradient: null }; }
      if (next.energy <= current.energy + 1e-4 * step * slope) break;
      step *= 0.5;
    }
    if (!(next.energy <= current.energy + 1e-4 * step * slope)) break;
    const s = Float64Array.from(state, (x, j) => candidate[j] - x);
    const y = Float64Array.from(g, (x, j) => next.gradient[j] - x);
    const curvature = fullDot(s, y);
    if (curvature > 1e-18) {
      history.push({ s, y, inverse: 1 / curvature });
      if (history.length > 10) history.shift();
    }
    state.set(candidate);
    current = next;
  }
  return { iterations, energy: current.energy };
};
const staticAudit = multipliers => {
  const gradient = physicalEnergy(p).gradient;
  let maxExtension = 0, complementarity = 0;
  for (let k = 0; k < hard.length; k++) {
    const C = hard[k].value(p).C;
    maxExtension = Math.max(maxExtension, C);
    complementarity = Math.max(complementarity, Math.abs(multipliers[k] * C));
    for (const [i, g] of hard[k].value(p).grad) if (w[i])
      for (let j = 0; j < 3; j++) gradient[3 * i + j] += multipliers[k] * g[j];
  }
  return { maxExtension, complementarity,
    rmsForce: Math.sqrt(fullDot(gradient, gradient) / ((n - 2) ** 2)) };
};
const auditStaticGradient = () => {
  const state = initial.slice();
  state[3 * center] += 0.002;
  state[3 * center + 2] += 0.004;
  state[3 * index(1, 1) + 1] -= 0.003;
  state[3 * index(n - 2, n - 2)] -= 0.0015;
  state[3 * index(n - 2, n - 2) + 2] += 0.0025;
  const multipliers = new Float64Array(hard.length), rho = 1e4;
  const analytical = staticEnergy(state, multipliers, rho).gradient;
  let worst = 0, worstAt = '';
  for (const i of new Set([center, index(1, 1), index(n - 2, n - 2)]))
    for (let j = 0; j < 3; j++) {
      const q = 3 * i + j, eps = 1e-7;
      state[q] += eps;
      const plus = staticEnergy(state, multipliers, rho).energy;
      state[q] -= 2 * eps;
      const minus = staticEnergy(state, multipliers, rho).energy;
      state[q] += eps;
      const numerical = (plus - minus) / (2 * eps);
      if (Math.abs(numerical - analytical[q]) > worst) {
        worst = Math.abs(numerical - analytical[q]);
        worstAt = `узел ${i}, ось ${j}, аналитика ${analytical[q].toExponential(6)} Н, ` +
          `разность ${numerical.toExponential(6)} Н`;
      }
    }
  console.log(`Градиент полной статической цели против центральной разности: ` +
    `${worst.toExponential(3)} Н (допуск 1e-6 Н); ${worstAt}`);
  if (!(worst <= 1e-6)) throw new Error('Неверный градиент статической цели');
};
if (solver === 'static') {
  auditStaticGradient();
  if (staticStart !== 'rest') {
    const sign = staticStart === 'raised' ? 1 : -1;
    for (let r = 1; r < n - 1; r++) for (let c = 1; c < n - 1; c++)
      p[3 * index(r, c) + 2] += sign * 0.002 *
        Math.sin(Math.PI * r / (n - 1)) * Math.sin(Math.PI * c / (n - 1));
  }
  const startLabel = { rest: 'опорная', raised: 'выше на 2 мм',
    lowered: 'ниже на 2 мм' }[staticStart];
  console.log(`Начальная форма оптимизатора: ${startLabel}`);
  const multipliers = new Float64Array(hard.length);
  let rho = 1e4, converged = false;
  console.log('Статические допуски до прогона: ребро 1e-8 м, ' +
    `RMS силы 1e-6 Н, дополнительность 1e-8 Дж; ` +
    `лимиты ${maxOuter}×${maxInner}`);
  for (let outer = 1; outer <= maxOuter; outer++) {
    const inner = minimize(p, multipliers, rho);
    for (let k = 0; k < hard.length; k++)
      multipliers[k] = Math.max(0, multipliers[k] + rho * hard[k].value(p).C);
    const audit = staticAudit(multipliers);
    console.log(`Внешний шаг ${outer}: внутренние ${inner.iterations}, ` +
      `дополненная энергия ${inner.energy.toExponential(4)} Дж, ` +
      `ρ ${rho.toExponential(1)} Н/м, ` +
      `ребро ${audit.maxExtension.toExponential(3)} м, ` +
      `RMS силы ${audit.rmsForce.toExponential(3)} Н, ` +
      `дополнительность ${audit.complementarity.toExponential(3)} Дж`);
    if (audit.maxExtension <= 1e-8 && audit.rmsForce <= 1e-6 &&
        audit.complementarity <= 1e-8) { converged = true; break; }
    if (outer % 4 === 0) rho *= 4;
  }
  for (let k = 0; k < hard.length; k++) hard[k].lambda = -multipliers[k] * h * h;
  show('Статический результат', measure());
  const energy = physicalEnergy(p);
  console.log(`Физическая энергия: материал ${energy.material.toExponential(6)} Дж, ` +
    `работа нагрузки ${energy.work.toExponential(6)} Дж, ` +
    `разность ${energy.energy.toExponential(6)} Дж`);
  const shape = shapeAudit();
  console.log(`Форма по площади: среднее Δz ${(1000 * shape.meanZ).toFixed(9)} мм, ` +
    `RMS Δz ${(1000 * shape.rmsZ).toFixed(9)} мм, ` +
    `RMS |Δr| ${(1000 * shape.rmsVector).toFixed(9)} мм, ` +
    `макс. |Δr| ${(1000 * shape.maxVector).toFixed(9)} мм`);
  console.log(`Срез 5×5 (мм, Δx/Δy/Δz): ${JSON.stringify(shape.slice)}`);
  console.log(`Статический итог: ${converged ? 'доведён' : 'НЕ доведён'}, ` +
    `время ${((performance.now() - start) / 1000).toFixed(3)} с`);
  if (!converged) process.exitCode = 1;
} else {
  show(0, measure());
  for (let k = 1; k <= steps; k++) {
    const old = p.slice();
    for (let i = 0; i < count; i++) if (w[i])
      for (let j = 0; j < 3; j++) {
        const q = 3 * i + j;
        p[q] += decay * (p[q] - prev[q]) + h * h * w[i] * force[q];
      }
    for (const c of constraints) c.lambda = 0;
    for (let it = 0; it < passes; it++)
      for (const c of constraints) solveConstraint(p, w, c, h);
    prev.set(old);
    const result = measure();
    if (![result.z, result.stretch, result.minArea, result.minFacing,
          result.meanDz, result.work, result.rmsResidual, result.maxResidual].every(Number.isFinite))
      throw new Error(`Нечисловое состояние 3D-поверхности на шаге ${k}`);
    minFacingEver = Math.min(minFacingEver, result.minFacing);
    maxStretchEver = Math.max(maxStretchEver, result.stretch);
    if (k === Math.round(steps / 2) || k === steps) show(k * h, result);
  }
  console.log(`За всё движение: мин. направление ${minFacingEver.toFixed(5)}, ` +
    `макс. растяжение ${(1000 * maxStretchEver).toFixed(5)} мм, ` +
    `время ${((performance.now() - start) / 1000).toFixed(3)} с`);
  if (minFacingEver <= 0) process.exitCode = 1;
}
