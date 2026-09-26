// Рождение свободной LE-пелены точно на кромке плоской пластины.
// node tests/fourier-edge-birth.test.mjs [--gate]
import assert from 'node:assert/strict';
import { boundVelocity, fourierPlate, fourierSheetWakeStep } from
  './lib/fourier-vortex.mjs';

const setup = { flow: [1, .1], dt: .01, modes: 128,
  reynolds: 1e5, releaseHeight: 0,
  advection: 'induced', advectionSubsteps: 16,
  leadingFormation: 'tangent' };

const first = fourierSheetWakeStep({ ...setup, points: 512 });
assert.ok(first.ok && Math.abs(first.kelvin) < 1e-10);
const leading = first.state.sheets.find(sheet => sheet.edge === 'LE');
assert.deepEqual(leading.a, [0, 0]);
const plate = fourierPlate({ flow: setup.flow,
  sheets: first.state.sheets, modes: 128, points: 512 });
assert.ok(Math.abs(plate.A0) < 1e-10);

// Независимая угловая квадратура предела Био–Савара на LE.
const intervals = 50000;
let quadrature = 0;
let trailingQuadrature = 0;
for (let i = 0; i < intervals; i++) {
  const theta = Math.PI * (i + .5) / intervals;
  let series = 0;
  for (let j = 0; j < plate.An.length; j++)
    series += plate.An[j] * Math.sin((j + 1) * theta);
  quadrature += plate.edgeSpeed / intervals * series *
    Math.sin(theta) / (1 - Math.cos(theta));
  const gamma = -2 * plate.edgeSpeed *
    (plate.A0 * (1 + Math.cos(theta)) / Math.sin(theta) + series);
  trailingQuadrature += gamma * Math.sin(theta) /
    (1 + Math.cos(theta)) / (2 * intervals);
}
const edgeVelocity = boundVelocity(plate, 0, 0);
assert.ok(Number.isFinite(edgeVelocity[1]) &&
  Math.abs(quadrature - edgeVelocity[1]) < 1e-7);
assert.ok(Math.abs(trailingQuadrature - boundVelocity(plate, 1, 0)[1]) <
  1e-7);
console.log(`LE-скорость: ряд=${edgeVelocity[1].toFixed(9)}, ` +
  `независимая квадратура=${quadrature.toFixed(9)}; ` +
  `TE=${boundVelocity(plate, 1, 0)[1].toFixed(9)}`);

let previousRaw = Infinity;
let last = null;
for (const points of [512, 1024, 2048, 4096]) {
  const result = fourierSheetWakeStep({ ...setup, points });
  assert.ok(result.ok && Math.abs(result.kelvin) < 1e-10);
  const rate = result.leadingGamma / setup.dt;
  const cutForce = result.force - rate;
  const discrepancy = Math.abs(cutForce - result.impulseForce) /
    Math.abs(result.impulseForce);
  const rawAtEdge = result.pressure[0];
  const cutAtEdge = rawAtEdge - rate;
  assert.ok(Math.abs(rawAtEdge) < previousRaw);
  assert.ok(discrepancy < .05);
  previousRaw = Math.abs(rawAtEdge);
  last = { result, cutAtEdge };
  console.log(`точек=${points}: Γ̇LE=${rate.toFixed(6)}, ` +
    `Fp=${result.force.toFixed(6)}, ` +
    `Fcut?=${cutForce.toFixed(6)}, ` +
    `Fi=${result.impulseForce.toFixed(6)}, ` +
    `ΔpLE?=${cutAtEdge.toFixed(6)}, ` +
    `RMS=${result.residual.toExponential(3)}`);
}
const refined = fourierSheetWakeStep({ ...setup,
  modes: 1024, points: 4096 });
assert.ok(refined.ok && refined.residual < .001);
assert.ok(Math.abs(refined.leadingGamma - last.result.leadingGamma) < 1e-5);
assert.ok(Math.abs((refined.pressure[0] - refined.leadingGamma / setup.dt) -
  last.cutAtEdge) < .1);
console.log(`1024 моды: ΔpLE?=${(refined.pressure[0] -
  refined.leadingGamma / setup.dt).toFixed(6)}, ` +
  `RMS=${refined.residual.toExponential(3)}`);

const second = fourierSheetWakeStep({ ...setup, points: 512,
  state: first.state });
console.log(`второй шаг: ${second.reason}, ` +
  `x=${second.position?.[0]}, z=${second.position?.[1]}`);
assert.equal(second.reason, 'sheet-crossed-plate');
if (process.argv.includes('--gate'))
  assert.ok(second.ok && Math.abs(last.cutAtEdge) < 1e-2,
    'NO-GO: свободный слой пересекает пластину, локальный импульс ' +
    'при выпуске не сбалансирован');
