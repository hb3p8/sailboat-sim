// Браузерный повтор сохранённой постановки. Те же энергия, силы и решатель.
import { materialSurface, gridTriangles, MODEL_MATERIAL } from './cloth-material.mjs';
import { ImplicitEnergyMotion } from './cloth-implicit-motion.mjs';
import { distance } from '../cloth-compliance.mjs';
import { installSharedInput } from './cloth-shared-input.mjs';

export function browserMotion(recipe, wasmSparseFactor) {
  const { rows, cols, reference, positions, previous, mass, fixed, board, hard, field, boat } = recipe;
  const surface = materialSurface(Float64Array.from(reference), gridTriangles(rows, cols), MODEL_MATERIAL,
    { bendingModel: 'curvature', rows, cols });
  const constraints = [...surface.constraints.map(c => ({ ...c, unit: c.family === 'bending' ? '1/м' : '1' })),
    ...hard.map(c => Object.assign(distance(c.a, c.b, c.rest, 0, c.unilateral), { family: c.family }))];
  const motion = new ImplicitEnergyMotion({ positions, mass, fixed, board, constraints,
    dampingHz: 6, gridRows: rows, gridCols: cols, linearBackend: 'kkt-wasm', wasmSparseFactor });
  // Штатное подключение оставляет исходные массивы Cloth общими с решателем.
  motion.pos = Float64Array.from(positions); motion.prev = Float64Array.from(previous);
  motion.prevDt = recipe.prevDt;
  const cloth = { rows, cols, n: rows * cols, rigidBoard: true, freeClew: false,
    pos: motion.pos, prev: motion.prev, frc: new Float64Array(positions.length),
    nrm: new Float64Array(positions.length), pattern() {},
    velocityDt(h) { return motion.prevDt > 0 ? motion.prevDt : h; } };
  installSharedInput(cloth, field);
  return { motion, surface, forceN:cloth.frc, step(supportTargets) {
    cloth.forcesAt(boat, recipe.hS);
    return motion.step(cloth.frc, recipe.hS, recipe.iterations,supportTargets);
  } };
}
