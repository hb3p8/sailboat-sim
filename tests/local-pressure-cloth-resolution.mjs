// Диагностика разрешения ткани при одной физической постановке:
// node tests/local-pressure-cloth-resolution.mjs --sheet=9 --tack=1
// Ряды, шаг времени, число проходов и локальных панелей одинаковы; меняется
// только число материальных столбцов по хорде. Никаких ворот под ответ нет.
import { readFileSync } from 'node:fs';
import { Boat } from '../sim/physics.js';
import { localPressureForRow } from '../sim/local-pressure.js';

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url), 'utf8'));
const D = Math.PI / 180;
const arg = (key, def) => Number(process.argv.find(s => s.startsWith(`--${key}=`))?.split('=')[1] ?? def);
const sheet = arg('sheet', 9), tack = arg('tack', 1), iter = arg('iter', 40);
const panels = arg('panels', 32), hz = arg('hz', 30);
const bend = process.argv.some(s => s.startsWith('--bend=')) ? arg('bend', 0.05) : null;
const baseline = process.argv.includes('--baseline');
const boardMaterial = process.argv.includes('--board-material');
const cols = (process.argv.find(s => s.startsWith('--cols='))?.split('=')[1] ?? '9,17,33')
  .split(',').map(Number);
if (![1, -1].includes(tack) || ![30, 60, 120].includes(hz) ||
    !(sheet > 0) || (bend != null && !(bend >= 0 && bend <= 1)) ||
    !Number.isInteger(iter) || iter < 1 ||
    !Number.isInteger(panels) || panels < 4 || panels > 128 ||
    cols.some(x => !Number.isInteger(x) || x < 5 || x > 65))
  throw new Error('Неверные параметры стенда');
const wrap = x => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

function wholeRowStretch(cloth, includeBoard) {
  let worst = { excess: 0, row: -1, arc: 0, mat: 0 };
  for (let r = 0; r < cloth.rows - (includeBoard ? 0 : 1); r++) {
    let arc = 0, mat = 0;
    for (let c = 0; c + 1 < cloth.cols; c++) {
      const a = cloth.ix(r, c), b = cloth.ix(r, c + 1), i = a * 3, j = b * 3;
      arc += Math.hypot(cloth.pos[j] - cloth.pos[i], cloth.pos[j + 1] - cloth.pos[i + 1],
                        cloth.pos[j + 2] - cloth.pos[i + 2]);
      mat += cloth.matDist(a, b);
    }
    if (mat > 0.05 && arc / mat - 1 > worst.excess)
      worst = { excess: arc / mat - 1, row: r, arc, mat };
  }
  return worst;
}

