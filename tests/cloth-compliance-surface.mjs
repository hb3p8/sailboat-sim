// Модельная 3D-поверхность с заранее заданной кривизной и вертикальной
// нагрузкой. Это контроль совместимости связей, не крой генакера SV20.
import { area3d, dihedral, dihedralAngle, distance, shear,
  solveConstraint } from './cloth-compliance.mjs';

const opt = (name, fallback) => process.argv.find(s => s.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const n = Number(opt('n', '5'));
const hz = Number(opt('hz', '30'));
const passes = Number(opt('passes', '16'));
const seconds = Number(opt('seconds', '2'));
if (![5, 9].includes(n) || ![30, 120].includes(hz) ||
    ![1, 4, 16, 64].includes(passes) || ![1, 2, 3].includes(seconds))
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
  return { z: p[3 * center + 2], stretch, minArea, minFacing,
    meanDz: sumDz / moving, minDz, maxDz, work };
};
const show = (t, m) => console.log(`${t.toFixed(3)} с: высота середины ${m.z.toFixed(6)} м, ` +
  `Δz ${(1000 * (m.z - initial[3 * center + 2])).toFixed(3)} мм, ` +
  `внутренние Δz ср./мин./макс. ${(1000 * m.meanDz).toFixed(3)}/` +
  `${(1000 * m.minDz).toFixed(3)}/${(1000 * m.maxDz).toFixed(3)} мм, ` +
  `работа ${m.work.toExponential(3)} Дж, ` +
  `ребро +${(1000 * m.stretch).toFixed(5)} мм, ` +
  `мин. площадь ${m.minArea.toFixed(5)}, направление ${m.minFacing.toFixed(5)}`);
const h = 1 / hz, decay = Math.exp(-6 * h), steps = seconds * hz;
let minFacingEver = Infinity, maxStretchEver = 0;
const start = performance.now();
console.log(`3D-поверхность ${n}×${n}: ${triangles.length} треугольников, ` +
  `${hard.length}/${soft.length}/${areas.length}/${hinges.length} ` +
  `жёстких/сдвиговых/площадных/изгибных связей, ${hz} Гц, ` +
  `${passes} проходов, ${seconds} с; общая нагрузка ` +
  `${force.filter((_, i) => i % 3 === 2).reduce((a, z) => a + z, 0).toFixed(5)} Н`);
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
        result.meanDz, result.work].every(Number.isFinite))
    throw new Error(`Нечисловое состояние 3D-поверхности на шаге ${k}`);
  minFacingEver = Math.min(minFacingEver, result.minFacing);
  maxStretchEver = Math.max(maxStretchEver, result.stretch);
  if (k === Math.round(steps / 2) || k === steps) show(k * h, result);
}
console.log(`За всё движение: мин. направление ${minFacingEver.toFixed(5)}, ` +
  `макс. растяжение ${(1000 * maxStretchEver).toFixed(5)} мм, ` +
  `время ${((performance.now() - start) / 1000).toFixed(3)} с`);
if (minFacingEver <= 0) process.exitCode = 1;
