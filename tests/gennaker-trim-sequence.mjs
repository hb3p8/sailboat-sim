// Диагностический парный прогон:
// node tests/gennaker-trim-sequence.mjs [TWA] [исходная длина] [длина травления] [длина подбора] [--free-clew] [--fine-mesh]
// В обоих прогонах одинаковые ветер, рулевой и начальный ход. Только в одном
// шкот генакера меняется между заданными длинами; другой остаётся при исходной.
// Никаких ворот под ответ здесь нет: печатаются знак и размер отклика ткани,
// тяги и хода относительно одновременного контроля.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(root, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;
const twa = Number(process.argv[2] || 140);
if (!(twa >= 100 && twa <= 170)) throw new Error('TWA должен быть 100…170°');
const start = Number(process.argv[3] || 5.5);
const eased = Number(process.argv[4] || 6.5);
const trimmed = Number(process.argv[5] || start);
const freeClew = process.argv.includes('--free-clew');
const fineMesh = process.argv.includes('--fine-mesh');
if (!(start >= pack.rig.gennaker.sheet_min_m && start < eased &&
      eased <= pack.rig.gennaker.sheet_max_m &&
      trimmed >= start && trimmed < eased))
  throw new Error('Длины шкота вне рабочего диапазона или не образуют травление → подбор');
const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const mean = (a, key) => a.reduce((s, v) => s + v[key], 0) / a.length;

function run(u0, change) {
  const b = new Boat(pack);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.crewHike = -1; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  if (freeClew || fineMesh) b.o.cloth = {
    ...(freeClew ? { freeClew: true } : {}),
    ...(fineMesh ? { rows: 21, cols: 17, iter: 40 } : {}),
  };
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = start;
  b.reset();
  b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = u0;
  b.psi = (100 - twa) * D;
  const rows = [];
  for (let i = 0; i < 32 * 30; i++) {
    const t = i / 30;
    if (change && i === 12 * 30) b.o.genSheetLen = eased;
    if (change && i === 20 * 30) b.o.genSheetLen = trimmed;
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
      -(2.2 * wrap((100 - twa) * D - b.psi) - 0.9 * b.r)));
    b.step(1 / 30);
    const gen = b.rig.stripState.slice(12);
    const entry = Array.from({ length: 9 }, (_, k) =>
      b.rig.cloth.rowShape((k + 1) * (b.rig.cloth.rows - 1) / 10).entry / D);
    // Отрисовка добавляет заполаскивание поверх ткани, когда обе величины
    // положительны (sim/main.js, shapeSails). Это отдельный сигнал от формы.
    const flapStrips = gen.filter(g => g.luffFrac > 0.02 && g.slack > 0).length;
    const flapAmp = Math.max(...gen.map((g, k) =>
      (2 / Math.PI) * g.luffFrac * b.rig.strips[12 + k].chord *
      Math.sqrt(Math.max(0, g.slack))));
    const cloth = b.rig.cloth, ci = cloth.clew * 3;
    const lead = pack.rig.gennaker.sheet_lead_m;
    const leadY = Math.abs(lead[1]) * Math.sign(b.rigSide || -1);
    const sheetSlack = b.o.genSheetLen - Math.hypot(
      cloth.pos[ci] - lead[0], cloth.pos[ci + 1] - leadY,
      cloth.pos[ci + 2] - lead[2]);
    rows.push({
      t, sheet: b.o.genSheetLen,
      speed: b.telemetry.speedKn, awa: b.telemetry.awaDeg,
      drive: b.telemetry.driveN,
      genDrive: gen.reduce((s, g) => s + g.drive, 0),
      luff: gen.reduce((s, g) => s + g.luffFrac, 0) / gen.length,
      entry: Math.min(...entry),
      entryNegativeRows: entry.filter(a => a < 0).length,
      flapStrips, flapAmp, sheetSlack,
      sag: b.rig.cloth.luffSag().sag,
    });
  }
  return rows;
}

function report(label, changed, control, lo, hi) {
  const a = changed.filter(r => r.t >= lo && r.t < hi);
  const b = control.filter(r => r.t >= lo && r.t < hi);
  const fmt = (key, digits) => `${mean(a, key).toFixed(digits)} (${(mean(a, key) - mean(b, key) >= 0 ? '+' : '')}${(mean(a, key) - mean(b, key)).toFixed(digits)})`;
  console.log(`${label.padEnd(14)} ${fmt('speed', 3).padStart(15)} ${fmt('genDrive', 1).padStart(17)} ${fmt('drive', 1).padStart(17)} ${fmt('luff', 3).padStart(15)} ${fmt('entry', 1).padStart(17)} ${fmt('sag', 3).padStart(15)} ${fmt('awa', 2).padStart(15)}  ${mean(a, 'entryNegativeRows').toFixed(2)} / ${mean(a, 'flapStrips').toFixed(2)} / ${mean(a, 'flapAmp').toFixed(2)} / ${mean(a, 'sheetSlack').toFixed(2)}`);
}

console.log(`TWA ${twa}°, TWS 6 м/с, грот 70°, твист 8°, шаг 1/30 с; шкот ${start} → ${eased} → ${trimmed} м; шкотовый угол ${freeClew ? 'свободен (эксперимент)' : 'на дуге (штатно)'}; сетка ${fineMesh ? '21×17 / 40 проходов' : 'штатная'}`);
console.log('Число: опыт (разница с одновременным контролем); entry — минимальный угол входа ткани на 10…90% высоты, отрицательный = заворот.');
console.log('Окно           ход, уз       ген-тяга, Н       общ. тяга, Н       luffFrac        entry, °        провис, м          AWA, °   отриц. рядов / полосок заполаскивания / амплитуда, м* / слабина шкота, м');
console.log('*Амплитуда оценена формулой рендера с хордой полоски, а не строки полотна.');
for (const u0 of [3, 3.05]) {
  const changed = run(u0, true);
  const control = run(u0, false);
  for (let i = 0; i < 12 * 30; i++) {
    if (changed[i].speed !== control[i].speed ||
        changed[i].genDrive !== control[i].genDrive)
      throw new Error(`Опыт и контроль разошлись до изменения шкота на шаге ${i}`);
  }
  console.log(`начальный ход ${u0} м/с`);
  report('до 9…12 с', changed, control, 9, 12);
  report('травление 17…20', changed, control, 17, 20);
  report('подбор 20…23', changed, control, 20, 23);
  report('после 29…32', changed, control, 29, 32);
  const tail = changed.filter(r => r.t >= 12 && r.t < 20);
  console.log(`  во время травления: min entry ${Math.min(...tail.map(r => r.entry)).toFixed(1)}°, max luffFrac ${Math.max(...tail.map(r => r.luff)).toFixed(3)}, max отрицательных рядов ${Math.max(...tail.map(r => r.entryNegativeRows))}`);
}
