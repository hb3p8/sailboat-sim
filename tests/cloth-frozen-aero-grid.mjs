// Один и тот же замороженный аэродинамический вход для нескольких сеток ткани:
// node tests/cloth-frozen-aero-grid.mjs --tack=1 --sheet=9
// Лодка и полоски после опорных 30 с не двигаются; отдельно шагает только ткань.
import { readFileSync } from 'node:fs';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';
import { gennakerClew } from '../sim/aero.js';

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url), 'utf8'));
const D = Math.PI / 180;
const arg = (key, def) => Number(process.argv.find(s => s.startsWith(`--${key}=`))?.split('=')[1] ?? def);
const tack = arg('tack', 1), sheet = arg('sheet', 9), iter = arg('iter', 40);
const clothHz = arg('cloth-hz', 30);
const loadScale = arg('load-scale', 1);
const gravityScale = arg('gravity-scale', 1);
const sheetRamp = arg('sheet-ramp', 0);
const fixedLoad = process.argv.includes('--fixed-load');
const fixedNormals = fixedLoad || process.argv.includes('--fixed-normals');
const edgeAudit = process.argv.includes('--edges');
const cellAudit = process.argv.includes('--cells');
const cutNesting = process.argv.includes('--cut-nesting');
const boardMaterial = process.argv.includes('--board-material');
const attachmentPaths = process.argv.includes('--attachment-paths');
const rigidBoard = process.argv.includes('--rigid-board');
const cornerAudit = process.argv.includes('--corner-gap');
const holdCutClew = process.argv.includes('--hold-cut-clew');
const bend = process.argv.some(s => s.startsWith('--bend=')) ? arg('bend', 0.05) : null;
const cols = (process.argv.find(s => s.startsWith('--cols='))?.split('=')[1] ?? '9,17,33')
  .split(',').map(Number);
