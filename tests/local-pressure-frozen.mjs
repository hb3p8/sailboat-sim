// Одна и та же летящая форма и одна и та же сила строки при 16/32/64/128
// панелях. Здесь Cloth.advance() не вызывается после снимка: состояние ткани
// неизменно, а функция расчёта профиля та же, что использует её рабочий шаг.
// node tests/local-pressure-frozen.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Boat } from '../sim/physics.js';
import { localPressureForRow, pressureToNodes } from '../sim/local-pressure.js';
import { sectionsOf, wrenchOf } from './lib/gennaker-observables.mjs';

const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url), 'utf8'));
const D = Math.PI / 180, hz = 30;
const cases = [
  { twa: 140, sheet: 9.0, tack: 1, source: 0 },
  { twa: 140, sheet: 9.0, tack: 1, source: 16 },
  { twa: 140, sheet: 9.0, tack: 1, source: 32 },
  { twa: 140, sheet: 9.0, tack: 1, source: 64 },
  { twa: 140, sheet: 9.0, tack: -1, source: 32 },
  { twa: 140, sheet: 8.5, tack: 1, source: 32 },
];
const unforced = process.argv.includes('--unforced');
if (unforced) {
  cases.length = 0;
  cases.push({ twa: 140, sheet: 9.0, tack: 1, source: 0 },
             { twa: 140, sheet: 9.0, tack: -1, source: 0 },
             { twa: 140, sheet: 8.5, tack: 1, source: 0 },
             { twa: 140, sheet: 8.5, tack: -1, source: 0 },
             { twa: 150, sheet: 9.2, tack: 1, source: 0 },
             { twa: 150, sheet: 9.2, tack: -1, source: 0 });
  if (process.argv.includes('--one')) cases.length = 1;
}
const sum = a => a.reduce((s, v) => s + v, 0);
function baselineLoads(b, cloth, area) {
  const f = new Float64Array(cloth.n);
  for (let si = 0; si < 6; si++) {
    let sx = 0, sy = 0, sz = 0, aSum = 0;
    for (let r = 0; r < cloth.rows; r++) if (cloth.stripOf(r) === si) {
      const k = cloth.ix(r, 0) * 3;
      sx += cloth.nrm[k]; sy += cloth.nrm[k + 1]; sz += cloth.nrm[k + 2];
      for (let c = 0; c < cloth.cols; c++) aSum += area[cloth.ix(r, c)];
    }
    const len = Math.hypot(sx, sy, sz) || 1;
    const d = b.rig.stripState[12 + si];
    const fn = (d.drive * sx + d.side * sy) / len;
    if (!(aSum > 0)) continue;
    for (let r = 0; r < cloth.rows; r++) if (cloth.stripOf(r) === si)
      for (let c = 0; c < cloth.cols; c++) {
        const i = cloth.ix(r, c);
        f[i] = fn * area[i] / aSum;
      }
  }
  return f;
}
function rowWrench(cloth, row, forces) {
  const normal = cloth.nrm.slice(cloth.ix(row, 0) * 3, cloth.ix(row, 0) * 3 + 3);
  const points = [], vectors = [];
  for (let c = 0; c < cloth.cols; c++) {
    const i = cloth.ix(row, c), k = i * 3, f = forces[c];
    points.push(Array.from(cloth.pos.slice(k, k + 3)));
    vectors.push(Array.from(normal, n => n * f));
  }
  const w = wrenchOf(points, vectors);
  return Float64Array.from([...w.forceN, ...w.momentNm]);
}
function panelWrench(cloth, row, profile) {
  const normal = cloth.nrm.slice(cloth.ix(row, 0) * 3, cloth.ix(row, 0) * 3 + 3);
  const points = [], vectors = [];
  for (let i = 0; i < profile.forces.length; i++) {
    const v = profile.at[i] * (cloth.cols - 1), c = Math.min(cloth.cols - 2, Math.floor(v)), t = v - c;
    const k = cloth.ix(row, c) * 3, next = cloth.ix(row, c + 1) * 3, f = profile.forces[i];
    const p = [0, 1, 2].map(j => cloth.pos[k + j] * (1 - t) + cloth.pos[next + j] * t);
    points.push(p); vectors.push(Array.from(normal, n => n * f));
  }
  const w = wrenchOf(points, vectors);
  return Float64Array.from([...w.forceN, ...w.momentNm]);
}
const frac = (p, limit) => sum(p.forces.map((f, i) => {
  const a = p.edgesChord[i], b = p.edgesChord[i + 1];
  const part = b === a ? Number(a < limit) :
    Math.max(0, Math.min(1, (limit - Math.min(a, b)) / Math.abs(b - a)));
  return f * part;
}));
function boat({ twa, sheet, tack, source }) {
  const b = new Boat(pack);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.crewHike = -tack; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  if (source) b.o.localPressure = { panels: source };
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = sheet;
  b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = 3;
  b.psi = (100 - tack * twa) * D;
  for (let i = 0; i < 30 * hz; i++) {
    const wrap = x => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
      -(2.2 * wrap((100 - tack * twa) * D - b.psi) - 0.9 * b.r)));
    b.step(1 / hz);
  }
  return b;
}

