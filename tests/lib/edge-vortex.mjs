// Изолированный численный опыт двумерного схода с острой передней кромки.
// Не подключён к лодке: здесь пока плоская пластина, пробные варианты сноса
// свободных вихрей и линейный нестационарный Бернулли. Назначение — проверить
// непротекание, Кельвина, отражение и цену шага до переноса на летящую ткань.
import { solveLinear } from '../../sim/local-pressure.js';

const PI2 = 2 * Math.PI;

function induced(vortex, x, z, core2) {
  const dx = x - vortex.x, dz = z - vortex.z;
  const k = vortex.gamma / (PI2 * (dx * dx + dz * dz + core2));
  return [-k * dz, k * dx];
}

function leadingEdgeSuction(flow, free, core2) {
  const atEdge = [flow[0], flow[1]];
  for (const vortex of free) {
    const v = induced(vortex, 0, 0, core2);
    atEdge[0] += v[0]; atEdge[1] += v[1];
  }
  const vmag = Math.hypot(...atEdge);
  let sum = 0;
  const points = 256;
  for (let k = 0; k < points; k++) {
    const theta = Math.PI * (k + 0.5) / points;
    const x = (1 - Math.cos(theta)) / 2;
    let w = flow[1];
    for (const vortex of free) w += induced(vortex, x, 0, core2)[1];
    sum += w;
  }
  return sum / (points * vmag);
}

function meanNormal(vortex, core2) {
  const points = 256;
  let sum = 0;
  for (let k = 0; k < points; k++) {
    const theta = Math.PI * (k + 0.5) / points;
    sum += induced(vortex, (1 - Math.cos(theta)) / 2, 0, core2)[1];
  }
  return sum / points;
}

