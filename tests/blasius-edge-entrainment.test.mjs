// Каноническая ПС-проверка, не модель генакера. Уравнения подобия
// f''' + f f''/2 = 0, u/U=f'(eta), eta=y sqrt(U/(nu x)).
// Поток вовлечения через границу 99% сравнивается с (27) DeVoria–Mohseni.
import assert from 'node:assert/strict';

function derivative([f, fp, fpp]) {
  return [fp, fpp, -.5 * f * fpp];
}

function addScaled(state, increment, scale) {
  return state.map((value, index) => value + scale * increment[index]);
}

function integrate(wallCurvature, step = .005, etaMax = 12) {
  const count = Math.round(etaMax / step);
  let state = [0, 0, wallCurvature];
  let eta99 = null;
  let f99 = null;
  for (let i = 0; i < count; i++) {
    const k1 = derivative(state);
    const k2 = derivative(addScaled(state, k1, step / 2));
    const k3 = derivative(addScaled(state, k2, step / 2));
    const k4 = derivative(addScaled(state, k3, step));
    const next = state.map((value, index) => value + step / 6 *
      (k1[index] + 2 * k2[index] + 2 * k3[index] + k4[index]));
    if (eta99 === null && state[1] <= .99 && next[1] >= .99) {
      const fraction = (.99 - state[1]) / (next[1] - state[1]);
      eta99 = (i + fraction) * step;
      f99 = state[0] + fraction * (next[0] - state[0]);
    }
    state = next;
  }
  return { endVelocity: state[1], eta99, f99 };
}

let low = .3, high = .36;
for (let i = 0; i < 38; i++) {
  const middle = (low + high) / 2;
  if (integrate(middle).endVelocity < 1) low = middle;
  else high = middle;
}
const wallCurvature = (low + high) / 2;
const { endVelocity, eta99, f99 } = integrate(wallCurvature);
const refined = integrate(wallCurvature, .0025);
assert.ok(Math.abs(endVelocity - 1) < 1e-11);
assert.ok(Math.abs(wallCurvature - .332057336) < 3e-7);
assert.ok(eta99 > 4.8 && eta99 < 5.1);
assert.ok(Math.abs(eta99 - refined.eta99) < 2e-6);

// v/U = (eta*f' - f)/(2 sqrt(Re_x)) on the 99% boundary.
const thicknessCoefficient = eta99;
const normalVelocityCoefficient = (.99 * eta99 - f99) / 2;
const entrainmentCoefficient = thicknessCoefficient / 2 -
  normalVelocityCoefficient;
assert.ok(entrainmentCoefficient > 1.5 && entrainmentCoefficient < 2);

// Формула (27), q/U = c_q / sqrt((c_delta/2)^2 + Re_x),
// rho_s = rho delta99; здесь rho=U=chord=1. Формальное продолжение
// подобия к x=0 не физично: сама исходная работа запрещает этот предел.
const reynolds = 1e5;
const halfThicknessCoefficient = thicknessCoefficient / 2;
const cellWidths = [1 / 128, 1 / 512, 1 / 2048];
const cells = cellWidths.map(width => ({
  width,
  localReynolds: reynolds * width,
  boundaryMass: thicknessCoefficient * Math.sqrt(width / reynolds),
  formalEntrainedFlux: 2 * entrainmentCoefficient / reynolds *
    (Math.sqrt(halfThicknessCoefficient ** 2 + reynolds * width) -
      halfThicknessCoefficient),
}));
for (let i = 1; i < cells.length; i++) {
  assert.ok(Math.abs(cells[i].boundaryMass /
    cells[i - 1].boundaryMass - .5) < 1e-12);
  assert.ok(cells[i].formalEntrainedFlux <
    cells[i - 1].formalEntrainedFlux);
}
assert.ok(cells.every(cell => Math.sqrt(cell.localReynolds) >
  halfThicknessCoefficient));

console.log(JSON.stringify({ wallCurvature, eta99, f99,
  normalVelocityCoefficient, entrainmentCoefficient, cells }, null, 2));
