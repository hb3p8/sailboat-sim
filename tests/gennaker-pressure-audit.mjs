// Диагностика связи «решётка — нагрузка ткани»:
// node tests/gennaker-pressure-audit.mjs
// Постановки и окно взяты из карты триммирования; ни один параметр симулятора
// не меняется. Нагрузка восстановлена из того же q и коэффициентов, которыми
// Cloth.advance() нагружает узлы. После шага q опережает коэффициенты на один
// физический шаг; на установившемся окне проверяется и погрешность суммы.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { NCHORD } from '../sim/aero.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(root, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;
const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const cases = [
  { twa: 140, sheets: [8.5, 9.0] },
  { twa: 150, sheets: [8.5, 9.2] },
];
const starts = [3, 3.05];

function run(twa, sheet, u0) {
  const b = new Boat(pack);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.crewHike = -1; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = sheet;
  b.reset();
  b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = u0;
  b.psi = (100 - twa) * D;
  const sum = { n: 0, drive: 0, speed: 0, luff: 0, entry: Infinity,
                cols: new Float64Array(9), abs: 0, frontAbs: 0 };
  for (let i = 0; i < 30 * 30; i++) {
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
      -(2.2 * wrap((100 - twa) * D - b.psi) - 0.9 * b.r)));
    b.step(1 / 30);
    if (i < 25 * 30) continue;
    const cloth = b.rig.cloth, gen = b.rig.stripState.slice(12);
    sum.n++;
    sum.drive += gen.reduce((s, g) => s + g.drive, 0);
    sum.speed += b.telemetry.speedKn;
    sum.luff += gen.reduce((s, g) => s + g.luffFrac, 0) / gen.length;
    for (let k = 1; k <= 9; k++) sum.entry = Math.min(sum.entry,
      cloth.rowShape(k * (cloth.rows - 1) / 10).entry / D);
    for (let r = 0; r < cloth.rows; r++) {
      const si = cloth.stripOf(r), g = b.rig.stripCalc[12 + si];
      if (!g.live || !g.q) continue;
      for (let c = 0; c < cloth.cols; c++) {
        const u = c / (cloth.cols - 1);
        const kp = Math.min(NCHORD - 1, Math.floor(u * NCHORD));
        const pr = (cloth._kShape[si] * g.q[kp] + cloth._kFlat[si]) *
          cloth._areaNow[cloth.ix(r, c)];
        if (!Number.isFinite(pr)) throw new Error('Нагрузка узла не конечна');
        sum.cols[c] += pr;
        sum.abs += Math.abs(pr);
        if (c < 2) sum.frontAbs += Math.abs(pr);
      }
    }
  }
  const signed = Array.from(sum.cols, x => x / sum.n);
  const total = signed.reduce((s, x) => s + x, 0);
  return {
    speed: sum.speed / sum.n, drive: sum.drive / sum.n,
    luff: sum.luff / sum.n, entry: sum.entry,
    signed, total,
    frontShare: (signed[0] + signed[1]) / (total || 1),
    frontAbsShare: sum.frontAbs / (sum.abs || 1),
  };
}

console.log('TWA/шкот/u₀ | ход уз, ген-тяга Н, luffFrac, min entry ° | нагрузка ткани по 9 столбцам Н; первые два — передняя кромка');
for (const { twa, sheets } of cases) for (const sheet of sheets)
  for (const u0 of starts) {
    const x = run(twa, sheet, u0);
    console.log(`${twa}/${sheet.toFixed(1)}/${u0.toFixed(2)} | ${x.speed.toFixed(3)} ${x.drive.toFixed(1)} ${x.luff.toFixed(3)} ${x.entry.toFixed(1)} | ${x.signed.map(v => v.toFixed(1)).join(' ')} | Σ ${x.total.toFixed(1)}; передняя/Σ ${(100 * x.frontShare).toFixed(1)} %; передняя по модулю ${(100 * x.frontAbsShare).toFixed(1)} %`);
  }
