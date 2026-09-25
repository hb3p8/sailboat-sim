// Жёсткое движение не должно создавать работу внутренних связей ткани.
import { area3d, dihedral, dihedralAngle, shear } from './cloth-compliance.mjs';

const p = Float64Array.from([
  0, 0, 0,
  1, 0, 0.05,
  0, 1, -0.02,
  1, 1, 0.20,
]);
const A = area3d(0, 1, 2, 0.9, 0.01);
const S = shear(0, 1, 2, -0.1, 0.01);
const D = dihedral(0, 1, 2, 3, 0, 0.1);
const constraints = [['площадь', A], ['сдвиг', S], ['двугранный изгиб', D]];
const rotate = v => {
  const ax = 0.43, az = -0.71;
  const [x, y, z] = v;
  const yy = Math.cos(ax) * y - Math.sin(ax) * z;
  const zz = Math.sin(ax) * y + Math.cos(ax) * z;
  return [Math.cos(az) * x - Math.sin(az) * yy,
    Math.sin(az) * x + Math.cos(az) * yy, zz];
};
const moved = p.slice();
for (let i = 0; i < 4; i++) {
  const v = rotate(Array.from(p.subarray(3 * i, 3 * i + 3)));
  for (let j = 0; j < 3; j++) moved[3 * i + j] = v[j] + [2, -3, 1][j];
}
let worstValue = 0, worstGradient = 0, worstForce = 0, worstTorque = 0;
for (const [name, con] of constraints) {
  const before = con.value(p), after = con.value(moved);
  worstValue = Math.max(worstValue, Math.abs(after.C - before.C));
  const force = [0, 0, 0], torque = [0, 0, 0];
  for (let k = 0; k < before.grad.length; k++) {
    const [i, g] = before.grad[k], rotated = rotate(g);
    const [other, mg] = after.grad[k];
    if (i !== other) throw new Error('Порядок градиентов изменился');
    for (let j = 0; j < 3; j++) {
      worstGradient = Math.max(worstGradient, Math.abs(rotated[j] - mg[j]));
      force[j] += g[j];
    }
    const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2];
    torque[0] += y * g[2] - z * g[1];
    torque[1] += z * g[0] - x * g[2];
    torque[2] += x * g[1] - y * g[0];
  }
  worstForce = Math.max(worstForce, Math.hypot(...force));
  worstTorque = Math.max(worstTorque, Math.hypot(...torque));
  console.log(`${name}: C=${before.C.toFixed(8)}, после движения ` +
    `${after.C.toFixed(8)}; Σ∇C ${Math.hypot(...force).toExponential(2)}, ` +
    `Σr×∇C ${Math.hypot(...torque).toExponential(2)}`);
}

const area = A.value(p);
let worstAreaDerivative = 0;
for (const [i, g] of area.grad) for (let j = 0; j < 3; j++) {
  const q = p.slice(), eps = 1e-6;
  q[3 * i + j] += eps;
  const plus = A.value(q).C;
  q[3 * i + j] -= 2 * eps;
  const minus = A.value(q).C;
  worstAreaDerivative = Math.max(worstAreaDerivative,
    Math.abs((plus - minus) / (2 * eps) - g[j]));
}
console.log(`Остатки: C ${worstValue.toExponential(2)}, поворот ∇C ` +
  `${worstGradient.toExponential(2)}, сумма сил ${worstForce.toExponential(2)}, ` +
  `сумма моментов ${worstTorque.toExponential(2)}, ` +
  `градиент площади ${worstAreaDerivative.toExponential(2)}`);
console.log(`Двугранный угол ${(180 * dihedralAngle(p, 0, 1, 2, 3) / Math.PI).toFixed(5)}°`);
if (worstValue > 1e-10 || worstGradient > 1e-6 || worstForce > 1e-6 ||
    worstTorque > 1e-6 || worstAreaDerivative > 1e-6)
  throw new Error('Внутренняя связь зависит от жёсткого движения');
