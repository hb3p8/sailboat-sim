// Независимые геометрические и механические пределы измерителей приёмки.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cloth } from '../sim/cloth.js';
import { Boat } from '../sim/physics.js';
import { localPressure, pressureToNodes } from '../sim/local-pressure.js';
import { sectionsOf, wrenchOf, clothPressureOf, stripLoadOf, sheetGeometryOf, rollVector,
  stabilityOf, entryCycles } from './lib/gennaker-observables.mjs';

const close = (a, b, eps = 1e-10) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const vector = (a, b) => a.forEach((v, i) => close(v, b[i]));

// Известная полилиния; тот же rowShape читает её в независимом опыте и Cloth
// в лодке. Высота/масштаб различают долю и индекс строки, стороны зеркальны.
function sectionFixture(points, scale = 1, side = 1) {
  return {
    rows: 21, cols: points.length, rowShape: Cloth.prototype.rowShape,
    sample(row, u, out) {
      const x = u * (points.length - 1), i = Math.min(points.length - 2, Math.floor(x));
      const t = x - i;
      out[0] = scale * (points[i][0] * (1 - t) + points[i + 1][0] * t);
      out[1] = side * scale * (points[i][1] * (1 - t) + points[i + 1][1] * t);
      out[2] = row;
      return out;
    },
  };
}
const arc = [[0, 0], [0.25, 0.2], [0.5, 0.25], [0.75, 0.2], [1, 0]];
const ordinary = sectionsOf(sectionFixture(arc));
assert.equal(ordinary.length, 9);
assert.equal(ordinary[0].row, 2);
assert.equal(ordinary[8].row, 18);
for (const row of ordinary) {
  close(row.chord, 1); close(row.camber, 0.25); close(row.draft, 0.5);
  close(row.entry, Math.atan2(0.2, 0.25)); close(row.back, 0); close(row.flip, 0);
}
const mirrored = sectionsOf(sectionFixture(arc, 4, -1));
ordinary.forEach((row, i) => {
  close(mirrored[i].chord, 4 * row.chord);
  for (const key of ['entry', 'camber', 'back', 'flip', 'draft', 'kink'])
    close(mirrored[i][key], row[key]);
});
const curl = sectionsOf(sectionFixture([[0, 0], [0.1, -0.04], [0.5, 0.25], [1, 0]]));
assert.ok(curl.every(s => s.entry < 0));
const reversed = sectionsOf(sectionFixture([[0, 0], [-0.1, -0.04], [0.5, 0.25], [1, 0]]));
close(reversed[0].back, 0.1);
assert.throws(() => sectionsOf(sectionFixture(arc), [1.1]));
console.log('ок: доли 10–90%, известная форма, заворот, ход назад, зеркало и масштаб');

