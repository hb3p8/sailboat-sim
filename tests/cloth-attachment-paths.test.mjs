// Дальний предел должен допускать разворачивание без растяжения ткани.
// Известная изометрия многогранного цилиндра → плоскость, затем настоящий крой.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cloth, clothEdgePaths } from '../sim/cloth.js';
import { Boat } from '../sim/physics.js';

const close = (a, b) => assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)),
  `${a} != ${b}`);
const length = (p, a, b) => Math.hypot(...p[a].map((x, k) => x - p[b][k]));
function strip(rows, cols, angle) {
  const ref = [], flat = [], ci = [], cj = [], diagonal = [];
  const step = 2 * Math.sin(Math.abs(angle) / (2 * (cols - 1)));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const t = c * angle / (cols - 1), i = r * cols + c;
    ref.push([Math.cos(t) - 1, Math.sin(t), r * 0.5]);
    flat.push([c * step, 0, r * 0.5]);
    if (c + 1 < cols) { ci.push(i); cj.push(i + 1); }
    if (r + 1 < rows) { ci.push(i); cj.push(i + cols); }
    if (c + 1 < cols && r + 1 < rows) {
      diagonal.push([i, i + cols + 1], [i + 1, i + cols]);
    }
  }
  const rest = ci.map((a, k) => length(ref, a, cj[k]));
  for (let k = 0; k < ci.length; k++) close(length(flat, ci[k], cj[k]), rest[k]);
  for (const [a, b] of diagonal) close(length(flat, a, b), length(ref, a, b));
  return { ref, flat, ci, cj, rest };
}
for (const cols of [9, 17, 33]) for (const angle of [Math.PI, -Math.PI]) {
  const { ref, flat, ci, cj, rest } = strip(3, cols, angle);
  for (const anchor of [0, 2 * cols]) {
    const paths = clothEdgePaths(ref.length, ci, cj, rest, ci.length, anchor);
    close(paths[anchor], 0);
    for (let i = 0; i < ref.length; i++)
      assert.ok(length(flat, anchor, i) <= paths[i] + 1e-12);
    const target = anchor + cols - 1;
    close(paths[target], length(flat, anchor, target));
    assert.ok(length(flat, anchor, target) > length(ref, anchor, target) * 1.5);
    // Тем же проектором старый предел меняет допустимую плоскую форму;
    // материальный путь не делает этого. Две точки выделяют одну дальнюю связь.
    const project = limit => {
      const p = Float64Array.from([0, 0, 0, length(flat, anchor, target), 0, 0]);
      Cloth.prototype.sweep.call({ pos: p, ci: [0], cj: [1], ck: [1], rest: [limit],
        w: [0, 1], board() {} }, null, 1);
      return p[3];
    };
    close(project(length(ref, anchor, target)), 2);
    close(project(paths[target]), length(flat, anchor, target));
    const scaled = clothEdgePaths(ref.length, ci, cj, rest.map(x => x * 4), ci.length, anchor);
    paths.forEach((x, i) => close(scaled[i], x * 4));
    const order = ci.map((_, k) => ci.length - 1 - k);
    const reverse = clothEdgePaths(ref.length, order.map(k => cj[k]), order.map(k => ci[k]),
      order.map(k => rest[k]), ci.length, anchor);
    paths.forEach((x, i) => close(reverse[i], x));
  }
}
// Известный граф с обходом: нужна именно кратчайшая сумма, а не первая цепочка.
assert.deepEqual(Array.from(clothEdgePaths(3, [0, 0, 1], [1, 2, 2], [4, 1, 1], 3, 0)), [0, 2, 1]);
assert.throws(() => clothEdgePaths(3, [0], [1], [1], 1, 0), /не связана/);
assert.throws(() => clothEdgePaths(2, [0], [1], [-1], 1, 0), /ребро/);
assert.throws(() => clothEdgePaths(2, [0], [1], [NaN], 1, 0), /ребро/);
console.log('ок: изометрическое разворачивание, две стороны, три сетки, границы графа');

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url)));
let maxRatio = 1;
for (const tack of [1, -1]) for (const cols of [9, 17, 33]) {
  const b = new Boat(pack);
  b.setGennaker(true); b.o.genSheetLen = 9;
  b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * Math.PI / 180;
  b.u = 3; b.psi = (100 - tack * 140) * Math.PI / 180;
  b.step(1 / 30);
  const options = { rows: 11, cols, iter: 10 };
  const original = new Cloth(b.rig.sails[2], 2, options);
  const paths = new Cloth(b.rig.sails[2], 2, { ...options, attachmentPaths: true });
  original.step(b, 1 / 30); paths.step(b, 1 / 30);
  for (const key of ['ci', 'cj', 'ck', 'dx', 'dy', 'dz', 'area', 'mass', 'w'])
    assert.deepEqual(paths[key], original[key], `Изменилось ${key}`);
  for (let k = 0; k < paths.rest.length; k++) {
    if (k < paths.attachmentStart) assert.equal(paths.rest[k], original.rest[k]);
    else {
      assert.ok(paths.rest[k] + 1e-12 >= original.rest[k]);
      maxRatio = Math.max(maxRatio, paths.rest[k] / original.rest[k]);
    }
  }
  const before = paths.rest.slice();
  paths.pattern(paths.slackWas);
  assert.deepEqual(paths.rest, before, 'Повторная подготовка меняет пределы');
  assert.ok(paths.pos.every(Number.isFinite));
}
console.log(`ок: настоящий крой, кромки/изгиб/масса сохранены; отношение пути к хорде до ${maxRatio.toFixed(3)}`);
