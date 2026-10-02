// Измеритель воспроизведения физического опыта после замены линейного решения.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPLICIT_TOLERANCES } from './lib/cloth-implicit-motion.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = b => createHash('sha256').update(b).digest('hex');
const computational = new Set(['tests/cloth-frozen-aero-grid.mjs', 'tests/lib/cloth-energy-experiment.mjs',
  'tests/lib/cloth-implicit-motion.mjs', 'tests/lib/cloth-linear-solve.mjs', 'tests/lib/cloth-kkt-direction.mjs',
  'tests/lib/cloth-sparse-solve.mjs', 'tests/lib/cloth-sparse-wasm.mjs', 'tests/lib/cloth-sparse-kernel.c']);
const omitBackend = c => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'linearBackend'));
export const REPRODUCTION_LIMITS = Object.freeze({ positionsM: 1e-8, energyJ: 1e-7 });

export function compareResults(a, b) {
  assert.deepEqual([a.rows, a.cols], [b.rows, b.cols]);
  assert.deepEqual(a.initialInput, b.initialInput, 'Нагрузка или масса изменились');
  assert.deepEqual(a.referencePositionsM, b.referencePositionsM, 'Крой изменился');
  assert.deepEqual(a.energyMotion.parameters, b.energyMotion.parameters, 'Материал изменился');
  assert.deepEqual(a.samples.map(s => s.timeS), b.samples.map(s => s.timeS), 'Кадры имеют разное время');
  let maxPositionDifferenceM = 0, maxEnergyDifferenceJ = 0;
  const positions = (x, y) => {
    assert.equal(x.length, y.length); assert.equal(x.length % 3, 0);
    for (let i = 0; i < x.length; i += 3) {
      const d = Math.hypot(x[i] - y[i], x[i + 1] - y[i + 1], x[i + 2] - y[i + 2]);
      assert.ok(Number.isFinite(d)); maxPositionDifferenceM = Math.max(maxPositionDifferenceM, d);
    }
  };
  const energies = (x, y, inEnergy = false) => {
    if (typeof x === 'number' && inEnergy) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      maxEnergyDifferenceJ = Math.max(maxEnergyDifferenceJ, Math.abs(x - y));
    } else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) {
      if (k === 'solver') continue;
      energies(v, y?.[k], inEnergy || k.endsWith('J'));
    }
  };
  for (let i = 0; i < a.samples.length; i++) positions(a.samples[i].positionsM, b.samples[i].positionsM);
  positions(a.finalPositionsM, b.finalPositionsM);
  for (const k of ['warmup', 'mechanics', 'energyMotion', 'samples']) energies(a[k], b[k]);
  for (const r of [a, b]) for (const e of [r.warmup.energyMotion, r.energyMotion, ...r.samples.map(s => s.energyMotion)]) {
    assert.equal(e.solver.converged, true);
    for (const [k, v] of Object.entries(IMPLICIT_TOLERANCES)) assert.equal(e.solver[k], v, `Изменён допуск ${k}`);
    assert.ok(e.solver.maxForceResidualN <= IMPLICIT_TOLERANCES.forceToleranceN);
    assert.ok(e.solver.maxHardViolationM <= IMPLICIT_TOLERANCES.lengthToleranceM);
    assert.ok(e.solver.complementarityJ <= IMPLICIT_TOLERANCES.complementarityToleranceJ);
    assert.ok(e.totals.maxPhysicalResidualN <= IMPLICIT_TOLERANCES.forceToleranceN);
    assert.ok(e.totals.maxHardViolationM <= IMPLICIT_TOLERANCES.lengthToleranceM);
  }
  assert.ok(maxPositionDifferenceM <= REPRODUCTION_LIMITS.positionsM, `Форма: ${maxPositionDifferenceM} м`);
  assert.ok(maxEnergyDifferenceJ <= REPRODUCTION_LIMITS.energyJ, `Энергия/работа: ${maxEnergyDifferenceJ} Дж`);
  return { rows: a.rows, cols: a.cols, maxPositionDifferenceM, maxEnergyDifferenceJ,
    beforeWallSeconds: a.wallSeconds, afterWallSeconds: b.wallSeconds, measuredSpeedup: a.wallSeconds / b.wallSeconds };
}

function readRecord(path) {
  const bytes = readFileSync(resolve(root, path)), data = JSON.parse(bytes);
  assert.equal(data.schema, 1); assert.ok(!data.failure && !data.failed, 'Незавершённый опыт');
  assert.ok(data.results?.length && data.sourceSha256 && data.revision);
  for (const [p, expected] of Object.entries(data.sourceSha256)) {
    const committed = execFileSync('git', ['show', `${data.revision}:${p}`], { cwd: root });
    assert.equal(hash(committed), expected, `Исходник не соответствует записанному коммиту: ${p}`);
  }
  if (data.linearWasm) assert.equal(hash(readFileSync(resolve(root, data.linearWasm.path))), data.linearWasm.sha256);
  return { path, sha256: hash(bytes), data };
}

function main() {
  const args = process.argv.slice(2), get = key => args.find(s => s.startsWith(`--${key}=`))?.slice(key.length + 3);
  if (args.length !== 3 || !['before', 'after', 'out'].every(k => get(k))) throw new Error('Нужны --before=запись --after=запись --out=сравнение');
  const before = readRecord(get('before')), after = readRecord(get('after'));
  assert.equal(before.data.physicsSha256, after.data.physicsSha256);
  assert.deepEqual(omitBackend(before.data.config), omitBackend(after.data.config));
  assert.deepEqual(before.data.sharedInputField, after.data.sharedInputField);
  for (const [p, v] of Object.entries(before.data.sourceSha256)) if (!computational.has(p))
    assert.equal(after.data.sourceSha256[p], v, `Изменён источник физической модели: ${p}`);
  assert.deepEqual(before.data.results.map(r => [r.rows, r.cols]), after.data.results.map(r => [r.rows, r.cols]));
  const results = before.data.results.map((r, i) => compareResults(r, after.data.results[i]));
  const parent = x => ({ path: x.path, sha256: x.sha256, revision: x.data.revision, dirty: x.data.dirty,
    sourceSha256: x.data.sourceSha256, linearWasm: x.data.linearWasm });
  const out = resolve(root, get('out')); mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), before: parent(before), after: parent(after),
    toolSha256: hash(readFileSync(fileURLToPath(import.meta.url))), physicsSha256: before.data.physicsSha256,
    limits: REPRODUCTION_LIMITS, rule: 'контроль вычислительного воспроизведения сохранённых кадров и энергетических полей; не G2 и не FPS', results }, null, 2) + '\n');
  for (const r of results) console.log(`${r.rows}×${r.cols}: отличие ${r.maxPositionDifferenceM.toExponential(3)} м, ${r.maxEnergyDifferenceJ.toExponential(3)} Дж; ${r.beforeWallSeconds.toFixed(2)}→${r.afterWallSeconds.toFixed(2)} с (${r.measuredSpeedup.toFixed(2)} раза)`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
