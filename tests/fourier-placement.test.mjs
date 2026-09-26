// Отрицательный контроль размещения нового вихря и физического ядра.
// node tests/fourier-placement.test.mjs [--gate]
import assert from 'node:assert/strict';
import { fourierWakeStep } from './lib/fourier-vortex.mjs';

function run({ wz = 0.1, dt, reynolds, placement, modes = 128,
               points = 512 }) {
  let state = null, result;
  for (let step = 1; step <= Math.round(0.4 / dt); step++) {
    result = fourierWakeStep({ flow: [1, wz], dt,
      modes, points, shedLeadingEdge: true,
      advection: 'induced', advectionSubsteps: 4,
      placement, reynolds, state });
    if (!result.ok) return { ...result, step };
    assert.ok(Math.abs(result.kelvin) < 1e-10);
    state = result.state;
  }
  return { ok: true, force: result.force };
}

const records = [];
for (const dt of [0.01, 0.005]) {
  for (const reynolds of [Infinity, 1e6, 1e5]) {
    const result = run({ dt, reynolds, placement: 'previous-third' });
    records.push(result);
    console.log(`треть предыдущего: dt=${dt}, Re=${reynolds}, ` +
      (result.ok ? `F=${result.force.toFixed(6)}` :
        `пересечение на шаге ${result.step}`));
  }
}
const mirror = run({ wz: -0.1, dt: 0.01, reynolds: 1e5,
  placement: 'previous-third' });
assert.equal(mirror.reason, 'vortex-crossed-plate');
assert.equal(mirror.step, records[2].step);
for (const [modes, points] of [[64, 256], [128, 512],
                                [256, 1024], [384, 1024]]) {
  const result = run({ dt: 0.005, reynolds: 1e5,
    placement: 'previous-third', modes, points });
  records.push(result);
  console.log(`Re=1e5, dt=0.005, мод=${modes}, точек=${points}: ` +
    (result.ok ? `F=${result.force.toFixed(6)}` :
      `пересечение на шаге ${result.step}`));
}
assert.ok(records.every(r => r.reason === 'vortex-crossed-plate'));
if (process.argv.includes('--gate'))
  assert.ok(records.every(r => r.ok),
    'NO-GO: размещение и диффузионное ядро не предотвращают пересечения');
