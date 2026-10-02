// Известные решения полного неявного уравнения; физические остатки не подменены податливостью.
import assert from 'node:assert/strict';
import { ImplicitEnergyMotion, bandFactor } from './lib/cloth-implicit-motion.mjs';
import { materialSurface } from './lib/cloth-material.mjs';
import { distance } from './cloth-compliance.mjs';
import { borderedBandFactor } from './lib/cloth-linear-solve.mjs';
import { readFileSync } from 'node:fs';
import { loadSparseFactor } from './lib/cloth-sparse-wasm.mjs';

const close = (a, b, tolerance = 2e-10) => assert.ok(Math.abs(a - b) < tolerance * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const args = process.argv.slice(2), backendArg = args.find(a => a.startsWith('--linear-backend=')), wasmArg = args.find(a => a.startsWith('--wasm='));
if (args.some(a => a !== backendArg && a !== wasmArg)) throw new Error('Допустимы --linear-backend=способ и --wasm=путь');
const backend = backendArg?.slice(17) ?? 'band-js';
const backendOptions = { linearBackend: backend, ...(wasmArg ? { wasmSparseFactor: await loadSparseFactor(readFileSync(wasmArg.slice(7))) } : {}) };
const options = { ...backendOptions, forceToleranceN: 1e-9, lengthToleranceM: 1e-11, dualToleranceN: 1e-10, complementarityToleranceJ: 1e-10 };
// Независимая A=L Lᵀ: диагональ, узкие/широкая полосы, несколько правых частей.
// Ширины 161/305 соответствуют парусу 21×17/41×33; есть обе границы полосы.
for (const [n, band] of [[9, 0], [9, 1], [9, 3], [257, 161], [401, 305], [9, 12]]) {
  const lower = Array.from({ length: n }, () => new Float64Array(n));
  // Нормировка сохраняет диагональное преобладание L при росте полосы;
  // иначе широкий контроль проверяет потерю точности плохой матрицы.
  for (let i = 0; i < n; i++) for (let j = Math.max(0, i - band); j <= i; j++) lower[i][j] = i === j ? 2 + i / 10 : .13 * (i - j) / (n > 9 ? band : 1);
  const dense = lower.map((a, i) => Float64Array.from({ length: n }, (_, j) => a.reduce((sum, v, k) => sum + v * lower[j][k], 0)));
  const packed = new Float64Array(n * (band + 1));
  for (let i = 0; i < n; i++) for (let j = Math.max(0, i - band); j <= i; j++) packed[i * (band + 1) + i - j] = dense[i][j];
  const solve = bandFactor(packed, n, band);
  for (const x of [Float64Array.from({ length: n }, (_, i) => n > 9 ? Math.sin(i) : i - 2), new Float64Array(n).fill(1)]) {
    const rhs = dense.map(row => row.reduce((sum, v, j) => sum + v * x[j], 0)), result = solve(rhs);
    result.forEach((v, i) => close(v, x[i], 1e-12));
  }
}
console.log('ок: ленточная матрица, известные решения и повторные правые части');

for (const [n, size] of [[9, 3], [0, 3], [9, 0]]) {
  const band = 2, total = n + size, L = Array.from({ length: total }, () => new Float64Array(total));
  for (let i = 0; i < total; i++) for (let j = (i < n ? Math.max(0, i - band) : 0); j <= i; j++)
    L[i][j] = i === j ? 3 + i / 10 : .1 * Math.sin(i + j);
  const dense = L.map(row => Float64Array.from({ length: total }, (_, j) => row.reduce((sum, v, k) => sum + v * L[j][k], 0)));
  const A = new Float64Array(n * (band + 1)), B = new Float64Array(n * size), D = new Float64Array(size * size);
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - band); j <= i; j++) A[i * (band + 1) + i - j] = dense[i][j];
    for (let j = 0; j < size; j++) B[i * size + j] = dense[i][n + j];
  }
  for (let i = 0; i < size; i++) for (let j = 0; j <= i; j++) D[i * size + i - j] = dense[n + i][n + j];
  const solve = borderedBandFactor(A, B, D, n, band, size), x = Float64Array.from({ length: total }, (_, i) => Math.cos(i));
  const rhs = dense.map(row => row.reduce((sum, v, j) => sum + v * x[j], 0));
  solve(rhs).forEach((v, i) => close(v, x[i], 1e-12));
}
console.log('ок: отдельный глобальный блок, пустые блоки и независимое решение полной матрицы');