console.log(`140°, 6 м/с; снимок после 30 с; ${unforced ? 'без заданной силы' : 'заданная сила'}; n — панели на неизменной форме, строка — минимальный угол входа ткани`);
console.log('галс/шкот/источник  строка/вход   n   Fn, Н   доля силы в первых 10 % хорды   x центра/хорда   L1 узлов против n=128');
for (const c of cases) {
  const b = boat(c), cloth = b.rig.cloth;
  const mid = b.rig.stripCalc[12 + 3];
  cloth.rowNormals(mid.d1, mid.d2);
  const area = cloth.flyingAreas();
  const pressureForce = baselineLoads(b, cloth, area);
  if (unforced) {
    const net = { fx: 0, fy: 0, fz: 0, accepted: 0, reasons: {},
                  firstCell: [], crossingSteps: [], convectiveStep: [] };
    for (let r = 0; r < cloth.rows; r++) {
      const si = cloth.stripOf(r), strip = b.rig.stripCalc[12 + si];
      const a = cloth.ix(r, 0) * 3, first = cloth.ix(r, 1) * 3,
            end = cloth.ix(r, cloth.cols - 1) * 3;
      const chord = Math.hypot(cloth.pos[end] - cloth.pos[a],
                               cloth.pos[end + 1] - cloth.pos[a + 1],
                               cloth.pos[end + 2] - cloth.pos[a + 2]);
      const edge = Math.hypot(cloth.pos[first] - cloth.pos[a],
                              cloth.pos[first + 1] - cloth.pos[a + 1],
                              cloth.pos[first + 2] - cloth.pos[a + 2]);
      net.firstCell.push(edge / chord);
      net.crossingSteps.push(0.1 * chord * 30 / strip.ve);
      net.convectiveStep.push(strip.ve / (30 * chord));
      if (process.argv.includes('--resolution-detail'))
        console.log(`    строка ${r}: хорда ${chord.toFixed(3)} м, поток ${strip.ve.toFixed(3)} м/с, первое ребро ${(100 * edge / chord).toFixed(1)} % c, первые 10 % за ${(0.1 * chord * 30 / strip.ve).toFixed(2)} шага`);
      const profile = localPressureForRow({
        pos: cloth.pos, normals: cloth.nrm, area, pressureForce,
        row: r, cols: cloth.cols, strip,
        rho: cloth.rhoAir, panels: 32, forceMatched: false,
      });
      if (!profile.ok) {
        net.reasons[profile.reason] = (net.reasons[profile.reason] || 0) + 1;
        continue;
      }
      net.accepted++;
      const nodes = pressureToNodes(profile, cloth.cols);
      let rowFx = 0;
      for (let c = 0; c < cloth.cols; c++) {
        const k = cloth.ix(r, c) * 3, f = nodes[c];
        rowFx += f * cloth.nrm[k];
        net.fy += f * cloth.nrm[k + 1];
        net.fz += f * cloth.nrm[k + 2];
      }
      net.fx += rowFx;
      if (process.argv.includes('--resolution-detail'))
        console.log(`      свободная нормальная сила ${sum(profile.forces).toFixed(2)} Н; продольная ${rowFx.toFixed(2)} Н`);
    }
    const gen = b.rig.stripState.slice(12), drive = sum(gen.map(g => g.drive));
    console.log(`  независимый интеграл всех строк ${c.tack}/${c.twa}/${c.sheet}: Fx/Fy/Fz=${net.fx.toFixed(1)}/${net.fy.toFixed(1)}/${net.fz.toFixed(1)} Н; прежняя тяга генакера ${drive.toFixed(1)} Н; принято ${net.accepted}/${cloth.rows}, отказы ${JSON.stringify(net.reasons)}`);
    console.log(`  первые 10% хорды: первое ребро ткани ${(100 * Math.min(...net.firstCell)).toFixed(1)}…${(100 * Math.max(...net.firstCell)).toFixed(1)}% c; пересечение потоком ${Math.min(...net.crossingSteps).toFixed(1)}…${Math.max(...net.crossingSteps).toFixed(1)} шага по 1/30 с; конвективный шаг ${(100 * Math.min(...net.convectiveStep)).toFixed(1)}…${(100 * Math.max(...net.convectiveStep)).toFixed(1)}% c`);
  }
  let row = 1, entry = Infinity;
  for (let r = 1; r + 1 < cloth.rows; r++) {
    const angle = sectionsOf(cloth, [r / (cloth.rows - 1)])[0].entry / D;
    if (angle < entry) { entry = angle; row = r; }
  }
  const si = cloth.stripOf(row), input = {
    pos: cloth.pos, normals: cloth.nrm, area, pressureForce,
    row, cols: cloth.cols, strip: b.rig.stripCalc[12 + si], rho: cloth.rhoAir,
    forceMatched: !unforced,
  };
  const ref = localPressureForRow({ ...input, panels: 128 });
  if (!ref.ok) throw new Error(`Опорный снимок не принят: ${ref.reason}`);
  const refNodes = pressureToNodes(ref, cloth.cols);
  for (const n of [16, 32, 64, 128]) {
    const p = localPressureForRow({ ...input, panels: n });
    if (!p.ok) throw new Error(`n=${n} не принят: ${p.reason}`);
    const nodes = pressureToNodes(p, cloth.cols);
    const wn = rowWrench(cloth, row, nodes), wp = panelWrench(cloth, row, p);
    for (let j = 0; j < 6; j++)
      assert.ok(Math.abs(wn[j] - wp[j]) < 1e-9 * Math.max(1, Math.abs(wp[j])),
        `n=${n}, компонент ${j}: ${wn[j]} != ${wp[j]}`);
    const load = sum(p.forces), moment = sum(p.forces.map((f, i) => f * p.atChord[i]));
    const l1 = sum(nodes.map((f, i) => Math.abs(f - refNodes[i]))) / (sum(refNodes.map(Math.abs)) || 1);
    console.log(`${c.tack}/${c.sheet.toFixed(1)}/${c.source || 'шт'}  ${row}/${entry.toFixed(1)}°  ${n}  ${load.toFixed(3)}  ${(100 * frac(p, 0.1) / (load || 1)).toFixed(2)} %  ${(moment / (load || 1)).toFixed(4)}  ${(100 * l1).toFixed(2)} %`);
  }
  const baseRow = Array.from({ length: cloth.cols }, (_, j) => pressureForce[cloth.ix(row, j)]);
  const wb = rowWrench(cloth, row, baseRow), wl = rowWrench(cloth, row, refNodes);
  if (unforced) console.log(`  строка ${row}: прежняя сумма ${sum(baseRow).toFixed(2)} Н; свободная сумма ${sum(ref.forces).toFixed(2)} Н; отношение ${(sum(ref.forces) / (sum(baseRow) || 1)).toFixed(3)}`);
  console.log(`  строка ${row}: изменение центра нагрузки относительно ровного давления: ΔMx=${(wl[3] - wb[3]).toFixed(2)}, ΔMz=${(wl[5] - wb[5]).toFixed(2)} Н·м`);
}