export function edgeVortexStep({ flow, dt, panels = 16, state = null,
                                 shedLeadingEdge = true,
                                 localConvection = false }) {
  if (!Array.isArray(flow) || flow.length !== 2 || !flow.every(Number.isFinite) ||
      !(flow[0] > 0) || !(dt > 0) || !Number.isInteger(panels) ||
      panels < 4 || panels > 128)
    throw new Error('Вихрь кромки: некорректный поток, шаг или число панелей');
  if (state && (state.panels !== panels || state.shedLeadingEdge !== shedLeadingEdge ||
                state.localConvection !== localConvection ||
                !Array.isArray(state.free) ||
                !Array.isArray(state.bound) || state.bound.length !== panels))
    throw new Error('Вихрь кромки: несовместимое предыдущее состояние');

  const speed = Math.hypot(...flow), dxStep = flow[0] * dt;
  const edges = Array.from({ length: panels + 1 }, (_, i) =>
    (1 - Math.cos(Math.PI * i / panels)) / 2);
  const boundAt = [], control = [], width = [];
  for (let i = 0; i < panels; i++) {
    const w = edges[i + 1] - edges[i];
    width.push(w);
    boundAt.push(edges[i] + w / 4);
    control.push(edges[i] + 3 * w / 4);
  }
  // Радиус ядра — численная регуляризация, привязанная к первой панели.
  // Его зависимость от сетки и шага — отдельные обязательные испытания.
  const core2 = (width[0] / 2) ** 2;
  const free = state ? state.free.map((v, index) => {
    let vx = flow[0], vz = flow[1];
    if (localConvection) {
      for (let j = 0; j < panels; j++) {
        const inducedAt = induced({ x: boundAt[j], z: 0,
          gamma: state.bound[j] }, v.x, v.z, core2);
        vx += inducedAt[0]; vz += inducedAt[1];
      }
      for (let j = 0; j < state.free.length; j++) {
        if (j === index) continue;
        const inducedAt = induced(state.free[j], v.x, v.z, core2);
        vx += inducedAt[0]; vz += inducedAt[1];
      }
    }
    return { x: v.x + vx * dt, z: v.z + vz * dt, gamma: v.gamma };
  }) : [];
  const side = Math.sign(flow[1]);
  const lev = { x: dxStep / 2, z: side * dxStep / 2, gamma: 0 };
  const tev = { x: 1 + dxStep / 2, z: 0, gamma: 0 };
  const n = panels + 1 + Number(shedLeadingEdge);
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  const rhs = new Float64Array(n);
  for (let i = 0; i < panels; i++) {
    for (let j = 0; j < panels; j++)
      matrix[i][j] = induced({ x: boundAt[j], z: 0, gamma: 1 },
                             control[i], 0, 0)[1];
    if (shedLeadingEdge)
      matrix[i][panels] = induced({ ...lev, gamma: 1 }, control[i], 0, core2)[1];
    matrix[i][n - 1] = induced({ ...tev, gamma: 1 }, control[i], 0, core2)[1];
    rhs[i] = -flow[1];
    for (const vortex of free)
      rhs[i] -= induced(vortex, control[i], 0, core2)[1];
  }
  // Для острой передней кромки обнуляем A0 из интеграла нормального потока
  // по θ, а не первую дискретную циркуляцию: это разные условия.
  if (shedLeadingEdge) {
    matrix[panels][panels] = meanNormal({ ...lev, gamma: 1 }, core2);
    matrix[panels][n - 1] = meanNormal({ ...tev, gamma: 1 }, core2);
    rhs[panels] = -flow[1];
    for (const vortex of free) rhs[panels] -= meanNormal(vortex, core2);
  }
  for (let j = 0; j < n; j++) matrix[n - 1][j] = 1;
  rhs[n - 1] = -free.reduce((s, v) => s + v.gamma, 0);
  const solution = solveLinear(matrix, rhs);
  if (!solution || !solution.every(Number.isFinite))
    return { ok: false, reason: 'singular' };
  lev.gamma = shedLeadingEdge ? solution[panels] : 0;
  tev.gamma = solution[n - 1];
  let residual = 0;
  for (let i = 0; i < n; i++) {
    let value = 0, norm = Math.abs(rhs[i]);
    for (let j = 0; j < n; j++) {
      value += matrix[i][j] * solution[j];
      norm += Math.abs(matrix[i][j] * solution[j]);
    }
    residual = Math.max(residual, Math.abs(value - rhs[i]) / Math.max(1, norm));
  }
  const old = state ? state.bound : Array(panels).fill(0);
  let cumulative = 0, oldCumulative = 0;
  const pressure = [];
  let circulatoryForce = 0, unsteadyForce = 0;
  for (let i = 0; i < panels; i++) {
    cumulative += solution[i]; oldCumulative += old[i];
    // Для плоской пластины первая часть — касательный поток × вихревой лист,
    // вторая — временная производная скачка потенциала (Бернулли).
    let tangential = flow[0];
    for (const vortex of free) tangential += induced(vortex, control[i], 0, core2)[0];
    if (shedLeadingEdge) tangential += induced(lev, control[i], 0, core2)[0];
    tangential += induced(tev, control[i], 0, core2)[0];
    const circulatory = -tangential * solution[i] / width[i];
    const unsteady = -(cumulative - oldCumulative) / dt;
    pressure.push(circulatory + unsteady);
    circulatoryForce += circulatory * width[i];
    unsteadyForce += unsteady * width[i];
  }
  const next = { panels, shedLeadingEdge, localConvection,
    bound: Array.from(solution.slice(0, panels)),
    free: shedLeadingEdge ? [...free, lev, tev] : [...free, tev] };
  return { ok: true, residual, bound: next.bound, lev, tev, pressure,
    // A0 из интеграла требуемого нормального потока по θ (тонкий профиль).
    // Критическое значение и право применять этот критерий к ткани не заданы.
    lesp: leadingEdgeSuction(flow, next.free, core2),
    // Не калиброванный LESP: первая циркуляция / √ширины панели.
    // Это только проверка сеточной инвариантности признака входного всасывания.
    suctionProxy: -solution[0] / (speed * Math.sqrt(width[0])),
    circulatoryForce, unsteadyForce,
    force: pressure.reduce((s, p, i) => s + p * width[i], 0),
    circulation: next.bound.reduce((s, g) => s + g, 0) +
      next.free.reduce((s, v) => s + v.gamma, 0), state: next };
}