if (![1, -1].includes(tack) || !(sheet > 0) || !(loadScale >= 0 && loadScale <= 2) ||
    !(gravityScale >= 0 && gravityScale <= 1) || !(sheetRamp >= 0 && sheetRamp <= 30) ||
    !Number.isInteger(iter) || iter < 1 ||
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

// После опорного хода можно изолировать одни геометрические ограничения.
// Это не режим симулятора и не физический сценарий паруса.
b.p.environment.g *= gravityScale;

// Только диагностическая амплитуда прежней силы: полоски и лодка после этого
// не пересчитываются. Приёмочные прогоны используют ровно 1.
for (const d of b.rig.stripState.slice(12)) {
  d.drive *= loadScale;
  d.side *= loadScale;
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
const rowLinks = (cl, row) => {
  let arc = 0, mat = 0, slack = 0, excess = 0, min = Infinity, max = 0;
  for (let c = 0; c + 1 < cl.cols; c++) {
    const a = cl.ix(row, c), z = cl.ix(row, c + 1), i = a * 3, j = z * 3;
    const d = Math.hypot(cl.pos[j] - cl.pos[i], cl.pos[j + 1] - cl.pos[i + 1],
                         cl.pos[j + 2] - cl.pos[i + 2]);
    const m = cl.matDist(a, z), ratio = d / m;
    arc += d; mat += m;
    if (ratio < 0.995) slack++;
    if (ratio > 1.01) excess++;
    min = Math.min(min, ratio); max = Math.max(max, ratio);
  }
  return { ratio: arc / mat, slack, excess, min, max };
};
console.log(`Замороженный вход после опорных 30 с при 140°/6 м/с, шкот ${sheet} м, галс ${tack}; масштаб силы ${loadScale}, тяжести ${gravityScale}; ${sheetRamp ? `шкот от проектного до ${sheet} м за ${sheetRamp} с` : 'шкот постоянен'}; полоски и лодка больше не шагают`);
console.log(`Исходный максимальный разброс q по хорде: ${qSpread.toExponential(3)}`);
console.log(`Опорная ткань 11×9: вход ${minShape(reference).angle.toFixed(1)}°, ` +
            `пузо строки 5 ${(100 * reference.rowShape(5).camber).toFixed(1)} % хорды; ` +
            `тяга ${b.rig.stripState.slice(12).reduce((s, d) => s + d.drive, 0).toFixed(1)} Н`);
console.log(`Ткань: ${iter} проходов, ${clothHz} Гц, изгиб ${bend == null ? 'штатный' : bend}, нормали ${fixedNormals ? 'зафиксированы на первом подшаге' : 'следуют за тканью'}, площадь нагрузки ${fixedLoad ? 'зафиксирована на первом подшаге' : 'следует за тканью'}; дальние пределы ${attachmentPaths ? 'пути по жёстким рёбрам' : 'хорды кроя'}; жёсткое верхнее крепление ${rigidBoard}`);
console.log('столбцов | время ткани с | мин. вход °/строка | max ход назад/вывернуто % | пузо строки 5 % | Fx/Fy ткани Н');
const priorCuts = [];
const clewArc = b.p.rig.gennaker.clew_arc_r;
const designSheet = 0.5 * (b.p.rig.gennaker.sheet_min_m + b.p.rig.gennaker.sheet_max_m);
for (const n of cols) {
  b.p.rig.gennaker.clew_arc_r = clewArc;
  b.o.genSheetLen = sheetRamp ? designSheet : sheet;
  const cl = new Cloth(b.rig.sails[2], 2, { rows: 11, cols: n, iter,
    ...(bend == null ? {} : { bend }), boardMaterial, attachmentPaths, rigidBoard });
  if (fixedNormals) {
    const follow = cl.rowNormals.bind(cl);
    let firstNormals = null;
    cl.rowNormals = (wx, wy) => {
      if (!firstNormals) { follow(wx, wy); firstNormals = cl.nrm.slice(); }
      else cl.nrm.set(firstNormals);
    };
  }
  if (fixedLoad) {
    const currentArea = cl.flyingAreas.bind(cl);
    let firstArea = null;
    cl.flyingAreas = () => {
      if (!firstArea) firstArea = currentArea().slice();
      return firstArea;
    };
  }
  let firstPressure = null;
  for (let i = 0; i < 30 * clothHz; i++) {
    if (sheetRamp) b.o.genSheetLen = designSheet + (sheet - designSheet) *
      Math.min(1, i / (clothHz * sheetRamp));
    if (!cl.step(b, 1 / clothHz)) throw new Error('Шаг ткани отклонён');
    if (fixedLoad) {
      const applied = JSON.stringify(cl.pressureForce);
      if (firstPressure == null) firstPressure = applied;
      else if (applied !== firstPressure) throw new Error('Зафиксированная понодальная нагрузка изменилась');
    }
    if (i === 0) {
      const cut = minShape(cl, true), fly = minShape(cl);
      console.log(`${n} | крой/первый шаг | ${cut.angle.toFixed(1)}/${fly.angle.toFixed(1)}° | ` +
        `${(100 * cut.maxBack).toFixed(1)}/${(100 * cut.maxFlip).toFixed(1)} % по крою; ` +
        `${(100 * fly.maxBack).toFixed(1)}/${(100 * fly.maxFlip).toFixed(1)} % в полёте`);
      if (cornerAudit) {
        const expected = gennakerClew(b.o, b.p.rig.gennaker);
        expected[1] = Math.abs(expected[1]) * Math.sign(b.rigSide || -1);
        const k = cl.clew * 3;
        const gap = Math.hypot(expected[0] - cl.pos[k], expected[1] - cl.pos[k + 1],
                               expected[2] - cl.pos[k + 2]);
        console.log(`${n} | шкотовый угол: крой→дуга ${gap.toFixed(4)} м, ` +
          `крой ${[cl.pos[k], cl.pos[k + 1], cl.pos[k + 2]].map(x => x.toFixed(3)).join('/')}, ` +
          `дуга ${expected.map(x => x.toFixed(3)).join('/')}`);
      }
      if (cutNesting) {
        for (const prev of priorCuts) {
          if ((n - 1) % (prev.cols - 1) !== 0) continue;
          const stride = (n - 1) / (prev.cols - 1);
          let worst = { d: 0, row: 0, col: 0 };
          for (let r = 0; r < cl.rows; r++) for (let c = 0; c < prev.cols; c++) {
            const a = cl.ix(r, c * stride), z = r * prev.cols + c;
            const d = Math.hypot(cl.dx[a] - prev.dx[z], cl.dy[a] - prev.dy[z],
                                 cl.dz[a] - prev.dz[z]);
            if (d > worst.d) worst = { d, row: r, col: c };
          }
          console.log(`${n} | крой против ${prev.cols}: общий узел max ${worst.d.toExponential(3)} м, строка ${worst.row}, столбец ${worst.col}`);
          if (worst.d > 1e-9) throw new Error('Вложенные сетки имеют разный крой в общем узле');
        }
        priorCuts.push({ cols: n, dx: cl.dx.slice(), dy: cl.dy.slice(), dz: cl.dz.slice() });
      }
      if (holdCutClew) b.p.rig.gennaker.clew_arc_r = 0;
    }
    const time = (i + 1) / clothHz;
    if (![5, 10, 20, 30, ...(edgeAudit || cellAudit ? [0.5, 1, 2, 3] : [])].includes(time)) continue;
    const s = minShape(cl), load = cl.load || {};
    let line = `${n} | ${time.toFixed(time < 5 ? 1 : 0)} | ${s.angle.toFixed(1)}/${s.row} | ${(100 * s.maxBack).toFixed(1)}/${(100 * s.maxFlip).toFixed(1)} | ${(100 * cl.rowShape(5).camber).toFixed(1)} | ${(load.fx || 0).toFixed(1)}/${(load.fy || 0).toFixed(1)}`;
    if (edgeAudit) {
      const luff = edgeState(cl, 0), leech = edgeState(cl, cl.cols - 1);
      line += ` | кромки дуга/крой ${(100 * luff.ratio).toFixed(1)}/${(100 * leech.ratio).toFixed(1)} %; натянуто ${luff.taut}/${leech.taut} из ${cl.rows - 1}; ход назад стр. ${s.backRow}`;
    }
    if (cellAudit) {
      const r = s.backRow < 0 ? 5 : s.backRow;
      const links = rowLinks(cl, r);
      line += ` | строка ${r}: дуга/крой ${(100 * links.ratio).toFixed(1)} %, слабых ${links.slack}, растянутых >1 % ${links.excess} из ${cl.cols - 1}, min/max ${(100 * links.min).toFixed(1)}/${(100 * links.max).toFixed(1)} %`;
    }
    console.log(line);
  }
  if (frozenInput() !== inputBefore) throw new Error('Замороженный вход изменился при шаге ткани');
}
b.p.rig.gennaker.clew_arc_r = clewArc;
b.o.genSheetLen = sheet;
