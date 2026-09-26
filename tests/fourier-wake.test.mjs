// Дискретный след только за задней кромкой непрерывной пелены.
// node tests/fourier-wake.test.mjs
import assert from 'node:assert/strict';
import { fourierWakeStep } from './lib/fourier-vortex.mjs';

function run(wz, dt, modes, points) {
  let state = null, result;
  for (let i = 0; i < Math.round(0.4 / dt); i++) {
    result = fourierWakeStep({ flow: [1, wz], dt, modes,
      points, state });
    assert.ok(result.ok);
    assert.ok(Math.abs(result.kelvin) < 1e-10);
    state = result.state;
  }
  const integral = result.pressure.reduce((s, p, i) => s +
    p * (result.edges[i + 1] - result.edges[i]), 0);
  assert.ok(Math.abs(result.force - integral) < 1e-12);
  return result;
}

const zero = run(0, 0.01, 64, 512);
assert.ok(Math.abs(zero.force) < 1e-12);
const reference = run(0.1, 0.01, 64, 512);
const mirror = run(-0.1, 0.01, 64, 512);
assert.ok(Math.abs(reference.force + mirror.force) < 1e-11);
assert.ok(Math.abs(reference.A0 + mirror.A0) < 1e-11);
assert.ok(reference.force > 0);
console.log(`след TE: F=${reference.force.toFixed(9)}, A0=${reference.A0.toFixed(9)}, невязка потока=${reference.residual.toExponential(2)}`);

let previous = Infinity;
for (const dt of [0.02, 0.01, 0.005, 0.0025]) {
  const p = run(0.1, dt, 128, 512);
  assert.ok(p.force > 0);
  assert.ok(p.force < previous); previous = p.force;
  console.log(`след TE: dt=${dt}, F=${p.force.toFixed(9)}, Кельвин=${p.kelvin.toExponential(2)}, невязка=${p.residual.toExponential(2)}`);
}
const fine = run(0.1, 0.0025, 256, 1024);
assert.ok(Math.abs(fine.force - previous) < 1e-6);
assert.ok(fine.residual < 1e-8);
console.log(`след TE, густая пелена: F=${fine.force.toFixed(9)}, невязка=${fine.residual.toExponential(2)}`);
