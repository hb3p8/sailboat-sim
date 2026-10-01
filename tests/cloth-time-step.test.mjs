// Смена подшага не переопределяет уже накопленную скорость ткани.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cloth } from '../sim/cloth.js';
import { Boat } from '../sim/physics.js';
import { dumpCore, applyDump } from '../sim/trace.js';
const close = (a, b) => assert.ok(Math.abs(a - b) < 2e-12 * Math.max(1, Math.abs(b)), `${a} != ${b}`);

function particle(previousH, velocity, force = 0) {
  const c = Object.create(Cloth.prototype);
  Object.assign(c, { n: 1, pos: new Float64Array(3),
    prev: new Float64Array([-previousH * velocity, 0, 0]), prevDt: previousH,
    frc: new Float64Array([force, 0, 0]), w: [1], forcesAt() {}, project() {} });
  return c;
}
for (const sign of [1, -1]) for (const [oldH, h] of [[1 / 60, 1 / 120], [1 / 120, 1 / 60]]) {
  const c = particle(oldH, sign);
  c.advance(null, h, sign, null);
  close(c.pos[0] / h, sign * Math.exp(-6 * h));
  assert.equal(c.prevDt, h);
}
// Разное разбиение одной длительности: точное затухание скорости свободной массы.
const schedules = [new Array(60).fill(1 / 60), new Array(120).fill(1 / 120),
  new Array(40).fill([1 / 120, 1 / 60]).flat()];
for (const schedule of schedules) {
  const c = particle(1 / 60, 1);
  for (const h of schedule) c.advance(null, h, 1, null);
  close((c.pos[0] - c.prev[0]) / c.prevDt, Math.exp(-6));
}
const loaded = particle(1 / 60, 1, 2);
loaded.advance(null, 1 / 120, 1, null);
close(loaded.pos[0] * 120, Math.exp(-6 / 120) + 2 / 120);
console.log('ок: оба перехода шага, две стороны, переменное расписание и добавленная сила');

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url)));
function boat(side) {
  const b = new Boat(pack); b.o.cloth = { attachmentPaths: true, rigidBoard: true };
  b.setGennaker(true); b.o.genSheetLen = 9;
  b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * Math.PI / 180;
  b.u = 3; b.psi = (100 - side * 140) * Math.PI / 180;
  return b;
}
for (const side of [1, -1]) {
  const b = boat(side);
  for (let step = 0; step < 20; step++) b.step(1 / 120);
  const cl = b.rig.cloth;
  assert.equal(cl.prevDt, 1 / 120);
  // Одинаковое состояние и скорость: направление/сила затухания не зависят
  // от планируемой длительности следующего подшага.
  for (const local of [false, { panels: 16 }]) {
    b.o.localPressure = local;
    cl.forcesAt(b, 1 / 60, b.rigSide, b.p.environment);
    const force = cl.frc.slice();
    cl.forcesAt(b, 1 / 120, b.rigSide, b.p.environment);
    assert.deepEqual(cl.frc, force, 'Затухание изменилось до нового движения');
  }
  b.o.localPressure = false;
  const snapshot = JSON.parse(JSON.stringify(dumpCore(b)));
  assert.equal(snapshot.cloth.prevDt, 1 / 120);
  const restored = boat(side);
  assert.equal(applyDump(restored, snapshot).cloth, true);
  assert.equal(restored.rig.cloth.prevDt, cl.prevDt);
  // Округление pos/prev в снимке: допускается только ошибка его 9 знаков.
  const h = 1 / 60;
  b.step(h); restored.step(h);
  let worst = 0;
  for (let i = 0; i < cl.pos.length; i++) worst = Math.max(worst, Math.abs(cl.pos[i] - restored.rig.cloth.pos[i]));
  assert.ok(worst < 2e-6, `Снимок после смены шага: ${worst} м`);
  assert.ok(cl.pos.every(Number.isFinite));
  const legacy = JSON.parse(JSON.stringify(snapshot)); delete legacy.cloth.prevDt;
  const old = boat(side); assert.equal(applyDump(old, legacy).cloth, true);
  assert.equal(old.rig.cloth.prevDt, 1 / 60);
  const before = old.rig.cloth.pos.slice();
  assert.equal(old.rig.cloth.restore(before, before, old.rig, -1), false);
  assert.deepEqual(old.rig.cloth.pos, before);
}
console.log('ок: фактическое затухание, снимок с новым шагом, старый формат и некорректная длительность');
