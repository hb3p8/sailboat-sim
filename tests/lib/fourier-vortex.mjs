// Контрольная непрерывная пелена тонкого профиля на единичной плоской пластине.
// Только изолированный опыт: здесь пока плоская пластина и нет силы лодки.
import { mappedVortexVelocity } from './flat-plate-map.mjs';
const PI2 = 2 * Math.PI;

function induced(vortex, x, z) {
  const dx = x - vortex.x, dz = z - vortex.z;
  const r2 = dx * dx + dz * dz;
  const denominator = vortex.coreRadius ?
    Math.sqrt(r2 * r2 + vortex.coreRadius ** 4) :
    r2 + (vortex.core2 ?? 0);
  const k = vortex.gamma / (PI2 * denominator);
  return [-k * dz, k * dx];
}

// Интеграл Био–Савара по прямому отрезку свободной пелены с
// постоянной циркуляцией на единицу длины, не точечная квадратура.
export function inducedSegment(sheet, x, z, core2 = 0) {
  const [ax, az] = sheet.a, [bx, bz] = sheet.b;
  const length = Math.hypot(bx - ax, bz - az);
  if (!(length > 0)) throw new Error('Свободная пелена: нулевой отрезок');
  const tx = (bx - ax) / length, tz = (bz - az) / length;
  const nx = -tz, nz = tx;
  const s = (x - ax) * tx + (z - az) * tz;
  const h = (x - ax) * nx + (z - az) * nz;
  if (h === 0 && s > 0 && s < length && core2 === 0)
    throw new Error('Свободная пелена: точка на вихревом слое');
  const density = sheet.gamma / length;
  const hEffective = Math.sqrt(h * h + core2);
  const along = core2 ? -density / PI2 * h / hEffective *
    (Math.atan((length - s) / hEffective) -
     Math.atan(-s / hEffective)) : -density / PI2 *
    (Math.atan((length - s) / h) - Math.atan(-s / h));
  const across = density / (2 * PI2) *
    Math.log((s * s + hEffective * hEffective) /
      ((s - length) ** 2 + hEffective * hEffective));
  return [along * tx + across * nx,
          along * tz + across * nz];
}

// Точный интеграл регуляризованного Био–Савара для движения узлов
// свободного слоя. Радиус ядра растёт с вязким временем жизни отрезка.
function sheetNodeVelocity(sheets, plate, flow, reynolds, dt, x, z) {
  const bound = boundVelocity(plate, x, z);
  let ux = flow[0] + bound[0], uz = flow[1] + bound[1];
  const nu = Math.hypot(...flow) / reynolds;
  for (const sheet of sheets) {
    const core2 = sheet.core2 ??
      4 * nu * Math.max(sheet.age ?? 0, dt / 2);
    const v = inducedSegment(sheet, x, z, core2);
    ux += v[0]; uz += v[1];
  }
  return [ux, uz];
}

function movedSheets(sheets, velocity, h) {
  return sheets.map((sheet, i) => ({ ...sheet,
    a: [sheet.a[0] + velocity[i].a[0] * h,
      sheet.a[1] + velocity[i].a[1] * h],
    b: [sheet.b[0] + velocity[i].b[0] * h,
      sheet.b[1] + velocity[i].b[1] * h] }));
}

function advectSheets(sheets, flow, dt, modes, points, reynolds,
                      substeps) {
  const nu = Math.hypot(...flow) / reynolds;
  const aged = (items, elapsed) => items.map(sheet => ({ ...sheet,
    age: (sheet.age ?? 0) + elapsed,
    core2: 4 * nu * Math.max((sheet.age ?? 0) + elapsed, dt / 2) }));
  let current = aged(sheets.map(sheet => ({ ...sheet,
    a: [...sheet.a], b: [...sheet.b] })), 0);
  const h = dt / substeps;
  const velocities = (positions) => {
    const plate = fourierPlate({ flow, sheets: positions, modes, points });
    if (!plate.ok) return null;
    return positions.map(sheet => ({
      a: sheetNodeVelocity(positions, plate, flow, reynolds, dt,
        ...sheet.a),
      b: sheetNodeVelocity(positions, plate, flow, reynolds, dt,
        ...sheet.b) }));
  };
  for (let substep = 0; substep < substeps; substep++) {
    const first = velocities(current);
    if (!first) return { ok: false, reason: 'advection-plate' };
    const midpoint = aged(movedSheets(current, first, h / 2), h / 2);
    const second = velocities(midpoint);
    if (!second) return { ok: false, reason: 'advection-midpoint' };
    const next = aged(movedSheets(current, second, h), h);
    for (let index = 0; index < next.length; index++) {
      const sheet = next[index];
      for (const p of [sheet.a, sheet.b]) {
        if (!p.every(Number.isFinite))
          return { ok: false, reason: 'sheet-nonfinite',
            index, edge: sheet.edge, substep: substep + 1 };
        if (p[0] > 0 && p[0] < 1 &&
            p[1] * Math.sign(flow[1] || 1) <= 0)
          return { ok: false, reason: 'sheet-crossed-plate',
            index, edge: sheet.edge, substep: substep + 1,
            position: p };
      }
    }
    current = next;
  }
  return { ok: true, sheets: current };
}

