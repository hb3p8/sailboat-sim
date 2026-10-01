// Совместный протокол: форма → приложенная нагрузка → силы лодки → управление.
// node tests/gennaker-acceptance.mjs --out=out/acceptance/baseline.json
// Критерии: docs/reference/gennaker-acceptance.md. Решатель CFD не вызывается.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Boat } from '../sim/physics.js';
import { FULL } from './lib/mode.mjs';
import { sectionsOf, clothPressureOf, stripLoadOf, sheetGeometryOf,
  stabilityOf, entryCycles, SECTION_FRACTIONS, LIMITS, rollVector } from './lib/gennaker-observables.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packPath = resolve(root, 'out/export/physics.json');
const packBytes = readFileSync(packPath), pack = JSON.parse(packBytes);
const flags = new Map();
for (const a of process.argv.slice(2)) {
  const [key, value] = a.split('=');
  if (!['--out', '--case', '--local-pressure', '--panels', '--hz', '--rows', '--cols',
    '--iter', '--free-clew', '--attachment-paths', '--rigid-board', '--full', '--trace', '--gate'].includes(key))
    throw new Error(`Неизвестный параметр ${key}`);
  if (flags.has(key)) throw new Error(`Повторный параметр ${key}`);
  flags.set(key, value ?? true);
}
const number = (key, fallback) => {
  if (flags.get(key) === true) throw new Error(`${key}: требуется числовое значение`);
  const x = Number(flags.get(key) ?? fallback);
  if (!Number.isInteger(x)) throw new Error(`${key}: требуется целое число`);
  return x;
};
const config = { hz: number('--hz', 30), rows: number('--rows', 11),
  cols: number('--cols', 9), iter: number('--iter', 10), panels: number('--panels', 32),
  localPressure: flags.has('--local-pressure'), freeClew: flags.has('--free-clew'),
  attachmentPaths: flags.has('--attachment-paths'), rigidBoard: flags.has('--rigid-board') };
if (![30, 60, 120].includes(config.hz) || config.rows < 3 || config.rows > 41 ||
    config.cols < 5 || config.cols > 65 || config.iter < 1 || config.iter > 640 ||
    config.panels < 4 || config.panels > 128) throw new Error('Параметры вне диапазона протокола');
for (const key of ['--out', '--case'])
  if (flags.get(key) === true) throw new Error(`${key}: требуется значение`);
for (const key of ['--local-pressure', '--free-clew', '--attachment-paths', '--rigid-board', '--full', '--trace', '--gate'])
  if (flags.has(key) && flags.get(key) !== true) throw new Error(`${key}: значение не требуется`);
const D = Math.PI / 180;
const wrap = x => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sourcePaths = [...readdirSync(resolve(root, 'sim')).filter(f => f.endsWith('.js')).map(f => `sim/${f}`),
  'tests/lib/gennaker-observables.mjs', 'tests/gennaker-acceptance.mjs'];
