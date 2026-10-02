// Форма и движение при смене координат; прямые натянутые кромки — отдельный отрицательный контроль.
import assert from 'node:assert/strict';
import { ImplicitEnergyMotion, IMPLICIT_TOLERANCES } from './lib/cloth-implicit-motion.mjs';
import { materialSurface, gridTriangles, MODEL_MATERIAL } from './lib/cloth-material.mjs';
import { distance } from './cloth-compliance.mjs';
import { readFileSync } from 'node:fs';
import { loadSparseFactor } from './lib/cloth-sparse-wasm.mjs';

const args = process.argv.slice(2);
const backendArg = args.find(a => a.startsWith('--linear-backend=')), wasmArg = args.find(a => a.startsWith('--wasm='));
if (args.some(a => a !== '--straight-control' && a !== backendArg && a !== wasmArg) || new Set(args).size !== args.length)
  throw new Error('Допустимы --straight-control, --linear-backend=способ и --wasm=путь');
const backendOptions = { linearBackend: backendArg?.slice(17) ?? 'band-js',
  ...(wasmArg ? { wasmSparseFactor: await loadSparseFactor(readFileSync(wasmArg.slice(7))) } : {}) };
const straight = args.includes('--straight-control');
const rows = 4, cols = 7, reference = [];
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const x = 2 * c / (cols - 1), y = r / (rows - 1);
  const curve = straight ? 0 : .05 * (Math.sin(Math.PI * x / 2) * (1 - y) + Math.sin(Math.PI * y) * (1 - x / 2));
  reference.push(x, y, .08 * x * y + curve);
}
const rotate = ([x, y, z]) => {
  const a = .7, b = .3, u = Math.cos(a) * x - Math.sin(a) * y, v = Math.sin(a) * x + Math.cos(a) * y;
  return [u, Math.cos(b) * v - Math.sin(b) * z, Math.sin(b) * v + Math.cos(b) * z];
};
const variants = [
  { name: 'исходный', map: v => v },
  { name: 'поворот', map: rotate },
  { name: 'зеркало', map: ([x, y, z]) => [x, -y, z] },
  { name: 'перенос', map: v => v, shift: [3, -5, 2] },
];
const referenceForce = [.2, -.1, .4], results = [];
for (const variant of variants) {
  const transformed = [];
  for (let i = 0; i < rows * cols; i++)
    transformed.push(...variant.map(reference.slice(3 * i, 3 * i + 3)).map((v, d) => v + (variant.shift?.[d] || 0)));
  const material = materialSurface(transformed, gridTriangles(rows, cols), MODEL_MATERIAL,
    { bendingModel: 'curvature', rows, cols });
  const hard = [], length = (a, b) => Math.hypot(...[0, 1, 2].map(d => transformed[3 * a + d] - transformed[3 * b + d]));
  for (let c = 0; c < cols - 1; c++) hard.push(distance(c, c + 1, length(c, c + 1), 0, true));
  for (let r = 0; r < rows - 1; r++) for (const c of [0, cols - 1]) {
    const a = r * cols + c, b = a + cols;
    hard.push(distance(a, b, length(a, b), 0, true));
  }
  const head = (rows - 1) * cols, end = rows * cols - 1;
  hard.push(distance(head, end, length(head, end), 0));
  const motion = new ImplicitEnergyMotion({ positions: transformed,
    ...backendOptions,
    mass: new Float64Array(rows * cols).fill(.3), fixed: [0, cols - 1, head],
    constraints: [...material.constraints, ...hard], gridRows: rows, gridCols: cols,
    board: { head, end, nodes: Array.from({ length: cols }, (_, c) => head + c),
      fractions: Array.from({ length: cols }, (_, c) => c / (cols - 1)) } });
  const transformedForce = variant.map(referenceForce);
  const force = Float64Array.from({ length: reference.length }, (_, k) => transformedForce[k % 3]);
  let audit, maxResidual = 0;
  for (let step = 0; step < 12; step++) {
    audit = motion.step(force, 1 / 60, 40);
    maxResidual = Math.max(maxResidual, audit.maxPhysicalResidualN);
    assert.ok(audit.maxPhysicalResidualN <= IMPLICIT_TOLERANCES.forceToleranceN);
    assert.ok(audit.maxHardViolationM <= IMPLICIT_TOLERANCES.lengthToleranceM);
  }
  const result = { name: variant.name, positions: Array.from(motion.pos),
    energyJ: material.evaluate(motion.pos).totalJ, appliedWorkJ: audit.appliedWorkJ,
    kineticJ: audit.kineticJ, maxResidualN: maxResidual };
  if (results.length) {
    const base = results[0];
    let maxDifferenceM = 0;
    for (let i = 0; i < rows * cols; i++) {
      const expected = variant.map(base.positions.slice(3 * i, 3 * i + 3));
      for (let d = 0; d < 3; d++) maxDifferenceM = Math.max(maxDifferenceM,
        Math.abs(result.positions[3 * i + d] - expected[d] - (variant.shift?.[d] || 0)));
    }
    assert.ok(maxDifferenceM < 1e-9, `Смена координат ${variant.name}: ${maxDifferenceM} м`);
    for (const key of ['energyJ', 'appliedWorkJ', 'kineticJ'])
      assert.ok(Math.abs(result[key] - base[key]) < 1e-10, `${variant.name}: ${key}`);
    result.maxDifferenceM = maxDifferenceM;
  }
  results.push(result);
  console.log(JSON.stringify({ ...result, positions: undefined }));
}

// Без закреплений внутренние силы не меняют движение центра массы.
// Известное решение использует только общую массу, внешнюю силу и затухание.
const mass = Float64Array.from({ length: rows * cols }, (_, i) => .2 + .01 * i);
const freeMaterial = materialSurface(reference, gridTriangles(rows, cols), MODEL_MATERIAL,
  { bendingModel: 'curvature', rows, cols });
const freeMotion = new ImplicitEnergyMotion({ positions: reference, mass,
  ...backendOptions,
  constraints: freeMaterial.constraints, gridRows: rows, gridCols: cols, forceToleranceN: 1e-9 });
const force = new Float64Array(reference.length);
force.set(referenceForce, 3 * 10);
const totalMass = mass.reduce((sum, m) => sum + m, 0), h = 1 / 60, steps = 12;
const decay = Math.exp(-freeMotion.dampingHz * h);
const center = p => [0, 1, 2].map(d => mass.reduce((sum, m, i) => sum + m * p[3 * i + d], 0) / totalMass);
const initialCenter = center(reference);
let audit;
for (let step = 0; step < steps; step++) {
  audit = freeMotion.step(force, h, 40);
  assert.ok(audit.maxPhysicalResidualN < 1e-9);
}
const finalCenter = center(freeMotion.pos);
const factor = h * h / (1 - decay) * (steps - decay * (1 - decay ** steps) / (1 - decay));
let maxCenterErrorM = 0;
for (let d = 0; d < 3; d++) {
  const error = Math.abs(finalCenter[d] - initialCenter[d] - factor * referenceForce[d] / totalMass);
  maxCenterErrorM = Math.max(maxCenterErrorM, error);
  assert.ok(error < 1e-10, `Центр массы: ${error} м`);
}
console.log(JSON.stringify({ name: 'центр массы без закреплений', totalMassKg: totalMass,
  maxCenterErrorM, energyJ: freeMaterial.evaluate(freeMotion.pos).totalJ, residualN: audit.maxPhysicalResidualN }));
