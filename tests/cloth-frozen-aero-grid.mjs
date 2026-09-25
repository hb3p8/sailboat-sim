// Один и тот же замороженный аэродинамический вход для нескольких сеток ткани:
// node tests/cloth-frozen-aero-grid.mjs --tack=1 --sheet=9
// Лодка и полоски после опорных 30 с не двигаются; отдельно шагает только ткань.
import { readFileSync } from 'node:fs';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url), 'utf8'));
const D = Math.PI / 180;
const arg = (key, def) => Number(process.argv.find(s => s.startsWith(`--${key}=`))?.split('=')[1] ?? def);
const tack = arg('tack', 1), sheet = arg('sheet', 9), iter = arg('iter', 40);
const clothHz = arg('cloth-hz', 30);
const fixedNormals = process.argv.includes('--fixed-normals');
const edgeAudit = process.argv.includes('--edges');
const bend = process.argv.some(s => s.startsWith('--bend=')) ? arg('bend', 0.05) : null;
const cols = (process.argv.find(s => s.startsWith('--cols='))?.split('=')[1] ?? '9,17,33')
  .split(',').map(Number);
if (![1, -1].includes(tack) || !(sheet > 0) || !Number.isInteger(iter) || iter < 1 ||
    (bend != null && !(bend >= 0 && bend <= 1)) ||
    ![30, 60, 120].includes(clothHz) ||
    cols.some(x => !Number.isInteger(x) || x < 5 || x > 65))
  throw new Error('Неверные параметры стенда');
const wrap = x => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

const b = new Boat(pack);
b.o.freeWake = true; b.o.wakeForces = true;
b.o.crewHike = -tack; b.o.crewMass = 219.9;
b.wind.o.gust = 0; b.wind.o.shift = 0;
b.setGennaker(true);
b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = sheet;
b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = 3;
b.psi = (100 - tack * 140) * D;
for (let i = 0; i < 30 * 30; i++) {
  b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
    -(2.2 * wrap((100 - tack * 140) * D - b.psi) - 0.9 * b.r)));
  b.step(1 / 30);
}

const reference = b.rig.cloth;
const qSpread = Math.max(...b.rig.stripCalc.slice(12).map(g => g.q
  ? Math.max(...g.q) - Math.min(...g.q) : 0));
const frozenInput = () => JSON.stringify({
  calc: b.rig.stripCalc.slice(12).map(g => [g.ve, g.d1, g.d2, g.slackCut, ...(g.q || [])]),
  state: b.rig.stripState.slice(12).map(d => [d.drive, d.side]),
  boat: [b.x, b.y, b.psi, b.phi, b.u, b.v, b.r, b.t],
});
const inputBefore = frozenInput();
const minShape = (cl, cut = false) => {
  let row = 1, angle = Infinity, maxBack = 0, maxFlip = 0, backRow = -1, flipRow = -1;
  for (let r = 1; r + 1 < cl.rows; r++) {
    const s = cl.rowShape(r, cut);
    if (s.entry < angle) { row = r; angle = s.entry; }
    if (s.back > maxBack) { maxBack = s.back; backRow = r; }
    if (s.flip > maxFlip) { maxFlip = s.flip; flipRow = r; }
  }
  return { row, angle: angle / D, maxBack, maxFlip, backRow, flipRow };
};
const edgeState = (cl, col) => {
  // 99.5 % — только диагностический признак почти расправленного ребра,
  // не порог приёмки и не оценка силы натяжения PBD-связи.
  let arc = 0, mat = 0, taut = 0;
  for (let r = 0; r + 1 < cl.rows; r++) {
    const a = cl.ix(r, col), z = cl.ix(r + 1, col), i = a * 3, j = z * 3;
    const d = Math.hypot(cl.pos[j] - cl.pos[i], cl.pos[j + 1] - cl.pos[i + 1],
                         cl.pos[j + 2] - cl.pos[i + 2]);
    const m = cl.matDist(a, z);
    arc += d; mat += m;
    if (m > 0 && d / m >= 0.995) taut++;
  }
  return { ratio: arc / mat, taut };
};
console.log(`Замороженный вход после опорных 30 с при 140°/6 м/с, шкот ${sheet} м, галс ${tack}; полоски и лодка больше не шагают`);
console.log(`Исходный максимальный разброс q по хорде: ${qSpread.toExponential(3)}`);
console.log(`Опорная ткань 11×9: вход ${minShape(reference).angle.toFixed(1)}°, ` +
            `пузо строки 5 ${(100 * reference.rowShape(5).camber).toFixed(1)} % хорды; ` +
            `тяга ${b.rig.stripState.slice(12).reduce((s, d) => s + d.drive, 0).toFixed(1)} Н`);
console.log(`Ткань: ${iter} проходов, ${clothHz} Гц, изгиб ${bend == null ? 'штатный' : bend}, нормали ${fixedNormals ? 'зафиксированы на первом подшаге' : 'следуют за тканью'}`);
console.log('столбцов | время ткани с | мин. вход °/строка | max ход назад/вывернуто % | пузо строки 5 % | Fx/Fy ткани Н');
for (const n of cols) {
  const cl = new Cloth(b.rig.sails[2], 2, { rows: 11, cols: n, iter,
    ...(bend == null ? {} : { bend }) });
  if (fixedNormals) {
    const follow = cl.rowNormals.bind(cl);
    let firstNormals = null;
    cl.rowNormals = (wx, wy) => {
      if (!firstNormals) { follow(wx, wy); firstNormals = cl.nrm.slice(); }
      else cl.nrm.set(firstNormals);
    };
  }
  for (let i = 0; i < 30 * clothHz; i++) {
    if (!cl.step(b, 1 / clothHz)) throw new Error('Шаг ткани отклонён');
    if (i === 0) {
      const cut = minShape(cl, true), fly = minShape(cl);
      console.log(`${n} | крой/первый шаг | ${cut.angle.toFixed(1)}/${fly.angle.toFixed(1)}° | ` +
        `${(100 * cut.maxBack).toFixed(1)}/${(100 * cut.maxFlip).toFixed(1)} % по крою; ` +
        `${(100 * fly.maxBack).toFixed(1)}/${(100 * fly.maxFlip).toFixed(1)} % в полёте`);
    }
    const time = (i + 1) / clothHz;
    if (![5, 10, 20, 30, ...(edgeAudit ? [0.5, 1, 2, 3] : [])].includes(time)) continue;
    const s = minShape(cl), load = cl.load || {};
    let line = `${n} | ${time.toFixed(time < 5 ? 1 : 0)} | ${s.angle.toFixed(1)}/${s.row} | ${(100 * s.maxBack).toFixed(1)}/${(100 * s.maxFlip).toFixed(1)} | ${(100 * cl.rowShape(5).camber).toFixed(1)} | ${(load.fx || 0).toFixed(1)}/${(load.fy || 0).toFixed(1)}`;
    if (edgeAudit) {
      const luff = edgeState(cl, 0), leech = edgeState(cl, cl.cols - 1);
      line += ` | кромки дуга/крой ${(100 * luff.ratio).toFixed(1)}/${(100 * leech.ratio).toFixed(1)} %; натянуто ${luff.taut}/${leech.taut} из ${cl.rows - 1}; ход назад стр. ${s.backRow}`;
    }
    console.log(line);
  }
  if (frozenInput() !== inputBefore) throw new Error('Замороженный вход изменился при шаге ткани');
}
