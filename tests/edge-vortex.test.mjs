// Численный свидетель изолированной вихревой пробы. Штатный симулятор её не вызывает.
// node tests/edge-vortex.test.mjs [--gate]
import assert from 'node:assert/strict';
import { edgeVortexStep } from './lib/edge-vortex.mjs';

function run(panels, dt, wz) {
  let state = null, result;
  const steps = Math.round(0.4 / dt);
  for (let i = 0; i < steps; i++) {
    result = edgeVortexStep({ flow: [1, wz], dt, panels, state });
    assert.ok(result.ok);
    assert.ok(result.residual < 1e-12, `невязка ${result.residual}`);
    assert.ok(Math.abs(result.circulation) < 1e-12,
      `циркуляция ${result.circulation}`);
    state = result.state;
  }
  return result;
}

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
// Положительный угол входа на пластине должен давать положительную нормальную
// нагрузку. Пока схема этого не выполняет, её нельзя переносить на генакер.
if (process.argv.includes('--gate')) {
  const result = run(16, 0.02, 0.1);
  assert.ok(result.force > 0,
    `NO-GO: при положительном угле получена отрицательная сила ${result.force}`);
}
