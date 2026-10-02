// Независимый контроль измерителя; его пределы не принимают физическую модель.
import assert from 'node:assert/strict';
import { compareResults } from './cloth-solver-comparison.mjs';
import { IMPLICIT_TOLERANCES } from './lib/cloth-implicit-motion.mjs';
const energy = { parameters: { K: 1000 }, softEnergyJ: 2, solver: { ...IMPLICIT_TOLERANCES,
  converged: true, maxForceResidualN: 1e-7, maxHardViolationM: 1e-12, complementarityJ: 1e-10 },
  totals: { maxPhysicalResidualN: 2e-7, maxHardViolationM: 1e-12, appliedWorkJ: 3 } };
const base = { rows: 1, cols: 1, initialInput: { massKg: 1 }, referencePositionsM: [0, 0, 0],
  finalPositionsM: [0, 0, 0], warmup: { energyMotion: energy }, energyMotion: energy,
  mechanics: { workJ: { pressure: 3 } }, samples: [{ timeS: 0, positionsM: [0, 0, 0], energyMotion: energy }], wallSeconds: 10 };
const changed = structuredClone(base); changed.finalPositionsM = [3e-9, 4e-9, 0]; changed.wallSeconds = 2;
changed.mechanics.workJ.pressure += 5e-8;
const r = compareResults(base, changed);
assert.ok(Math.abs(r.maxPositionDifferenceM - 5e-9) < 1e-23);
assert.ok(Math.abs(r.maxEnergyDifferenceJ - 5e-8) < 1e-15); assert.equal(r.measuredSpeedup, 5);
for (const change of [
  x => x.finalPositionsM[0] = 2e-8,
  x => x.mechanics.workJ.pressure += 2e-7,
  x => x.initialInput.massKg = 2,
  x => x.energyMotion.solver.forceToleranceN = 2e-6,
  x => x.energyMotion.totals.maxPhysicalResidualN = 2e-6,
]) { const bad = structuredClone(base); change(bad); assert.throws(() => compareResults(base, bad)); }
console.log('ок: измеритель известных отличий 3–4–5, работы, скорости и отказов несовпадающих условий');
