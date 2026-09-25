// Карта отклика генакера, без CFD: node tests/gennaker-trim-map.mjs
// Сетка задана до замера: TWA 120/140/150/160°, TWS 4/6/8 м/с,
// шкот 5.5/6.5/7.5/8.5/9.2 м, два начальных хода 3.00/3.05 м/с.
// Все случаи отдельные и последовательные; форма, силы и ход относятся к
// одному и тому же шагу модели. Дрейф — разница средних окон 15…20 и 25…30 с.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(root, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;
const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const grid = {
  twa: [120, 140, 150, 160],
  tws: [4, 6, 8],
  sheet: [5.5, 6.5, 7.5, 8.5, 9.2],
  u0: [3, 3.05],
};

function once(twa, tws, sheet, u0) {
  const b = new Boat(pack);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.crewHike = -1; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = sheet;
  b.reset();
  b.o.windSpeed = tws; b.o.windDir = 100 * D; b.u = u0;
  b.psi = (100 - twa) * D;
  const a = { n: 0, v: 0, drive: 0 };
  const z = { n: 0, v: 0, drive: 0, gen: 0, luff: 0, amp: 0, awa: 0 };
  let entry = Infinity, gamma = 0, jump = 0, prev = null, ref = 1;
  for (let i = 0; i < 30 * 30; i++) {
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
      -(2.2 * wrap((100 - twa) * D - b.psi) - 0.9 * b.r)));
    b.step(1 / 30);
    const t = i / 30;
    const tele = b.telemetry;
    if (!Number.isFinite(tele.speedKn) || !Number.isFinite(tele.driveN))
      throw new Error(`Не-конечное состояние: TWA ${twa}, TWS ${tws}, шкот ${sheet}, шаг ${i}`);
    if (t >= 10) {
      if (b.rig.stripGamma)
        for (const g of b.rig.stripGamma) gamma = Math.max(gamma, Math.abs(g));
      ref = Math.max(ref, Math.abs(tele.driveN));
      if (prev !== null) jump = Math.max(jump, Math.abs(tele.driveN - prev));
    }
    prev = tele.driveN;
    if (t >= 15 && t < 20) {
      a.n++; a.v += tele.speedKn; a.drive += tele.driveN;
    }
    if (t >= 25) {
      const gen = b.rig.stripState.slice(12);
      z.n++; z.v += tele.speedKn; z.drive += tele.driveN;
      z.gen += gen.reduce((s, g) => s + g.drive, 0);
      z.luff += gen.reduce((s, g) => s + g.luffFrac, 0) / gen.length;
      z.amp += Math.max(...gen.map((g, k) =>
        (2 / Math.PI) * g.luffFrac * b.rig.strips[12 + k].chord *
        Math.sqrt(Math.max(0, g.slack))));
      z.awa += tele.awaDeg;
      // Форма паруса: в отличие от рисуемого заполаскивания, это положение
      // самой ткани. Достаточно мерить её каждые пять физических шагов.
      if (i % 5 === 0) for (let k = 1; k <= 9; k++)
        entry = Math.min(entry,
          b.rig.cloth.rowShape(k * (b.rig.cloth.rows - 1) / 10).entry / D);
    }
  }
  return {
    v: z.v / z.n, drive: z.drive / z.n, gen: z.gen / z.n,
    luff: z.luff / z.n, amp: z.amp / z.n, awa: z.awa / z.n, entry,
    dv: z.v / z.n - a.v / a.n,
    ddrive: z.drive / z.n - a.drive / a.n,
    gamma, jump: jump / ref,
  };
}

console.log('TWA TWS шкот | ход уз тяга ген Н доля лоб. amp м* min entry ° | дрейф уз / Н | Γmax jump % | чувств. уз / Н');
console.log('*Амплитуда — формула отрисовки с хордой полоски, не смещение самой ткани.');
for (const twa of grid.twa) for (const tws of grid.tws) {
  for (const sheet of grid.sheet) {
    const x = grid.u0.map(u0 => once(twa, tws, sheet, u0));
    const m = (key) => (x[0][key] + x[1][key]) / 2;
    const s = (key) => Math.abs(x[0][key] - x[1][key]);
    const f = (n, d) => n.toFixed(d);
    console.log(`${twa} ${tws} ${f(sheet, 1)} | ${f(m('v'), 3)} ${f(m('gen'), 1)} ${f(m('luff'), 3)} ${f(m('amp'), 2)} ${f(Math.min(x[0].entry, x[1].entry), 1)} | ${f(m('dv'), 3)} ${f(m('ddrive'), 1)} | ${f(Math.max(x[0].gamma, x[1].gamma), 1)} ${f(100 * Math.max(x[0].jump, x[1].jump), 1)} | ${f(s('v'), 3)} ${f(s('gen'), 1)}`);
  }
}
