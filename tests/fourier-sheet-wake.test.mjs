// Диагностика временного LE/TE-схода распределёнными отрезками.
// node tests/fourier-sheet-wake.test.mjs [--gate]
import assert from 'node:assert/strict';
import { fourierSheetWakeStep } from './lib/fourier-vortex.mjs';

function run(dt, releaseHeight = null, modes = 128, uz = 0.1,
             shedLeadingEdge = true) {
  let state = null, result;
  for (let step = 0; step < Math.round(0.4 / dt); step++) {
    result = fourierSheetWakeStep({ flow: [1, uz], dt, modes,
      points: 512, reynolds: 1e5, releaseHeight,
      shedLeadingEdge, state });
    assert.ok(result.ok);
    assert.ok(Math.abs(result.kelvin) < 1e-10);
    if (shedLeadingEdge) assert.ok(Math.abs(result.A0) < 1e-10);
    assert.ok(Number.isFinite(result.force));
    assert.ok(Number.isFinite(result.impulseForce));
    state = result.state;
  }
  return result;
}

const diffusive = [.02, .01, .005, .0025].map(dt => run(dt));
const finite = [.02, .01, .005, .0025].map(dt =>
  run(dt, .005));
const trailingOnly = [.02, .01, .005, .0025].map(dt =>
  run(dt, null, 128, .1, false));
for (let i = 0; i < diffusive.length; i++) {
  const dt = [.02, .01, .005, .0025][i];
  for (const [label, r] of [['диффузионный', diffusive[i]],
                            ['фиксированный', finite[i]]])
    console.log(`${label} выпуск, Δt=${dt}: ` +
      `давление=${r.force.toFixed(6)}, ` +
      `импульс=${r.impulseForce.toFixed(6)}, ` +
      `RMS=${r.residual.toExponential(3)}`);
}
for (let i = 0; i < trailingOnly.length; i++) {
  const r = trailingOnly[i];
  console.log(`только TE, Δt=${[.02, .01, .005, .0025][i]}: ` +
    `давление=${r.force.toFixed(6)}, ` +
    `импульс=${r.impulseForce.toFixed(6)}, ` +
    `A0=${r.A0.toFixed(6)}`);
  assert.ok(r.force > 0);
  assert.ok(Math.abs(r.force - r.impulseForce) /
    r.impulseForce < .01);
}
assert.ok(Math.abs(trailingOnly[0].force - trailingOnly.at(-1).force) /
  trailingOnly.at(-1).force < .01);
assert.ok(Math.max(...diffusive.map(r => r.impulseForce)) -
  Math.min(...diffusive.map(r => r.impulseForce)) < .005);
assert.ok(Math.max(...finite.map(r => r.impulseForce)) -
  Math.min(...finite.map(r => r.impulseForce)) < .005);
const mirror = run(.01, null, 128, -.1);
assert.ok(Math.abs(mirror.force + diffusive[1].force) < 1e-10);
assert.ok(Math.abs(mirror.impulseForce +
  diffusive[1].impulseForce) < 1e-10);
const modes = [64, 128, 192].map(n => run(.01, null, n));
assert.ok(Math.abs(modes[1].force - modes[2].force) < 1e-6);
if (process.argv.includes('--gate')) {
  const pressureAgrees = [...diffusive, ...finite].every(r =>
    Math.abs(r.force - r.impulseForce) <=
      .05 * Math.abs(r.impulseForce));
  const timeAgrees = diffusive.slice(1).every((r, i) =>
    Math.abs(r.force - diffusive[i].force) <=
      .05 * Math.abs(diffusive[i].force));
  assert.ok(pressureAgrees && timeAgrees,
    'NO-GO: давление расходится с вихревым импульсом и шагом времени');
}
