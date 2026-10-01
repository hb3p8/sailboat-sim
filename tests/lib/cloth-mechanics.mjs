// Чтение работы приложенных сил и кинетической энергии полной ткани.
// Поправки положения не выдаются за физические реакции или энергию материала.
export function constraintFamily(cloth, k) {
  const a = cloth.ci[k], cols = cloth.cols, row = Math.floor(a / cols), col = a % cols;
  if (k < cloth.rows * (cols - 1))
    return row === 0 ? 'foot' : row === cloth.rows - 1 ? 'board' : 'rows';
  if (k < cloth.localHardCount)
    return col === 0 ? 'luff' : col === cols - 1 ? 'leech' : 'span';
  if (k < cloth.localHardCount + 2 * (cloth.rows - 1) * (cols - 1)) return 'shear';
  return k < cloth.attachmentStart ? 'bend' : 'attachments';
}

export function constraintErrorsOf(cloth) {
  const groups = {};
  for (let k = 0; k < cloth.ci.length; k++) {
    const name = constraintFamily(cloth, k);
    const g = groups[name] ||= { count: 0, active: 0, maxExtensionM: 0,
      maxCompressionM: 0, maxRelativeExtension: 0, rmsViolationM: 0 };
    g.count++;
    if (cloth.ck[k] === 0) continue;
    g.active++;
    const a = 3 * cloth.ci[k], b = 3 * cloth.cj[k], p = cloth.pos;
    const error = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2])
      - cloth.rest[k];
    if (!Number.isFinite(error)) throw new Error('Не-конечная длина связи');
    const violation = cloth.ck[k] < 0 ? Math.abs(error) : Math.max(0, error);
    g.maxExtensionM = Math.max(g.maxExtensionM, error);
    g.maxCompressionM = Math.max(g.maxCompressionM, -error);
    g.maxRelativeExtension = Math.max(g.maxRelativeExtension, error / Math.max(1e-12, cloth.rest[k]));
    g.rmsViolationM += violation * violation;
  }
  for (const g of Object.values(groups)) g.rmsViolationM = Math.sqrt(g.rmsViolationM / Math.max(1, g.active));
  return groups;
}

export function kineticOf(cloth, h) {
  let energy = 0;
  for (let i = 0; i < cloth.n; i++) {
    // Зависимые точки планки движутся вместе с концом; mass остаётся исходной
    // массой узла. Сумма равна энергии с эффективной массой конца при fixed head.
    const moving = cloth.w[i] > 0 || (cloth.rigidBoard && i > cloth.head);
    if (!moving) continue;
    for (let d = 0; d < 3; d++) {
      const velocity = (cloth.pos[3 * i + d] - cloth.prev[3 * i + d]) / h;
      energy += .5 * cloth.mass[i] * velocity * velocity;
    }
  }
  if (!Number.isFinite(energy)) throw new Error('Не-конечная кинетическая энергия');
  return energy;
}

export function observeClothMechanics(cloth) {
  const advance = cloth.advance, forcesAt = cloth.forcesAt;
  let before, applied, pressure, beforeKinetic, currentH;
  let substeps, elapsedS, pressureWork, otherWork, kineticChange, kineticJ, maxKineticJ;
  let pressureFirst, maxPressureVectorChangeN, stepsByH;
  const reset = () => {
    substeps = elapsedS = pressureWork = otherWork = kineticChange = kineticJ = maxKineticJ = 0;
    maxPressureVectorChangeN = 0; pressureFirst = null; stepsByH = new Map();
  };
  reset();
  cloth.forcesAt = function (...args) {
    const result = forcesAt.apply(this, args);
    before = this.pos.slice(); applied = this.frc.slice();
    pressure = new Float64Array(this.n * 3);
    currentH = args[1]; beforeKinetic = kineticOf(this, currentH);
    for (let i = 0; i < this.n; i++) for (let d = 0; d < 3; d++)
      pressure[3 * i + d] = this.pressureForce[i] * this.nrm[3 * i + d];
    if (!pressureFirst) pressureFirst = pressure.slice();
    for (let k = 0; k < pressure.length; k++)
      maxPressureVectorChangeN = Math.max(maxPressureVectorChangeN, Math.abs(pressure[k] - pressureFirst[k]));
    return result;
  };
  cloth.advance = function (...args) {
    before = null;
    const result = advance.apply(this, args);
    if (!before || !(currentH > 0)) throw new Error('Нет снимка приложенных сил в подшаге');
    let wp = 0, wo = 0;
    for (let k = 0; k < before.length; k++) {
      const delta = this.pos[k] - before[k];
      wp += pressure[k] * delta; wo += (applied[k] - pressure[k]) * delta;
    }
    kineticJ = kineticOf(this, currentH);
    if (![wp, wo].every(Number.isFinite)) throw new Error('Не-конечная работа нагрузки');
    pressureWork += wp; otherWork += wo; kineticChange += kineticJ - beforeKinetic;
    maxKineticJ = Math.max(maxKineticJ, kineticJ); elapsedS += currentH; substeps++;
    const key = String(currentH);
    stepsByH.set(key, (stepsByH.get(key) || 0) + 1);
    return result;
  };
  return { reset,
    snapshot: () => ({ substeps, elapsedS, stepsByH: Array.from(stepsByH, ([h, count]) => ({ hS: Number(h), count })),
      workJ: { pressure: pressureWork, otherApplied: otherWork, totalApplied: pressureWork + otherWork },
      kineticJ, kineticChangeJ: kineticChange, maxKineticJ, maxPressureVectorChangeN,
      materialEnergyJ: null, supportWorkJ: null, projectionReactionsMeasured: false,
      workRule: 'узловая сила до движения · полное перемещение за подшаг; не полный баланс энергии' }),
    detach: () => { cloth.advance = advance; cloth.forcesAt = forcesAt; },
  };
}