function run(ncols) {
  const b = new Boat(pack);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.localPressure = baseline ? false : { panels };
  b.o.cloth = { rows: 11, cols: ncols, iter };
  if (bend != null) b.o.cloth.bend = bend;
  if (boardMaterial) b.o.cloth.boardMaterial = true;
  b.o.crewHike = -tack; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = sheet;
  b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = 3;
  b.psi = (100 - tack * 140) * D;
  let drive = 0, speed = 0, samples = 0, jump = 0, ref = 1, prev = null;
  let minEntry = Infinity;
  const start = performance.now();
  for (let i = 0; i < 30 * hz; i++) {
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
      -(2.2 * wrap((100 - tack * 140) * D - b.psi) - 0.9 * b.r)));
    b.step(1 / hz);
    const f = b.telemetry.driveN;
    if (i >= 10 * hz) {
      ref = Math.max(ref, Math.abs(f));
      if (prev != null) jump = Math.max(jump, Math.abs(f - prev));
    }
    prev = f;
    if (i < 25 * hz) continue;
    drive += b.rig.stripState.slice(12).reduce((s, x) => s + x.drive, 0);
    speed += b.telemetry.speedKn;
    samples++;
    const cl = b.rig.cloth;
    for (let r = 1; r + 1 < cl.rows; r++) minEntry = Math.min(minEntry, cl.rowShape(r).entry / D);
  }
  const cl = b.rig.cloth;
  const boardFirst = cl.ix(cl.rows - 1, 0), boardBeforeLast = cl.ix(cl.rows - 1, cl.cols - 2);
  const legacyBoardT = (cl.px[boardFirst] - cl.px[boardBeforeLast]) / cl.rowW[cl.rows - 1];
  if (boardMaterial) {
    const aft = cl.ix(cl.rows - 1, cl.cols - 1);
    for (let c = 1; c + 1 < cl.cols; c++) {
      const i = cl.ix(cl.rows - 1, c), t = c / (cl.cols - 1);
      for (let k = 0; k < 3; k++) {
        const expect = cl.pos[boardFirst * 3 + k] * (1 - t) + cl.pos[aft * 3 + k] * t;
        if (Math.abs(cl.pos[i * 3 + k] - expect) > 1e-9)
          throw new Error(`Дощечка: узел ${c}, компонента ${k} вне материального отрезка`);
      }
    }
  }
  const mid = b.rig.stripCalc[12 + 3];
  cl.rowNormals(mid.d1, mid.d2);
  const area = cl.flyingAreas();
  let row = 1;
  for (let r = 2; r + 1 < cl.rows; r++)
    if (cl.rowShape(r).entry < cl.rowShape(row).entry) row = r;
  const shape = cl.rowShape(row), si = cl.stripOf(row);
  const profile = localPressureForRow({ pos: cl.pos, normals: cl.nrm,
    area, pressureForce: cl.pressureForce, row, cols: cl.cols,
    strip: b.rig.stripCalc[12 + si], rho: cl.rhoAir, panels: 128 });
  if (!profile.ok) throw new Error(`Снимок ${ncols}: ${profile.reason}`);
  const fn = profile.forces.reduce((s, f) => s + f, 0);
  const first = profile.forces.reduce((s, f, i) => {
    const a = profile.edgesChord[i], z = profile.edgesChord[i + 1];
    const fraction = z === a ? Number(a < 0.1) :
      Math.max(0, Math.min(1, (0.1 - Math.min(a, z)) / Math.abs(z - a)));
    return s + f * fraction;
  }, 0);
  const cp = profile.forces.reduce((s, f, i) => s + f * profile.atChord[i], 0) / fn;
  return { ncols, drive: drive / samples, speed: speed / samples,
    entry: minEntry, row, rowEntry: shape.entry / D,
    chord: shape.chord, camber: shape.camber, back: shape.back,
    flip: shape.flip, kink: shape.kink / D,
    stretch: wholeRowStretch(cl, false), board: wholeRowStretch(cl, true), legacyBoardT,
    fn, first: first / fn, cp,
    jump: jump / ref, wall: (performance.now() - start) / 1000 };
}

console.log(`TWA 140°, TWS 6 м/с, шкот ${sheet} м, галс ${tack}; ткань 11×N, ${iter} проходов, ${hz} Гц, излом ${bend == null ? 'штатный' : bend}, дощечка ${boardMaterial ? 'по крою' : 'штатная'}, давление ${baseline ? 'штатное' : `локальное/${panels}`}; окно 25…30 с`);
console.log('столбцов | тяга Н | вход min/строка ° | хорда м/пузо c | ход назад/вывернуто % | залом ° | растяжение % | первые 10 %/Fn | cp/c | скачок % | с/прогон');
let gateFailed = false;
for (const n of cols) {
  const x = run(n);
  console.log(`${n} | ${x.drive.toFixed(1)} | ${x.entry.toFixed(1)}/${x.rowEntry.toFixed(1)} (${x.row}) | ${x.chord.toFixed(3)}/${x.camber.toFixed(3)} | ${(100 * x.back).toFixed(1)}/${(100 * x.flip).toFixed(1)} | ${x.kink.toFixed(1)} | ${(100 * x.stretch.excess).toFixed(2)} (стр. ${x.stretch.row}; с дощечкой ${(100 * x.board.excess).toFixed(2)} %, старое t ${x.legacyBoardT.toFixed(3)}) | ${(100 * x.first).toFixed(1)} %/${x.fn.toFixed(1)} Н | ${x.cp.toFixed(3)} | ${(100 * x.jump).toFixed(1)} | ${x.wall.toFixed(1)}`);
  if (x.jump > 0.05) { gateFailed = true; console.log('  NO-GO: скачок общей тяги > 5 %'); }
}
if (process.argv.includes('--gate') && gateFailed) process.exitCode = 1;
