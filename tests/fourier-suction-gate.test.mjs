// Чувствительность условного LE-выпуска: только диагностический контроль.
// node tests/fourier-suction-gate.test.mjs [--gate]
import assert from 'node:assert/strict';
import { fourierSheetWakeStep } from './lib/fourier-vortex.mjs';

function run(limit, dt, uz = .1) {
  let state = null, result, active = 0;
  for (let i = 0; i < Math.round(.4 / dt); i++) {
    result = fourierSheetWakeStep({ flow: [1, uz], dt,
      modes: 128, points: 512, reynolds: 1e5,
      releaseHeight: .005, suctionNumeratorLimit: limit,
      state });
    assert.ok(result.ok);
    assert.ok(Math.abs(result.kelvin) < 1e-10);
    if (result.leadingActive) active++;
    state = result.state;
  }
  return { ...result, active };
}

const steps = [.02, .01, .005, .0025];
const cases = new Map();
for (const limit of [.04, .06, .08]) {
  const values = steps.map(dt => run(limit, dt));
  cases.set(limit, values);
  for (let i = 0; i < steps.length; i++) {
    const r = values[i];
    console.log(`предел=${limit}, Δt=${steps[i]}: ` +
      `LE-шагов=${r.active}, Fp=${r.force.toFixed(6)}, ` +
      `Fi=${r.impulseForce.toFixed(6)}, ` +
      `RMS=${r.residual.toExponential(3)}`);
  }
}
assert.equal(cases.get(.04)[3].active, 160);
assert.ok(cases.get(.04)[3].force < 0);
assert.ok(cases.get(.04)[3].impulseForce > 0);
assert.equal(cases.get(.06)[2].active, 79);
assert.equal(cases.get(.06)[3].active, 1);
assert.ok(cases.get(.04)[1].residual < 1e-6);
const mirror = run(.04, .01, -.1);
assert.equal(mirror.active, cases.get(.04)[1].active);
assert.ok(Math.abs(mirror.force + cases.get(.04)[1].force) < 1e-10);
assert.ok(Math.abs(mirror.impulseForce +
  cases.get(.04)[1].impulseForce) < 1e-10);
if (process.argv.includes('--gate')) {
  const all = [...cases.values()].flat();
  assert.ok(all.every(r => Math.abs(r.force - r.impulseForce) <=
    .05 * Math.abs(r.impulseForce)),
  'NO-GO: условный LE-выпуск не согласовал давление и импульс');
}
