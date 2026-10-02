// Совместное направление той же задачи: [H G; Gᵀ 0] [dx;mu] = [-grad;-C].
// Свободная связь имеет отдельный единичный блок и нулевой ответ.
import { sparsePattern } from './cloth-sparse-solve.mjs';
const sparseDot = (g, x) => g.reduce((sum, [i, v]) => sum + v * x[i], 0);

export function kktDirection(motion, state, h, priorMu) {
  const { gradient, soft, hard } = state, n = motion.free.length, total = n + hard.length;
  if (!motion.kktPattern) {
    const base = Array.from(motion.sparseOrder ?? Int32Array.from({ length: motion.coreDofs }, (_, i) => i));
    for (let i = motion.coreDofs; i < n; i++) base.push(i);
    const position = new Int32Array(n); base.forEach((i, k) => position[i] = k);
    const after = Array.from({ length: n + 1 }, () => []), edges = motion.inertiaCouplings.map(({i,j})=>[i,j]);
    hard.forEach(({ g }, j) => {
      const last = g.length ? Math.max(...g.map(([i]) => position[i])) + 1 : 0;
      after[last].push(n + j);
      for (const [i] of g) edges.push([i, n + j]);
    });
    const order = [...after[0]];
    base.forEach((i, k) => order.push(i, ...after[k + 1]));
    motion.kktPattern = sparsePattern(total, soft.map(({ g }) => g.map(([i]) => i)), Int32Array.from(order), edges);
  }
  const p = motion.kktPattern, matrix = new Float64Array(p.cols.length);
  if (!motion.kktAssembly) {
    motion.kktAssembly = soft.map(({ g }) => {
      const entries = [];
      for (let a = 0; a < g.length; a++) for (let b = 0; b <= a; b++) {
        const i = p.inverse[g[a][0]], j = p.inverse[g[b][0]];
        entries.push(p.locations[Math.max(i, j)].get(Math.min(i, j)));
      }
      return { coordinates: Int32Array.from(g, ([i]) => i), entries: Int32Array.from(entries) };
    });
  }
  const add = (i, j, v, target = matrix) => {
    const a = p.inverse[i], b = p.inverse[j], entry = p.locations[Math.max(a, b)].get(Math.min(a, b));
    if (entry === undefined) throw new Error('Изменилась структура совместной матрицы');
    target[entry] += v;
  };
  for (let i = 0; i < n; i++) add(i, i, 1 / (motion.w[Math.floor(motion.free[i] / 3)] * h * h));
  for (const {i,j,massKg} of motion.inertiaCouplings) add(i,j,massKg/(h*h));
  for (let k = 0; k < soft.length; k++) {
    const { c, g } = soft[k], plan = motion.kktAssembly[k]; let entry = 0;
    if (g.length !== plan.coordinates.length || g.some(([i], a) => i !== plan.coordinates[a]))
      throw new Error('Изменилась структура градиента совместной матрицы');
    for (let a = 0; a < g.length; a++) for (let b = 0; b <= a; b++)
      matrix[plan.entries[entry++]] += g[a][1] * g[b][1] / c.alpha;
  }
  const active = new Set(hard.flatMap((a, i) => a.g.length && (!a.c.unilateral || priorMu[i] > motion.dualToleranceN) ? [i] : []));
  for (let qp = 0; qp < 4 * hard.length + 10; qp++) {
    const coefficients = matrix.slice(), rhs = new Float64Array(total), signs = new Int32Array(total).fill(1);
    for (let i = 0; i < n; i++) rhs[p.inverse[i]] = -gradient[i];
    hard.forEach(({ C, g }, j) => {
      if (active.has(j)) {
        for (const [i, v] of g) add(i, n + j, v, coefficients);
        rhs[p.inverse[n + j]] = -C; signs[p.inverse[n + j]] = -1;
      } else add(n + j, n + j, 1, coefficients);
    });
    const solve = motion.kktFactor(coefficients, p, signs);
    let result;
    try { result = solve(rhs); } finally { solve.release?.(); }
    const step = Float64Array.from({ length: n }, (_, i) => result[p.inverse[i]]);
    const mu = Float64Array.from({ length: hard.length }, (_, i) => result[p.inverse[n + i]]);
    let remove = -1, mostNegative = -motion.dualToleranceN;
    for (const i of active) if (hard[i].c.unilateral && mu[i] < mostNegative) { mostNegative = mu[i]; remove = i; }
    if (remove >= 0) { active.delete(remove); continue; }
    let insert = -1, worst = motion.lengthToleranceM;
    for (let i = 0; i < hard.length; i++) if (hard[i].c.unilateral && !active.has(i) && hard[i].g.length) {
      const violation = hard[i].C + sparseDot(hard[i].g, step);
      if (violation > worst) { worst = violation; insert = i; }
    }
    if (insert >= 0) { active.add(insert); continue; }
    return { step, mu, active: active.size, qpIterations: qp + 1, responseSolves: 0 };
  }
  throw new Error('Не сошёлся выбор односторонних кромок');
}
