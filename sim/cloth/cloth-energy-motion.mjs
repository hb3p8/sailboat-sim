// Исследовательское движение из заданной энергии: XPBD, без старых мягких связей.
// Многоточечный градиент сначала сворачивается через аффинную планку, затем
// вычисляется знаменатель. Равенство C+α λ/h² не заменяет уравнение движения.
export class EnergyMotion {
  constructor({ positions, mass, constraints, fixed = [], board = null, dampingHz = 6, translatingBody = null }) {
    if (!mass?.length || positions?.length !== 3 * mass.length ||
        !Array.from(mass).every(x => Number.isFinite(x) && x > 0) ||
        !Array.from(positions).every(Number.isFinite) || !Array.isArray(constraints) ||
        !Number.isFinite(dampingHz) || dampingHz < 0)
      throw new Error('Некорректная постановка движения ткани');
    this.pos = Float64Array.from(positions); this.prev = this.pos.slice(); this.prevDt = 0;
    this.mass = Float64Array.from(mass); this.w = Float64Array.from(mass, m => 1 / m);
    this.constraints = constraints.map(c => ({ ...c, lambda: 0 })); this.dampingHz = dampingHz;
    this.fixed = new Set(fixed); this.board = board;
    this.supportMotionActive = false;
    this.fixedPositions = new Map(fixed.map(i => [i, Array.from(this.pos.slice(3 * i, 3 * i + 3))]));
    this.target = Int32Array.from(mass, (_, i) => i); this.fraction = new Float64Array(mass.length).fill(1);
    for (const i of fixed) {
      if (!Number.isInteger(i) || i < 0 || i >= mass.length) throw new Error('Некорректное закрепление');
      this.w[i] = 0;
    }
    if (translatingBody) {
      const { node, attachments, dampingHz: bodyDampingHz = 0, frame } = translatingBody;
      if (!this.movingSupportsAllowed() || !Number.isInteger(node) || node < 0 || node >= mass.length ||
          this.fixed.has(node) || !Array.isArray(attachments) || !attachments.length ||
          new Set(attachments).size !== attachments.length || attachments.some(i =>
            !Number.isInteger(i) || i < 0 || i >= mass.length || i === node || this.fixed.has(i)) ||
          !Number.isFinite(bodyDampingHz) || bodyDampingHz < 0 || frame!=='inertial-cartesian')
        throw new Error('Поступательная опора требует полного уравнения, инерциальных осей и отдельных узлов');
      // mass[node] — только опора. Массы прикреплённых узлов ткани уже есть
      // в mass и входят в общую инерцию ровно один раз.
      this.translatingBody = Object.freeze({ node, attachments: Object.freeze(attachments.slice()), dampingHz: bodyDampingHz, frame,
        offsets: Object.freeze(attachments.map(i => Object.freeze(Array.from(this.pos.slice(3*i,3*i+3),
          (v,d) => v-this.pos[3*node+d])))) });
      this.bodyAttachments = new Set(attachments);
      const effectiveMass = mass[node] + attachments.reduce((s,i) => s + mass[i], 0);
      if (!Number.isFinite(effectiveMass) || !Number.isFinite(1/effectiveMass))
        throw new Error('Переполнение массы поступательной опоры');
      this.w[node] = 1/effectiveMass; this.bodyEffectiveMassKg = effectiveMass;
      for (const i of attachments) { this.w[i]=0; this.target[i]=node; }
      this.reconstruct(); this.prev.set(this.pos);
    }
    if (board) {
      const { head, end, nodes, fractions } = board;
      const body = this.translatingBody;
      if ((body ? !this.bodyAttachments.has(head) : !this.fixed.has(head)) || this.fixed.has(end) || !Array.isArray(nodes) ||
          nodes.length !== fractions?.length || new Set(nodes).size !== nodes.length ||
          !nodes.includes(head) || !nodes.includes(end) || nodes.some(i =>
            !Number.isInteger(i) || i < 0 || i >= mass.length || (i !== head && this.fixed.has(i))) ||
          fractions.some(t => !Number.isFinite(t) || t < 0 || t > 1) ||
          fractions[nodes.indexOf(head)] !== 0 || fractions[nodes.indexOf(end)] !== 1 ||
          (body && (nodes.includes(body.node) || nodes.some(i => i !== head && this.bodyAttachments.has(i)))))
        throw new Error('Некорректное аффинное верхнее крепление');
      // Копия постановки: внешняя правка fractions не меняет текущую механику.
      this.board = { ...board, nodes: nodes.slice(), fractions: fractions.slice() };
      let effectiveMass = 0, crossMass = 0, headMass = 0;
      if (body) {
        this.secondaryTarget = new Int32Array(mass.length).fill(-1);
        this.secondaryFraction = new Float64Array(mass.length);
      }
      for (let k = 0; k < nodes.length; k++) {
        const i = nodes[k], t = fractions[k];
        this.target[i] = end; this.fraction[i] = t; this.w[i] = 0;
        effectiveMass += mass[i] * t * t;
        crossMass += mass[i] * t * (1 - t);
        headMass += mass[i] * (1 - t) ** 2;
        if (body) { this.secondaryTarget[i] = body.node; this.secondaryFraction[i] = 1-t; }
      }
      this.w[end] = 1 / effectiveMass; this.boardMass = effectiveMass;
      this.boardCrossMass = crossMass;
      if (body) {
        // Полная масса двух свободных концов: [[A,C],[C,B]] для каждой оси.
        // Масса головы уже входила в прикреплённые узлы; второй раз её не добавляем.
        const A = this.bodyEffectiveMassKg + headMass - mass[head], B = effectiveMass, C = crossMass;
        const determinant = A*B-C*C;
        if (![A,B,C,determinant,1/determinant].every(Number.isFinite) || !(determinant>0))
          throw new Error('Некорректная полная масса опоры и планки');
        this.bodyEffectiveMassKg = A; this.w[body.node] = 1/A;
        this.coupledBoardMass = Object.freeze({ bodyMassKg:A, endMassKg:B, crossMassKg:C, determinantKg2:determinant });
        this.massCouplings = Object.freeze([Object.freeze({ a:body.node, b:end, massKg:C })]);
        Object.freeze(this.board.nodes); Object.freeze(this.board.fractions); Object.freeze(this.board);
      }
      this.reconstruct(); this.prev.set(this.pos);
    }
    for (const c of this.constraints) if (!(Number.isFinite(c.alpha) && c.alpha >= 0) || typeof c.value !== 'function')
      throw new Error('Некорректная податливость или связь энергии');
  }