// Точный интеграл Био–Савара для постоянной плотности на каждом отрезке.
export function boundVelocity(state, x, z) {
  // В крайних точках кусочно-постоянная квадратура даёт ложную
  // логарифмическую особенность. Предел ряда Фурье при A0=0 на LE
  // и всегда на TE интегрируется точно по каждой синусной моде.
  if (z === 0 && (x === 0 || x === 1) &&
      Number.isFinite(state.edgeSpeed) && Array.isArray(state.An)) {
    if (x === 0 && Math.abs(state.A0) > 1e-8)
      return [0, NaN]; // Настоящий сингулярный LE-предел.
    const modes = state.An.reduce((sum, coefficient, i) =>
      sum + coefficient * (x === 0 ? 1 : (-1) ** (i + 1)), 0);
    return [0, state.edgeSpeed * (modes - (x === 1 ? state.A0 : 0))];
  }
  let ux = 0, uz = 0;
  for (let i = 0; i < state.gamma.length; i++) {
    const a = state.edges[i], b = state.edges[i + 1];
    const g = state.gamma[i] / PI2;
    ux -= g * (Math.atan((b - x) / z) - Math.atan((a - x) / z));
    uz += g / 2 * Math.log(((x - a) ** 2 + z * z) /
      ((x - b) ** 2 + z * z));
  }
  return [ux, uz];
}

function advectFree(free, state, flow, dt, substeps, mapped) {
  const velocity = (positions, i) => {
    if (mapped) return mappedVortexVelocity({ flow,
      vortices: positions, index: i });
    const p = positions[i];
    let ux = flow[0], uz = flow[1];
    const bound = boundVelocity(state, p.x, p.z);
    ux += bound[0]; uz += bound[1];
    for (let j = 0; j < positions.length; j++) {
      if (j === i) continue;
      const v = induced(positions[j], p.x, p.z);
      ux += v[0]; uz += v[1];
    }
    return [ux, uz];
  };
  let start = free.map(v => ({ ...v }));
  const h = dt / substeps;
  for (let step = 0; step < substeps; step++) {
    const first = start.map((_, i) => velocity(start, i));
    const mid = start.map((v, i) => ({ ...v,
      x: v.x + first[i][0] * h / 2,
      z: v.z + first[i][1] * h / 2 }));
    const second = mid.map((_, i) => velocity(mid, i));
    const next = start.map((v, i) => ({ ...v,
      x: v.x + second[i][0] * h,
      z: v.z + second[i][1] * h }));
    for (let i = 0; i < next.length; i++) {
      if (!Number.isFinite(next[i].x) || !Number.isFinite(next[i].z))
        return { ok: false, reason: 'vortex-nonfinite',
          index: i, substep: step + 1 };
      if (start[i].z * next[i].z < 0 &&
          (start[i].x > 0 && start[i].x < 1 ||
           next[i].x > 0 && next[i].x < 1))
        return { ok: false, reason: 'vortex-crossed-plate',
          index: i, substep: step + 1 };
    }
    start = next;
  }
  return { ok: true, free: start };
}