const sourceSha256 = Object.fromEntries(sourcePaths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
const startedAt = new Date().toISOString();
const limits = { ...LIMITS };
const core = { id: 'core', twa: 140, tws: 6, lengths: [8.5, 9, 8.5],
  ends: [12, 20, 32], windows: [[9, 12], [17, 20], [29, 32]] };
const deep = { ...core, id: 'deep', twa: 150, lengths: [8.5, 9.2, 8.5] };
const progressive = { id: 'progressive', twa: 140, tws: 6,
  lengths: [8.5, 9, 9.2, 8.5], ends: [12, 20, 28, 40],
  windows: [[9, 12], [17, 20], [25, 28], [37, 40]] };
const presets = [core, deep, progressive];
if (FULL) for (const [twa, tws] of [[135, 6], [145, 6], [140, 4], [140, 8]])
  presets.push({ ...progressive, id: `neighbor-${twa}-${tws}`, twa, tws });
const cases = flags.has('--case') ? presets.filter(c => c.id === flags.get('--case')) : presets;
if (!cases.length) throw new Error('Неизвестный случай; core, deep, progressive или соседний в --full');
for (const c of cases) if (c.lengths.some(l =>
  l < pack.rig.gennaker.sheet_min_m || l > pack.rig.gennaker.sheet_max_m))
  throw new Error(`Случай ${c.id} вне диапазона текущего пакета`);

function once(c, tack, u0, changed) {
  const b = new Boat(pack);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.localPressure = config.localPressure ? { panels: config.panels } : false;
  b.o.cloth = { rows: config.rows, cols: config.cols, iter: config.iter,
    freeClew: config.freeClew, attachmentPaths: config.attachmentPaths, rigidBoard: config.rigidBoard };
  b.o.crewHike = -tack; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = c.lengths[0];
  b.reset(); b.o.windSpeed = c.tws; b.o.windDir = 100 * D; b.u = u0;
  const course = (100 - tack * c.twa) * D;
  b.psi = course;
  const origin = [pack.mass.cg_m[0], 0, pack.mass.cg_m[2]];
  const cloth = b.rig.cloth, forcesAt = cloth.forcesAt;
  const effectiveCloth = Object.fromEntries(['rows', 'cols', 'iter', 'bend', 'cut3d',
    'boardMaterial', 'rigidBoard', 'freeClew', 'attachmentPaths', 'rhoAir'].map(k => [k, cloth[k]]));
  const initialOptions = JSON.parse(JSON.stringify(b.o));
  let pressure, forceCheck = 0, allRigCheck = 0;
  // Снимок делается до перемещения узлов, в момент расчёта самой нагрузки.
  // Обёртка возвращает исходный результат и не пишет в состояние модели.
  cloth.forcesAt = function (...args) {
    const result = forcesAt.apply(this, args);
    pressure = clothPressureOf(this, b.phi, origin, flags.has('--trace'));
    const actual = rollVector([this.load.fx, this.load.fy, this.load.fz], b.phi);
    forceCheck = Math.max(forceCheck,
      ...actual.map((x, k) => Math.abs(x - pressure.forceN[k]) / Math.max(1, Math.abs(x))),
      Math.abs(this.load.mx - pressure.momentNm[0]) / Math.max(1, Math.abs(this.load.mx)));
    assert.ok(forceCheck < 1e-9, 'Снимок нагрузки не совпадает с Cloth.load');
    return result;
  };
  const samples = [];
  const wallStart = performance.now();
  const steps = c.ends.at(-1) * config.hz;
  for (let i = 0; i < steps; i++) {
    const t = i / config.hz;
    const phase = c.ends.findIndex(end => t < end);
    b.o.genSheetLen = changed ? c.lengths[phase] : c.lengths[0];
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
      -(2.2 * wrap(course - b.psi) - 0.9 * b.r)));
    const loadPhi = b.phi;
    b.step(1 / config.hz);
    const gen = stripLoadOf(b.rig, loadPhi, origin, 2);
    const all = stripLoadOf(b.rig, loadPhi, origin);
    const sail = b.rig.sailOut;
    allRigCheck = Math.max(allRigCheck,
      ...[sail.fx, sail.fy, sail.fz].map((f, k) => Math.abs(f - all.forceN[k]) / Math.max(1, Math.abs(f))),
      Math.abs(sail.mx - all.momentNm[0]) / Math.max(1, Math.abs(sail.mx)),
      Math.abs(sail.mz - all.momentNm[2]) / Math.max(1, Math.abs(sail.mz)));
    assert.ok(allRigCheck < 1e-9, 'Полоски не восстановили приложенные лодке силу/момент');
    const strips = b.rig.stripState.filter((_, k) => b.rig.strips[k].sail === 2);
    const genDefs = b.rig.strips.filter(s => s.sail === 2);
    const sections = sectionsOf(cloth);
    if (!b.rig.stripGamma?.length) throw new Error('Нет измерения циркуляции');
    const sample = { t, tAfter: (i + 1) / config.hz, phase,
      sheetM: b.o.genSheetLen, sections, pressureAtLoad: pressure,
      genLoad: gen, driveN: b.telemetry.driveN, speedKn: b.telemetry.speedKn,
      heelDeg: b.telemetry.heelDeg, yawRateDegS: b.telemetry.yawRate,
      awaDeg: b.telemetry.awaDeg, twaDeg: b.telemetry.twaDeg,
      gammaMax: Math.max(0, ...Array.from(b.rig.stripGamma || [], Math.abs)),
      sheet: sheetGeometryOf(cloth, pack.rig.gennaker, b.rigSide, b.o.genSheetLen),
      renderAmplitudeEstimateM: Math.max(0, ...strips.map((g, k) =>
        (2 / Math.PI) * g.luffFrac * genDefs[k].chord * Math.sqrt(Math.max(0, g.slack)))),
    };
    if (flags.has('--trace')) sample.rigPositionsAfterStepM = Array.from(cloth.pos);
    if (![sample.driveN, sample.speedKn, sample.heelDeg, sample.yawRateDegS,
      sample.awaDeg, sample.twaDeg, sample.renderAmplitudeEstimateM].every(Number.isFinite))
      throw new Error(`Не-конечное состояние: ${c.id}, галс ${tack}, шаг ${i}`);
    samples.push(sample);
  }
  return { samples, stability: stabilityOf(samples), forceCheck, allRigCheck,
    effectiveCloth, initialOptions,
    wallSeconds: (performance.now() - wallStart) / 1000 };
}

