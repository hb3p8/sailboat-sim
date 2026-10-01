// Жёсткая планка с закреплённым концом: известные работа, инерция и момент.
// Проверяем реальную передачу сил/поправок, не один красивый силуэт паруса.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cloth } from '../sim/cloth.js';
import { Boat } from '../sim/physics.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 2e-12 * Math.max(1, Math.abs(b)),
  `${a} != ${b}`);
const dot = (a, b) => a.reduce((s, x, k) => s + x * b[k], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function rod(rigidBoard = true) {
  const cols = 5, n = 10, head = 5, end = 9;
  const cl = Object.create(Cloth.prototype);
  Object.assign(cl, { rows: 2, cols, n, head, boardEnd: end, rigidBoard,
    boardMaterial: true, boardRest: 2, rowW: [2, 2],
    pos: new Float64Array(n * 3), prev: new Float64Array(n * 3),
    frc: new Float64Array(n * 3), mass: new Float64Array(n).fill(1),
    w: new Float64Array(n).fill(1), px: new Float64Array(n),
    boardTarget: Int32Array.from({ length: n }, (_, i) => i),
    boardFraction: new Float64Array(n).fill(1), boardForce: new Float64Array(3),
    forcesAt() {}, project() { this.board(); } });
  for (let c = 0; c < cols; c++) {
    const i = head + c, t = c / (cols - 1);
    cl.pos[i * 3] = 2 * t; cl.px[i] = 2 * (1 - t);
    cl.mass[i] = c + 1; cl.w[i] = 1 / cl.mass[i];
    cl.boardTarget[i] = end; cl.boardFraction[i] = t;
  }
  cl.w[head] = 0; cl.prev.set(cl.pos);
  if (rigidBoard) cl.prepareBoard();
  return cl;
}

// Независимые тождества для произвольных сил и допустимого смещения конца.
const cl = rod(), masses = cl.mass.slice();
close(cl.boardMass, 8.125); // 2·(1/4)² + 3·(1/2)² + 4·(3/4)² + 5
const displacement = [0, .17, -.09], velocity = [0, -.7, .4];
let work = 0, energy = 0, torque = [0, 0, 0];
for (let c = 0; c < cl.cols; c++) {
  const i = cl.head + c, t = c / (cl.cols - 1), force = [c - 1, 3 - c, 2 * c];
  cl.frc.set(force, i * 3);
  work += t * dot(force, displacement);
  energy += .5 * (c + 1) * t * t * dot(velocity, velocity);
  const moment = cross([2 * t, 0, 0], force);
  torque = torque.map((x, k) => x + moment[k]);
}
const raw = cl.frc.slice(), force = cl.boardForces();
close(dot(force, displacement), work);
close(.5 * cl.boardMass * dot(velocity, velocity), energy);
cross([2, 0, 0], force).forEach((x, k) => close(x, torque[k]));
assert.deepEqual(cl.frc, raw); assert.deepEqual(cl.mass, masses);

// Поперечная сила 8 Н только на середине: прежний вариант её стирает.
const legacy = rod(false); legacy.frc[(legacy.head + 2) * 3 + 1] = 8;
legacy.advance(null, .001, 1, null);
assert.equal(legacy.pos[legacy.boardEnd * 3 + 1], 0);
for (const sign of [1, -1]) for (const h of [.001, .0005]) {
  const c = rod(); c.frc[(c.head + 2) * 3 + 1] = sign * 8;
  c.advance(null, h, sign, null);
  const predictedY = sign * h * h * 4 / 8.125;
  const scale = 2 / Math.hypot(2, predictedY);
  close(c.pos[c.boardEnd * 3 + 1], predictedY * scale);
  for (let col = 0; col < c.cols; col++)
    close(c.pos[(c.head + col) * 3 + 1], col / 4 * predictedY * scale);
  close(Math.hypot(...c.pos.slice(c.boardEnd * 3, c.boardEnd * 3 + 3)), 2);
  assert.ok(c.pos[c.boardEnd * 3 + 1] * sign > 0);
}
const headOnly = rod(); headOnly.frc[headOnly.head * 3 + 1] = 8;
headOnly.advance(null, .001, 1, null);
close(headOnly.pos[headOnly.boardEnd * 3 + 1], 0);
for (const length of [1.7, 2.3]) {
  const c = rod(); c.pos[c.boardEnd * 3] = length; c.board();
  close(c.pos[c.boardEnd * 3], 2); // двусторонняя жёсткость
}

// Аналитические поправки одной связи в исключённых координатах, до сферы.
const pull = rod(); pull.board = () => {};
pull.pos.set([1, 1, 0], 0); pull.w[0] = 0;
Object.assign(pull, { ci: [pull.head + 2], cj: [0], ck: [1], rest: [.5] });
pull.sweep(null, 1);
close(pull.pos[pull.boardEnd * 3], 2);
close(pull.pos[pull.boardEnd * 3 + 1], 1);
// Оба узла ведут к одному концу: сумма градиентов, а не сумма квадратов.
const same = rod(); same.board = () => {};
same.pos[same.boardEnd * 3] = 2.2;
Object.assign(same, { ci: [same.head + 1], cj: [same.head + 3], ck: [1], rest: [1] });
same.sweep(null, 1); close(same.pos[same.boardEnd * 3], 2);
console.log('ок: работа, инерция, момент, сила на середине, обе стороны, якобианы связей');

// Независимое уравнение угла: I θ'' + 6 I θ' = F_end L cos θ.
// Точечная RK4-опора проверяет движение, не только одно предсказание координат.
const duration = .5, referenceH = 1e-5;
let theta = 0, speed = 0;
const acceleration = (angle, velocity) => 4 / (8.125 * 2) * Math.cos(angle) - 6 * velocity;
for (let step = 0; step < Math.round(duration / referenceH); step++) {
  const a1 = acceleration(theta, speed);
  const v2 = speed + .5 * referenceH * a1, t2 = theta + .5 * referenceH * speed;
  const a2 = acceleration(t2, v2);
  const v3 = speed + .5 * referenceH * a2, t3 = theta + .5 * referenceH * v2;
  const a3 = acceleration(t3, v3);
  const v4 = speed + referenceH * a3, t4 = theta + referenceH * v3;
  const a4 = acceleration(t4, v4);
  theta += referenceH * (speed + 2 * v2 + 2 * v3 + v4) / 6;
  speed += referenceH * (a1 + 2 * a2 + 2 * a3 + a4) / 6;
}
let previousError = Infinity;
const errors = [];
for (const hz of [60, 120, 240]) {
  const c = rod(); c.frc[(c.head + 2) * 3 + 1] = 8;
  for (let step = 0; step < duration * hz; step++) c.advance(null, 1 / hz, 1, null);
  const angle = Math.atan2(c.pos[c.boardEnd * 3 + 1], c.pos[c.boardEnd * 3]);
  const error = Math.abs(angle - theta);
  assert.ok(error < previousError, 'Уточнение шага не приближает движение к уравнению угла');
  previousError = error; errors.push(error);
}
console.log(`ок: движение к независимой угловой опоре, ошибки 60/120/240 Гц ${errors.map(x => x.toExponential(3)).join('/')} рад`);

// Настоящий крой: геометрия, локальная масса и давление не заменяются.
const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url)));
for (const side of [1, -1]) for (const cols of [9, 17, 33]) {
  const b = new Boat(pack);
  b.setGennaker(true); b.o.genSheetLen = 9;
  b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * Math.PI / 180;
  b.u = 3; b.psi = (100 - side * 140) * Math.PI / 180; b.step(1 / 30);
  const options = { rows: 11, cols, iter: 10, attachmentPaths: true };
  const old = new Cloth(b.rig.sails[2], 2, options);
  const rigid = new Cloth(b.rig.sails[2], 2, { ...options, rigidBoard: true });
  old.step(b, 1 / 30); rigid.step(b, 1 / 30);
  for (const key of ['dx', 'dy', 'dz', 'rest', 'area', 'mass'])
    assert.deepEqual(rigid[key], old[key], key);
  let expected = 0;
  for (let c = 0; c < cols; c++) expected += rigid.mass[rigid.head + c] * (c / (cols - 1)) ** 2;
  close(rigid.boardMass, expected);
  for (let step = 0; step < 3; step++) {
    rigid.step(b, 1 / 30);
    const h = rigid.head * 3, e = rigid.boardEnd * 3;
    close(Math.hypot(...[0, 1, 2].map(d => rigid.pos[e + d] - rigid.pos[h + d])), rigid.boardRest);
    for (let c = 0; c < cols; c++) for (let d = 0; d < 3; d++)
      close(rigid.pos[(rigid.head + c) * 3 + d],
        rigid.pos[h + d] + c / (cols - 1) * (rigid.pos[e + d] - rigid.pos[h + d]));
    assert.ok(rigid.pos.every(Number.isFinite));
  }
}
console.log('ок: настоящий крой, две стороны, три сетки, неизменные площадь/масса и жёсткая длина');
