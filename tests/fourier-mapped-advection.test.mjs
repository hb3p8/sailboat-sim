// Диагностика LE/TE-рождения при непроницаемом аналитическом переносе.
// node tests/fourier-mapped-advection.test.mjs [--gate]
import assert from 'node:assert/strict';
import { fourierWakeStep, fourierPlate } from './lib/fourier-vortex.mjs';

function run(dt, substeps) {
  let state = null, result;
  for (let step = 1; step <= Math.round(0.4 / dt); step++) {
    result = fourierWakeStep({ flow: [1, 0.1], dt,
      modes: 128, points: 512, shedLeadingEdge: true,
      advection: 'mapped', advectionSubsteps: substeps,
      placement: 'half-flow', state });
    if (!result.ok) return { ...result, step };
    assert.ok(Math.abs(result.kelvin) < 1e-10);
    state = result.state;
  }
  return { ok: true, force: result.force, residual: result.residual,
    state };
}

const outcomes = [];
for (const [dt, substeps] of [[0.02, 4], [0.02, 16], [0.02, 64],
                             [0.01, 4], [0.01, 16], [0.01, 64],
                             [0.005, 16], [0.005, 64]]) {
  const result = run(dt, substeps);
  outcomes.push(result);
  console.log(`dt=${dt}, подшагов=${substeps}: ` +
    (result.ok ? `F=${result.force.toFixed(6)}, RMS=${result.residual.toExponential(2)}` :
      `пересечение на шаге ${result.step}`));
}
assert.equal(outcomes[3].reason, 'vortex-crossed-plate');
const frozen = outcomes.at(-1).state.free;
let previousResidual = Infinity;
for (const modes of [128, 256, 512, 1024]) {
  const plate = fourierPlate({ flow: [1, 0.1], free: frozen,
    modes, points: 4096 });
  assert.ok(plate.ok);
  assert.ok(plate.downwashError < previousResidual);
  previousResidual = plate.downwashError;
  console.log(`замороженный след: мод=${modes}, RMS=${plate.downwashError.toExponential(2)}`);
}
if (process.argv.includes('--gate'))
  assert.ok(outcomes.every(r => r.ok && r.force > 0) &&
    previousResidual < 1e-6,
  'NO-GO: нет совместной сходимости траектории, давления и силы');