function windowOf(samples, lo, hi) {
  const a = samples.filter(s => s.t >= lo && s.t < hi);
  assert.ok(a.length, 'Пустое окно');
  const sections = a.flatMap(s => s.sections);
  const localProfileReasons = {};
  for (const s of a) for (const [reason, count] of Object.entries(s.pressureAtLoad.localProfiles.reasons))
    localProfileReasons[reason] = (localProfileReasons[reason] || 0) + count;
  const averageVector = getter => [0, 1, 2].map(k => mean(a.map(s => getter(s)[k])));
  return { windowS: [lo, hi], samples: a.length,
    speedKn: mean(a.map(s => s.speedKn)), driveN: mean(a.map(s => s.driveN)),
    genForceN: averageVector(s => s.genLoad.forceN), genMomentNm: averageVector(s => s.genLoad.momentNm),
    pressureForceN: averageVector(s => s.pressureAtLoad.forceN),
    pressureMomentNm: averageVector(s => s.pressureAtLoad.momentNm),
    maxEquivalentPa: Math.max(...a.map(s => s.pressureAtLoad.maxEquivalentPa)),
    heelDeg: mean(a.map(s => s.heelDeg)), yawRateDegS: mean(a.map(s => s.yawRateDegS)),
    entryMinDeg: Math.min(...sections.map(s => s.entry)) / D,
    negativeStationFraction: mean(a.map(s => s.sections.filter(r => r.entry < 0).length / s.sections.length)),
    maxBack: Math.max(...sections.map(s => s.back)), maxFlip: Math.max(...sections.map(s => s.flip)),
    maxKinkDeg: Math.max(...sections.map(s => s.kink)) / D,
    camberMin: Math.min(...sections.map(s => s.camber)), camberMax: Math.max(...sections.map(s => s.camber)),
    sheetGapMinM: Math.min(...a.map(s => s.sheet.gapM)), sheetGapMaxM: Math.max(...a.map(s => s.sheet.gapM)),
    renderAmplitudeEstimateM: Math.max(...a.map(s => s.renderAmplitudeEstimateM)),
    cyclesByStation: SECTION_FRACTIONS.map(f => ({ fraction: f, cycles: entryCycles(a, f) })),
    localProfilesAccepted: a.reduce((s, x) => s + x.pressureAtLoad.localProfiles.accepted, 0),
    localProfilesTotal: a.reduce((s, x) => s + x.pressureAtLoad.localProfiles.total, 0), localProfileReasons,
  };
}

const results = [];
console.log(`Совместная приёмка: ${FULL ? 'полный набор соседей' : 'основные сценарии'}, ` +
  `давление ${config.localPressure ? config.panels : 'штатное'}, ${config.hz} Гц, ` +
    `ткань ${config.rows}×${config.cols}/${config.iter}, свободный угол ${config.freeClew}, ` +
    `дальние пути ${config.attachmentPaths}, жёсткое крепление ${config.rigidBoard}`);
