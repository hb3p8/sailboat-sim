// Полное неявное уравнение заданной энергии. Кромки — ограничения, не второй материал.
// Положительная матрица Гаусса–Ньютона задаёт направление; остановка — по настоящему
// градиенту энергии и условиям односторонних связей, без предположения g=0.
import { EnergyMotion } from './cloth-energy-motion.mjs';

export { bandFactor } from './cloth-linear-solve.mjs';
import { bandFactor, borderedBandFactor } from './cloth-linear-solve.mjs';
import { gridDissection, sparsePattern, sparseFactor } from './cloth-sparse-solve.mjs';
import { kktDirection } from './cloth-kkt-direction.mjs';

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const sparseDot = (g, x) => g.reduce((sum, [i, v]) => sum + v * x[i], 0);
export const IMPLICIT_TOLERANCES = Object.freeze({ forceToleranceN: 1e-6,
  lengthToleranceM: 1e-9, dualToleranceN: 1e-8, complementarityToleranceJ: 1e-8 });

export class ImplicitEnergyMotion extends EnergyMotion {
  constructor(options) {
    super(options);
    const { forceToleranceN, lengthToleranceM, dualToleranceN, complementarityToleranceJ } = { ...IMPLICIT_TOLERANCES, ...options };
    if (![forceToleranceN, lengthToleranceM, dualToleranceN, complementarityToleranceJ].every(v => Number.isFinite(v) && v > 0))
      throw new Error('Нужны положительные допуски полного уравнения');
    Object.assign(this, { forceToleranceN, lengthToleranceM, dualToleranceN, complementarityToleranceJ });
    this.free = [];
    this.offset = new Int32Array(this.mass.length).fill(-1);
    const { gridRows, gridCols } = options;
    if ((gridRows != null || gridCols != null) &&
        !(Number.isInteger(gridRows) && gridRows > 0 && Number.isInteger(gridCols) && gridCols > 0 && gridRows * gridCols === this.mass.length))
      throw new Error('Некорректная структура сетки для порядка координат');
    const nodes = Array.from(this.mass, (_, i) => i).filter(i => this.w[i] && i !== this.board?.end);
    // Вытянутая по ширине таблица получает порядок по столбцам.
    if (gridCols > gridRows) nodes.sort((a, b) => a % gridCols - b % gridCols || a - b);
    if (this.board) nodes.push(this.board.end);
    for (const i of nodes) {
      this.offset[i] = this.free.length;
      for (let d = 0; d < 3; d++) this.free.push(3 * i + d);
    }
    this.coreDofs = this.free.length - (this.board ? 3 : 0);
    this.linearBackend = options.linearBackend ?? 'band-js';
    if (!['band-js', 'sparse-js', 'sparse-wasm', 'kkt-wasm'].includes(this.linearBackend) ||
        (['sparse-wasm', 'kkt-wasm'].includes(this.linearBackend) && typeof options.wasmSparseFactor !== 'function'))
      throw new Error('Неизвестный или не загруженный способ линейного решения');
    this.coreFactor = options.wasmSparseFactor ?? sparseFactor;
    this.kktFactor = options.wasmSparseFactor?.ldl;
    this.sparseOrder = gridRows ? gridDissection(gridRows, gridCols, this.offset, this.coreDofs) : undefined;
    this.soft = this.constraints.filter(c => c.alpha > 0);
    this.hard = this.constraints.filter(c => c.alpha === 0);
    if (this.soft.some(c => c.unilateral)) throw new Error('Односторонняя упругая энергия требует отдельного закона');
  }

  sparse(grad) {
    const out = [];
    for (const [i, g] of this.reduce(grad)) if (this.offset[i] >= 0)
      for (let d = 0; d < 3; d++) out.push([this.offset[i] + d, g[d]]);
    return out;
  }

