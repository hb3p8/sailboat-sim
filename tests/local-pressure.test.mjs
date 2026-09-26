// Независимые пределы локального замыкания: тонкая пластина, размерность,
// отражение, нулевая равнодействующая и консервативный перенос на ткань.
// node tests/local-pressure.test.mjs
import assert from 'node:assert/strict';
import { localPressure, pressureToNodes } from '../sim/local-pressure.js';

const sum = a => a.reduce((s, v) => s + v, 0);
const close = (x, y, e = 1e-10) => assert.ok(Math.abs(x - y) <= e * Math.max(1, Math.abs(y)), `${x} != ${y}`);
const base = { points: [[0, 0], [1, 0]], flow: [1, 0.1], rho: 1, span: 1, normalForce: 1 };
// Без подгонки интеграла плоская пластина при малом угле даёт линейную
// тонкопрофильную силу πρU·Wcb; это только проверка потенциального предела.
for (const panels of [8, 16, 32, 64]) {
  const free = localPressure({ ...base, normalForce: null, panels });
  assert.ok(free.ok);
  close(sum(free.forces), Math.PI * base.flow[0] * base.flow[1]);
  close(free.circulation, -Math.PI * base.flow[0] * base.flow[1]);
  close(free.downwash, 0);
  const other = localPressure({ ...base, normalForce: null,
    flow: [1, -0.1], panels });
  assert.ok(other.ok);
  free.pressure.forEach((v, i) => close(other.pressure[i], -v));
}
let last = Infinity;
for (const panels of [8, 16, 32, 64]) {
  const p = localPressure({ ...base, panels });
  assert.ok(p.ok); close(sum(p.forces), 1);
  const cp = sum(p.forces.map((f, i) => f * p.at[i]));
  // Для плоской пластины в линейной теории центр нагрузки — четверть хорды.
  // Допуск задаётся шагом панели, ошибка должна уменьшаться при сгущении.
  assert.ok(Math.abs(cp - 0.25) < 1 / panels);
  assert.ok(Math.abs(cp - 0.25) < last); last = Math.abs(cp - 0.25);
  // Интеграл sqrt((1-x)/x) до x=0.1, с долей пересечённой панели.
  const front = sum(p.forces.map((f, i) => f * Math.max(0, Math.min(1,
    (0.1 - p.edges[i]) / (p.edges[i + 1] - p.edges[i])))));
  const exact = 2 / Math.PI * (Math.asin(Math.sqrt(0.1)) + Math.sqrt(0.1 * 0.9));
  assert.ok(Math.abs(front - exact) < 1 / panels);
  console.log(`Пластина ${panels}: центр ${cp.toFixed(6)}, первые 10 % ${front.toFixed(6)}, точное ${exact.toFixed(6)}`);
  for (const nodes of [9, 17, 33]) {
    const f = pressureToNodes(p, nodes);
    close(sum(f), 1); close(sum(f.map((v, i) => v * i / (nodes - 1))), cp);
  }
}
const curved = { ...base, points: Array.from({ length: 9 }, (_, i) => [i / 8, 0.4 * i / 8 * (1 - i / 8)]), normalForce: 0.4 };
const p = localPressure(curved);
assert.ok(p.ok); close(sum(p.forces), 0.4);
const mirror = localPressure({ ...curved, points: curved.points.map(([x, z]) => [x, -z]), flow: [1, -0.1], normalForce: -0.4 });
assert.ok(mirror.ok);
p.pressure.forEach((v, i) => close(mirror.pressure[i], -v));
// Изменение геометрии при том же интеграле обязано менять местную нагрузку.
const flat = localPressure({ ...curved, points: base.points });
assert.ok(Math.abs(p.pressure[0] - flat.pressure[0]) > 1e-6);
const scaled = localPressure({ ...curved, flow: [2, 0.2], normalForce: 1.6 });
p.pressure.forEach((v, i) => close(scaled.pressure[i], 4 * v));
const large = localPressure({ ...curved, points: curved.points.map(p => p.map(v => 3 * v)), span: 3, normalForce: 3.6 });
p.pressure.forEach((v, i) => close(large.pressure[i], v));
// Нулевой интеграл не должен обнулять встречные локальные силы или приводить
// к делению на почти нулевую сумму профиля.
const zero = localPressure({ ...curved, normalForce: 0 });
assert.ok(zero.ok); close(sum(zero.forces), 0);
assert.ok(zero.forces.some(f => f < 0) && zero.forces.some(f => f > 0));
assert.equal(localPressure({ ...base, flow: [-1, 0] }).reason, 'reverse-flow');
assert.equal(localPressure({ ...base, flow: [0, 0] }).reason, 'degenerate');
console.log('ок: сумма и момент переноса, отражение, масштабы, форма, нулевая сумма, явная неприменимость');