for (const c of cases) for (const tack of [1, -1]) for (const u0 of [3, 3.05]) {
  const changed = once(c, tack, u0, true), control = once(c, tack, u0, false);
  for (let i = 0; i < c.ends[0] * config.hz; i++)
    assert.deepEqual(changed.samples[i], control.samples[i], 'Опыт отличается от контроля до команды');
  const windows = c.windows.map(([lo, hi], phase) => {
    const actual = windowOf(changed.samples, lo, hi), base = windowOf(control.samples, lo, hi);
    const delta = { speedKn: actual.speedKn - base.speedKn, driveN: actual.driveN - base.driveN,
      genForceN: actual.genForceN.map((x, k) => x - base.genForceN[k]),
      genMomentNm: actual.genMomentNm.map((x, k) => x - base.genMomentNm[k]) };
    const begin = phase === 0 ? 0 : c.ends[phase - 1];
    const history = changed.samples.filter(s => s.t >= begin && s.t < c.ends[phase]);
    const phaseCycles = { windowS: [begin, c.ends[phase]],
      stations: SECTION_FRACTIONS.map(f => ({ fraction: f, cycles: entryCycles(history, f) })) };
    return { changed: actual, control: base, delta, phaseCycles };
  });
  const evidence = {
    numerical: changed.stability.gammaPass && changed.stability.continuousJumpPass &&
      control.stability.gammaPass && control.stability.continuousJumpPass,
    geometricCurlObserved: windows.slice(1, -1).some(w => w.changed.entryMinDeg < 0),
    repeatObserved: windows.slice(1, -1).some(w => w.phaseCycles.stations.some(r => r.cycles >= 2)),
    pressureAndBoatHaveCommonSource: null,
    sheetReactionMeasured: false,
    separatedAirflowValidated: null,
    refinementChecked: null,
    physicalThreeStatesAccepted: null,
  };
  // Частичный геометрический свидетель не даёт физическую приёмку.
  const result = { case: c, tack, initialSpeedMs: u0, windows, evidence,
    effectiveCloth: changed.effectiveCloth, initialOptions: changed.initialOptions,
    accepted: Object.values(evidence).every(x => x === true),
    changedStability: changed.stability, controlStability: control.stability,
    measurementResidual: { cloth: Math.max(changed.forceCheck, control.forceCheck),
      boat: Math.max(changed.allRigCheck, control.allRigCheck) },
    wallSeconds: changed.wallSeconds + control.wallSeconds,
  };
  if (flags.has('--trace')) result.trace = { changed: changed.samples, control: control.samples };
  results.push(result);
  const eased = windows[1], recovered = windows.at(-1);
  console.log(`${c.id} галс ${tack}, u₀=${u0}: Δход ${eased.delta.speedKn.toFixed(3)} уз; ` +
    `вход ${eased.changed.entryMinDeg.toFixed(1)}°; Δпосле ${recovered.delta.speedKn.toFixed(3)} уз; ` +
    `Γ ${changed.stability.gammaMax.toFixed(1)}, скачок без смены команды ${(100 * changed.stability.continuousJump).toFixed(2)}% ` +
    `(на команде ${(100 * changed.stability.commandJump).toFixed(2)}%); ` +
    `заворот ${evidence.geometricCurlObserved}, повтор ${evidence.repeatObserved}; не принято`);
}
for (const p of sourcePaths)
  assert.equal(hash(readFileSync(resolve(root, p))), sourceSha256[p], `Исходник изменился во время опыта: ${p}`);
assert.equal(hash(readFileSync(packPath)), hash(packBytes), 'Пакет изменился во время опыта');
const report = { schema: 1, startedAt, createdAt: new Date().toISOString(),
  revision, dirty, sourceSha256,
  physicsSha256: hash(packBytes), config, limits, full: FULL,
  units: { force: 'N', moment: 'N m', length: 'm', speed: 'kn', angle: 'deg' },
  phases: { pressure: 'последний forcesAt до движения ткани; вход воздуха предыдущего шага',
    boat: 'новые полоски после движения ткани; момент относительно ЦТ',
    shape: 'конец физического шага; геометрия без добавок изображения' },
  originM: [pack.mass.cg_m[0], 0, pack.mass.cg_m[2]], results,
};
if (flags.has('--out')) {
  const path = resolve(root, flags.get('--out'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.log(`Сохранено: ${path}`);
}
console.log('Неизмеренные условия отмечены null/false; они препятствуют физической приёмке.');
if (flags.has('--gate') && results.some(r => !r.accepted)) process.exitCode = 1;
