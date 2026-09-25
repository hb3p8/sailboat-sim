// Свидетель подключения: при одной и той же форме локальный решатель меняет
// распределение, сохраняя нормальную силу каждой строки; в решётке не работает.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Boat } from '../sim/physics.js';

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url), 'utf8'));
const D = Math.PI / 180;
function boat(tack) {
  const b = new Boat(pack);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.crewHike = -tack; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  b.setGennaker(true); b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = 9;
  b.reset(); b.o.windSpeed = 6; b.o.windDir = tack * 140 * D; b.u = 3;
  for (let i = 0; i < 90; i++) {
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, 2.2 * b.psi + 0.9 * b.r));
    b.step(1 / 30);
  }
  return b;
}
for (const tack of [-1, 1]) for (const inside of [false, true]) {
  const a = boat(tack), b = boat(tack);
  assert.deepEqual(a.rig.cloth.pos, b.rig.cloth.pos);
  if (inside) { a.rig.latOn.fill(1); b.rig.latOn.fill(1); }
  b.o.localPressure = { panels: 32 };
  a.rig.cloth.advance(a, 1 / 60, a.rigSide, pack.environment);
  b.rig.cloth.advance(b, 1 / 60, b.rigSide, pack.environment);
  const c = a.rig.cloth, d = b.rig.cloth;
  let difference = 0, active = 0;
  for (let r = 0; r < c.rows; r++) {
    let fa = 0, fb = 0;
    for (let j = 0; j < c.cols; j++) {
      const k = c.ix(r, j);
      fa += c.pressureForce[k]; fb += d.pressureForce[k];
      difference += Math.abs(c.pressureForce[k] - d.pressureForce[k]);
    }
    assert.ok(Math.abs(fa - fb) < 1e-8 * Math.max(1, Math.abs(fa)), `Сила строки ${r}: ${fa} / ${fb}`);
    if (d.localPressureProfiles[r].ok) active++;
  }
  if (inside) {
    assert.equal(active, 0); assert.equal(difference, 0);
    assert.deepEqual(c.pos, d.pos);
  } else { assert.ok(active > 0); assert.ok(difference > 1e-6); }
  console.log(`ок: галс ${tack}, в решётке ${inside}, локальных строк ${active}, перераспределено ${difference.toFixed(3)} Н`);
}
