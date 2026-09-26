// Изолированный численный опыт двумерного схода с острой передней кромки.
// Не подключён к лодке: здесь пока плоская пластина, кинематический снос
// свободных вихрей и линейный нестационарный Бернулли. Назначение — проверить
// непротекание, Кельвина, отражение и цену шага до переноса на летящую ткань.
import { solveLinear } from '../../sim/local-pressure.js';

const PI2 = 2 * Math.PI;

function induced(vortex, x, z, core2) {
  const dx = x - vortex.x, dz = z - vortex.z;
  const k = vortex.gamma / (PI2 * (dx * dx + dz * dz + core2));
  return [-k * dz, k * dx];
}

export function edgeVortexStep({ flow, dt, panels = 16, state = null }) {
  if (!Array.isArray(flow) || flow.length !== 2 || !flow.every(Number.isFinite) ||
      !(flow[0] > 0) || !(dt > 0) || !Number.isInteger(panels) ||
      panels < 4 || panels > 128)
    throw new Error('Вихрь кромки: некорректный поток, шаг или число панелей');
  if (state && (state.panels !== panels || !Array.isArray(state.free) ||
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
  const free = state ? state.free.map(v => ({
    x: v.x + flow[0] * dt, z: v.z + flow[1] * dt, gamma: v.gamma,
  })) : [];
  const side = Math.sign(flow[1]);
  const lev = { x: dxStep / 2, z: side * dxStep / 2, gamma: 0 };
  const tev = { x: 1 + dxStep / 2, z: 0, gamma: 0 };
  const n = panels + 2;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  const rhs = new Float64Array(n);
  for (let i = 0; i < panels; i++) {
    for (let j = 0; j < panels; j++)
      matrix[i][j] = induced({ x: boundAt[j], z: 0, gamma: 1 },
                             control[i], 0, 0)[1];
    matrix[i][panels] = induced({ ...lev, gamma: 1 }, control[i], 0, core2)[1];
    matrix[i][panels + 1] = induced({ ...tev, gamma: 1 }, control[i], 0, core2)[1];
    rhs[i] = -flow[1];
    for (const vortex of free)
      rhs[i] -= induced(vortex, control[i], 0, core2)[1];
  }
  // Нулевой первый связанный вихрь — пробное условие снятия LE-сингулярности.
  // Сумма всех циркуляций остаётся нулевой, пока внешнего момента нет.
  matrix[panels][0] = 1;
  for (let j = 0; j < n; j++) matrix[panels + 1][j] = 1;
  rhs[panels + 1] = -free.reduce((s, v) => s + v.gamma, 0);
  const solution = solveLinear(matrix, rhs);
  if (!solution || !solution.every(Number.isFinite))
    return { ok: false, reason: 'singular' };
  lev.gamma = solution[panels]; tev.gamma = solution[panels + 1];
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
  for (let i = 0; i < panels; i++) {
    cumulative += solution[i]; oldCumulative += old[i];
    // Для плоской пластины первая часть — касательный поток × вихревой лист,
    // вторая — временная производная скачка потенциала (Бернулли).
    pressure.push(-flow[0] * solution[i] / width[i] -
                  (cumulative - oldCumulative) / dt);
  }
  const next = { panels, bound: Array.from(solution.slice(0, panels)),
    free: [...free, lev, tev] };
  return { ok: true, residual, bound: next.bound, lev, tev, pressure,
    force: pressure.reduce((s, p, i) => s + p * width[i], 0),
    circulation: next.bound.reduce((s, g) => s + g, 0) +
      next.free.reduce((s, v) => s + v.gamma, 0), state: next };
}
