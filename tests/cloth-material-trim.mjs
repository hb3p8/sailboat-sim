// Диагностика полной штатной PBD-ткани при той же команде шкота, что и
// опытный hard-only проектор. Не выдаёт поправку PBD за силу в снасти.
import { readFileSync } from 'node:fs';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';

const opt = (name, fallback) => process.argv.find(s => s.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const cols = Number(opt('cols', '33'));
const iter = Number(opt('iter', '40'));
const hz = Number(opt('hz', '30'));
const ramp = Number(opt('ramp', '0'));
const noBendDynamic = process.argv.includes('--no-bend-dynamic');
if (![9, 17, 33].includes(cols) || ![40, 160, 640].includes(iter) ||
    ![30, 60, 120].includes(hz) || ![0, 0.3, -0.3].includes(ramp))
  throw new Error('Неверные параметры стенда полной ткани');

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url), 'utf8'));
const b = new Boat(pack), D = Math.PI / 180;
b.o.freeWake = true; b.o.wakeForces = true;
b.wind.o.gust = 0; b.wind.o.shift = 0;
b.setGennaker(true);
b.o.genSheetLen = 5.218;
b.o.crewHike = -1; b.o.crewMass = 219.9;
b.o.sheet = 70 * D; b.o.twist = 8 * D;
b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = 3;
b.psi = -40 * D;
const wrap = x => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const rudder = () => Math.max(-25 * D, Math.min(25 * D,
  -(2.2 * wrap(-40 * D - b.psi) - 0.9 * b.r)));
for (let i = 0; i < 30 * 30; i++) {
  b.o.rudderTarget = rudder();
  b.step(1 / 30);
}
const cl = new Cloth(b.rig.sails[2], 2,
  { rows: 11, cols, iter: 40, boardMaterial: true, freeClew: true });
if (!cl.step(b, 1 / 30)) throw new Error('Исходный шаг ткани отклонён');
cl.iter = 640;
cl.project(b, b.rigSide);
const initial = cl.pos.slice();
cl.restore(initial, initial, b.rig);
if (noBendDynamic) for (let q = 0; q < cl.ck.length; q++)
  if (cl.ck[q] < 0) cl.ck[q] = 0;
cl.iter = iter;
b.rig.cloth = cl;
const gen = b.p.rig.gennaker;
const side = Math.sign(b.rigSide || -1);
const lead = [gen.sheet_lead_m[0], Math.abs(gen.sheet_lead_m[1]) * side,
  gen.sheet_lead_m[2]];
const sheetGap = () => {
  const k = 3 * cl.clew, p = cl.pos;
  return b.o.genSheetLen - Math.hypot(p[k] - lead[0], p[k + 1] - lead[1],
    p[k + 2] - lead[2]);
};
const hardStretch = () => {
  let worst = 0;
  for (let q = 0; q < cl.ci.length; q++) {
    if (cl.ck[q] !== 1) continue;
    const a = 3 * cl.ci[q], z = 3 * cl.cj[q], p = cl.pos;
    worst = Math.max(worst, Math.hypot(p[z] - p[a], p[z + 1] - p[a + 1],
      p[z + 2] - p[a + 2]) - cl.rest[q]);
  }
  return worst;
};
const row = () => {
  const k = 3 * cl.ix(5, (cols - 1) / 2), p = cl.pos;
  const sh = cl.rowShape(5);
  return `x/y/z ${p[k].toFixed(6)}/${p[k + 1].toFixed(6)}/${p[k + 2].toFixed(6)} м; ` +
    `хорда ${sh.chord.toFixed(4)} м, пузо ${sh.camber.toFixed(4)}, ` +
    `ход назад ${sh.back.toFixed(4)}, залом ${(sh.kink / D).toFixed(2)}°`;
};
console.log(`Полная PBD-ткань 11×${cols}, ${iter} проходов, ${hz} Гц, ` +
  `команда ${ramp > 0 ? 'травить' : ramp < 0 ? 'добирать' : 'контроль'} ` +
  `${Math.abs(ramp).toFixed(3)} м за 0.5…1.5 с` +
  (noBendDynamic ? ', изгиб отключён только после общей начальной формы' : ''));
console.log(`Начало: ${row()}; слабина ${(1000 * sheetGap()).toFixed(3)} мм`);
let worstStretch = 0, worstSheet = 0;
const t0 = performance.now();
for (let i = 1; i <= 2 * hz; i++) {
  const t = i / hz, phase = Math.max(0, Math.min(1, (t - 0.5) / 1));
  b.o.genSheetLen = 5.218 + ramp * phase;
  b.o.rudderTarget = rudder();
  b.step(1 / hz);
  worstStretch = Math.max(worstStretch, hardStretch());
  worstSheet = Math.max(worstSheet, Math.max(0, -sheetGap()));
  if (i === hz || i === 2 * hz)
    console.log(`${t.toFixed(1)} с: ${row()}; ` +
      `слабина ${(1000 * sheetGap()).toFixed(3)} мм; ` +
      `ход ${b.u.toFixed(4)} м/с, курс ${(b.psi / D).toFixed(3)}°, ` +
      `крен ${(b.phi / D).toFixed(3)}°; сила парусов ` +
      `${b.rig.sailOut.fx.toFixed(2)}/${b.rig.sailOut.fy.toFixed(2)} Н`);
}
console.log(`Итого: максимум растяжения жёстких связей ` +
  `${(1000 * worstStretch).toFixed(3)} мм, превышения длины шкота ` +
  `${(1000 * worstSheet).toFixed(6)} мм; вычислено за ` +
  `${((performance.now() - t0) / 1000).toFixed(2)} с`);
