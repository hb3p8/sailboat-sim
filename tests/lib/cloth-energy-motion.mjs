// Исследовательское движение из заданной энергии: XPBD, без старых мягких связей.
// Многоточечный градиент сначала сворачивается через аффинную планку, затем
// вычисляется знаменатель. Равенство C+α λ/h² не заменяет уравнение движения.
export class EnergyMotion {
  constructor({ positions, mass, constraints, fixed = [], board = null, dampingHz = 6 }) {
    if (!mass?.length || positions?.length !== 3 * mass.length ||
        !Array.from(mass).every(x => Number.isFinite(x) && x > 0) ||
        !Array.from(positions).every(Number.isFinite) || !Array.isArray(constraints) ||
        !Number.isFinite(dampingHz) || dampingHz < 0)
      throw new Error('Некорректная постановка движения ткани');
    this.pos = Float64Array.from(positions); this.prev = this.pos.slice(); this.prevDt = 0;
    this.mass = Float64Array.from(mass); this.w = Float64Array.from(mass, m => 1 / m);
    this.constraints = constraints.map(c => ({ ...c, lambda: 0 })); this.dampingHz = dampingHz;
    this.fixed = new Set(fixed); this.board = board;
    this.fixedPositions = new Map(fixed.map(i => [i, Array.from(this.pos.slice(3 * i, 3 * i + 3))]));
    this.target = Int32Array.from(mass, (_, i) => i); this.fraction = new Float64Array(mass.length).fill(1);
    for (const i of fixed) {
      if (!Number.isInteger(i) || i < 0 || i >= mass.length) throw new Error('Некорректное закрепление');
      this.w[i] = 0;
    }
    if (board) {
      const { head, end, nodes, fractions } = board;
      if (!this.fixed.has(head) || this.fixed.has(end) || !Array.isArray(nodes) ||
          nodes.length !== fractions?.length || new Set(nodes).size !== nodes.length ||
          !nodes.includes(head) || !nodes.includes(end) || nodes.some(i =>
            !Number.isInteger(i) || i < 0 || i >= mass.length || (i !== head && this.fixed.has(i))) ||
          fractions.some(t => !Number.isFinite(t) || t < 0 || t > 1) ||
          fractions[nodes.indexOf(head)] !== 0 || fractions[nodes.indexOf(end)] !== 1)
        throw new Error('Некорректное аффинное верхнее крепление');
      // Копия постановки: внешняя правка fractions не меняет текущую механику.
      this.board = { ...board, nodes: nodes.slice(), fractions: fractions.slice() };
      let effectiveMass = 0;
      for (let k = 0; k < nodes.length; k++) {
        const i = nodes[k], t = fractions[k];
        this.target[i] = end; this.fraction[i] = t; this.w[i] = 0;
        effectiveMass += mass[i] * t * t;
      }
      this.w[end] = 1 / effectiveMass; this.boardMass = effectiveMass;
      this.reconstruct(); this.prev.set(this.pos);
    }
    for (const c of this.constraints) if (!(Number.isFinite(c.alpha) && c.alpha >= 0) || typeof c.value !== 'function')
      throw new Error('Некорректная податливость или связь энергии');
  }

  // Длина планки задаётся отдельной жёсткой связью, не скрытой поправкой здесь.
  reconstruct() {
    if (!this.board) return;
    const { head, end, nodes, fractions } = this.board, p = this.pos;
    for (let k = 0; k < nodes.length; k++) for (let d = 0; d < 3; d++)
      p[3 * nodes[k] + d] = p[3 * head + d] + fractions[k] * (p[3 * end + d] - p[3 * head + d]);
  }

  reduce(grad) {
    const merged = new Map();
    for (const [i, g] of grad) {
      const target = this.target[i], t = this.fraction[i];
      if (!merged.has(target)) merged.set(target, [0, 0, 0]);
      const value = merged.get(target);
      for (let d = 0; d < 3; d++) value[d] += t * g[d];
    }
    return Array.from(merged);
  }

