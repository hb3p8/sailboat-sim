// Энергия проверяется по известной деформации, работе и силам, не по силуэту.
import assert from 'node:assert/strict';
import { gridTriangles, materialSurface, MODEL_MATERIAL } from './lib/cloth-material.mjs';

const close = (a, b, tol = 3e-10) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)),
  `${a} != ${b}`);
const dot = (a, b) => a.reduce((s, x, k) => s + x * b[k], 0);
const rotate = ([x, y, z]) => {
  const c = Math.cos(.73), s = Math.sin(.73), q = Math.cos(-.41), t = Math.sin(-.41);
  return [q * (c * x - s * y) + t * z, s * x + c * y, -t * (c * x - s * y) + q * z];
};
const transform = (p, fn) => Float64Array.from(Array.from({ length: p.length / 3 }, (_, i) =>
  fn(Array.from(p.slice(3 * i, 3 * i + 3)))).flat());
function rectangle(rows, cols) {
  return Float64Array.from(Array.from({ length: rows * cols }, (_, i) =>
    [2 * (i % cols) / (cols - 1), Math.floor(i / cols) / (rows - 1), 0]).flat());
}

// Независимая формула для аффинного F в исходных осях прямоугольника 2×1 м.
const parameters = { ...MODEL_MATERIAL, bendingNm: 0 };
for (const F of [[1.07, 0, 0, 1], [1, .2, 0, 1], [1.03, 0, 0, 1.03], [.98, 0, 0, 1.01],
  [1.02, -.08, .12, .99]]) {
  const [a, b, c, d] = F, E11 = .5 * (a * a + c * c - 1), E22 = .5 * (b * b + d * d - 1);
  const E12 = .5 * (a * b + c * d);
  const expected = 2 * (.5 * parameters.bulkNPerM * (E11 + E22) ** 2
    + .5 * parameters.shearNPerM * (E11 - E22) ** 2 + 2 * parameters.shearNPerM * E12 ** 2);
  for (const [rows, cols] of [[3, 5], [9, 17], [17, 33]]) for (const opposite of [false, true]) {
    const reference = rectangle(rows, cols), tris = gridTriangles(rows, cols, opposite);
    const current = transform(reference, ([x, y]) => [a * x + b * y, c * x + d * y, 0]);
    for (const cyclic of [false, true]) {
      const topology = cyclic ? tris.map(([x, y, z]) => [y, z, x]) : tris;
      for (const moved of [false, true]) {
        const place = p => moved ? transform(p, v => rotate(v).map((x, k) => x + [2, -7, 3][k])) : p;
        const model = materialSurface(place(reference), topology, parameters);
        close(model.areaM2, 2); close(model.evaluate(place(current)).membraneJ, expected);
      }
    }
  }
}
console.log('ок: известные растяжение, перекос и сжатие; вложенные сетки, диагонали, базисы и повороты');

// Кривой участок: аналитический градиент общей энергии сверяется с разностью энергий.
const rows = 4, cols = 5, flat = rectangle(rows, cols), tris = gridTriangles(rows, cols);
const reference = transform(flat, ([x, y]) => [x, y, .12 * Math.sin(1.7 * x) * Math.sin(2.1 * y)]);
const current = transform(reference, ([x, y, z]) => [1.04 * x + .03 * y, .98 * y, z + .04 * x * y]);
const options = { bendingModel: 'curvature', rows, cols };
const model = materialSurface(reference, tris, MODEL_MATERIAL, options);
const result = model.evaluate(current, true), gradient = result.gradientJPerM;
let maxGradientError = 0;
for (let k = 0; k < current.length; k++) {
  const eps = 1e-6, plus = current.slice(), minus = current.slice(); plus[k] += eps; minus[k] -= eps;
  const numerical = (model.evaluate(plus).totalJ - model.evaluate(minus).totalJ) / (2 * eps);
  const error = Math.abs(gradient[k] - numerical) / Math.max(1, Math.abs(gradient[k]));
  assert.ok(error < 2e-7, `Градиент ${k}: ${gradient[k]} / ${numerical}`);
  maxGradientError = Math.max(maxGradientError, error);
}
const force = [0, 0, 0], torque = [0, 0, 0];
for (let i = 0; i < current.length / 3; i++) {
  const x = current.slice(3 * i, 3 * i + 3), g = gradient.slice(3 * i, 3 * i + 3);
  for (let d = 0; d < 3; d++) force[d] -= g[d];
  torque[0] -= x[1] * g[2] - x[2] * g[1];
  torque[1] -= x[2] * g[0] - x[0] * g[2];
  torque[2] -= x[0] * g[1] - x[1] * g[0];
}
force.forEach(x => close(x, 0)); torque.forEach(x => close(x, 0));
const rigid = transform(reference, v => rotate(v).map((x, k) => x + [2, -7, 3][k]));
const zero = model.evaluate(rigid, true);
close(zero.totalJ, 0); zero.gradientJPerM.forEach(x => close(x, 0));
const rotatedModel = materialSurface(rigid, tris, MODEL_MATERIAL, options);
const rotatedCurrent = transform(current, v => rotate(v).map((x, k) => x + [2, -7, 3][k]));
const rotatedResult = rotatedModel.evaluate(rotatedCurrent, true);
close(rotatedResult.totalJ, result.totalJ);
const expectedGradient = transform(gradient, rotate);
expectedGradient.forEach((x, k) => close(x, rotatedResult.gradientJPerM[k]));
// Зеркало должно изменить знак угла, сохранив энергию и исходный крой.
const mirror = p => transform(p, ([x, y, z]) => [x, -y, z]);
close(materialSurface(mirror(reference), tris, MODEL_MATERIAL, options).evaluate(mirror(current)).totalJ, result.totalJ);
const displacement = Float64Array.from(current, (_, k) => Math.sin(k * .71) * 1e-6);
const plus = Float64Array.from(current, (x, k) => x + displacement[k]);
const minus = Float64Array.from(current, (x, k) => x - displacement[k]);
close(.5 * (model.evaluate(plus).totalJ - model.evaluate(minus).totalJ), dot(gradient, displacement), 2e-11);
console.log(`ок: работа, нулевая сумма внутренних сил/моментов, зеркало; ошибка градиента ${maxGradientError.toExponential(3)}`);

