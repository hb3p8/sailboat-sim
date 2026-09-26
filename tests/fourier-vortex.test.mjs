// Непрерывная связанная пелена плоской пластины до добавления отрыва.
// node tests/fourier-vortex.test.mjs
import assert from 'node:assert/strict';
import { fourierPlate } from './lib/fourier-vortex.mjs';

const target = Math.PI * 0.1;
let previousError = Infinity;
for (const points of [32, 64, 128, 256, 512]) {
  const p = fourierPlate({ flow: [1, 0.1], points });
  const mirror = fourierPlate({ flow: [1, -0.1], points });
  assert.ok(p.ok && mirror.ok);
  assert.ok(Math.abs(p.circulation + target) < 1e-12);
  assert.ok(Math.abs(p.force + mirror.force) < 1e-12);
  assert.ok(p.downwashError < 1e-12);
  const error = Math.abs(p.force - target);
  assert.ok(error < previousError); previousError = error;
  console.log(`плоская пластина: точки=${points}, F=${p.force.toFixed(9)}, ошибка=${error.toExponential(2)}`);
}

const vortex = { x: 0.2, z: 0.1, gamma: -0.02, core2: 1e-6 };
const errors = [];
for (const modes of [2, 4, 8, 16, 32, 64]) {
  const p = fourierPlate({ flow: [1, 0.1], free: [vortex],
    modes, points: 512 });
  const mirror = fourierPlate({ flow: [1, -0.1],
    free: [{ ...vortex, z: -vortex.z, gamma: -vortex.gamma }],
    modes, points: 512 });
  assert.ok(Math.abs(p.force + mirror.force) < 1e-12);
  assert.ok(Math.abs(p.A0 + mirror.A0) < 1e-12);
  errors.push(p.downwashError);
  console.log(`свободный вихрь: моды=${modes}, A0=${p.A0.toFixed(9)}, F=${p.force.toFixed(9)}, RMS остатка=${p.downwashError.toExponential(2)}`);
}
for (let i = 1; i < errors.length; i++) assert.ok(errors[i] < errors[i - 1]);
assert.ok(errors.at(-1) < 1e-7);

// Независимая проверка нормальной скорости через Био–Савара по связанной
// пелене: экстраполируем к поверхности с двух малых положительных высот.
function boundVz(p, x, z) {
  let sum = 0;
  const n = p.x.length;
  for (let k = 0; k < n; k++) {
    const left = (1 - Math.cos(Math.PI * k / n)) / 2;
    const right = (1 - Math.cos(Math.PI * (k + 1) / n)) / 2;
    const dx = x - p.x[k];
    sum += p.gamma[k] * (right - left) * dx /
      (2 * Math.PI * (dx * dx + z * z));
  }
  return sum;
}
for (const free of [[], [vortex]]) {
  const p = fourierPlate({ flow: [1, 0.1], free, modes: 64,
    points: 4096 });
  let maxLeak = 0;
  for (const x of [0.1, 0.2, 0.5, 0.8, 0.9]) {
    let external = 0.1;
    for (const v of free) {
      const dx = x - v.x;
      external += v.gamma * dx /
        (2 * Math.PI * (dx * dx + v.z * v.z + v.core2));
    }
    const atSurface = 2 * boundVz(p, x, 0.0005) -
      boundVz(p, x, 0.001);
    maxLeak = Math.max(maxLeak, Math.abs(external + atSurface));
  }
  assert.ok(maxLeak < 2e-6, `протекание ${maxLeak}`);
  console.log(`Био–Савар, свободных=${free.length}: максимальное протекание ${maxLeak.toExponential(2)}`);
}
