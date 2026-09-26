// Связанный перенос распределённого LE/TE-следа: диагностика, не генакер.
// node tests/fourier-sheet-advection.test.mjs [--full] [--gate]
import assert from 'node:assert/strict';
import { fourierSheetWakeStep, inducedSegment } from './lib/fourier-vortex.mjs';

const sheet = { a: [.01, .005], b: [.02, .008], gamma: -.03 };
const exact = inducedSegment(sheet, .015, .002, 1e-5);
const quadrature = [0, 0];
for (let i = 0; i < 100000; i++) {
  const u = (i + .5) / 100000;
  const x = sheet.a[0] * (1 - u) + sheet.b[0] * u;
  const z = sheet.a[1] * (1 - u) + sheet.b[1] * u;
  const dx = .015 - x, dz = .002 - z;
  const k = sheet.gamma /
    (2 * Math.PI * 100000 * (dx * dx + dz * dz + 1e-5));
  quadrature[0] -= k * dz;
  quadrature[1] += k * dx;
}
assert.ok(Math.hypot(exact[0] - quadrature[0],
  exact[1] - quadrature[1]) < 1e-10);

function run(leading, modes, points, substeps,
             formation = 'flow', releaseHeight = .005) {
  let state = null, result, step;
  for (step = 1; step <= 40; step++) {
    result = fourierSheetWakeStep({ flow: [1, .1], dt: .01,
      modes, points, reynolds: 1e5, releaseHeight,
      shedLeadingEdge: leading, advection: 'induced',
      advectionSubsteps: substeps,
      leadingFormation: formation, state });
    if (!result.ok) break;
    assert.ok(Math.abs(result.kelvin) < 1e-10);
    state = result.state;
  }
  console.log(`${leading ? 'LE+TE' : 'TE'}, мод=${modes}, ` +
    `подшагов=${substeps}, рождение=${formation}, h=${releaseHeight}: ` +
    (result.ok ? `Fp=${result.force.toFixed(6)}, ` +
      // Кандидат скачка потенциала у LE; не физическая сила при h > 0.
      (leading ? `Fcut?=${(result.force -
        result.leadingGamma / .01).toFixed(6)}, ` : '') +
      `Fi=${result.impulseForce.toFixed(6)}, ` +
      `RMS=${result.residual.toExponential(3)}` :
      `отказ ${result.reason} на шаге ${step}, x=${result.position?.[0]}, ` +
      `z=${result.position?.[1]}`));
  return { ...result, step };
}

const trailing = run(false, 128, 512, 16);
const earlyCollision = run(true, 128, 512, 4);
const leading = run(true, 128, 512, 16);
const tangent = run(true, 128, 512, 16, 'tangent');
const edgeRelease = run(true, 128, 512, 16, 'flow', 0);
const thinRelease = run(true, 128, 512, 16, 'flow', .002);
for (const result of [trailing, leading, tangent]) {
  const sheets = result.state.sheets;
  for (const edge of ['LE', 'TE']) {
    const chain = sheets.filter(s => s.edge === edge);
    for (let i = 1; i < chain.length; i++)
      assert.ok(Math.hypot(chain[i].b[0] - chain[i - 1].a[0],
        chain[i].b[1] - chain[i - 1].a[1]) < 1e-12);
  }
}
assert.ok(trailing.ok && trailing.force > 0);
assert.ok(Math.abs(trailing.force - trailing.impulseForce) /
  trailing.impulseForce < .01);
assert.equal(earlyCollision.reason, 'sheet-crossed-plate');
assert.ok(leading.ok && leading.force < 0 &&
  leading.impulseForce > 0);
assert.ok(tangent.ok && tangent.force < 0 &&
  tangent.impulseForce > 0);
assert.equal(edgeRelease.reason, 'advection-midpoint');
assert.equal(thinRelease.reason, 'sheet-crossed-plate');
let refined = null;
if (process.argv.includes('--full')) {
  refined = run(true, 256, 1024, 16);
  assert.ok(refined.ok && refined.force < 0 &&
    refined.impulseForce > 0);
  const tangentRefined = run(true, 256, 1024, 16, 'tangent');
  assert.ok(tangentRefined.ok && tangentRefined.force < 0 &&
    tangentRefined.impulseForce > 0);
}
if (process.argv.includes('--gate')) {
  assert.ok(leading.ok &&
    Math.abs(leading.force - leading.impulseForce) <=
      .05 * Math.abs(leading.impulseForce) &&
    earlyCollision.ok &&
    (!refined || Math.abs(refined.force - refined.impulseForce) <=
      .05 * Math.abs(refined.impulseForce)),
  'NO-GO: LE-слой пересекает профиль либо нарушает баланс силы');
}
