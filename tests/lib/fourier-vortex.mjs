// Контрольная непрерывная пелена тонкого профиля на единичной плоской пластине.
// Только изолированный опыт: здесь нет схода, памяти и силы штатной лодки.
const PI2 = 2 * Math.PI;

function induced(vortex, x, z) {
  const dx = x - vortex.x, dz = z - vortex.z;
  const k = vortex.gamma / (PI2 *
    (dx * dx + dz * dz + (vortex.core2 ?? 0)));
  return [-k * dz, k * dx];
}

export function fourierPlate({ flow, free = [], modes = 8,
                               points = 256 }) {
  if (!Array.isArray(flow) || flow.length !== 2 ||
      !flow.every(Number.isFinite) || !(flow[0] > 0) ||
      !Number.isInteger(modes) || modes < 1 || modes >= points / 2 ||
      !Number.isInteger(points) || points < 32 || points > 4096)
    throw new Error('Непрерывная пелена: некорректный поток или разрешение');
  const atEdge = [...flow];
  for (const vortex of free) {
    const v = induced(vortex, 0, 0);
    atEdge[0] += v[0]; atEdge[1] += v[1];
  }
  const vmag = Math.hypot(...atEdge);
  if (!(vmag > 0)) return { ok: false, reason: 'zero-leading-edge-speed' };
  const theta = [], x = [], incoming = [], tangential = [];
  for (let k = 0; k < points; k++) {
    const t = Math.PI * (k + 0.5) / points;
    const xi = (1 - Math.cos(t)) / 2;
    let ux = flow[0], uz = flow[1];
    for (const vortex of free) {
      const v = induced(vortex, xi, 0);
      ux += v[0]; uz += v[1];
    }
    theta.push(t); x.push(xi);
    incoming.push(uz); tangential.push(ux);
  }
  const average = a => a.reduce((s, v) => s + v, 0) / points;
  const A0 = average(incoming) / vmag;
  const An = Array.from({ length: modes }, (_, j) =>
    -2 * average(incoming.map((w, k) => w * Math.cos((j + 1) * theta[k]))) / vmag);
  const gamma = [], pressure = [], reconstructed = [];
  for (let k = 0; k < points; k++) {
    let g = A0 * (1 + Math.cos(theta[k])) / Math.sin(theta[k]);
    let w = -vmag * A0;
    for (let j = 0; j < modes; j++) {
      g += An[j] * Math.sin((j + 1) * theta[k]);
      w += vmag * An[j] * Math.cos((j + 1) * theta[k]);
    }
    gamma.push(-2 * vmag * g);
    pressure.push(-tangential[k] * gamma[k]);
    reconstructed.push(w);
  }
  const edges = Array.from({ length: points + 1 }, (_, i) =>
    (1 - Math.cos(Math.PI * i / points)) / 2);
  let force = 0;
  for (let k = 0; k < points; k++)
    force += pressure[k] * (edges[k + 1] - edges[k]);
  const circulation = -Math.PI * vmag * (A0 + An[0] / 2);
  const downwashError = Math.sqrt(average(incoming.map((w, k) =>
    (w + reconstructed[k]) ** 2)));
  return { ok: true, A0, An, force, circulation, pressure,
    gamma, x, edges, incoming, reconstructed, downwashError };
}

export function fourierWakeStep({ flow, dt, state = null,
                                  modes = 32, points = 512 }) {
  if (!(dt > 0) || (state && (state.points !== points ||
      state.modes !== modes || !Array.isArray(state.free) ||
      !Array.isArray(state.cumulative))))
    throw new Error('След Фурье: некорректный шаг или состояние');
  const old = state ? state.free.map(v => ({ ...v,
    x: v.x + flow[0] * dt, z: v.z + flow[1] * dt })) : [];
  const newVortex = { x: 1 + flow[0] * dt / 2,
    z: flow[1] * dt / 2, gamma: 0 };
  const baseline = fourierPlate({ flow, free: [...old, newVortex],
    modes, points });
  const unit = fourierPlate({ flow, free: [...old,
    { ...newVortex, gamma: 1 }], modes, points });
  if (!baseline.ok || !unit.ok) return { ok: false, reason: 'plate' };
  const response = unit.circulation - baseline.circulation;
  const denominator = 1 + response;
  if (Math.abs(denominator) < 1e-10)
    return { ok: false, reason: 'kelvin-singular' };
  newVortex.gamma = (-old.reduce((s, v) => s + v.gamma, 0) -
    baseline.circulation) / denominator;
  const plate = fourierPlate({ flow, free: [...old, newVortex],
    modes, points });
  if (!plate.ok) return plate;
  const cumulative = [], pressure = [];
  let running = 0, unsteadyForce = 0, force = 0;
  for (let i = 0; i < points; i++) {
    const width = plate.edges[i + 1] - plate.edges[i];
    const half = running + plate.gamma[i] * width / 2;
    const previous = state ? state.cumulative[i] : 0;
    const unsteady = -(half - previous) / dt;
    pressure.push(plate.pressure[i] + unsteady);
    unsteadyForce += unsteady * width;
    force += pressure[i] * width;
    cumulative.push(half);
    running += plate.gamma[i] * width;
  }
  const free = [...old, newVortex];
  return { ok: true, pressure, edges: plate.edges, force,
    circulatoryForce: plate.force, unsteadyForce,
    A0: plate.A0, residual: plate.downwashError,
    kelvin: plate.circulation + free.reduce((s, v) => s + v.gamma, 0),
    tev: newVortex,
    state: { points, modes, free, cumulative } };
}