export function fourierPlate({ flow, free = [], sheets = [], modes = 8,
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
  for (const sheet of sheets) {
    const v = inducedSegment(sheet, 0, 0, sheet.core2 ?? 0);
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
    for (const sheet of sheets) {
      const v = inducedSegment(sheet, xi, 0, sheet.core2 ?? 0);
      ux += v[0]; uz += v[1];
    }
    theta.push(t); x.push(xi);
    incoming.push(uz); tangential.push(ux);
  }
  const average = a => a.reduce((s, v) => s + v, 0) / points;
  const A0 = average(incoming) / vmag;
  const suctionNumerator = average(incoming);
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
  return { ok: true, A0, suctionNumerator, An, edgeSpeed: vmag,
    force, circulation, pressure,
    gamma, x, edges, incoming, reconstructed, downwashError };
}

function unsteadyPressure(plate, previous, dt) {
  const cumulative = [], pressure = [];
  let running = 0, unsteadyForce = 0, force = 0;
  for (let i = 0; i < plate.gamma.length; i++) {
    const width = plate.edges[i + 1] - plate.edges[i];
    const half = running + plate.gamma[i] * width / 2;
    const unsteady = -(half - (previous ? previous[i] : 0)) / dt;
    pressure.push(plate.pressure[i] + unsteady);
    unsteadyForce += unsteady * width;
    force += pressure[i] * width;
    cumulative.push(half);
    running += plate.gamma[i] * width;
  }
  return { cumulative, pressure, force, unsteadyForce };
}

function solveEdgeStrengths(baseline, leadingUnit, trailingUnit, oldGamma,
                            suctionNumeratorTarget = 0) {
  const a = leadingUnit.suctionNumerator - baseline.suctionNumerator;
  const b = trailingUnit.suctionNumerator - baseline.suctionNumerator;
  const c = 1 + leadingUnit.circulation - baseline.circulation;
  const d = 1 + trailingUnit.circulation - baseline.circulation;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-10) return null;
  const rhsA = suctionNumeratorTarget - baseline.suctionNumerator;
  const rhsK = -oldGamma - baseline.circulation;
  return [(rhsA * d - b * rhsK) / determinant,
          (a * rhsK - rhsA * c) / determinant];
}

export function fourierWakeStep({ flow, dt, state = null,
                                  modes = 32, points = 512,
                                  shedLeadingEdge = false,
                                  advection = 'uniform',
                                  advectionSubsteps = 1,
                                  placement = 'half-flow',
                                  reynolds = Infinity }) {
  if (!(dt > 0) || (state && (state.points !== points ||
      state.modes !== modes ||
      state.shedLeadingEdge !== shedLeadingEdge ||
      state.advection !== advection ||
      state.advectionSubsteps !== advectionSubsteps ||
      state.placement !== placement ||
      state.reynolds !== reynolds ||
      !Array.isArray(state.free) ||
      (advection === 'induced' &&
        (!Array.isArray(state.gamma) || !Array.isArray(state.edges))) ||
      !Array.isArray(state.cumulative))) ||
      !['uniform', 'induced', 'mapped'].includes(advection) ||
      !['half-flow', 'previous-third'].includes(placement) ||
      !(reynolds === Infinity || Number.isFinite(reynolds) && reynolds > 0) ||
      (advection === 'mapped' && reynolds !== Infinity) ||
      !Number.isInteger(advectionSubsteps) || advectionSubsteps < 1)
    throw new Error('След Фурье: некорректный шаг или состояние');
  const aged = state ? state.free.map(v => ({ ...v,
    age: (v.age ?? 0) + dt / 2,
    coreRadius: Number.isFinite(reynolds) ?
      Math.sqrt(4 * ((v.age ?? 0) + dt / 2) / reynolds) : undefined })) : [];
  const transferred = state && advection !== 'uniform' ?
    advectFree(aged, state, flow, dt, advectionSubsteps,
      advection === 'mapped') : null;
  if (transferred && !transferred.ok) return transferred;
  const old = state ? (transferred ? transferred.free :
    aged.map(v => ({ ...v,
      x: v.x + flow[0] * dt, z: v.z + flow[1] * dt }))) : [];
  for (let i = 0; i < old.length; i++) {
    const prev = state.free[i], now = old[i];
    if (prev.z * now.z < 0 &&
        (prev.x > 0 && prev.x < 1 || now.x > 0 && now.x < 1))
      return { ok: false, reason: 'vortex-crossed-plate', index: i };
  }
  if (Number.isFinite(reynolds))
    for (const v of old) {
      v.age += dt / 2;
      v.coreRadius = Math.sqrt(4 * v.age / reynolds);
    }
  const newLeading = { x: flow[0] * dt / 2,
    z: Math.sign(flow[1]) * flow[0] * dt / 2,
    gamma: 0, edge: 'LE' };
  const newVortex = { x: 1 + flow[0] * dt / 2,
    z: flow[1] * dt / 2, gamma: 0, edge: 'TE' };
  if (Number.isFinite(reynolds)) {
    newLeading.age = dt / 2;
    newVortex.age = dt / 2;
    newLeading.coreRadius = Math.sqrt(2 * dt / reynolds);
    newVortex.coreRadius = Math.sqrt(2 * dt / reynolds);
  }
  if (placement === 'previous-third') {
    const priorLeading = [...old].reverse().find(v => v.edge === 'LE');
    if (priorLeading) {
      newLeading.x = priorLeading.x / 3;
      newLeading.z = priorLeading.z / 3;
    }
    const priorTrailing = [...old].reverse().find(v => v.edge === 'TE');
    if (priorTrailing) {
      newVortex.x = 1 + (priorTrailing.x - 1) / 3;
      newVortex.z = priorTrailing.z / 3;
    }
  }
  const sources = shedLeadingEdge ? [...old, newLeading, newVortex] :
    [...old, newVortex];
  const baseline = fourierPlate({ flow, free: sources,
    modes, points });
  const unit = fourierPlate({ flow, free: [
    ...(shedLeadingEdge ? [...old, newLeading] : old),
    { ...newVortex, gamma: 1 }], modes, points });
  if (!baseline.ok || !unit.ok) return { ok: false, reason: 'plate' };
  const oldGamma = old.reduce((s, v) => s + v.gamma, 0);
  if (shedLeadingEdge) {
    const leadingUnit = fourierPlate({ flow, free: [...old,
      { ...newLeading, gamma: 1 }, newVortex], modes, points });
    if (!leadingUnit.ok) return { ok: false, reason: 'leading-plate' };
    const strengths = solveEdgeStrengths(baseline, leadingUnit,
      unit, oldGamma);
    if (!strengths)
      return { ok: false, reason: 'leading-singular' };
    [newLeading.gamma, newVortex.gamma] = strengths;
  } else {
    const response = unit.circulation - baseline.circulation;
    const denominator = 1 + response;
    if (Math.abs(denominator) < 1e-10)
      return { ok: false, reason: 'kelvin-singular' };
    newVortex.gamma = (-oldGamma - baseline.circulation) / denominator;
  }
  const free = shedLeadingEdge ? [...old, newLeading, newVortex] :
    [...old, newVortex];
  const plate = fourierPlate({ flow, free,
    modes, points });
  if (!plate.ok) return plate;
  const { cumulative, pressure, force, unsteadyForce } =
    unsteadyPressure(plate, state?.cumulative, dt);
  let impulseMoment = free.reduce((s, v) => s + v.gamma * v.x, 0);
  for (let i = 0; i < points; i++) {
    const width = plate.edges[i + 1] - plate.edges[i];
    impulseMoment += plate.gamma[i] * plate.x[i] * width;
  }
  const impulseForce = (impulseMoment -
    (state ? state.impulseMoment : 0)) / dt;
  return { ok: true, pressure, edges: plate.edges, force,
    circulatoryForce: plate.force, unsteadyForce,
    impulseMoment, impulseForce,
    A0: plate.A0, residual: plate.downwashError,
    kelvin: plate.circulation + free.reduce((s, v) => s + v.gamma, 0),
    lev: shedLeadingEdge ? newLeading : null, tev: newVortex,
    state: { points, modes, shedLeadingEdge, advection, advectionSubsteps,
      placement,
      reynolds,
      free, cumulative,
      impulseMoment, gamma: plate.gamma, edges: plate.edges } };
}