const points = [[0, 0, 2], [1, 0, 2], [2, 0, 2]];
const forces = [[0, 1, 0], [0, 2, 0], [0, 3, 0]];
const origin = [1, 0, 1], direct = wrenchOf(points, forces, origin);
vector(direct.forceN, [0, 6, 0]); vector(direct.momentNm, [-6, 0, 2]);
// Нулевая сумма сил сохраняет ненулевой момент; центр давления тогда не нужен.
const couple = wrenchOf([[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [0, -1, 0]]);
vector(couple.forceN, [0, 0, 0]); vector(couple.momentNm, [0, 0, -1]);
const translated = wrenchOf(points.map(p => p.map((v, k) => v + [10, 20, 30][k])),
  forces, origin.map((v, k) => v + [10, 20, 30][k]));
assert.deepEqual(translated, direct);
const cloth = { n: 3, cols: 3, pos: Float64Array.from(points.flat()),
  nrm: Float64Array.from([[0, 1, 0], [0, 1, 0], [0, 1, 0]].flat()),
  pressureForce: Float64Array.from([1, 2, 3]), _areaNow: [0.5, 0.5, 0.5] };
const measured = clothPressureOf(cloth, 0, origin);
assert.deepEqual(measured.forceN, direct.forceN);
assert.deepEqual(measured.momentNm, direct.momentNm);
close(measured.maxEquivalentPa, 6);
const rolled = clothPressureOf(cloth, Math.PI / 2);
vector(rolled.forceN, [0, 0, 6]); vector(rolled.momentNm, [-12, -8, 0]);
const reflected = wrenchOf(points.map(([x, y, z]) => [x, -y, z]),
  forces.map(([x, y, z]) => [x, -y, z]), origin);
vector(reflected.forceN, [0, -6, 0]); vector(reflected.momentNm, [6, 0, -2]);
const snapshot = clothPressureOf(cloth, 0, origin, true);
cloth.pos[0] = 10; cloth.pressureForce[0] = 99;
assert.equal(snapshot.nodes.rigPositionsM[0], 0);
assert.equal(snapshot.nodes.scalarForceN[0], 1);
console.log('ок: сила и три момента, начало отсчёта, нулевая сумма, крен и зеркало');

// Независимый плоский предел давления: интеграл и первый момент сохраняются
// при переносе на материальные узлы, затем тем же wrenchOf читаются в лодке.
for (const count of [16, 32, 64]) {
  const p = localPressure({ points: [[0, 0], [1, 0]], flow: [1, 0.1],
    rho: 1, span: 1, normalForce: null, panels: count });
  assert.ok(p.ok);
  const panel = wrenchOf(p.at.map(x => [x, 0, 2]), p.forces.map(f => [0, f, 0]));
  close(panel.forceN[1], Math.PI * 0.1);
  for (const cols of [9, 17, 33]) {
    const nodes = pressureToNodes(p, cols);
    const node = wrenchOf(Array.from({ length: cols }, (_, i) => [i / (cols - 1), 0, 2]),
      Array.from(nodes, f => [0, f, 0]));
    vector(node.forceN, panel.forceN); vector(node.momentNm, panel.momentNm);
  }
}
console.log('ок: независимое давление → узлы → общий измеритель силы и момента');

const samples = [9, 10, 11, 12, 13].map((t, i) => ({ t, driveN: 100 + i,
  gammaMax: 299, sections: [{ fraction: 0.5, entry: [1, -1, 1, -1, 1][i] }] }));
assert.equal(entryCycles(samples, 0.5), 2);
assert.equal(stabilityOf(samples).gammaPass, true);
assert.equal(stabilityOf(samples).jumpPass, true);
assert.equal(stabilityOf(samples.map(s => ({ ...s, gammaMax: 300 }))).gammaPass, false);
const jump = stabilityOf([{ ...samples[0], driveN: 95 }, { ...samples[1], driveN: 100 }]);
close(jump.jump, 0.05); assert.equal(jump.jumpPass, true);
assert.equal(stabilityOf([{ ...samples[0], driveN: 94.9 }, { ...samples[1], driveN: 100 }]).jumpPass, false);
const command = stabilityOf([{ ...samples[0], sheetM: 8.5, driveN: 80, phase: 0 },
  { ...samples[1], sheetM: 9, driveN: 100, phase: 1 },
  { ...samples[2], sheetM: 9, driveN: 99, phase: 1 }]);
close(command.commandJump, 0.2); close(command.continuousJump, 0.01);
assert.equal(command.jumpPass, false); assert.equal(command.continuousJumpPass, true);
// Граница окна у контроля не является изменением команды.
const unchanged = stabilityOf([{ ...samples[0], sheetM: 8.5, driveN: 80, phase: 0 },
  { ...samples[1], sheetM: 8.5, driveN: 100, phase: 1 }]);
close(unchanged.commandJump, 0); assert.equal(unchanged.continuousJumpPass, false);
assert.throws(() => stabilityOf([{ ...samples[1], driveN: NaN }]));
assert.throws(() => stabilityOf([samples[1], samples[0]]));
// Направление преобразуется той же ортогональной матрицей, что и точка.
close(Math.hypot(...rollVector([1, 2, 3], 0.7)), Math.sqrt(14));
console.log('ок: неизменные границы Γ < 300, скачок ≤ 5%, конечность и история знака');

// Парный контроль самого наблюдателя: команда одинакова, только одна лодка
// читает измерители. Они не должны менять дальнейший физический результат.
const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url)));
for (const tack of [1, -1]) for (const local of [false, true]) {
  const setup = () => {
    const b = new Boat(pack);
    b.o.freeWake = true; b.o.wakeForces = true;
    b.o.localPressure = local ? { panels: 32 } : false;
    b.o.crewHike = -tack;
    b.wind.o.gust = 0; b.wind.o.shift = 0;
    b.setGennaker(true); b.o.sheet = 70 * Math.PI / 180;
    b.o.twist = 8 * Math.PI / 180; b.o.genSheetLen = 8.5;
    b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * Math.PI / 180;
    b.u = 3; b.psi = (100 - tack * 140) * Math.PI / 180;
    return b;
  };
  const observed = setup(), untouched = setup(), c = observed.rig.cloth;
  const original = c.forcesAt, cg = [pack.mass.cg_m[0], 0, pack.mass.cg_m[2]];
  let calls = 0;
  c.forcesAt = function (...args) {
    const result = original.apply(this, args);
    clothPressureOf(this, observed.phi, cg, true); calls++;
    return result;
  };
  for (let i = 0; i < 60; i++) {
    observed.o.genSheetLen = untouched.o.genSheetLen = i < 30 ? 8.5 : 9;
    const phi = observed.phi;
    observed.step(1 / 30); untouched.step(1 / 30);
    sectionsOf(c); stripLoadOf(observed.rig, phi, cg, 2);
    sheetGeometryOf(c, pack.rig.gennaker, observed.rigSide, observed.o.genSheetLen);
    for (const key of ['u', 'v', 'r', 'psi', 'phi']) assert.equal(observed[key], untouched[key]);
    assert.deepEqual(observed.telemetry, untouched.telemetry);
    for (const key of ['pos', 'prev', 'frc', 'nrm', 'pressureForce', 'load'])
      assert.deepEqual(c[key], untouched.rig.cloth[key]);
    for (const key of ['stripState', 'stripGamma', 'sailOut'])
      assert.deepEqual(observed.rig[key], untouched.rig[key]);
  }
  assert.ok(calls > 0);
}
console.log('ок: наблюдатель не меняет ткань и лодку, две стороны, штатное/местное давление');
