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
const fineCloth = process.argv.includes('--fine-cloth');

function run(twa, sheet, u0) {
  const b = new Boat(pack);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.crewHike = -1; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  if (fineCloth) b.o.cloth = { rows: 21, cols: 17, iter: 40 };
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = sheet;
  b.reset();
  b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = u0;
  b.psi = (100 - twa) * D;
  const startWall = performance.now();
  const sum = { n: 0, drive: 0, speed: 0, luff: 0, entry: Infinity,
                cols: new Float64Array(fineCloth ? 17 : 9),
                midQ: new Float64Array(NCHORD), topQ: new Float64Array(NCHORD),
                abs: 0, frontAbs: 0, gamma: 0, jump: 0, ref: 1 };
  let prevDrive = null;
  for (let i = 0; i < 30 * 30; i++) {
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
      -(2.2 * wrap((100 - twa) * D - b.psi) - 0.9 * b.r)));
    b.step(1 / 30);
    if (i >= 10 * 30) {
      if (b.rig.stripGamma)
        for (const g of b.rig.stripGamma) sum.gamma = Math.max(sum.gamma, Math.abs(g));
      sum.ref = Math.max(sum.ref, Math.abs(b.telemetry.driveN));
      if (prevDrive !== null)
        sum.jump = Math.max(sum.jump, Math.abs(b.telemetry.driveN - prevDrive));
    }
    prevDrive = b.telemetry.driveN;
    if (i < 25 * 30) continue;
    const cloth = b.rig.cloth, gen = b.rig.stripState.slice(12);
    sum.n++;
    sum.drive += gen.reduce((s, g) => s + g.drive, 0);
    sum.speed += b.telemetry.speedKn;
    sum.luff += gen.reduce((s, g) => s + g.luffFrac, 0) / gen.length;
    for (let k = 0; k < NCHORD; k++) {
      sum.midQ[k] += b.rig.stripCalc[12 + 3].q[k];
      sum.topQ[k] += b.rig.stripCalc[12 + 5].q[k];
    }
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
        if (c / (cloth.cols - 1) <= 0.125) sum.frontAbs += Math.abs(pr);
      }
    }
  }
  const signed = Array.from(sum.cols, x => x / sum.n);
  const total = signed.reduce((s, x) => s + x, 0);
  return {
    speed: sum.speed / sum.n, drive: sum.drive / sum.n,
    luff: sum.luff / sum.n, entry: sum.entry,
    signed, total,
    frontShare: signed.reduce((s, v, c) =>
      s + (c / (signed.length - 1) <= 0.125 ? v : 0), 0) / (total || 1),
    frontAbsShare: sum.frontAbs / (sum.abs || 1),
    midQ: Array.from(sum.midQ, v => v / sum.n),
    topQ: Array.from(sum.topQ, v => v / sum.n),
    gamma: sum.gamma, jump: sum.jump / sum.ref,
    wall: (performance.now() - startWall) / 1000,
  };
}

console.log(`NCHORD=${NCHORD}, ткань ${fineCloth ? '21×17/40' : '11×9/10'}; TWA/шкот/u₀ | ход уз, ген-тяга Н, luffFrac, min entry ° | нагрузка по столбцам Н; до 12.5% — передняя кромка`);
for (const { twa, sheets } of cases) for (const sheet of sheets)
  for (const u0 of starts) {
    const x = run(twa, sheet, u0);
    console.log(`${twa}/${sheet.toFixed(1)}/${u0.toFixed(2)} | ${x.speed.toFixed(3)} ${x.drive.toFixed(1)} ${x.luff.toFixed(3)} ${x.entry.toFixed(1)} | ${x.signed.map(v => v.toFixed(1)).join(' ')} | Σ ${x.total.toFixed(1)}; вход/Σ ${(100 * x.frontShare).toFixed(1)} %; вход по модулю ${(100 * x.frontAbsShare).toFixed(1)} %; Γmax ${x.gamma.toFixed(1)} скачок ${(100 * x.jump).toFixed(1)} %; ${x.wall.toFixed(1)} с`);
    console.log(`  q полоски 4/6: ${x.midQ.map(v => v.toFixed(2)).join(' ')}; полоски 6/6: ${x.topQ.map(v => v.toFixed(2)).join(' ')}`);
  }
