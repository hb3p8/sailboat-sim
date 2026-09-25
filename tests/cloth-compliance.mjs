// Изолированная проверка податливых связей XPBD до переноса в полотно.
// Числа податливости — модельные, не заявленные свойства ткани SV20.
// Формула: Macklin, Müller, Chentanez (2016), уравнение (18).
const vec = (x, y = 0, z = 0) => [x, y, z];
const distance = (a, b, rest, alpha, unilateral = false) => ({
  alpha, unilateral, lambda: 0,
  value(p) {
    const A = 3 * a, B = 3 * b;
    const d = [p[B] - p[A], p[B + 1] - p[A + 1], p[B + 2] - p[A + 2]];
    const len = Math.hypot(...d);
    if (!(len > 1e-12)) throw new Error('Вырожденная длина связи');
    const u = d.map(x => x / len);
    return { C: len - rest, grad: [[a, u.map(x => -x)], [b, u]] };
  },
});
const shear = (a, b, c, restDot, alpha) => ({
  alpha, unilateral: false, lambda: 0,
  value(p) {
    const A = vec(...p.slice(3 * a, 3 * a + 3));
    const B = vec(...p.slice(3 * b, 3 * b + 3));
    const C = vec(...p.slice(3 * c, 3 * c + 3));
    const e = B.map((x, j) => x - A[j]), f = C.map((x, j) => x - A[j]);
    return { C: e.reduce((s, x, j) => s + x * f[j], 0) - restDot,
      grad: [[a, e.map((x, j) => -x - f[j])], [b, f], [c, e]] };
  },
});
const bend = (a, b, c, restAngle, alpha) => ({
  alpha, unilateral: false, lambda: 0,
  value(p) {
    const A = 3 * a, B = 3 * b, C = 3 * c;
    const ex = p[B] - p[A], ey = p[B + 1] - p[A + 1];
    const fx = p[C] - p[B], fy = p[C + 1] - p[B + 1];
    const e2 = ex * ex + ey * ey, f2 = fx * fx + fy * fy;
    if (!(e2 > 1e-12 && f2 > 1e-12)) throw new Error('Вырожденный изгиб');
    const ge = [ey / e2, -ex / e2, 0];
    const gf = [-fy / f2, fx / f2, 0];
    const angle = Math.atan2(ex * fy - ey * fx, ex * fx + ey * fy);
    return { C: angle - restAngle,
      grad: [[a, ge.map(x => -x)], [b, ge.map((x, j) => x - gf[j])], [c, gf]] };
  },
});

function solveConstraint(p, w, con, h) {
  const { C, grad } = con.value(p), scaled = con.alpha / (h * h);
  let denom = scaled;
  for (const [i, g] of grad) denom += w[i] * g.reduce((s, x) => s + x * x, 0);
  if (!(denom > 0)) return;
  const raw = (-C - scaled * con.lambda) / denom;
  const next = con.unilateral ? Math.min(0, con.lambda + raw) : con.lambda + raw;
  const delta = next - con.lambda;
  con.lambda = next;
  for (const [i, g] of grad) for (let j = 0; j < 3; j++)
    p[3 * i + j] += w[i] * delta * g[j];
}

function simulate({ initial, inverseMass, constraints, external, hz, passes,
                    seconds = 5, damping = 6 }) {
  const p = Float64Array.from(initial), prev = p.slice(), h = 1 / hz;
  const decay = Math.exp(-damping * h), steps = Math.round(seconds * hz);
  let maxConstraint = 0;
  for (let step = 0; step < steps; step++) {
    const old = p.slice();
    for (let i = 0; i < inverseMass.length; i++) {
      if (!inverseMass[i]) continue;
      for (let j = 0; j < 3; j++) {
        const k = 3 * i + j;
        p[k] += decay * (p[k] - prev[k]) + h * h * inverseMass[i] * external[k];
      }
    }
    for (const c of constraints) c.lambda = 0; // множитель только внутри шага
    for (let pass = 0; pass < passes; pass++)
      for (const c of constraints) solveConstraint(p, inverseMass, c, h);
    prev.set(old);
    for (const c of constraints) maxConstraint = Math.max(maxConstraint,
      Math.abs(c.value(p).C + c.alpha * c.lambda / (h * h)));
  }
  return { p, reaction: constraints.map(c => -c.lambda / (h * h)),
    maxConstraint };
}

function scenario(kind) {
  if (kind === 'растяжение') return {
    initial: [0, 0, 0, 1, 0, 0, 2, 0, 0], inverseMass: [0, 1, 1],
    constraints: [distance(0, 1, 1, 0.02, true), distance(1, 2, 1, 0.02, true)],
    external: [0, 0, 0, 0, 0, 0, 5, 0, 0],
    read: r => r.p[6], expected: 2.2,
  };
  if (kind === 'сдвиг') return {
    initial: [0, 0, 0, 1, 0, 0, 0, 1, 0], inverseMass: [0, 0, 1],
    constraints: [shear(0, 1, 2, 0, 0.05)],
    external: [0, 0, 0, 0, 0, 0, 1, 0, 0],
    read: r => r.p[6], expected: 0.05,
  };
  // Равновесие среднего узла при фиксированных соседях:
  // θ=-2 atan(y), dθ/dy=-2/(1+y²), F=-θ(dθ/dy)/α.
  let lo = 0, hi = 0.1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (40 * Math.atan(mid) / (1 + mid * mid) < 1) lo = mid;
    else hi = mid;
  }
  return {
    initial: [-1, 0, 0, 0, 0, 0, 1, 0, 0], inverseMass: [0, 1, 0],
    constraints: [bend(0, 1, 2, 0, 0.1)],
    external: [0, 0, 0, 0, 1, 0, 0, 0, 0],
    read: r => r.p[4], expected: (lo + hi) / 2,
  };
}

for (const kind of ['растяжение', 'сдвиг', 'изгиб']) {
  console.log(`${kind}: модельная податливость, не ткань SV20`);
  const reactionUnit = kind === 'растяжение' ? 'Н' :
    kind === 'сдвиг' ? 'Н/м' : 'Н·м';
  for (const hz of [30, 120]) for (const passes of [1, 4, 16, 64]) {
    const setup = scenario(kind);
    const result = simulate({ ...setup, hz, passes });
    console.log(`  ${hz} Гц / ${passes} проходов: координата ` +
      `${setup.read(result).toFixed(8)} м, ориентир ${setup.expected.toFixed(8)} м, ` +
      `обобщённые реакции ${result.reaction.map(x => x.toFixed(5)).join('/')} ${reactionUnit}, ` +
      `невязка ${result.maxConstraint.toExponential(2)}`);
  }
}

const slack = simulate({
  initial: [0, 0, 0, 1, 0, 0], inverseMass: [0, 1],
  constraints: [distance(0, 1, 1, 0.02, true)],
  external: [0, 0, 0, -5, 0, 0], hz: 120, passes: 16, seconds: 0.1,
});
console.log(`Сжатие односторонней нити: длина ${slack.p[3].toFixed(6)} м, ` +
  `реакция ${slack.reaction[0].toFixed(6)} Н`);
if (!(slack.p[3] < 1 && slack.reaction[0] === 0))
  throw new Error('Односторонняя связь толкает при сжатии');