  state(prediction, h, mu) {
    const n = this.free.length, gradient = new Float64Array(n), residual = new Float64Array(n);
    let objectiveJ = 0, band = 0, violationM = 0, violationL1M = 0, dualViolationN = 0, complementarityJ = 0;
    for (let j = 0; j < n; j++) {
      const k = this.free[j], m = 1 / this.w[Math.floor(k / 3)], delta = this.pos[k] - prediction[k];
      gradient[j] = m * delta / (h * h); objectiveJ += .5 * m * delta * delta / (h * h);
    }
    const soft = this.soft.map(c => {
      const { C, grad } = c.value(this.pos), g = this.sparse(grad);
      objectiveJ += .5 * C * C / c.alpha;
      for (const [i, v] of g) gradient[i] += C * v / c.alpha;
      const core = g.filter(([i]) => i < this.coreDofs);
      if (core.length) band = Math.max(band, Math.max(...core.map(([i]) => i)) - Math.min(...core.map(([i]) => i)));
      return { c, C, g };
    });
    residual.set(gradient);
    const hard = this.hard.map((c, j) => {
      const { C, grad } = c.value(this.pos), g = this.sparse(grad), violation = c.unilateral ? Math.max(0, C) : Math.abs(C);
      violationM = Math.max(violationM, violation); violationL1M += violation;
      for (const [i, v] of g) residual[i] += mu[j] * v;
      if (c.unilateral) {
        dualViolationN = Math.max(dualViolationN, -mu[j]);
        complementarityJ = Math.max(complementarityJ, Math.abs(mu[j] * C));
      }
      if (!g.length && violation > this.lengthToleranceM) throw new Error('Нарушена связь между неподвижными точками');
      return { c, C, g };
    });
    const maxForceN = Math.max(0, ...residual.map(Math.abs));
    return { objectiveJ, gradient, residual, soft, hard, band, maxForceN, violationM, violationL1M,
      dualViolationN, complementarityJ };
  }

  direction(state, h, priorMu) {
    if (this.linearBackend === 'kkt-wasm') return kktDirection(this, state, h, priorMu);
    const { gradient, soft, hard, band } = state, n = this.free.length, stride = band + 1;
    const core = this.coreDofs, size = n - core;
    let pattern;
    if (this.linearBackend !== 'band-js') {
      this.pattern ??= sparsePattern(core, soft.map(({ g }) => g.map(([i]) => i)), this.sparseOrder);
      pattern = this.pattern;
    }
    const matrix = new Float64Array(pattern ? pattern.cols.length : core * stride);
    const coupling = new Float64Array(core * size), border = new Float64Array(size * size);
    const add = (i, j, v) => {
      if (pattern) { if (i < core) i = pattern.inverse[i]; if (j < core) j = pattern.inverse[j]; }
      const row = Math.max(i, j), col = Math.min(i, j);
      if (row < core) {
        const entry = pattern ? pattern.locations[row].get(col) : row * stride + row - col;
        if (entry === undefined) throw new Error('Изменилась структура градиента разреженной матрицы');
        matrix[entry] += v;
      }
      else if (col < core) coupling[col * size + row - core] += v;
      else border[(row - core) * size + row - col] += v;
    };
    for (let i = 0; i < n; i++) add(i, i, 1 / (this.w[Math.floor(this.free[i] / 3)] * h * h));
    for (const { c, g } of soft) for (let a = 0; a < g.length; a++) for (let b = 0; b <= a; b++) {
      const [i, vi] = g[a], [j, vj] = g[b]; add(i, j, vi * vj / c.alpha);
    }
    const permutedSolve = borderedBandFactor(matrix, coupling, border, core, band, size,
      pattern ? a => this.coreFactor(a, pattern) : bandFactor);
    const permute = rhs => {
      const permuted = new Float64Array(n);
      for (let i = 0; i < core; i++) permuted[i] = rhs[pattern.order[i]];
      permuted.set(rhs.slice(core), core); return permuted;
    };
    const restore = x => {
      const result = new Float64Array(n);
      for (let i = 0; i < core; i++) result[pattern.order[i]] = x[i];
      result.set(x.slice(core), core); return result;
    };
    const solve = pattern ? rhs => restore(permutedSolve(permute(rhs))) : permutedSolve;
    if (pattern && permutedSolve.many) solve.many = rightSides => permutedSolve.many(rightSides.map(permute)).map(restore);
    const unforced = solve(gradient);
    // Ненатянутая кромка проверяется по шагу без решения её реакции.
    // Ответ нужен только при включении связи и сохраняется до смены матрицы.
    const responses = new Array(hard.length); let responseSolves = 0;
    const prepareResponses = indices => {
      const missing = indices.filter(i => !responses[i]);
      const rightSides = missing.map(i => {
        const rhs = new Float64Array(n); for (const [j, v] of hard[i].g) rhs[j] = v; return rhs;
      });
      const solved = solve.many ? solve.many(rightSides) : rightSides.map(solve);
      missing.forEach((i, j) => responses[i] = solved[j]); responseSolves += missing.length;
    };
    const active = new Set(hard.flatMap((a, i) => a.g.length && (!a.c.unilateral || priorMu[i] > this.dualToleranceN) ? [i] : []));
    for (let qp = 0; qp < 4 * hard.length + 10; qp++) {
      const indices = Array.from(active), m = indices.length, schur = new Float64Array(m * m);
      prepareResponses(indices);
      const rhs = Float64Array.from(indices, i => hard[i].C - sparseDot(hard[i].g, unforced));
      for (let a = 0; a < m; a++) for (let b = 0; b <= a; b++)
        schur[a * m + a - b] = sparseDot(hard[indices[a]].g, responses[indices[b]]);
      const multipliers = m ? bandFactor(schur, m, m - 1)(rhs) : [];
      const mu = new Float64Array(hard.length), step = unforced.map(v => -v);
      for (let a = 0; a < m; a++) {
        const i = indices[a]; mu[i] = multipliers[a];
        for (let j = 0; j < n; j++) step[j] -= mu[i] * responses[i][j];
      }
      let remove = -1, mostNegative = -this.dualToleranceN;
      for (const i of active) if (hard[i].c.unilateral && mu[i] < mostNegative) { mostNegative = mu[i]; remove = i; }
      if (remove >= 0) { active.delete(remove); continue; }
      let add = -1, worst = this.lengthToleranceM;
      for (let i = 0; i < hard.length; i++) if (hard[i].c.unilateral && !active.has(i) && hard[i].g.length) {
        const violation = hard[i].C + sparseDot(hard[i].g, step);
        if (violation > worst) { worst = violation; add = i; }
      }
      if (add >= 0) { active.add(add); continue; }
      return { step, mu, active: active.size, qpIterations: qp + 1, responseSolves };
    }
    throw new Error('Не сошёлся выбор односторонних кромок');
  }