  reduceField(field) {
    const out = new Float64Array(this.pos.length);
    for (let i = 0; i < this.mass.length; i++) for (let d = 0; d < 3; d++)
      out[3 * this.target[i] + d] += this.fraction[i] * field[3 * i + d];
    return out;
  }

  kinetic(h = this.prevDt) {
    if (!(h > 0)) return 0;
    let energy = 0;
    for (let i = 0; i < this.mass.length; i++) if (this.w[i] > 0 ||
        (this.board && this.board.nodes.includes(i) && !this.fixed.has(i)))
      for (let d = 0; d < 3; d++) energy += .5 * this.mass[i] *
        ((this.pos[3 * i + d] - this.prev[3 * i + d]) / h) ** 2;
    return energy;
  }

  project(c, h) {
    const { C, grad } = c.value(this.pos), reduced = this.reduce(grad), scaled = c.alpha / (h * h);
    let denominator = scaled;
    for (const [i, g] of reduced) denominator += this.w[i] * g.reduce((s, x) => s + x * x, 0);
    if (!(denominator > 0)) return;
    const raw = (-C - scaled * c.lambda) / denominator;
    const next = c.unilateral ? Math.min(0, c.lambda + raw) : c.lambda + raw, delta = next - c.lambda;
    c.lambda = next;
    for (const [i, g] of reduced) for (let d = 0; d < 3; d++) this.pos[3 * i + d] += this.w[i] * delta * g[d];
    if (this.board && delta && reduced.some(([i]) => i === this.board.end)) this.reconstruct();
  }

  solve(prediction, h, passes) {
    for (let pass = 0; pass < passes; pass++) for (const c of this.constraints) this.project(c, h);
  }