  // Длина планки задаётся отдельной жёсткой связью, не скрытой поправкой здесь.
  reconstruct() {
    if (this.translatingBody) {
      const { node, attachments, offsets } = this.translatingBody;
      for (let j=0;j<attachments.length;j++) for (let d=0;d<3;d++)
        this.pos[3*attachments[j]+d] = this.pos[3*node+d]+offsets[j][d];
    }
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
      if (this.secondaryTarget?.[i]>=0) {
        const second = this.secondaryTarget[i], weight = this.secondaryFraction[i];
        if (!merged.has(second)) merged.set(second,[0,0,0]);
        for (let d=0;d<3;d++) merged.get(second)[d] += weight*g[d];
      }
    }
    return Array.from(merged);
  }

  reduceField(field) {
    const out = new Float64Array(this.pos.length);
    for (let i = 0; i < this.mass.length; i++) for (let d = 0; d < 3; d++) {
      out[3 * this.target[i] + d] += this.fraction[i] * field[3 * i + d];
      if (this.secondaryTarget?.[i]>=0)
        out[3*this.secondaryTarget[i]+d] += this.secondaryFraction[i]*field[3*i+d];
    }
    return out;
  }

  kinetic(h = this.prevDt) {
    if (!(h > 0)) return 0;
    let energy = 0;
    for (let i = 0; i < this.mass.length; i++) if (this.w[i] > 0 ||
        this.bodyAttachments?.has(i) ||
        (this.board && this.board.nodes.includes(i) && !this.fixed.has(i)) ||
        (this.supportMotionActive && this.fixed.has(i)))
      for (let d = 0; d < 3; d++) energy += .5 * this.mass[i] *
        ((this.pos[3 * i + d] - this.prev[3 * i + d]) / h) ** 2;
    return energy;
  }

  project(c, h) {
    if (this.coupledBoardMass) throw new Error('Связанная масса опоры и планки требует полного уравнения');
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

  movingSupportsAllowed() { return false; }

  decayAtNode(i,h,clothDecay) {
    return i===this.translatingBody?.node?Math.exp(-this.translatingBody.dampingHz*h):clothDecay;
  }

  // Команда применяется внутри подшага; внешняя перестановка pos не является
  // командой. Отказ возвращает и историю, и множители, и принятые закрепления.
  step(force, h, passes, supportTargets) {
    if (force?.length !== this.pos.length || !Array.from(force).every(Number.isFinite) ||
        !Number.isFinite(h) || !(h > 0) || !Number.isInteger(passes) || passes < 1)
      throw new Error('Некорректные сила, подшаг или число проходов');
    for (const [i, fixedPosition] of this.fixedPositions) for (let d = 0; d < 3; d++)
      if (this.pos[3 * i + d] !== fixedPosition[d])
        throw new Error('Подвижное закрепление требует отдельного учёта работы');
    if (this.translatingBody) {
      const {node,attachments,offsets}=this.translatingBody;
      // Оси опоры не вращаются. Проверяется и текущая геометрия, и история:
      // внешняя перестановка узла не должна создавать скрытого импульса.
      for (const field of [this.pos,this.prev]) for(let j=0;j<attachments.length;j++) for(let d=0;d<3;d++) {
        const value=field[3*attachments[j]+d],expected=field[3*node+d]+offsets[j][d];
        const roundoff=32*Number.EPSILON*Math.max(1,Math.abs(value),Math.abs(expected),Math.abs(offsets[j][d]));
        if (!Number.isFinite(value) || !Number.isFinite(expected) || Math.abs(value-expected)>roundoff)
          throw new Error('Поступательная опора или история изменена вне общего шага');
      }
      if (this.board) for (const field of [this.pos,this.prev]) for (let j=0;j<this.board.nodes.length;j++) for(let d=0;d<3;d++) {
        const {head,end,nodes,fractions}=this.board, value=field[3*nodes[j]+d];
        const expected=field[3*head+d]+fractions[j]*(field[3*end+d]-field[3*head+d]);
        const roundoff=32*Number.EPSILON*Math.max(1,Math.abs(value),Math.abs(expected),Math.abs(field[3*end+d]),Math.abs(field[3*head+d]));
        if (!Number.isFinite(value) || !Number.isFinite(expected) || Math.abs(value-expected)>roundoff)
          throw new Error('Связанная планка или история изменена вне общего шага');
      }
    }
    if (supportTargets !== undefined && (!this.movingSupportsAllowed() || !Array.isArray(supportTargets)))
      throw new Error('Перемещение закреплений требует полного уравнения и массива команд');
    const targets = (supportTargets ?? []).map(target => {
      if (!target || !this.fixed.has(target.node) || !Array.isArray(target.positionM) ||
          target.positionM.length !== 3 || !target.positionM.every(Number.isFinite))
        throw new Error('Некорректная команда закрепления');
      return { node:target.node, positionM:target.positionM.slice() };
    });
    if (new Set(targets.map(t => t.node)).size !== targets.length) throw new Error('Закрепление задано дважды');
    const old = this.pos.slice(), prior = this.prev.slice(), previousDt = this.prevDt;
    const lambdas = this.constraints.map(c => c.lambda), priorMu = this.lastMu, active = this.supportMotionActive;
    try {
      if (supportTargets !== undefined) this.supportMotionActive = true;
      const result = this.advanceStep(force,h,passes,targets,old,prior);
      for (const target of targets) this.fixedPositions.set(target.node,target.positionM);
      return result;
    } catch (error) {
      this.pos.set(old); this.prev.set(prior); this.prevDt = previousDt;
      this.constraints.forEach((c,i) => { c.lambda = lambdas[i]; });
      if (priorMu === undefined) delete this.lastMu; else this.lastMu = priorMu;
      this.supportMotionActive = active;
      throw error;
    }
  }

  advanceStep(force,h,passes,targets,old,prior) {
    const priorDt = this.prevDt || h;
    const initialKineticJ = this.kinetic(), reducedForce = this.reduceField(force), decay = Math.exp(-this.dampingHz * h);
    let initialSoftEnergyJ = 0;
    for (const c of this.constraints) if (c.alpha > 0) initialSoftEnergyJ += .5 * c.value(old).C ** 2 / c.alpha;
    const dampingForce = new Float64Array(this.pos.length);
    for (let i = 0; i < this.mass.length; i++) if (this.w[i] ||
        this.bodyAttachments?.has(i) ||
        (this.board && this.board.nodes.includes(i) && !this.fixed.has(i)) ||
        (this.supportMotionActive && this.fixed.has(i))) for (let d = 0; d < 3; d++) {
      const k = 3 * i + d;
      const ownDecay = this.decayAtNode(i,h,decay);
      dampingForce[k] = this.mass[i] * (ownDecay - 1) * (old[k] - prior[k]) / (priorDt * h);
    }
    for (const {node,positionM} of targets) this.pos.set(positionM,3*node);
    for (let i = 0; i < this.mass.length; i++) if (this.w[i] && i!==this.translatingBody?.node &&
        !(this.coupledBoardMass && i===this.board.end)) for (let d = 0; d < 3; d++) {
      const k = 3 * i + d;
      this.pos[k] += this.decayAtNode(i,h,decay) * (old[k] - prior[k]) / priorDt * h + h * h * this.w[i] * reducedForce[k];
    }
    if (this.translatingBody) {
      const node=this.translatingBody.node, reducedDamping=this.reduceField(dampingForce);
      for (let d=0;d<3;d++) {
        const k=3*node+d;
        if (this.coupledBoardMass) {
          const e=3*this.board.end+d, {bodyMassKg:A,endMassKg:B,crossMassKg:C,determinantKg2:D}=this.coupledBoardMass;
          const F0=reducedForce[k]+reducedDamping[k],F1=reducedForce[e]+reducedDamping[e];
          this.pos[k]=old[k]+(old[k]-prior[k])/priorDt*h+h*h*(B*F0-C*F1)/D;
          this.pos[e]=old[e]+(old[e]-prior[e])/priorDt*h+h*h*(A*F1-C*F0)/D;
        } else this.pos[k]=old[k]+(old[k]-prior[k])/priorDt*h + h*h*this.w[node]*(reducedForce[k]+reducedDamping[k]);
      }
    }
    if (this.board && this.supportMotionActive && !this.coupledBoardMass) for (let d=0;d<3;d++) {
      const k=3*this.board.head+d, delta=this.pos[k]-old[k]-decay*(old[k]-prior[k])/priorDt*h;
      // В полной массе планки есть смешанный член Σ m t(1−t).
      // Движение головы меняет предсказание свободного конца даже без силы.
      if (delta!==0) this.pos[3*this.board.end+d] -= this.boardCrossMass/this.boardMass*delta;
    }
    this.reconstruct(); const prediction = this.pos.slice();
    for (const c of this.constraints) c.lambda = 0;
    const solver = this.solve(prediction, h, passes);
    if (!Array.from(this.pos).every(Number.isFinite)) throw new Error('Не-конечная позиция ткани');
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
      const k = 3 * i + d;
      let inertial = (this.pos[k] - prediction[k]) / (h * h * this.w[i]);
      if (this.massCouplings) for (const {a,b,massKg} of this.massCouplings) if (i===a || i===b) {
        const other=3*(i===a?b:a)+d; inertial += massKg*(this.pos[other]-prediction[other])/(h*h);
      }
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
    const support = this.supportMotionActive || this.translatingBody
      ? this.supportAudit(force,h,priorDt,old,prior,dampingForce,materialResidual,hardForce,
          kineticJ-initialKineticJ,softEnergyJ-initialSoftEnergyJ,workJ,dampingWorkJ,hardWorkEstimateJ)
      : null;
    // Без явной команды закрепления неподвижны и их работа равна нулю.
    // constraintForce — оценка из множителей, не реакция, принятая для лодки.
    return { hS: h, passes, initialKineticJ, kineticJ, kineticChangeJ: kineticJ - initialKineticJ,
      initialSoftEnergyJ, softEnergyJ, softEnergyChangeJ: softEnergyJ - initialSoftEnergyJ,
      appliedWorkJ: workJ, dampingWorkJ, hardWorkEstimateJ, supportWorkJ: support?.supportWorkJ ?? 0, complianceResiduals, maxHardViolationM,
      discreteEnergyDefectJ: kineticJ - initialKineticJ + softEnergyJ - initialSoftEnergyJ - workJ - dampingWorkJ - hardWorkEstimateJ - (support?.supportWorkJ ?? 0),
      maxMotionResidualN, rmsMotionResidualN: Math.sqrt(rmsMotionResidualN / Math.max(1, dofs)),
      maxPhysicalResidualN, rmsPhysicalResidualN: Math.sqrt(rmsPhysicalResidualN / Math.max(1, dofs)),
      constraintForce, hardForce, prediction,
      ...(support ?? {}),
      ...(solver ? { solver } : {}),
      interpretation: 'остатки податливости, множителей и физического уравнения измерены отдельно; реакции не приняты' };
  }

  supportAudit(force,h,priorDt,old,prior,dampingForce,materialGradient,hardForce,
      kineticChangeJ,softEnergyChangeJ,appliedWorkJ,dampingWorkJ,hardWorkJ) {
    const supportForceN = new Float64Array(this.pos.length);
    const bodyAttachmentForceN = this.translatingBody ? new Float64Array(this.pos.length) : null;
    const bodyBalanceResidualN = this.translatingBody ? [0,0,0] : null;
    const nodeBalanceResidualN = this.auditNodeBalance ? new Float64Array(this.pos.length) : null;
    let inertiaIncrementJ=0, materialIncrementJ=-softEnergyChangeJ;
    for (let i=0;i<this.mass.length;i++) for (let d=0;d<3;d++) {
      const k=3*i+d, displacement=this.pos[k]-old[k];
      const velocity=displacement/h, priorVelocity=(old[k]-prior[k])/priorDt;
      const residual=this.mass[i]*(velocity-priorVelocity)/h-force[k]-dampingForce[k]+materialGradient[k]-hardForce[k];
      if (nodeBalanceResidualN) nodeBalanceResidualN[k]=residual;
      if (this.coupledBoardMass && this.board.nodes.includes(i)) {
        const weight=1-this.board.fractions[this.board.nodes.indexOf(i)];
        bodyAttachmentForceN[3*this.board.head+d]+=weight*residual;bodyBalanceResidualN[d]+=weight*residual;
      } else if (this.bodyAttachments?.has(i)) { bodyAttachmentForceN[k]=residual; bodyBalanceResidualN[d]+=residual; }
      if (i===this.translatingBody?.node) bodyBalanceResidualN[d]+=residual;
      inertiaIncrementJ += .5*this.mass[i]*(velocity-priorVelocity)**2;
      materialIncrementJ += materialGradient[k]*displacement;
      if (this.board?.nodes.includes(i) && !this.coupledBoardMass) {
        const weight=1-this.board.fractions[this.board.nodes.indexOf(i)];
        supportForceN[3*this.board.head+d] += weight*residual;
      } else if (this.fixed.has(i)) supportForceN[k] += residual;
    }
    let supportWorkJ=0;
    for (const i of this.fixed) for (let d=0;d<3;d++) {
      const k=3*i+d; supportWorkJ += supportForceN[k]*(this.pos[k]-old[k]);
    }
    let bodyAudit;
    if (this.translatingBody) {
      const {node,attachments}=this.translatingBody, bodyForceN=[0,0,0],bodyMomentNm=[0,0,0];
      let bodyWorkJ=0, attachmentWorkJ=0;
      for (const i of attachments) {
        const r=[0,1,2].map(d=>this.pos[3*i+d]-this.pos[3*node+d]);
        const f=[0,1,2].map(d=>-bodyAttachmentForceN[3*i+d]);
        for(let d=0;d<3;d++) {
          bodyForceN[d]+=f[d];bodyWorkJ+=f[d]*(this.pos[3*node+d]-old[3*node+d]);
          attachmentWorkJ-=f[d]*(this.pos[3*i+d]-old[3*i+d]);
        }
        bodyMomentNm[0]+=r[1]*f[2]-r[2]*f[1];bodyMomentNm[1]+=r[2]*f[0]-r[0]*f[2];
        bodyMomentNm[2]+=r[0]*f[1]-r[1]*f[0];
      }
      bodyAudit={bodyAttachmentForceN,bodyForceN,bodyMomentNm,bodyLockMomentNm:bodyMomentNm.map(v=>-v),
        bodyFrame:this.translatingBody.frame,bodyOriginM:Array.from(this.pos.slice(3*node,3*node+3)),
        bodyBalanceResidualN,bodyWorkJ,attachmentWorkJ,bodyWorkCancellationResidualJ:bodyWorkJ+attachmentWorkJ};
    }
    return {supportForceN,supportWorkJ,inertiaIncrementJ,materialIncrementJ,
      discreteBalanceResidualJ:kineticChangeJ+softEnergyChangeJ-appliedWorkJ-dampingWorkJ-hardWorkJ-supportWorkJ+inertiaIncrementJ+materialIncrementJ,
      ...(nodeBalanceResidualN ? {nodeBalanceResidualN} : {}),
      ...bodyAudit};
  }
}
