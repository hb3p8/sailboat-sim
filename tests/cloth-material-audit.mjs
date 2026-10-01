// Применение того же закона энергии к сохранённому полному крою и форме.
// Это чтение геометрии: новый материал НЕ участвовал в движении этих записей.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridTriangles, materialSurface, MODEL_MATERIAL } from './lib/cloth-material.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
if (!args.length || args.some(a => !a.startsWith('--input=') && !a.startsWith('--out='))
    || args.some(a => a === '--input=' || a === '--out=') || args.filter(a => a.startsWith('--out=')).length > 1)
  throw new Error('Нужен хотя бы один --input=запись; необязательный --out=путь');
const inputs = args.filter(a => a.startsWith('--input=')).map(a => resolve(root, a.slice(8)));
if (!inputs.length || new Set(inputs).size !== inputs.length) throw new Error('Не заданы разные входные записи');
const out = args.find(a => a.startsWith('--out='))?.slice(6), outPath = out ? resolve(root, out) : null;
if (inputs.includes(outPath)) throw new Error('Результат не должен перезаписывать входную запись');
const hash = value => createHash('sha256').update(value).digest('hex');
const paths = ['tests/cloth-material-audit.mjs', 'tests/lib/cloth-material.mjs', 'tests/cloth-compliance.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const results = [], inputSha256 = {};
for (const path of inputs) {
  const bytes = readFileSync(path), record = JSON.parse(bytes); inputSha256[path] = hash(bytes);
  assert.equal(record.schema, 1, 'Неизвестный формат замороженного стенда');
  assert.match(record.revision, /^[a-f0-9]{40}$/, 'Нет ревизии происхождения');
  assert.match(record.physicsSha256, /^[a-f0-9]{64}$/, 'Нет отпечатка физического пакета');
  assert.ok(record.sourceSha256?.['sim/cloth.js'] && Array.isArray(record.results) && record.results.length,
    'Не записано происхождение ткани или отсутствует результат');
  for (const row of record.results) {
    const cols = row.cols, reference = row.referencePositionsM, current = row.finalPositionsM;
    assert.ok(Array.isArray(reference) && Array.isArray(current), 'Нет координат исходного кроя/конечной формы');
    const rows = reference.length / (3 * cols);
    assert.ok(Number.isInteger(rows) && Number.isInteger(cols) && rows >= 4 && cols >= 4,
      'Размеры сетки не согласованы с координатами');
    const referenceBefore = reference.slice(), currentBefore = current.slice();
    const surface = materialSurface(reference, gridTriangles(rows, cols), MODEL_MATERIAL,
      { bendingModel: 'curvature', rows, cols });
    const zero = surface.evaluate(reference, true), energy = surface.evaluate(current, true);
    assert.ok(zero.totalJ < 1e-16 && Math.max(...zero.gradientJPerM.map(Math.abs)) < 1e-9,
      'Исходный полный крой имеет искусственную энергию или внутреннюю силу');
    assert.deepEqual(reference, referenceBefore); assert.deepEqual(current, currentBefore);
    const totalForceN = [0, 0, 0], totalTorqueNm = [0, 0, 0];
    let sumForceMagnitudesN = 0, maxNodeForceN = 0;
    for (let i = 0; i < rows * cols; i++) {
      const f = Array.from(energy.gradientJPerM.slice(3 * i, 3 * i + 3), x => -x);
      const [x, y, z] = current.slice(3 * i, 3 * i + 3), magnitude = Math.hypot(...f);
      sumForceMagnitudesN += magnitude; maxNodeForceN = Math.max(maxNodeForceN, magnitude);
      for (let d = 0; d < 3; d++) totalForceN[d] += f[d];
      totalTorqueNm[0] += y * f[2] - z * f[1];
      totalTorqueNm[1] += z * f[0] - x * f[2];
      totalTorqueNm[2] += x * f[1] - y * f[0];
    }
    assert.ok(Math.hypot(...totalForceN) < 1e-9 * Math.max(1, sumForceMagnitudesN),
      'Внутренние силы полного кроя имеют ненулевую сумму');
    const sizeM = Math.max(1, ...current.map(Math.abs));
    assert.ok(Math.hypot(...totalTorqueNm) < 1e-9 * Math.max(1, sizeM * sumForceMagnitudesN),
      'Внутренние силы полного кроя имеют ненулевой момент');
    const { gradientJPerM, ...summary } = energy;
    results.push({ input: path, inputRevision: record.revision, inputDirty: record.dirty,
      inputPhysicsSha256: record.physicsSha256, inputSourceSha256: record.sourceSha256, inputConfig: record.config,
      rows, cols, referenceSha256: hash(JSON.stringify(reference)), areaM2: surface.areaM2,
      referenceEnergyJ: zero.totalJ, ...summary, totalForceN, totalTorqueNm, maxNodeForceN,
      interpretation: 'энергия и внутренние силы назначенной модели на прежней форме; не фактическая энергия/реакция прежнего Cloth' });
    console.log(`Сторона ${record.config.tack}, сетка ${rows}×${cols}: растяжение ${summary.membraneJ.toFixed(6)} Дж, ` +
      `изгиб ${summary.bendingJ.toFixed(6)} Дж, главные относительные длины ` +
      `${summary.minPrincipalStretch.toFixed(6)}…${summary.maxPrincipalStretch.toFixed(6)}`);
  }
}
for (const [path, sha] of Object.entries({ ...sourceSha256, ...inputSha256 }))
  assert.equal(hash(readFileSync(resolve(root, path))), sha, `Источник изменился при чтении: ${path}`);
if (outPath) {
  const output = { schema: 1, createdAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    sourceSha256, inputSha256, parameters: MODEL_MATERIAL, bendingModel: 'curvature',
    motionUsesThisEnergy: false, actualMaterialEnergyJ: null, supportReactionsMeasured: false, results };
  mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`Сохранено: ${outPath}`);
}