// Изолированный временной контроль отрезков свободной пелены.
export function fourierSheetWakeStep({ flow, dt, state = null,
                                       modes = 64, points = 512,
                                       reynolds = 1e5,
                                       releaseHeight = null,
                                       shedLeadingEdge = true,
                                       suctionNumeratorLimit = 0,
                                       advection = 'uniform',
                                       advectionSubsteps = 1,
                                       leadingFormation = 'flow' }) {
  if (!(dt > 0) || !Number.isFinite(reynolds) || !(reynolds > 0) ||
      !Number.isFinite(suctionNumeratorLimit) ||
      !(suctionNumeratorLimit >= 0) ||
      !['uniform', 'induced'].includes(advection) ||
      !['flow', 'tangent'].includes(leadingFormation) ||
      !Number.isInteger(advectionSubsteps) ||
      advectionSubsteps < 1 || advectionSubsteps > 64 ||
      (releaseHeight !== null &&
        (!Number.isFinite(releaseHeight) || releaseHeight < 0)) ||
      (state && (state.modes !== modes || state.points !== points ||
        state.reynolds !== reynolds ||
        state.releaseHeight !== releaseHeight ||
        state.shedLeadingEdge !== shedLeadingEdge ||
        state.suctionNumeratorLimit !== suctionNumeratorLimit ||
        state.advection !== advection ||
        state.advectionSubsteps !== advectionSubsteps ||
        state.leadingFormation !== leadingFormation ||
        !Array.isArray(state.sheets) ||
        !Array.isArray(state.cumulative))))
    throw new Error('След из отрезков: некорректный шаг или состояние');
  let old;
  if (!state) old = [];
  else if (advection === 'induced') {
    const moved = advectSheets(state.sheets, flow, dt, modes, points,
      reynolds, advectionSubsteps);
    if (!moved.ok) return moved;
    old = moved.sheets;
  } else old = state.sheets.map(sheet => ({ ...sheet,
    a: [sheet.a[0] + flow[0] * dt, sheet.a[1] + flow[1] * dt],
    b: [sheet.b[0] + flow[0] * dt, sheet.b[1] + flow[1] * dt],
    age: (sheet.age ?? 0) + dt }));
  const sign = flow[1] < 0 ? -1 : 1;
  const offset = sign * (releaseHeight ??
    Math.sqrt(2 * Math.hypot(...flow) * dt / reynolds));
  const rise = flow[1] * dt;
  const leading = { a: [0, offset],
    b: [flow[0] * dt,
      offset + (leadingFormation === 'tangent' ? 0 : rise)],
    gamma: 0, edge: 'LE', age: 0 };
  const trailing = { a: [1, offset],
    b: [1 + flow[0] * dt, offset + rise], gamma: 0, edge: 'TE', age: 0 };
  if (advection === 'induced') {
    const newbornCore2 = 2 * Math.hypot(...flow) * dt / reynolds;
    leading.core2 = newbornCore2;
    trailing.core2 = newbornCore2;
    const previousLeading = [...old].reverse().find(s => s.edge === 'LE');
    const previousTrailing = [...old].reverse().find(s => s.edge === 'TE');
    if (previousLeading) leading.b = [...previousLeading.a];
    if (previousTrailing) trailing.b = [...previousTrailing.a];
  }
  const sources = shedLeadingEdge ? [...old, leading, trailing] :
    [...old, trailing];
  const baseline = fourierPlate({ flow,
    sheets: sources, modes, points });
  const leadingUnit = shedLeadingEdge ? fourierPlate({ flow,
    sheets: [...old, { ...leading, gamma: 1 }, trailing], modes, points }) :
    null;
  const trailingUnit = fourierPlate({ flow,
    sheets: shedLeadingEdge ?
      [...old, leading, { ...trailing, gamma: 1 }] :
      [...old, { ...trailing, gamma: 1 }], modes, points });
  if (!baseline.ok || (leadingUnit && !leadingUnit.ok) || !trailingUnit.ok)
    return { ok: false, reason: 'plate' };
  const oldGamma = old.reduce((s, sheet) => s + sheet.gamma, 0);
  const leadingActive = shedLeadingEdge &&
    Math.abs(baseline.suctionNumerator) > suctionNumeratorLimit;
  if (leadingActive) {
    const strengths = solveEdgeStrengths(baseline, leadingUnit,
      trailingUnit, oldGamma,
      Math.sign(baseline.suctionNumerator) * suctionNumeratorLimit);
    if (!strengths) return { ok: false, reason: 'edge-singular' };
    [leading.gamma, trailing.gamma] = strengths;
  } else {
    const response = 1 + trailingUnit.circulation - baseline.circulation;
    if (Math.abs(response) < 1e-10)
      return { ok: false, reason: 'kelvin-singular' };
    trailing.gamma = (-oldGamma - baseline.circulation) / response;
  }
  const sheets = leadingActive ? [...old, leading, trailing] :
    [...old, trailing];
  const plate = fourierPlate({ flow, sheets, modes, points });
  if (!plate.ok) return plate;
  const pressureStep = unsteadyPressure(plate, state?.cumulative, dt);
  let impulseMoment = sheets.reduce((s, sheet) =>
    s + sheet.gamma * (sheet.a[0] + sheet.b[0]) / 2, 0);
  for (let i = 0; i < points; i++)
    impulseMoment += plate.gamma[i] * plate.x[i] *
      (plate.edges[i + 1] - plate.edges[i]);
  const impulseForce = (impulseMoment -
    (state ? state.impulseMoment : 0)) / dt;
  return { ok: true, ...pressureStep, edges: plate.edges,
    impulseMoment, impulseForce,
    circulatoryForce: plate.force, A0: plate.A0,
    residual: plate.downwashError,
    kelvin: plate.circulation +
      sheets.reduce((s, sheet) => s + sheet.gamma, 0),
    leadingGamma: leadingActive ? leading.gamma : 0,
    leadingActive, trailingGamma: trailing.gamma,
    state: { modes, points, reynolds, releaseHeight,
      shedLeadingEdge, suctionNumeratorLimit,
      advection, advectionSubsteps, leadingFormation, sheets,
      cumulative: pressureStep.cumulative, impulseMoment } };
}
