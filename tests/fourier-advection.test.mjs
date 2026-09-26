// Отрицательный контроль индуцированного переноса LE-вихрей.
// node tests/fourier-advection.test.mjs [--gate]
import assert from 'node:assert/strict';
import { fourierWakeStep } from './lib/fourier-vortex.mjs';

function run(wz, dt, substeps, shedLeadingEdge) {
  let state = null, result;
  for (let step = 1; step <= Math.round(0.4 / dt); step++) {
    result = fourierWakeStep({ flow: [1, wz], dt,
      modes: 128, points: 512, shedLeadingEdge,
      advection: 'induced', advectionSubsteps: substeps, state });
    if (!result.ok) return { ...result, step };
    assert.ok(Math.abs(result.kelvin) < 1e-10);
    state = result.state;
  }
  return { ok: true, force: result.force };
}

const attached = run(0.1, 0.01, 4, false);
const attachedMirror = run(-0.1, 0.01, 4, false);
assert.ok(attached.ok && attachedMirror.ok);
assert.ok(Math.abs(attached.force + attachedMirror.force) < 1e-9);
console.log(`только TE: F=${attached.force.toFixed(6)}, зеркало=${attachedMirror.force.toFixed(6)}`);

const failures = [];
for (const dt of [0.01, 0.005]) {
  for (const substeps of [1, 4, 16, 32]) {
    const result = run(0.1, dt, substeps, true);
    failures.push(result);
    console.log(`LE+TE: dt=${dt}, подшагов=${substeps}, ` +
      (result.ok ? `F=${result.force.toFixed(6)}` :
        `пересечение на шаге ${result.step}, вихрь ${result.index}`));
  }
}
const mirror = run(-0.1, 0.01, 4, true);
assert.equal(mirror.reason, 'vortex-crossed-plate');
assert.equal(mirror.step, failures[1].step);
assert.ok(failures.every(r => r.reason === 'vortex-crossed-plate'));
if (process.argv.includes('--gate'))
  assert.ok(failures.every(r => r.ok),
    'NO-GO: LE-вихрь проходит сквозь непроницаемую пластину');
