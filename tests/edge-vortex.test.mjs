// Численный свидетель изолированной вихревой пробы. Штатный симулятор её не вызывает.
// node tests/edge-vortex.test.mjs [--gate|--wall-gate]
import assert from 'node:assert/strict';
import { edgeVortexStep } from './lib/edge-vortex.mjs';

function run(panels, dt, wz, shedLeadingEdge = true,
             localConvection = false, advectionSubsteps = 1,
             reynolds = null) {
  let state = null, result;
  const steps = Math.round(0.4 / dt);
  for (let i = 0; i < steps; i++) {
    result = edgeVortexStep({ flow: [1, wz], dt, panels, state,
      shedLeadingEdge, localConvection, advectionSubsteps, reynolds });
    assert.ok(result.ok);
    assert.ok(result.residual < 1e-12, `невязка ${result.residual}`);
    assert.ok(Math.abs(result.circulation) < 1e-12,
      `циркуляция ${result.circulation}`);
    state = result.state;
  }
  return result;
}
// Контрольная ветвь без переднекромочного схода: та же дискретизация,
// один свободный вихрь за задней кромкой и закон Кельвина.
for (const panels of [16, 32, 64, 96]) {
  for (const dt of [0.01, 0.005]) {
    const a = run(panels, dt, 0.1, false);
    const b = run(panels, dt, -0.1, false);
    assert.ok(a.force > 0);
    assert.ok(Math.abs(a.force + b.force) < 1e-11);
    console.log(`только задняя кромка: панели=${panels} dt=${dt}: F+ = ${a.force.toFixed(6)}`);
  }
}
const attachedCoarse = run(64, 0.01, 0.1, false).force;
const attachedFine = run(96, 0.005, 0.1, false).force;
assert.ok(Math.abs(attachedFine - attachedCoarse) / attachedFine < 0.02);
const suction64 = run(64, 0.005, 0.1, false);
const suction96 = run(96, 0.005, 0.1, false);
const suctionMirror = run(96, 0.005, -0.1, false);
assert.ok(Math.abs(suction64.lesp - suction96.lesp) < 2e-5);
assert.ok(Math.abs(suction96.lesp + suctionMirror.lesp) < 1e-12);
assert.ok(Math.abs(suction96.suctionProxy / (Math.PI * suction96.lesp) - 1) < 0.002);
console.log(`A0 контроль: 64=${suction64.lesp.toFixed(6)}, 96=${suction96.lesp.toFixed(6)}`);

for (const panels of [8, 16, 32]) {
  for (const dt of [0.04, 0.02, 0.01]) {
    const a = run(panels, dt, 0.1);
    const b = run(panels, dt, -0.1);
    const zero = run(panels, dt, 0);
    assert.ok(Math.abs(a.force + b.force) < 1e-11);
    assert.ok(Math.abs(zero.force) < 1e-12);
    console.log(`панели=${panels} dt=${dt}: F+ = ${a.force.toFixed(6)}, F− = ${b.force.toFixed(6)}, невязка=${a.residual.toExponential(2)}`);
  }
}
const sharp = run(64, 0.005, 0.1);
assert.ok(Math.abs(sharp.lesp) < 1e-12);
console.log(`острая передняя кромка: A0=${sharp.lesp.toExponential(2)}, F=${sharp.force.toFixed(6)}, циркуляционный=${sharp.circulatoryForce.toFixed(6)}, нестационарный=${sharp.unsteadyForce.toFixed(6)}`);
for (const [panels, dt] of [[16, 0.02], [32, 0.01], [32, 0.005], [64, 0.005]]) {
  const a = run(panels, dt, 0.1, true, true);
  const b = run(panels, dt, -0.1, true, true);
  assert.ok(Math.abs(a.lesp) < 1e-12);
  assert.ok(Math.abs(a.force + b.force) < 1e-9);
  console.log(`местная конвекция LE/TE: панели=${panels} dt=${dt}: F=${a.force.toFixed(6)}, пересечений ткани=${a.crossedLeading}`);
}
for (const panels of [32, 64]) {
  for (const substeps of [1, 4, 16, 32, 64]) {
    const r = run(panels, 0.005, 0.1, true, true, substeps);
    console.log(`подшаг переноса: панели=${panels} n=${substeps}: F=${r.force.toFixed(6)}, пересечений=${r.crossedLeading}`);
  }
}
for (const panels of [32, 64]) {
  for (const reynolds of [1e5, 1e6]) {
    for (const substeps of [1, 16]) {
      const r = run(panels, 0.005, 0.1, true, true,
        substeps, reynolds);
      console.log(`вязкое ядро: панели=${panels} Re=${reynolds} n=${substeps}: F=${r.force.toFixed(6)}, пересечений=${r.crossedLeading}`);
    }
  }
}
if (process.argv.includes('--wall-gate')) {
  const result = run(32, 0.005, 0.1, true, true);
  assert.equal(result.crossedLeading, 0,
    `NO-GO: ${result.crossedLeading} вихрей передней кромки прошли сквозь пластину`);
}
// Положительный угол входа на пластине должен давать положительную нормальную
// нагрузку. Пока схема этого не выполняет, её нельзя переносить на генакер.
if (process.argv.includes('--gate')) {
  const result = run(16, 0.02, 0.1);
  assert.ok(result.force > 0,
    `NO-GO: при положительном угле получена отрицательная сила ${result.force}`);
}
