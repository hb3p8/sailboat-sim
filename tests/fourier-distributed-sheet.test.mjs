// Контроль замороженной распределённой свободной пелены у входа.
// node tests/fourier-distributed-sheet.test.mjs
import assert from 'node:assert/strict';
import { fourierPlate, inducedSegment } from './lib/fourier-vortex.mjs';

const segment = { a: [0.1, 0.02], b: [0.2, 0.07], gamma: 0.03 };
const exact = inducedSegment(segment, 0.4, 0.15);
const quadrature = [0, 0], n = 10000;
for (let i = 0; i < n; i++) {
  const u = (i + 0.5) / n;
  const x = segment.a[0] * (1 - u) + segment.b[0] * u;
  const z = segment.a[1] * (1 - u) + segment.b[1] * u;
  const dx = 0.4 - x, dz = 0.15 - z;
  const k = segment.gamma / (2 * Math.PI * n * (dx * dx + dz * dz));
  quadrature[0] -= k * dz; quadrature[1] += k * dx;
}
assert.ok(Math.hypot(exact[0] - quadrature[0],
  exact[1] - quadrature[1]) < 1e-10);

function smoothSheet(count, sign = 1) {
  const parts = Array.from({ length: count }, (_, i) => {
    const x = (i + 0.5) * 0.2 / count;
    return { a: [i * 0.2 / count, sign * 0.001],
      b: [(i + 1) * 0.2 / count, sign * 0.001],
      weight: Math.exp(-0.5 * ((x - 0.05) / 0.03) ** 2) };
  });
  const total = parts.reduce((s, p) => s + p.weight, 0);
  return parts.map(p => ({ a: p.a, b: p.b,
    gamma: -sign * 0.02 * p.weight / total }));
}

const point = fourierPlate({ flow: [1, 0.1],
  free: [{ x: 0.05, z: 0.001, gamma: -0.02 }],
  modes: 256, points: 1024 });
console.log(`один вихрь: RMS=${point.downwashError.toExponential(3)}`);
let previousResidual = Infinity, previousForce = null;
for (const count of [32, 64, 128, 256, 512]) {
  const sheets = smoothSheet(count);
  const total = sheets.reduce((s, p) => s + p.gamma, 0);
  assert.ok(Math.abs(total + 0.02) < 1e-14);
  const p = fourierPlate({ flow: [1, 0.1], sheets,
    modes: 256, points: 1024 });
  const mirror = fourierPlate({ flow: [1, -0.1],
    sheets: smoothSheet(count, -1), modes: 256, points: 1024 });
  assert.ok(Math.abs(p.force + mirror.force) < 1e-12);
  assert.ok(p.downwashError < previousResidual);
  if (count === 256) assert.ok(p.downwashError < 1e-7);
  if (count === 512)
    assert.ok(Math.abs(p.force - previousForce) < 5e-7);
  previousResidual = p.downwashError; previousForce = p.force;
  console.log(`отрезков=${count}: RMS=${p.downwashError.toExponential(3)}, ` +
    `F=${p.force.toFixed(9)}`);
}
