// Независимые положительные матрицы, разреженное заполнение и пакет SIMD.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sparsePattern, sparseFactor, gridDissection } from './lib/cloth-sparse-solve.mjs';
import { loadSparseFactor } from './lib/cloth-sparse-wasm.mjs';
import { borderedBandFactor } from './lib/cloth-linear-solve.mjs';
const wasmArg = process.argv.find(a => a.startsWith('--wasm='));
if (process.argv.slice(2).some(a => a !== wasmArg) || !wasmArg?.slice(7))
  throw new Error('Нужен --wasm=путь');
const wasm = await loadSparseFactor(readFileSync(wasmArg.slice(7)));
const close = (a, b) => assert.ok(Math.abs(a - b) <= 2e-12 * Math.max(1, Math.abs(b)), `${a} != ${b}`);
for (const n of [0, 1, 13, 201]) {
  const groups = Array.from({ length: n }, (_, i) => Array.from(new Set([i, (i + 1) % n, (i + 7) % n])));
  const dense = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (_, j) => i === j ? 2 : 0));
  for (let g = 0; g < groups.length; g++) {
    const indices = groups[g], values = indices.map((_, i) => Math.sin(g + i + .2));
    for (let a = 0; a < indices.length; a++) for (let b = 0; b < indices.length; b++)
      dense[indices[a]][indices[b]] += values[a] * values[b];
  }
  for (const order of [Int32Array.from({ length: n }, (_, i) => i), Int32Array.from({ length: n }, (_, i) => n - i - 1)]) {
    const p = sparsePattern(n, groups, order), matrix = new Float64Array(p.cols.length);
    for (let i = 0; i < n; i++) for (let a = p.rowPtr[i]; a < p.rowPtr[i + 1]; a++)
      matrix[a] = dense[p.order[i]][p.order[p.cols[a]]];
    const saved = matrix.slice(), js = sparseFactor(matrix, p), accelerated = wasm(matrix, p);
    const diagonalFactor = wasm.ldl(matrix, p, new Int32Array(n).fill(1));
    assert.deepEqual(matrix, saved);
    for (const count of [1, 2, 3, 57]) {
      const expected = Array.from({ length: count }, (_, r) => Float64Array.from({ length: n }, (_, i) => Math.cos(i + r / 3)));
      const rhs = expected.map(x => Float64Array.from(p.order, i => dense[i].reduce((s, v, j) => s + v * x[j], 0)));
      const results = accelerated.many(rhs);
      for (let r = 0; r < count; r++) {
        assert.deepEqual(results[r], js(rhs[r]), 'SIMD сохраняет порядок арифметики скалярного разреженного решения');
        results[r].forEach((v, i) => close(v, expected[r][p.order[i]]));
        diagonalFactor(rhs[r]).forEach((v, i) => close(v, expected[r][p.order[i]]));
      }
    }
    assert.deepEqual(accelerated.many([]), []);
    // Новый фактор и рост памяти не меняют ранее возвращённые ответы/фактор.
    const rhs = new Float64Array(n).fill(1), old = accelerated(rhs).slice();
    wasm(matrix.map(v => 2 * v), p)(rhs);
    assert.deepEqual(accelerated(rhs), old);
    assert.throws(() => accelerated(new Float64Array(n + 1)), /длина/);
  }
}
for (const value of [0, -1, NaN, Infinity]) {
  const p = sparsePattern(1, [[0]]);
  for (const f of [sparseFactor, wasm]) assert.throws(() => f(Float64Array.of(value), p), /не положительна/);
}
assert.throws(() => sparsePattern(2, [], Int32Array.of(0, 0)), /перестановка/);
// Структурное заполнение: цепь 0–2–1 создаёт связь 1–2 при исключении 0.
const fill = sparsePattern(3, [[0, 1], [0, 2]]);
assert.ok(fill.locations[2].has(1));
for (const [rows, cols] of [[11, 9], [9, 21], [41, 33]]) {
  const offset = Int32Array.from({ length: rows * cols }, (_, i) => i === 0 ? -1 : 3 * (i - 1));
  const n = 3 * (rows * cols - 1), order = gridDissection(rows, cols, offset, n);
  assert.equal(order.length, n); assert.equal(new Set(order).size, n);
  for (let i = 0; i < n; i += 3) assert.deepEqual(Array.from(order.slice(i, i + 3)), [order[i], order[i] + 1, order[i] + 2]);
}
// Независимая полная матрица [3 1;1 2], пакет нечётной ширины и планка.
const p = sparsePattern(1, [[0]]);
const solve = borderedBandFactor(Float64Array.of(3), Float64Array.of(1), Float64Array.of(2), 1, 0, 1, a => wasm(a, p));
const rhs = [Float64Array.of(7, 5), Float64Array.of(2, -1), Float64Array.of(0, 0)];
const results = solve.many(rhs);
for (let i = 0; i < rhs.length; i++) {
  close(3 * results[i][0] + results[i][1], rhs[i][0]);
  close(results[i][0] + 2 * results[i][1], rhs[i][1]);
  assert.deepEqual(results[i], solve(rhs[i]));
}
console.log('ок: независимые матрицы, заполнение, перестановки, отказы, рост памяти, повторные ответы и SIMD 1/2/3/57');

// Независимое совместное решение: H=diag(2,3), G=[1,2], Gᵀx=0.4.
// mu=(GᵀH⁻¹b-0.4)/(GᵀH⁻¹G), затем x=H⁻¹(b-Gmu).
const kkt = sparsePattern(3, [[0], [1]], Int32Array.of(0, 1, 2), [[0, 2], [1, 2]]);
const values = new Float64Array(kkt.cols.length);
for (const [i, j, v] of [[0, 0, 2], [1, 1, 3], [2, 0, 1], [2, 1, 2]]) values[kkt.locations[i].get(j)] = v;
const ldl = wasm.ldl(values, kkt, Int32Array.of(1, 1, -1));
const mu = (5 / 2 + 2 * 7 / 3 - .4) / (1 / 2 + 4 / 3);
const exact = [(5 - mu) / 2, (7 - 2 * mu) / 3, mu], solved = ldl(Float64Array.of(5, 7, .4));
solved.forEach((v, i) => close(v, exact[i]));
assert.throws(() => wasm.ldl(values, kkt, Int32Array.of(1, 1, 1)), /не положительна/);
// Ограничение исключается после всех своих координат, перед независимой третьей.
const interleaved = sparsePattern(4, [[0], [1], [2]], Int32Array.of(0, 1, 3, 2), [[0, 3], [1, 3]]);
const A = [[2, 0, 1, 0], [0, 3, 2, 0], [1, 2, 0, 0], [0, 0, 0, 4]];
const entries = new Float64Array(interleaved.cols.length);
for (let i = 0; i < 4; i++) for (let a = interleaved.rowPtr[i]; a < interleaved.rowPtr[i + 1]; a++) entries[a] = A[i][interleaved.cols[a]];
const mixed = wasm.ldl(entries, interleaved, Int32Array.of(1, 1, -1, 1));
const x = Float64Array.of(1, -2, .5, 3), b = A.map(row => row.reduce((s, v, i) => s + v * x[i], 0));
mixed(b).forEach((v, i) => close(v, x[i]));
console.log('ок: известное совместное решение и отрицательные диагонали ограничений');