  solve(prediction, h, passes) {
    let mu = this.linearBackend === 'kkt-wasm' && this.lastMu ? this.lastMu.slice() : new Float64Array(this.hard.length);
    let lineSearchReductions = 0, qpIterations = 0, responseSolves = 0;
    let state = this.state(prediction, h, mu);
    for (let iteration = 0; iteration <= passes; iteration++) {
      if (state.maxForceN <= this.forceToleranceN && state.violationM <= this.lengthToleranceM &&
          state.dualViolationN <= this.dualToleranceN && state.complementarityJ <= this.complementarityToleranceJ) {
        for (const c of this.soft) c.lambda = -h * h * c.value(this.pos).C / c.alpha;
        this.hard.forEach((c, j) => c.lambda = -h * h * mu[j]);
        if (this.linearBackend === 'kkt-wasm') this.lastMu = mu.slice();
        return { method: 'полное уравнение энергии', converged: true, iterations: iteration, qpIterations, responseSolves,
          linearBackend: this.linearBackend, factorEntries: this.kktPattern?.cols.length ?? this.pattern?.cols.length ?? this.coreDofs * (state.band + 1),
          lineSearchReductions, bandwidth: state.band, borderCoordinates: this.free.length - this.coreDofs, maxForceResidualN: state.maxForceN,
          maxHardViolationM: state.violationM, complementarityJ: state.complementarityJ,
          forceToleranceN: this.forceToleranceN, lengthToleranceM: this.lengthToleranceM,
          dualToleranceN: this.dualToleranceN, complementarityToleranceJ: this.complementarityToleranceJ };
      }
      if (iteration === passes) break;
      const { step, mu: nextMu, qpIterations: qp, responseSolves: rs } = this.direction(state, h, mu);
      qpIterations += qp; responseSolves += rs;
      const old = this.pos.slice(), penaltyN = Math.max(1, 1.1 * Math.max(0, ...nextMu.map(Math.abs)));
      const meritJ = state.objectiveJ + penaltyN * state.violationL1M;
      const derivativeJ = dot(state.gradient, step) - penaltyN * state.violationL1M;
      let accepted = false;
      for (let line = 0; line < 24; line++) {
        const fraction = 2 ** -line, trialMu = mu.map((v, j) => v + fraction * (nextMu[j] - v));
        this.pos.set(old);
        for (let j = 0; j < this.free.length; j++) this.pos[this.free[j]] += fraction * step[j];
        this.reconstruct();
        let trial;
        try { trial = this.state(prediction, h, trialMu); } catch { lineSearchReductions++; continue; }
        const trialMeritJ = trial.objectiveJ + penaltyN * trial.violationL1M;
        const residualImproved = trial.maxForceN < state.maxForceN * (1 - 1e-4 * fraction) &&
          trial.violationM <= Math.max(this.lengthToleranceM, state.violationM);
        if ((derivativeJ < 0 && trialMeritJ <= meritJ + 1e-4 * fraction * derivativeJ) || residualImproved) {
          state = trial; mu = trialMu; accepted = true; break;
        }
        lineSearchReductions++;
      }
      if (!accepted) { this.pos.set(old); throw new Error(`Не найден убывающий шаг полного уравнения: ${state.maxForceN} Н, ${state.violationM} м`); }
    }
    throw new Error(`Полное уравнение не доведено за ${passes} итераций: ${state.maxForceN} Н, ${state.violationM} м`);
  }
}