  step(force, h, passes) {
    if (force?.length !== this.pos.length || !Array.from(force).every(Number.isFinite) ||
        !Number.isFinite(h) || !(h > 0) || !Number.isInteger(passes) || passes < 1)
      throw new Error('Некорректные сила, подшаг или число проходов');
    for (const [i, fixedPosition] of this.fixedPositions) for (let d = 0; d < 3; d++)
      if (this.pos[3 * i + d] !== fixedPosition[d])
        throw new Error('Подвижное закрепление требует отдельного учёта работы');
    const old = this.pos.slice(), prior = this.prev.slice(), priorDt = this.prevDt || h;
    const initialKineticJ = this.kinetic(), reducedForce = this.reduceField(force), decay = Math.exp(-this.dampingHz * h);
    let initialSoftEnergyJ = 0;
    for (const c of this.constraints) if (c.alpha > 0) initialSoftEnergyJ += .5 * c.value(old).C ** 2 / c.alpha;
    const dampingForce = new Float64Array(this.pos.length);
    for (let i = 0; i < this.mass.length; i++) if (this.w[i] ||
        (this.board && this.board.nodes.includes(i) && !this.fixed.has(i))) for (let d = 0; d < 3; d++) {
      const k = 3 * i + d; dampingForce[k] = this.mass[i] * (decay - 1) * (old[k] - prior[k]) / (priorDt * h);
    }
    for (let i = 0; i < this.mass.length; i++) if (this.w[i]) for (let d = 0; d < 3; d++) {
      const k = 3 * i + d;
      this.pos[k] += decay * (old[k] - prior[k]) / priorDt * h + h * h * this.w[i] * reducedForce[k];
    }
    this.reconstruct(); const prediction = this.pos.slice();
    for (const c of this.constraints) c.lambda = 0;
    let solver;
    try {
      solver = this.solve(prediction, h, passes);
      if (!Array.from(this.pos).every(Number.isFinite)) throw new Error('Не-конечная позиция ткани');
    } catch (error) { this.pos.set(old); this.prev.set(prior); throw error; }
    this.prev.set(old); this.prevDt = h;
    const kineticJ = this.kinetic(), predictedResidual = new Float64Array(this.pos.length);
    const materialResidual = new Float64Array(this.pos.length), constraintForce = new Float64Array(this.pos.length);
    const hardForce = new Float64Array(this.pos.length);
    let softEnergyJ = 0, maxHardViolationM = 0, workJ = 0, dampingWorkJ = 0, hardWorkEstimateJ = 0;
    const complianceResiduals = {};
    for (const c of this.constraints) {
      const { C, grad } = c.value(this.pos);
      if (c.alpha > 0) {
        softEnergyJ += .5 * C * C / c.alpha;
        const family = c.family || 'не указано', residual = Math.abs(C + c.alpha * c.lambda / (h * h));
        const group = complianceResiduals[family] ||= { max: 0, unit: c.unit || 'не указана' };
        group.max = Math.max(group.max, residual);
      } else maxHardViolationM = Math.max(maxHardViolationM, c.unilateral ? Math.max(0, C) : Math.abs(C));
      for (const [i, g] of grad) for (let d = 0; d < 3; d++) {
        const k = 3 * i + d, f = c.lambda / (h * h) * g[d];
        constraintForce[k] += f;
        if (c.alpha === 0) hardForce[k] += f;
        else materialResidual[k] += C / c.alpha * g[d];
      }
    }
    const multiplierForce = this.reduceField(constraintForce), reducedHardForce = this.reduceField(hardForce);
    const reducedMaterialGradient = this.reduceField(materialResidual);
    let maxMotionResidualN = 0, rmsMotionResidualN = 0, maxPhysicalResidualN = 0, rmsPhysicalResidualN = 0, dofs = 0;
    for (let i = 0; i < this.mass.length; i++) if (this.w[i]) for (let d = 0; d < 3; d++) {
      const k = 3 * i + d, inertial = (this.pos[k] - prediction[k]) / (h * h * this.w[i]);
      predictedResidual[k] = inertial - multiplierForce[k];
      const physical = inertial + reducedMaterialGradient[k] - reducedHardForce[k];
      maxMotionResidualN = Math.max(maxMotionResidualN, Math.abs(predictedResidual[k]));
      rmsMotionResidualN += predictedResidual[k] ** 2;
      maxPhysicalResidualN = Math.max(maxPhysicalResidualN, Math.abs(physical)); rmsPhysicalResidualN += physical ** 2; dofs++;
    }
    for (let k = 0; k < force.length; k++) {
      const displacement = this.pos[k] - old[k];
      workJ += force[k] * displacement; dampingWorkJ += dampingForce[k] * displacement;
      hardWorkEstimateJ += hardForce[k] * displacement;
    }
    // Закрепления неподвижны, поэтому их фактическая работа равна нулю.
    // constraintForce — оценка из множителей, не реакция, принятая для лодки.
    return { hS: h, passes, initialKineticJ, kineticJ, kineticChangeJ: kineticJ - initialKineticJ,
      initialSoftEnergyJ, softEnergyJ, softEnergyChangeJ: softEnergyJ - initialSoftEnergyJ,
      appliedWorkJ: workJ, dampingWorkJ, hardWorkEstimateJ, supportWorkJ: 0, complianceResiduals, maxHardViolationM,
      discreteEnergyDefectJ: kineticJ - initialKineticJ + softEnergyJ - initialSoftEnergyJ - workJ - dampingWorkJ - hardWorkEstimateJ,
      maxMotionResidualN, rmsMotionResidualN: Math.sqrt(rmsMotionResidualN / Math.max(1, dofs)),
      maxPhysicalResidualN, rmsPhysicalResidualN: Math.sqrt(rmsPhysicalResidualN / Math.max(1, dofs)),
      constraintForce, hardForce, prediction,
      ...(solver ? { solver } : {}),
      interpretation: 'остатки податливости, множителей и физического уравнения измерены отдельно; реакции не приняты' };
  }
}
