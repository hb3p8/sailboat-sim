// Подключение исследовательской энергии к замороженному стенду, не к Boat.
import { materialSurface, gridTriangles, MODEL_MATERIAL } from './cloth-material.mjs';
import { EnergyMotion } from './cloth-energy-motion.mjs';
import { ImplicitEnergyMotion } from './cloth-implicit-motion.mjs';
import { distance } from '../cloth-compliance.mjs';
import { constraintFamily } from './cloth-mechanics.mjs';

export function installEnergyExperiment(cloth, { implicit = false, linearBackend = 'band-js', wasmSparseFactor } = {}) {
  if (!cloth.rigidBoard || cloth.freeClew) throw new Error('Нужны неподвижные углы и исключённая верхняя планка');
  const kept = [], counts = {};
  for (let k = 0; k < cloth.ci.length; k++) {
    const family = constraintFamily(cloth, k), boundary = ['foot', 'luff', 'leech'].includes(family);
    cloth.ck[k] = boundary ? 1 : 0;
    if (boundary) { kept.push(k); counts[family] = (counts[family] || 0) + 1; }
  }
  let motion, surface, last, totals;
  const reset = () => { totals = { substeps: 0, elapsedS: 0, appliedWorkJ: 0, dampingWorkJ: 0,
    hardWorkEstimateJ: 0, discreteEnergyDefectJ: 0, maxPhysicalResidualN: 0,
    maxMotionResidualN: 0, maxHardViolationM: 0, initialSoftEnergyJ: null, initialKineticJ: null,
    ...(implicit ? { solverIterations: 0, maxSolverIterations: 0, qpIterations: 0, lineSearchReductions: 0, responseSolves: 0 } : {}) }; };
  reset();
  cloth.advance = function (boat, h, side, environment) {
    if (!motion) {
      const reference = Float64Array.from({ length: this.n * 3 }, (_, k) =>
        [this.dx, this.dy, this.dz][k % 3][Math.floor(k / 3)]);
      surface = materialSurface(reference, gridTriangles(this.rows, this.cols), MODEL_MATERIAL,
        { bendingModel: 'curvature', rows: this.rows, cols: this.cols });
      const hard = kept.map(k => Object.assign(distance(this.ci[k], this.cj[k], this.rest[k], 0, true),
        { family: constraintFamily(this, k) }));
      hard.push(Object.assign(distance(this.head, this.boardEnd, this.boardRest, 0), { family: 'board' }));
      const nodes = Array.from({ length: this.cols }, (_, c) => this.head + c);
      const Motion = implicit ? ImplicitEnergyMotion : EnergyMotion;
      motion = new Motion({ positions: this.pos, mass: this.mass,
        fixed: [this.tack, this.head, this.clew],
        board: { head: this.head, end: this.boardEnd, nodes, fractions: nodes.map(i => this.boardFraction[i]) },
        ...(implicit ? { gridRows: this.rows, gridCols: this.cols, linearBackend, wasmSparseFactor } : {}),
        constraints: [...surface.constraints.map(c => ({ ...c, unit: c.family === 'bending' ? '1/м' : '1' })), ...hard], dampingHz: 6 });
      // Общие массивы: форма, нормали давления и измерители читают один результат.
      motion.pos = this.pos; motion.prev = this.prev;
    }
    motion.prevDt = this.prevDt;
    this.forcesAt(boat, h, side, environment);
    last = motion.step(this.frc, h, this.iter); this.prevDt = motion.prevDt;
    if (!totals.substeps) { totals.initialSoftEnergyJ = last.initialSoftEnergyJ; totals.initialKineticJ = last.initialKineticJ; }
    totals.substeps++; totals.elapsedS += h;
    for (const name of ['appliedWorkJ', 'dampingWorkJ', 'hardWorkEstimateJ', 'discreteEnergyDefectJ']) totals[name] += last[name];
    for (const name of ['maxPhysicalResidualN', 'maxMotionResidualN', 'maxHardViolationM']) totals[name] = Math.max(totals[name], last[name]);
    if (last.solver) {
      totals.solverIterations += last.solver.iterations;
      totals.maxSolverIterations = Math.max(totals.maxSolverIterations, last.solver.iterations);
      totals.qpIterations += last.solver.qpIterations;
      totals.lineSearchReductions += last.solver.lineSearchReductions;
      totals.responseSolves += last.solver.responseSolves;
    }
  };
  return { reset, snapshot() {
    if (!last) return null;
    const { constraintForce, hardForce, prediction, ...summary } = last;
    return { ...summary, totals: { ...totals }, material: surface.evaluate(cloth.pos), parameters: surface.parameters,
      hardBoundaryCounts: { ...counts, board: 1 }, softConstraints: surface.constraints.length,
      interiorHardEdges: false, attachmentBounds: false, dampingHz: 6,
      actualSupportReactionsAccepted: false,
      implicitMotion: implicit,
      rule: 'только новая энергия; жёсткие кромки и длина планки; прежние мягкие связи/дальние пределы не действуют' };
  } };
}
