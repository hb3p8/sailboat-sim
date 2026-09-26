// Отрицательный свидетель переднего схода на непрерывной пелене.
// node tests/fourier-leading.test.mjs [--gate]
import assert from 'node:assert/strict';
import { fourierWakeStep } from './lib/fourier-vortex.mjs';

function run(wz, dt, modes, points, shedLeadingEdge) {
  let state = null, result;
  for (let i = 0; i < Math.round(0.4 / dt); i++) {
    result = fourierWakeStep({ flow: [1, wz], dt, modes,
      points, shedLeadingEdge, state });
    assert.ok(result.ok);
    assert.ok(Math.abs(result.kelvin) < 1e-10);
    state = result.state;
  }
  const integral = result.pressure.reduce((s, p, i) => s +
    p * (result.edges[i + 1] - result.edges[i]), 0);
  assert.ok(Math.abs(result.force - integral) < 1e-12);
  return result;
}

assert.ok(Math.abs(run(0, 0.01, 128, 512, true).force) < 1e-12);
for (const dt of [0.02, 0.01, 0.005]) {
  const attached = run(0.1, dt, 128, 512, false);
  const separated = run(0.1, dt, 128, 512, true);
  const mirror = run(-0.1, dt, 128, 512, true);
  assert.ok(Math.abs(separated.A0) < 1e-12);
  assert.ok(Math.abs(separated.force + mirror.force) < 1e-9);
  console.log(`dt=${dt}: без LE F=${attached.force.toFixed(6)}, импульс=${attached.impulseForce.toFixed(6)}; с LE F=${separated.force.toFixed(6)}, импульс=${separated.impulseForce.toFixed(6)}, A0=${separated.A0.toExponential(2)}`);
}
const fine = run(0.1, 0.005, 384, 1024, true);
console.log(`густая пелена LE: F=${fine.force.toFixed(6)}, импульс=${fine.impulseForce.toFixed(6)}, RMS остатка=${fine.residual.toExponential(2)}`);
// Ворота физической правдоподобности: при малом положительном угле
// контрольный профиль не должен получать устойчивую отрицательную силу.
// Разность с импульсной оценкой лишь диагностическая: кинематика следа
// здесь предписана, а не решена из полного локального поля скорости.
if (process.argv.includes('--gate'))
  assert.ok(fine.force > 0,
    `NO-GO: при положительном угле давление даёт F=${fine.force}`);
