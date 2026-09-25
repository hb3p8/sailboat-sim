// Модельная плоская панель: совместная работа нерастяжимых нитей,
// сдвиговой энергии и углового изгиба. Не крой и не материал SV20.
import { area, bend, distance, shear, solveConstraint } from './cloth-compliance.mjs';

const opt = (name, fallback) => process.argv.find(s => s.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const n = Number(opt('n', '5'));
const hz = Number(opt('hz', '30'));
const passes = Number(opt('passes', '16'));
const seconds = Number(opt('seconds', '3'));
const withArea = process.argv.includes('--with-area');
if (![5, 9, 17].includes(n) || ![30, 60, 120].includes(hz) ||
    ![1, 4, 16, 64, 256, 1024].includes(passes) ||
    ![1, 2, 3, 6].includes(seconds))
  throw new Error('Неверные параметры стенда модельной панели');

const side = 1, G = 50, B = 1, K = 1000, load = 1;
// Модельные модули сдвига/площади Н/м, изгиб Н·м, сила Н.
const step = side / (n - 1), cell = step * step, h = 1 / hz;
const index = (r, c) => r * n + c, count = n * n;
const p = new Float64Array(3 * count), prev = new Float64Array(3 * count);
const w = new Float64Array(count), external = new Float64Array(3 * count);
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  const i = index(r, c);
  p[3 * i] = c * step; p[3 * i + 1] = r * step;
  const area = cell * (r === 0 || r === n - 1 ? 0.5 : 1) *
    (c === 0 || c === n - 1 ? 0.5 : 1);
  w[i] = r === 0 ? 0 : 1 / area; // поверхностная масса 1 кг/м²
  if (r === n - 1) external[3 * i] = load / n;
}
prev.set(p);
const hard = [], soft = [], areas = [], hinges = [];
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  const a = index(r, c);
  if (c + 1 < n) hard.push(distance(a, index(r, c + 1), step, 0, true));
  if (r + 1 < n) hard.push(distance(a, index(r + 1, c), step, 0, true));
  if (r + 1 < n && c + 1 < n) {
    const right = index(r, c + 1), up = index(r + 1, c);
    const opposite = index(r + 1, c + 1);
    // Оба треугольника получают по половине площади ячейки. Их
    // податливость вдвое больше, суммарная энергия аффинного сдвига та же.
    soft.push(shear(a, right, up, 0, 2 * cell / G));
    soft.push(shear(opposite, up, right, 0, 2 * cell / G));
    if (withArea) {
      areas.push(area(a, right, up, cell, 2 * cell / K));
      areas.push(area(opposite, up, right, cell, 2 * cell / K));
    }
  }
  if (c > 0 && c + 1 < n)
    hinges.push(bend(index(r, c - 1), a, index(r, c + 1), 0, 1 / B));
  if (r > 0 && r + 1 < n)
    hinges.push(bend(index(r - 1, c), a, index(r + 1, c), 0, 1 / B));
}
const constraints = [...hard, ...soft, ...areas, ...hinges];
const measure = () => {
  let top = 0, maxStretch = 0, minJacobian = Infinity, maxBend = 0;
  for (let c = 0; c < n; c++) top += p[3 * index(n - 1, c)] - c * step;
  for (const link of hard) maxStretch = Math.max(maxStretch, link.value(p).C);
  for (const hinge of hinges) maxBend = Math.max(maxBend, Math.abs(hinge.value(p).C));
  for (let r = 0; r + 1 < n; r++) for (let c = 0; c + 1 < n; c++) {
    const a = 3 * index(r, c), b = 3 * index(r, c + 1);
    const z = 3 * index(r + 1, c), d = 3 * index(r + 1, c + 1);
    const lower = ((p[b] - p[a]) * (p[z + 1] - p[a + 1]) -
      (p[b + 1] - p[a + 1]) * (p[z] - p[a])) / cell;
    const upper = ((p[z] - p[d]) * (p[b + 1] - p[d + 1]) -
      (p[z + 1] - p[d + 1]) * (p[b] - p[d])) / cell;
    minJacobian = Math.min(minJacobian, lower, upper);
  }
  return { top: top / n, maxStretch, minJacobian, maxBend };
};
const show = (t, m) => console.log(`${t.toFixed(3)} с: сдвиг верха ` +
  `${(1000 * m.top).toFixed(4)} мм, жёсткая связь +${(1000 * m.maxStretch).toFixed(5)} мм, ` +
  `мин. якобиан ${m.minJacobian.toFixed(5)}, макс. изгиб ` +
  `${(180 * m.maxBend / Math.PI).toFixed(3)}°`);
const decay = Math.exp(-6 * h), steps = Math.round(seconds * hz);
let minJacobianEver = Infinity, maxStretchEver = 0, firstInversion = 0;
const start = performance.now();
console.log(`Модельная панель ${n}×${n}: G=${G} Н/м, B=${B} Н·м, ` +
  (withArea ? `K=${K} Н/м, ` : 'без энергии площади, ') +
  `F=${load} Н, ${hz} Гц, ${passes} проходов, ${seconds} с; ` +
  `жёстких/сдвиговых/площадных/изгибных связей ` +
  `${hard.length}/${soft.length}/${areas.length}/${hinges.length}`);
for (let stepIndex = 1; stepIndex <= steps; stepIndex++) {
  const old = p.slice();
  for (let i = 0; i < count; i++) if (w[i])
    for (let j = 0; j < 3; j++) {
      const k = 3 * i + j;
      p[k] += decay * (p[k] - prev[k]) + h * h * w[i] * external[k];
    }
  for (const c of constraints) c.lambda = 0;
  for (let pass = 0; pass < passes; pass++)
    for (const c of constraints) solveConstraint(p, w, c, h);
  prev.set(old);
  const state = measure();
  if (!Number.isFinite(state.top) || !Number.isFinite(state.minJacobian) ||
      !Number.isFinite(state.maxStretch))
    throw new Error(`Нечисловое состояние панели на шаге ${stepIndex}`);
  minJacobianEver = Math.min(minJacobianEver, state.minJacobian);
  maxStretchEver = Math.max(maxStretchEver, state.maxStretch);
  if (!firstInversion && state.minJacobian <= 0) firstInversion = stepIndex;
  if (stepIndex === Math.round(steps / 2) || stepIndex === steps)
    show(stepIndex * h, state);
}
console.log(`За всё движение: мин. якобиан ${minJacobianEver.toFixed(5)}, ` +
  `макс. растяжение ребра ${(1000 * maxStretchEver).toFixed(5)} мм, ` +
  `первый переворот ${firstInversion ? `${(firstInversion * h).toFixed(4)} с` : 'нет'}`);
console.log(`Вычислено за ${((performance.now() - start) / 1000).toFixed(3)} с`);
if (withArea && firstInversion) process.exitCode = 1;