// Единицы: масштаб в метрах меняет энергию растяжения как s², изгиба как s⁰.
for (const scale of [.3, 4]) {
  const scaled = p => Float64Array.from(p, x => scale * x);
  const value = materialSurface(scaled(reference), tris, MODEL_MATERIAL, options).evaluate(scaled(current));
  close(value.membraneJ, result.membraneJ * scale * scale); close(value.bendingJ, result.bendingJ);
}
const double = materialSurface(reference, tris, { ...MODEL_MATERIAL,
  bulkNPerM: 2000, shearNPerM: 100, bendingNm: 2 }, options).evaluate(current);
close(double.totalJ, 2 * result.totalJ);
let constraintEnergy = 0;
for (const con of model.constraints) constraintEnergy += .5 * con.value(current).C ** 2 / con.alpha;
close(constraintEnergy, result.totalJ);
console.log('ок: размерности и единая энергия для сил и податливых ограничений');

// Один шарнир: площадь каждой грани 1/2 м², общее ребро 1 м, вес ровно 3.
const hingeReference = Float64Array.from([0, 1, 0, 0, 0, 0, 1, 0, 0, 1, -1, 0]);
const hingeSurface = materialSurface(hingeReference, [[0, 1, 2], [3, 2, 1]], MODEL_MATERIAL, { bendingModel: 'hinge' });
for (const angle of [-.7, .3]) {
  const p = hingeReference.slice(); p[10] = -Math.cos(angle); p[11] = Math.sin(angle);
  const e = hingeSurface.evaluate(p);
  close(e.membraneJ, 0); close(e.bendingJ, 1.5 * angle * angle);
}
assert.throws(() => materialSurface(reference, tris, { ...MODEL_MATERIAL, bulkNPerM: -1 }));
assert.throws(() => materialSurface([0, 0, 0, 1, 0, 0, 2, 0, 0], [[0, 1, 2]], parameters), /Вырожденный/);
assert.throws(() => materialSurface(reference, [...tris, tris[0]], parameters), /Повторный/);
assert.throws(() => materialSurface(reference, [tris[0], [tris[1][0], tris[1][2], tris[1][1]]], parameters), /ориентация/);
assert.throws(() => materialSurface(reference, tris), /явно выбрать/);
assert.throws(() => model.evaluate(current.slice(3)), /координаты/);
const nonfinite = current.slice(); nonfinite[2] = NaN;
assert.throws(() => model.evaluate(nonfinite), /координаты/);
console.log('ок: известный угол изгиба; ошибочные параметры, топология и координаты отклонены');

// Другие известные изгибы: смена радиуса исходного цилиндра и смешанная кривизна.
// Здесь сверяем интеграл, а не формулу одного узла или форму нового решателя.
const curvedErrors = [], twistErrors = [], kappa = .17;
let twistReferenceJ = 0;
// Независимая квадратура серединами прямоугольников для z=κxy:
// |Δb|²=2κ²/(1+κ²(x²+y²)), исходная площадь=2 м².
const integrationN = 800;
for (let r = 0; r < integrationN; r++) for (let c = 0; c < integrationN; c++) {
  const x = 2 * (c + .5) / integrationN, y = (r + .5) / integrationN;
  twistReferenceJ += 2 / (integrationN * integrationN) * kappa * kappa / (1 + kappa * kappa * (x * x + y * y));
}
for (const n of [9, 17, 33]) {
  const rows = n, cols = 2 * n - 1, ref = rectangle(rows, cols), topology = gridTriangles(rows, cols);
  const cylinder = radius => transform(ref, ([x, y]) =>
    [radius * Math.sin(x / radius), y, radius * (1 - Math.cos(x / radius))]);
  const material = materialSurface(cylinder(3), topology, MODEL_MATERIAL, { bendingModel: 'curvature', rows, cols });
  const expected = .5 * 2 * (1 / 4 - 1 / 3) ** 2;
  curvedErrors.push(Math.abs(material.evaluate(cylinder(4)).bendingJ / expected - 1));
  const twist = transform(ref, ([x, y]) => [x, y, kappa * x * y]);
  const value = materialSurface(ref, topology, MODEL_MATERIAL, { bendingModel: 'curvature', rows, cols }).evaluate(twist);
  twistErrors.push(Math.abs(value.bendingJ / twistReferenceJ - 1));
}
for (const errors of [curvedErrors, twistErrors]) {
  assert.ok(errors[2] < errors[1] && errors[1] < errors[0], 'Энергия известного изгиба не сходится');
  assert.ok(errors[2] < .001, 'Энергия известного изгиба не приблизилась к опоре');
}
console.log(`ок: исходный цилиндр и смешанный изгиб; конечные ошибки ${curvedErrors[2].toExponential(3)}/${twistErrors[2].toExponential(3)}`);
