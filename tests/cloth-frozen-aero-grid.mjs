// Один и тот же замороженный аэродинамический вход для нескольких сеток ткани:
// node tests/cloth-frozen-aero-grid.mjs --tack=1 --sheet=9
// Лодка и полоски после опорных 30 с не двигаются; отдельно шагает только ткань.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';
import { gennakerClew } from '../sim/aero.js';
import { constraintFamily, constraintErrorsOf, observeClothMechanics } from './lib/cloth-mechanics.mjs';
import { installEnergyExperiment } from './lib/cloth-energy-experiment.mjs';
import { IMPLICIT_TOLERANCES } from './lib/cloth-implicit-motion.mjs';
import { wrenchOf } from './lib/gennaker-observables.mjs';
import { sharedInputFromCloth, installSharedInput } from './lib/cloth-shared-input.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packPath = resolve(root, 'out/export/physics.json'), packBytes = readFileSync(packPath);
const pack = JSON.parse(packBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = [...readdirSync(resolve(root, 'sim')).filter(f => f.endsWith('.js')).map(f => `sim/${f}`),
  'tests/cloth-frozen-aero-grid.mjs', 'tests/lib/cloth-mechanics.mjs',
  'tests/lib/cloth-energy-experiment.mjs', 'tests/lib/cloth-energy-motion.mjs',
  'tests/lib/cloth-material.mjs', 'tests/cloth-compliance.mjs', 'tests/lib/cloth-implicit-motion.mjs', 'tests/lib/cloth-linear-solve.mjs',
  'tests/lib/gennaker-observables.mjs', 'tests/lib/cloth-shared-input.mjs'];
const sourceSha256 = Object.fromEntries(sourcePaths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
const startedAt = new Date().toISOString();
const numericFlags = ['tack', 'sheet', 'iter', 'cloth-hz', 'load-scale', 'gravity-scale',
  'sheet-ramp', 'bend', 'seconds', 'cols', 'grids', 'out'];
const booleanFlags = ['fixed-load', 'fixed-normals', 'edges', 'cells', 'cut-nesting',
  'board-material', 'attachment-paths', 'rigid-board', 'mechanics', 'without-shear',
  'without-bend', 'corner-gap', 'hold-cut-clew', 'energy-material', 'implicit-motion', 'audit-input', 'shared-input', 'continuous-cut', 'analytic-cut-profile'];
const seenFlags = new Set();
for (const argument of process.argv.slice(2)) {
  const equals = argument.indexOf('='), name = argument.slice(2, equals < 0 ? undefined : equals);
  if (!argument.startsWith('--') || ![...numericFlags, ...booleanFlags].includes(name))
    throw new Error(`Неизвестный параметр ${argument}`);
  if (seenFlags.has(name)) throw new Error(`Повторный параметр --${name}`);
  seenFlags.add(name);
  if (numericFlags.includes(name) && (equals < 0 || equals === argument.length - 1))
    throw new Error(`--${name}: требуется значение после =`);
  if (booleanFlags.includes(name) && equals >= 0) throw new Error(`--${name}: значение не требуется`);
}
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
const mechanics = process.argv.includes('--mechanics');
const withoutShear = process.argv.includes('--without-shear');
const withoutBend = process.argv.includes('--without-bend');
const energyMaterial = process.argv.includes('--energy-material');
const implicitMotion = process.argv.includes('--implicit-motion');
const auditInput = process.argv.includes('--audit-input');
const sharedInput = process.argv.includes('--shared-input');
const continuousCut = process.argv.includes('--continuous-cut');
const analyticCutProfile = process.argv.includes('--analytic-cut-profile');
const seconds = arg('seconds', 30);
const outArg = process.argv.find(s => s.startsWith('--out='))?.slice('--out='.length);
if (process.argv.includes('--out') || outArg === '') throw new Error('--out: требуется путь после =');
const cornerAudit = process.argv.includes('--corner-gap');
const holdCutClew = process.argv.includes('--hold-cut-clew');
const bend = process.argv.some(s => s.startsWith('--bend=')) ? arg('bend', 0.05) : null;
const cols = (process.argv.find(s => s.startsWith('--cols='))?.split('=')[1] ?? '9,17,33')
  .split(',').map(Number);
const gridsArg = process.argv.find(s => s.startsWith('--grids='))?.slice('--grids='.length);
if (gridsArg && seenFlags.has('cols')) throw new Error('--grids и --cols задают альтернативные списки сеток');
const grids = gridsArg ? gridsArg.split(',').map(s => {
  if (!/^\d+x\d+$/.test(s)) throw new Error('--grids: нужны пары строкxстолбцов, например 11x9,21x17');
  const [rows, cols] = s.split('x').map(Number); return { rows, cols };
}) : cols.map(cols => ({ rows: 11, cols }));
if (![1, -1].includes(tack) || !(sheet > 0) || !(loadScale >= 0 && loadScale <= 2) ||
    !(gravityScale >= 0 && gravityScale <= 1) || !(sheetRamp >= 0 && sheetRamp <= 30) ||
    !Number.isInteger(iter) || iter < 1 ||
    (bend != null && !(bend >= 0 && bend <= 1)) ||
    ![30, 60, 120, 240].includes(clothHz) ||
    !(seconds >= 1 && seconds <= 30 && Number.isInteger(seconds)) ||
    grids.some(g => ![g.rows, g.cols].every(x => Number.isInteger(x) && x >= 5 && x <= 65)) ||
    new Set(grids.map(g => `${g.rows}x${g.cols}`)).size !== grids.length)
  throw new Error('Неверные параметры стенда');
if (energyMaterial && (!fixedLoad || !mechanics || !rigidBoard || !holdCutClew || withoutShear || withoutBend || bend != null || sheetRamp))
  throw new Error('Новый материал: нужны --fixed-load --mechanics --rigid-board --hold-cut-clew; исключение семей, bend и sheet-ramp неприменимы');
if (implicitMotion && !energyMaterial) throw new Error('--implicit-motion требует --energy-material');
if (auditInput && (energyMaterial || mechanics || sheetRamp || !fixedLoad))
  throw new Error('--audit-input: нужен --fixed-load; движение, механика и смена шкота не вычисляются');
if (sharedInput && (!fixedLoad || !rigidBoard || !holdCutClew || sheetRamp ||
    (!auditInput && !implicitMotion)))
  throw new Error('--shared-input: нужны --fixed-load --rigid-board --hold-cut-clew и полное движение или --audit-input');
if (sharedInput && grids.some(g => (g.rows-1)%10 || (g.cols-1)%8))
  throw new Error('--shared-input: сетки должны быть вложены в исходную 11×9');
if (continuousCut && (!fixedLoad || !rigidBoard || !holdCutClew || (!auditInput && !implicitMotion)))
  throw new Error('--continuous-cut: нужен отдельный опыт --fixed-load --rigid-board --hold-cut-clew с аудитом входа или полным движением');
if (analyticCutProfile && !continuousCut)
  throw new Error('--analytic-cut-profile требует --continuous-cut');
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
let sharedInputField = null;
if (sharedInput) {
  const source = new Cloth(b.rig.sails[2],2,{rows:11,cols:9,rigidBoard:true,continuousCut,analyticCutProfile});
  source.advance = function (...args) { this.forcesAt(...args); };
  if (!source.step(b,1/clothHz)) throw new Error('Не удалось подготовить общий вход');
  sharedInputField = sharedInputFromCloth(source,b);
}
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
console.log(`Ткань: ${iter} проходов, ${clothHz} Гц, изгиб ${energyMaterial ? 'заданная энергия кривизны' : bend == null ? 'штатный' : bend}, нормали ${fixedNormals ? 'зафиксированы на первом подшаге' : 'следуют за тканью'}, площадь нагрузки ${fixedLoad ? 'зафиксирована на первом подшаге' : 'следует за тканью'}; дальние пределы ${energyMaterial ? 'отключены' : attachmentPaths ? 'пути по жёстким рёбрам' : 'хорды кроя'}; жёсткое верхнее крепление ${rigidBoard}`);
if (mechanics) console.log(`Аудит механики: начальная посадка отдельно; длительность отсчитывается после неё. Работа силы и энергия движения измеряются; ${energyMaterial ? 'энергия нового материала записана в energyMotion; закрепления неподвижны, реакции ещё не приняты' : 'энергия материала и работа креплений неизвестны'}.`);
if (energyMaterial) console.log('Явный новый материал: энергия и остаток физического движения записываются отдельно; неподвижные углы, жёсткие кромки и длина планки; прежние внутренние жёсткие рёбра/мягкие связи/дальние пределы отключены.');
if (implicitMotion) console.log(`Полное уравнение энергии: ошибка сил ≤${IMPLICIT_TOLERANCES.forceToleranceN} Н, длины ≤${IMPLICIT_TOLERANCES.lengthToleranceM} м; недоведённый шаг отклоняется.`);
if (sharedInput) console.log('Общий вход: билинейное поле из неподвижного кроя 11×9; давление, вес, масса и сопротивление движения интегрируются на вложенных сетках. Это отдельная заданная постановка, не прежняя раскладка воздуха.');
if (withoutShear || withoutBend) console.log(`Диагностическое исключение связей: диагонали ${withoutShear}, изгиб ${withoutBend}; не новый принятый материал`);
console.log(auditInput ? 'Только исходный вход: движения ткани и его приёмки в этой записи нет.' :
  'строки×столбцы | время ткани с | мин. вход °/строка | max ход назад/вывернуто % | полнота середины % | Fx/Fy ткани Н');
const results = [];
const priorCuts = [];
const checkCut = cl => {
  if (!cutNesting) return;
  for (const prev of priorCuts) {
    if ((cl.rows - 1) % (prev.rows - 1) || (cl.cols - 1) % (prev.cols - 1)) continue;
    const sr = (cl.rows - 1) / (prev.rows - 1), sc = (cl.cols - 1) / (prev.cols - 1);
    let worst = { d: 0, row: 0, col: 0 };
    for (let r = 0; r < prev.rows; r++) for (let c = 0; c < prev.cols; c++) {
      const a = cl.ix(r * sr, c * sc), z = r * prev.cols + c;
      const d = Math.hypot(cl.dx[a] - prev.dx[z], cl.dy[a] - prev.dy[z], cl.dz[a] - prev.dz[z]);
      if (d > worst.d) worst = { d, row: r, col: c };
    }
    console.log(`${cl.rows}×${cl.cols} | крой против ${prev.rows}×${prev.cols}: общий узел max ${worst.d.toExponential(3)} м, строка ${worst.row}, столбец ${worst.col}`);
    if (worst.d > 1e-9) throw new Error('Вложенные сетки имеют разный крой в общем узле');
  }
  priorCuts.push({ rows: cl.rows, cols: cl.cols, dx: cl.dx.slice(), dy: cl.dy.slice(), dz: cl.dz.slice() });
};
const initialInputOf = cl => {
  const points = Array.from({ length: cl.n }, (_, i) => Array.from(cl.pos.slice(3 * i, 3 * i + 3)));
  const forces = points.map((_, i) => Array.from(cl.nrm.slice(3 * i, 3 * i + 3), x => x * cl.pressureForce[i]));
  return { frame: 'rig', originM: [0, 0, 0], ...wrenchOf(points, forces),
    massKg: Array.from(cl.mass).reduce((s, x) => s + x, 0),
    referenceAreaM2: Array.from(cl.area).reduce((s, x) => s + x, 0),
    positionsM: points.flat(), pressureVectorsN: forces.flat(), appliedVectorsN: Array.from(cl.frc),
    nodalMassKg: Array.from(cl.mass) };
};
const clewArc = b.p.rig.gennaker.clew_arc_r;
const designSheet = 0.5 * (b.p.rig.gennaker.sheet_min_m + b.p.rig.gennaker.sheet_max_m);
const verifyInputs = () => {
  for (const path of sourcePaths) assert.equal(hash(readFileSync(resolve(root, path))), sourceSha256[path],
    `Исходник изменился во время опыта: ${path}`);
  assert.equal(hash(readFileSync(packPath)), hash(packBytes), 'Пакет изменился во время опыта');
  assert.equal(frozenInput(), inputBefore, 'Замороженный вход изменился');
};
const saveOutcome = extra => {
  if (!outArg) return;
  const path = resolve(root, outArg); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: 1, startedAt, createdAt: new Date().toISOString(),
    revision, dirty, physicsSha256: hash(packBytes), sourceSha256,
    config: { tack, sheet, iter, clothHz, seconds, cols: grids.map(g => g.cols), grids, auditInput, loadScale, gravityScale, sheetRamp,
      fixedLoad, fixedNormals, bend, boardMaterial, attachmentPaths, rigidBoard, mechanics,
      withoutShear, withoutBend, holdCutClew, energyMaterial, implicitMotion, sharedInput, continuousCut, analyticCutProfile },
    ...(sharedInput ? { sharedInputField: { ...sharedInputField, values: Array.from(sharedInputField.values),
      parameterDomain: 'доли высоты/ширины [0,1]×[0,1]',
      rule: 'билинейные плотности из исходных узловых интегралов 11×9; точное распределение 2×2 точками на вложенных ячейках',
      componentOrder: 'pressure[3] Н, gravity[3] Н, mass[1] кг, normalDrag[9] Н·с/м на единицу параметрической площади' } } : {}),
    durationRule: mechanics ? 'посадка отдельно, затем заданные секунды движения' : 'прежний счёт кадров включает посадку',
    results, ...extra }, null, 2) + '\n');
  console.log(`Сохранено: ${path}`);
};
let failureContext = null;
try {
for (const { rows, cols: n } of grids) {
  failureContext = { rows, cols: n, stage: 'preparation', requestedFrameTimeS: null, lastCompletedFrameTimeS: null };
  b.p.rig.gennaker.clew_arc_r = clewArc;
  b.o.genSheetLen = sheetRamp ? designSheet : sheet;
  const cl = new Cloth(b.rig.sails[2], 2, { rows, cols: n, iter,
    ...(bend == null ? {} : { bend }), boardMaterial, attachmentPaths, rigidBoard, continuousCut, analyticCutProfile });
  // Топология и крой сохраняются: исключается только действие выбранной семьи.
  for (let k = 0; k < cl.ck.length; k++) {
    const family = constraintFamily(cl, k);
    if ((withoutShear && family === 'shear') || (withoutBend && family === 'bend')) cl.ck[k] = 0;
  }
  if (sharedInput) installSharedInput(cl,sharedInputField);
  const energy = energyMaterial ? installEnergyExperiment(cl, { implicit: implicitMotion }) : null;
  const observer = mechanics ? observeClothMechanics(cl) : null;
  let warmup = null;
  const samples = [], wallStart = performance.now();
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
  let initialInput = null;
  const originalForcesAt = cl.forcesAt;
  cl.forcesAt = function (...args) {
    const value = originalForcesAt.apply(this, args);
    if (!initialInput) initialInput = initialInputOf(this);
    return value;
  };
  failureContext.snapshot = () => ({ initialInput, warmup, samples,
    lastCompletedPositionsM: Array.from(cl.pos), lastCompletedMechanics: observer?.snapshot() || null,
    lastCompletedEnergyMotion: energy?.snapshot() || null,
    referencePositionsM: Array.from({ length: cl.n * 3 }, (_, k) =>
      [cl.dx, cl.dy, cl.dz][k % 3][Math.floor(k / 3)]),
    wallSeconds: (performance.now() - wallStart) / 1000 });
  if (auditInput) {
    // step() готовит штатный крой и начальное положение. Здесь advance()
    // только читает силу: ни один из сорока вызовов не перемещает полотно.
    cl.advance = function (...args) { this.forcesAt(...args); };
    failureContext.stage = 'input-audit';
    if (!cl.step(b, 1 / clothHz)) throw new Error('Не удалось подготовить вход ткани');
    checkCut(cl);
    assert.equal(frozenInput(), inputBefore, 'Замороженный вход изменился при измерении');
    results.push({ rows, cols: n, initialInput,
      referencePositionsM: Array.from({ length: cl.n * 3 }, (_, k) =>
        [cl.dx, cl.dy, cl.dz][k % 3][Math.floor(k / 3)]) });
    console.log(`${rows}×${n} | только вход: сила ${initialInput.forceN.map(x => x.toFixed(6)).join('/')} Н; момент ${initialInput.momentNm.map(x => x.toFixed(6)).join('/')} Н·м; масса ${initialInput.massKg.toFixed(6)} кг`);
    continue;
  }
  let firstPressure = null;
  const startIndex = mechanics ? -1 : 0;
  for (let i = startIndex; i < seconds * clothHz; i++) {
    failureContext.stage = i === startIndex ? 'warmup' : 'timed';
    failureContext.requestedFrameTimeS = (i + 1) / clothHz;
    if (sheetRamp) b.o.genSheetLen = designSheet + (sheet - designSheet) *
      Math.max(0, Math.min(1, i / (clothHz * sheetRamp)));
    if (!cl.step(b, 1 / clothHz)) throw new Error('Шаг ткани отклонён');
    failureContext.lastCompletedFrameTimeS = (i + 1) / clothHz;
    if (fixedLoad) {
      const applied = JSON.stringify(cl.pressureForce);
      if (firstPressure == null) firstPressure = applied;
      else if (applied !== firstPressure) throw new Error('Зафиксированная понодальная нагрузка изменилась');
    }
    if (i === startIndex) {
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
      checkCut(cl);
      if (holdCutClew) b.p.rig.gennaker.clew_arc_r = 0;
      if (observer) { warmup = { ...observer.snapshot(), ...(energy ? { energyMotion: energy.snapshot() } : {}) }; observer.reset(); }
      energy?.reset();
      if (energy) samples.push({ timeS: 0, positionsM: Array.from(cl.pos), energyMotion: energy.snapshot() });
    }
    const time = (i + 1) / clothHz;
    if (![5, 10, 20, 30, seconds, ...(edgeAudit || cellAudit ? [0.5, 1, 2, 3] : [])].includes(time)) continue;
    const s = minShape(cl), load = cl.load || {};
    const audit = observer?.snapshot() || null;
    samples.push({ timeS: time, shape: s, middle: cl.rowShape((rows - 1) / 2),
      loadN: { fx: load.fx, fy: load.fy, fz: load.fz },
      edges: { luff: edgeState(cl, 0), leech: edgeState(cl, cl.cols - 1) },
      constraints: constraintErrorsOf(cl), mechanics: audit,
      ...(energy ? { energyMotion: energy.snapshot(), positionsM: Array.from(cl.pos) } : {}) });
    let line = `${rows}×${n} | ${time.toFixed(time < 5 ? 1 : 0)} | ${s.angle.toFixed(1)}/${s.row} | ${(100 * s.maxBack).toFixed(1)}/${(100 * s.maxFlip).toFixed(1)} | ${(100 * cl.rowShape((rows - 1) / 2).camber).toFixed(1)} | ${(load.fx || 0).toFixed(1)}/${(load.fy || 0).toFixed(1)}`;
    if (edgeAudit) {
      const luff = edgeState(cl, 0), leech = edgeState(cl, cl.cols - 1);
      line += ` | кромки дуга/крой ${(100 * luff.ratio).toFixed(1)}/${(100 * leech.ratio).toFixed(1)} %; натянуто ${luff.taut}/${leech.taut} из ${cl.rows - 1}; ход назад стр. ${s.backRow}`;
    }
    if (cellAudit) {
      const r = s.backRow < 0 ? Math.floor((rows - 1) / 2) : s.backRow;
      const links = rowLinks(cl, r);
      line += ` | строка ${r}: дуга/крой ${(100 * links.ratio).toFixed(1)} %, слабых ${links.slack}, растянутых >1 % ${links.excess} из ${cl.cols - 1}, min/max ${(100 * links.min).toFixed(1)}/${(100 * links.max).toFixed(1)} %`;
    }
    console.log(line);
    if (audit) console.log(`${n} | механика ${time.toFixed(1)} с: работа давления ${audit.workJ.pressure.toFixed(4)} Дж, ` +
      `прочих сил ${audit.workJ.otherApplied.toFixed(4)} Дж; энергия движения ${audit.kineticJ.toExponential(3)} Дж; ` +
      `шаги ${audit.stepsByH.map(s => `${s.hS.toFixed(6)} с × ${s.count}`).join(', ')}`);
    if (energy) { const e = energy.snapshot(); console.log(`${n} | энергия материала ${e.material.totalJ.toFixed(6)} Дж, ` +
      `остаток физического движения RMS/макс. ${e.rmsPhysicalResidualN.toExponential(3)}/${e.maxPhysicalResidualN.toExponential(3)} Н, ` +
      `ошибка кромок/планки ${e.maxHardViolationM.toExponential(3)} м`); }
  }
  if (frozenInput() !== inputBefore) throw new Error('Замороженный вход изменился при шаге ткани');
  const measured = observer?.snapshot() || null;
  if (fixedLoad && measured) assert.ok(measured.maxPressureVectorChangeN < 1e-12,
    'Замороженный вектор давления изменился внутри подшага');
  if (fixedLoad && warmup) assert.ok(warmup.maxPressureVectorChangeN < 1e-12,
    'Замороженный вектор давления изменился при посадке');
  const referencePositionsM = Array.from({ length: cl.n * 3 }, (_, k) =>
    [cl.dx, cl.dy, cl.dz][k % 3][Math.floor(k / 3)]);
  results.push({ rows, cols: n, initialInput, warmup, mechanics: measured, samples,
    ...(energy ? { energyMotion: energy.snapshot() } : {}),
    constraints: constraintErrorsOf(cl), finalPositionsM: Array.from(cl.pos), referencePositionsM,
    wallSeconds: (performance.now() - wallStart) / 1000 });
  observer?.detach();
}
} catch (error) {
  let inputsVerified = true, inputError = null;
  try { verifyInputs(); } catch (guardError) { inputsVerified = false; inputError = guardError.message; }
  const { snapshot, ...context } = failureContext || {};
  saveOutcome({ phase: 'failed', inputsVerified, inputError,
    failure: { ...context, message: error.message }, failedGrid: snapshot?.() || null,
    resultRule: 'results — завершённые сетки; failedGrid — последнее сохранённое состояние, не принятый конечный результат' });
  throw error;
}
b.p.rig.gennaker.clew_arc_r = clewArc;
b.o.genSheetLen = sheet;
verifyInputs();
saveOutcome({ phase: 'complete', inputsVerified: true });