const reference = [0, 0, 0, 1, 0, 0, 0, 1, 0], force = [0, 0, 0, 10, 0, 0, 0, 0, 0];
const parameters = { bulkNPerM: 1000, shearNPerM: 50, bendingNm: 0 };
const root = f => { let lo = 1, hi = 2; for (let i = 0; i < 80; i++) { const x = (lo + hi) / 2; if (f(x) < 0) lo = x; else hi = x; } return (lo + hi) / 2; };
const elastic = x => .25 * 1050 * x * (x * x - 1), exactStatic = root(x => elastic(x) - 10);
for (const h of [1 / 30, 1 / 60, 1 / 120]) {
  const material = materialSurface(reference, [[0, 1, 2]], parameters);
  const motion = new ImplicitEnergyMotion({ positions: reference, mass: [1, 1, 1], fixed: [0, 2], constraints: material.constraints, ...options });
  const audit = motion.step(force, h, 40), exactStep = root(x => (x - 1) / (h * h) + elastic(x) - 10);
  close(motion.pos[3], exactStep, 1e-11); assert.ok(audit.maxPhysicalResidualN < options.forceToleranceN);
  close(motion.pos[4], 0); close(motion.pos[5], 0);
  console.log(`Треугольник h=${h}: точный неявный шаг, остаток ${audit.maxPhysicalResidualN.toExponential(3)} Н`);
}
for (const hz of [60, 120, 240]) {
  const material = materialSurface(reference, [[0, 1, 2]], parameters);
  const motion = new ImplicitEnergyMotion({ positions: reference, mass: [1, 1, 1], fixed: [0, 2], constraints: material.constraints, ...options });
  let audit;
  for (let i = 0; i < 5 * hz; i++) audit = motion.step(force, 1 / hz, 40);
  assert.ok(Math.abs(motion.pos[3] - exactStatic) < 2e-8);
  assert.ok(audit.maxPhysicalResidualN <= options.forceToleranceN);
  console.log(`Равновесие ${hz} Гц: ошибка ${(motion.pos[3] - exactStatic).toExponential(3)} м, остаток ${audit.maxPhysicalResidualN.toExponential(3)} Н`);
}

// Планка: многоточечная линейная энергия и независимая эффективная масса.
const board = { head: 0, end: 4, nodes: [0, 1, 2, 3, 4], fractions: [0, .25, .5, .75, 1] };
const positions = [0, 0, 0, .5, 0, 0, 1, 0, 0, 1.5, 0, 0, 2, 0, 0], coefficients = [1, -2, 3, -1, 2];
const linear = { alpha: 1 / 20, value(p) { return { C: coefficients.reduce((s, v, i) => s + v * p[3 * i + 1], 0), grad: coefficients.map((v, i) => [i, [0, v, 0]]) }; } };
const applied = new Float64Array(15); applied[7] = 8;
const boardMotion = new ImplicitEnergyMotion({ positions, mass: [1, 2, 3, 4, 5], fixed: [0], board, constraints: [linear], dampingHz: 0, ...options });
const h = 1 / 30, gamma = coefficients.reduce((s, v, i) => s + v * board.fractions[i], 0);
const boardAudit = boardMotion.step(applied, h, 4), exactY = h * h * 4 / (8.125 + h * h * 20 * gamma * gamma);
close(boardMotion.pos[13], exactY); close(boardAudit.appliedWorkJ, 4 * exactY); assert.ok(boardAudit.maxPhysicalResidualN < 1e-9);
console.log('ок: многоточечный градиент через планку, масса и работа');

// Односторонняя нить тянет, затем перестаёт действовать при отпускании нагрузки.
const tether = new ImplicitEnergyMotion({ positions: [0, 0, 0, 1, 0, 0], mass: [1, 1], fixed: [0], constraints: [distance(0, 1, 1, 0, true)], dampingHz: 0, ...options });
let audit = tether.step([0, 0, 0, 10, 0, 0], h, 40);
close(tether.pos[3], 1); close(audit.hardForce[3], -10); assert.ok(audit.maxPhysicalResidualN < 1e-9);
assert.equal(audit.solver.responseSolves, backend === 'kkt-wasm' ? 0 : 1);
audit = tether.step([0, 0, 0, -10, 0, 0], h, 40);
close(tether.pos[3], 1 - h * h * 10); close(audit.hardForce[3], 0); assert.ok(audit.maxPhysicalResidualN < 1e-9);
assert.equal(audit.solver.responseSolves, 0, 'Свободная нить не требует решения реакции');

// Точный первый шаг жёсткой планки — ближайшая точка окружности к предсказанию.
const rigid = new ImplicitEnergyMotion({ positions: [0, 0, 0, 1, 0, 0], mass: [1, 1], fixed: [0], constraints: [distance(0, 1, 1, 0)], dampingHz: 0, ...options });
audit = rigid.step([0, 0, 0, 0, 8, 0], h, 40);
const length = Math.hypot(1, h * h * 8);
close(rigid.pos[3], 1 / length); close(rigid.pos[4], h * h * 8 / length); assert.ok(audit.maxPhysicalResidualN < 1e-9);
console.log('ок: односторонняя нить, снятие реакции и известный шаг жёсткой планки');

const failed = new ImplicitEnergyMotion({ positions: reference, mass: [1, 1, 1], fixed: [0, 2], constraints: materialSurface(reference, [[0, 1, 2]], parameters).constraints, ...options });
const before = failed.pos.slice(), previous = failed.prev.slice();
assert.throws(() => failed.step(force, 1 / 30, 1), /не доведено/);
assert.deepEqual(failed.pos, before); assert.deepEqual(failed.prev, previous); assert.equal(failed.prevDt, 0);
if (backend === 'kkt-wasm') {
  failed.step(force, 1 / 30, 40);
  const acceptedMu = failed.lastMu.slice(), acceptedPos = failed.pos.slice(), acceptedPrev = failed.prev.slice();
  const largeForce = force.map(v => v * 50);
  assert.throws(() => failed.step(largeForce, 1 / 60, 1), /не доведено/);
  assert.deepEqual(failed.lastMu, acceptedMu); assert.deepEqual(failed.pos, acceptedPos); assert.deepEqual(failed.prev, acceptedPrev);
}
console.log('ок: недоведённый шаг отклонён, координаты и история восстановлены');
