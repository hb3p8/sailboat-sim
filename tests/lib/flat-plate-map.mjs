// Независимый контроль непротекания плоской пластины через отображение
// Жуковского z=(2+w+1/w)/4, |w|>1; только тестовая геометрия [0,1].
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, b) => [a[0] * b[0] - a[1] * b[1],
                       a[0] * b[1] + a[1] * b[0]];
const div = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d,
          (a[1] * b[0] - a[0] * b[1]) / d];
};
const abs = a => Math.hypot(...a);
const sqrt = a => {
  const r = abs(a);
  return [Math.sqrt((r + a[0]) / 2),
    Math.sign(a[1] || 1) * Math.sqrt((r - a[0]) / 2)];
};
const one = [1, 0];

function inverse(x, z) {
  const xi = [2 * x - 1, 2 * z];
  const root = sqrt(sub(mul(xi, xi), one));
  const first = add(xi, root), second = sub(xi, root);
  return abs(first) > abs(second) ? first : second;
}

export function mappedPlateVelocity({ flow, vortices = [], x, z,
                                      circulation = 0 }) {
  if (!(z !== 0 || x < 0 || x > 1))
    throw new Error('Отображение: точка на разрезе');
  const w = inverse(x, z);
  const w2 = mul(w, w);
  const a = [flow[0] / 4, -flow[1] / 4];
  let derivative = sub(a, div([a[0], -a[1]], w2));
  derivative = add(derivative,
    div([0, -circulation / (2 * Math.PI)], w));
  for (const vortex of vortices) {
    const v = inverse(vortex.x, vortex.z);
    const image = div(one, [v[0], -v[1]]);
    const factor = [0, -vortex.gamma / (2 * Math.PI)];
    derivative = add(derivative, mul(factor,
      sub(div(one, sub(w, v)), div(one, sub(w, image)))));
  }
  const mapDerivative = mul([0.25, 0], sub(one, div(one, w2)));
  const q = div(derivative, mapDerivative);
  return [q[0], -q[1]];
}

// Скорость центра точечного вихря: собственная сингулярность исключена,
// оставлены его образ и поправка Раута к кривизне отображения.
export function mappedVortexVelocity({ flow, vortices, index,
                                       circulation = 0 }) {
  const vortex = vortices[index];
  if (!vortex) throw new Error('Отображение: неизвестный вихрь');
  const w = inverse(vortex.x, vortex.z), w2 = mul(w, w);
  const a = [flow[0] / 4, -flow[1] / 4];
  let derivative = sub(a, div([a[0], -a[1]], w2));
  derivative = add(derivative,
    div([0, -circulation / (2 * Math.PI)], w));
  for (let k = 0; k < vortices.length; k++) {
    const other = vortices[k], position = inverse(other.x, other.z);
    const image = div(one, [position[0], -position[1]]);
    const factor = [0, -other.gamma / (2 * Math.PI)];
    const imageDerivative = div(one, sub(w, image));
    derivative = add(derivative, mul(factor,
      k === index ? mul([-1, 0], imageDerivative) :
        sub(div(one, sub(w, position)), imageDerivative)));
  }
  const zPrime = mul([0.25, 0], sub(one, div(one, w2)));
  const zSecond = div([0.5, 0], mul(w2, w));
  const selfFactor = [0, -vortex.gamma / (4 * Math.PI)];
  const routh = mul(selfFactor,
    mul([-1, 0], div(zSecond, mul(zPrime, zPrime))));
  const q = add(div(derivative, zPrime), routh);
  return [q[0], -q[1]];
}

export function mappedVortexInvariant(vortex) {
  const w = inverse(vortex.x, vortex.z);
  const zPrime = mul([0.25, 0], sub(one, div(one, mul(w, w))));
  return abs(zPrime) * (abs(w) ** 2 - 1);
}
