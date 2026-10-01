// Независимые работа/инерция многоточечного градиента и известные движения.
import assert from 'node:assert/strict';
import { EnergyMotion } from './lib/cloth-energy-motion.mjs';
import { materialSurface } from './lib/cloth-material.mjs';
import { distance } from './cloth-compliance.mjs';

const close = (a, b, tolerance = 2e-11) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const board = { head: 0, end: 4, nodes: [0, 1, 2, 3, 4], fractions: [0, .25, .5, .75, 1] };
const positions = Float64Array.from([0, 0, 0, .5, 0, 0, 1, 0, 0, 1.5, 0, 0, 2, 0, 0]);
const mass = [1, 2, 3, 4, 5], K = 20, coefficients = [1, -2, 3, -1, 2];
const gamma = coefficients.reduce((sum, g, i) => sum + g * board.fractions[i], 0);
const linear = { alpha: 1 / K, family: 'контроль', unit: 'м', value(p) {
  return { C: coefficients.reduce((sum, g, i) => sum + g * p[3 * i + 1], 0),
    grad: coefficients.map((g, i) => [i, [0, g, 0]]) };
} };
const force = new Float64Array(15); force[7] = 8;
for (const h of [1 / 30, 1 / 120]) for (const passes of [1, 4, 40, 160]) {
  const motion = new EnergyMotion({ positions, mass, fixed: [0], board, constraints: [linear], dampingHz: 0 });
  close(motion.boardMass, 8.125);
  const grad = motion.reduce(linear.value(positions).grad);
  close(grad.find(([i]) => i === 4)[1][1], gamma);
  const measure = motion.step(force, h, passes);
  const expectedY = h * h * 4 / (8.125 + h * h * K * gamma * gamma);
  close(motion.pos[13], expectedY);
  for (let i = 0; i < 5; i++) close(motion.pos[3 * i + 1], board.fractions[i] * expectedY);
  close(measure.appliedWorkJ, 4 * expectedY);
  close(measure.kineticJ, .5 * 8.125 * (expectedY / h) ** 2);
  close(measure.softEnergyJ, .5 * K * (gamma * expectedY) ** 2);
  // При нулевой исходной скорости неявный шаг теряет эту известную энергию.
  // Нулевой силовой остаток не означает точного непрерывного баланса энергии.
  close(measure.discreteEnergyDefectJ, -measure.kineticJ - measure.softEnergyJ);
  close(measure.maxMotionResidualN, 0); close(measure.maxPhysicalResidualN, 0);
}
console.log('ок: известное податливое движение, сумма многоточечных градиентов, работа и эффективная масса');

// Нелинейная геометрия планки: I θ'' + 6 I θ' = 4 L cos θ.
const acceleration = (theta, velocity) => 4 / (8.125 * 2) * Math.cos(theta) - 6 * velocity;
const seconds = .5, dt = 1e-5;
let theta = 0, speed = 0;
for (let step = 0; step < Math.round(seconds / dt); step++) {
  const a1 = acceleration(theta, speed), t2 = theta + .5 * dt * speed, v2 = speed + .5 * dt * a1;
  const a2 = acceleration(t2, v2), t3 = theta + .5 * dt * v2, v3 = speed + .5 * dt * a2;
  const a3 = acceleration(t3, v3), t4 = theta + dt * v3, v4 = speed + dt * a3;
  const a4 = acceleration(t4, v4);
  theta += dt / 6 * (speed + 2 * v2 + 2 * v3 + v4); speed += dt / 6 * (a1 + 2 * a2 + 2 * a3 + a4);
}
let priorError = Infinity;
for (const hz of [60, 120, 240]) {
  const motion = new EnergyMotion({ positions, mass, fixed: [0], board,
    constraints: [distance(0, 4, 2, 0)], dampingHz: 6 });
  for (let step = 0; step < seconds * hz; step++) motion.step(force, 1 / hz, 4);
  const error = Math.abs(Math.atan2(motion.pos[13], motion.pos[12]) - theta);
  assert.ok(error < priorError, 'Движение планки не сходится к независимому уравнению'); priorError = error;
  close(Math.hypot(...motion.pos.slice(12)), 2);
  console.log(`Планка ${hz} Гц: ошибка угла ${error.toExponential(3)} рад`);
}

// Настоящая энергия одного треугольника. Сила F = A(K+G)x(x²−1)/2.
const reference = [0, 0, 0, 1, 0, 0, 0, 1, 0], parameters = { bulkNPerM: 1000, shearNPerM: 50, bendingNm: 0 };
const external = Float64Array.from([0, 0, 0, 10, 0, 0, 0, 0, 0]);
let lo = 1, hi = 2;
for (let i = 0; i < 80; i++) {
  const x = (lo + hi) / 2;
  if (.25 * 1050 * x * (x * x - 1) < 10) lo = x; else hi = x;
}
const expected = (lo + hi) / 2, results = [];
for (const hz of [60, 120, 240]) {
  const surface = materialSurface(reference, [[0, 1, 2]], parameters);
  const motion = new EnergyMotion({ positions: reference, mass: [1, 1, 1], constraints: surface.constraints, fixed: [0, 2] });
  let audit;
  for (let step = 0; step < 5 * hz; step++) audit = motion.step(external, 1 / hz, 40);
  results.push({ hz, x: motion.pos[3], error: Math.abs(motion.pos[3] - expected),
    complianceResidual: Math.max(...Object.values(audit.complianceResiduals).map(g => g.max)), motionResidualN: audit.maxMotionResidualN,
    physicalResidualN: audit.maxPhysicalResidualN });
  close(motion.pos[4], 0); close(motion.pos[5], 0);
}
assert.ok(results[2].error < results[1].error && results[1].error < results[0].error);
console.log(`Треугольник: известное равновесие x=${expected.toFixed(9)} м; ${JSON.stringify(results)}`);

// Непрерывная скорость при смене h и затухание без нагрузки.
const free = new EnergyMotion({ positions: [0, 0, 0], mass: [1], constraints: [], dampingHz: 0 });
free.prev[0] = -2 / 60; free.prevDt = 1 / 60;
for (const h of [1 / 120, 1 / 60, 1 / 120]) { free.step([0, 0, 0], h, 1); close((free.pos[0] - free.prev[0]) / h, 2); }
assert.throws(() => free.step([0, 0, 0], -1, 1), /Некорректные/);
assert.throws(() => new EnergyMotion({ positions, mass, fixed: [], constraints: [linear], board }), /крепление/);
const supported = new EnergyMotion({ positions, mass, fixed: [0], constraints: [linear], board });
supported.pos[0] = .1;
assert.throws(() => supported.step(force, 1 / 60, 40), /Подвижное закрепление/);
console.log('ок: история скорости и ошибочные постановки');
