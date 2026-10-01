// Известная работа силы, независимая жёсткость и неизменность наблюдаемой ткани.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cloth } from '../sim/cloth.js';
import { Boat } from '../sim/physics.js';
import { distance, solveConstraint } from './cloth-compliance.mjs';
import { observeClothMechanics, kineticOf, constraintErrorsOf } from './lib/cloth-mechanics.mjs';
const close = (a, b) => assert.ok(Math.abs(a - b) < 2e-12 * Math.max(1, Math.abs(b)), `${a} != ${b}`);

// Одна коллинеарная мягкая связь: реальный sweep против замкнутой формулы.
for (const stiffness of [.3, .05]) for (const passes of [1, 4, 16, 40]) {
  const c = { pos: new Float64Array([0, 0, 0, 1.1, 0, 0]), ci: [0], cj: [1],
    ck: [-stiffness], rest: [1], w: [0, 1], board() {} };
  for (let pass = 0; pass < passes; pass++) Cloth.prototype.sweep.call(c, null, 1);
  close(c.pos[3] - 1, .1 * (1 - stiffness) ** passes);
}
// Те же Н/м и масса: податливая связь не меняет свой закон с числом проходов.
for (const h of [1 / 60, 1 / 120]) for (const passes of [1, 4, 40, 160]) {
  const mass = 2, force = 4, stiffness = 50;
  const p = new Float64Array([0, 0, 0, 1 + h * h * force / mass, 0, 0]);
  const con = distance(0, 1, 1, 1 / stiffness);
  for (let i = 0; i < passes; i++) solveConstraint(p, [0, 1 / mass], con, h);
  close(p[3] - 1, h * h * force / (mass + h * h * stiffness));
}
console.log('ок: независимая зависимость прежней мягкой связи от проходов; фиксированные Н/м сохраняют закон');

const particle = Object.create(Cloth.prototype);
Object.assign(particle, { n: 1, pos: new Float64Array(3), prev: new Float64Array(3),
  frc: new Float64Array(3), pressureForce: new Float64Array([2]),
  nrm: new Float64Array([1, 0, 0]), mass: new Float64Array([2]), w: new Float64Array([.5]),
  forcesAt() { this.frc[0] = 4; }, project() {} });
const observer = observeClothMechanics(particle);
particle.advance(null, .01, 1, null);
const m = observer.snapshot();
close(m.workJ.pressure, .0004); close(m.workJ.otherApplied, .0004);
close(m.kineticJ, .0004); close(m.kineticChangeJ, .0004);
assert.equal(m.materialEnergyJ, null); assert.equal(m.supportWorkJ, null);
assert.equal(m.projectionReactionsMeasured, false);
assert.deepEqual(m.stepsByH, [{ hS: .01, count: 1 }]);
observer.reset(); assert.equal(observer.snapshot().substeps, 0); observer.detach();

// Зависимые массы жёсткой планки входят в энергию, закреплённая точка — нет.
const rod = { n: 3, head: 0, rigidBoard: true, mass: [1, 2, 3], w: [0, 0, 1],
  pos: [0, 0, 0, 0, .5, 0, 0, 1, 0], prev: new Float64Array(9) };
close(kineticOf(rod, 1), 1.75);
console.log('ок: известная работа и энергия, зависимые массы, неизвестные реакции не подменены');

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url)));
function boat(side) {
  const b = new Boat(pack); b.o.cloth = { attachmentPaths: true, rigidBoard: true };
  b.setGennaker(true); b.o.genSheetLen = 9;
  b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * Math.PI / 180;
  b.u = 3; b.psi = (100 - side * 140) * Math.PI / 180;
  return b;
}
for (const side of [1, -1]) {
  const plain = boat(side), observed = boat(side), cl = observed.rig.cloth;
  const audit = observeClothMechanics(cl);
  for (let i = 0; i < 45; i++) { plain.step(1 / 30); observed.step(1 / 30); }
  for (const key of ['pos', 'prev', 'frc', 'pressureForce', 'mass', 'w'])
    assert.deepEqual(cl[key], plain.rig.cloth[key], key);
  for (const key of ['u', 'v', 'r', 'phi', 'psi', 't']) assert.equal(observed[key], plain[key]);
  const errors = constraintErrorsOf(cl);
  assert.equal(Object.values(errors).reduce((n, g) => n + g.count, 0), cl.ci.length);
  assert.equal(errors.luff.count, cl.rows - 1); assert.equal(errors.leech.count, cl.rows - 1);
  assert.equal(errors.board.count, cl.cols - 1); assert.equal(errors.shear.count, 2 * (cl.rows - 1) * (cl.cols - 1));
  assert.ok(audit.snapshot().substeps > 0); audit.detach();
}
for (const hz of [30, 60, 120]) {
  const b = boat(1), cl = b.rig.cloth, audit = observeClothMechanics(cl);
  cl.step(b, 1 / hz); audit.reset();
  for (let i = 0; i < 2; i++) cl.step(b, 1 / hz);
  const h = hz <= 60 ? 1 / 60 : 1 / 120;
  assert.deepEqual(audit.snapshot().stepsByH, [{ hS: h, count: hz === 30 ? 4 : 2 }]);
  audit.detach();
}
console.log('ок: наблюдатель не меняет ткань/лодку, семьи связей и фактический шаг 30/60/120 кадров');
