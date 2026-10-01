// Известная цилиндрическая деформация плоского листа. Без динамического решателя.
// На одном и том же листе меняем размер и ориентацию сетки относительно изгиба.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridTriangles, materialSurface, MODEL_MATERIAL } from './lib/cloth-material.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), gate = args.includes('--gate');
if (args.some(a => a !== '--gate' && !a.startsWith('--out=') && !a.startsWith('--bending='))
    || ['--out=', '--bending='].some(prefix => args.filter(a => a.startsWith(prefix)).length > 1 || args.includes(prefix))
    || args.filter(a => a === '--gate').length > 1)
  throw new Error('Допустимы --gate, --bending=hinge|curvature и один --out=путь');
const bendingModel = args.find(a => a.startsWith('--bending='))?.slice(10) ?? 'curvature';
if (!['hinge', 'curvature'].includes(bendingModel)) throw new Error('Неизвестная модель изгиба');
const hash = value => createHash('sha256').update(value).digest('hex');
const paths = ['tests/cloth-material-refinement.mjs', 'tests/lib/cloth-material.mjs', 'tests/cloth-compliance.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const results = [], radiusM = 3, areaM2 = 2;
// Для изотропного листа: E = B A κ² / 2, κ=1/R. Заранее заданная опора.
const expectedBendingJ = .5 * MODEL_MATERIAL.bendingNm * areaM2 / (radiusM * radiusM);
const relativeTolerance = .03;
for (const subdivisions of [4, 8, 16, 32, 64]) {
  const rows = subdivisions + 1, cols = 2 * subdivisions + 1;
  const reference = Float64Array.from(Array.from({ length: rows * cols }, (_, i) =>
    [(i % cols) / subdivisions, Math.floor(i / cols) / subdivisions, 0]).flat());
  for (const angleDeg of [0, 45, 90]) {
    const c = Math.cos(angleDeg * Math.PI / 180), s = Math.sin(angleDeg * Math.PI / 180);
    const p = Float64Array.from(Array.from({ length: rows * cols }, (_, i) => {
      const x = reference[3 * i], y = reference[3 * i + 1], u = c * x + s * y, v = -s * x + c * y;
      return [radiusM * Math.sin(u / radiusM), v, radiusM * (1 - Math.cos(u / radiusM))];
    }).flat());
    for (const oppositeDiagonal of [false, true]) {
      const surface = materialSurface(reference, gridTriangles(rows, cols, oppositeDiagonal), MODEL_MATERIAL,
        { bendingModel, rows, cols });
      const energy = surface.evaluate(p);
      results.push({ subdivisions, rows, cols, angleDeg, oppositeDiagonal, ...energy,
        bendingRatio: energy.bendingJ / expectedBendingJ });
      console.log(`Сетка ${rows}×${cols}, изгиб ${angleDeg}°, диагональ ${oppositeDiagonal ? 'другая' : 'штатная'}: ` +
        `энергия изгиба ${energy.bendingJ.toFixed(8)} Дж, отношение к опоре ${(energy.bendingJ / expectedBendingJ).toFixed(5)}, ` +
        `растяжение ${energy.membraneJ.toExponential(3)} Дж`);
    }
  }
}
const finest = results.filter(r => r.subdivisions === 64);
const errors = finest.map(r => Math.abs(r.bendingRatio - 1));
const ratios = finest.map(r => r.bendingRatio);
const orientationSpread = (Math.max(...ratios) - Math.min(...ratios)) / (ratios.reduce((a, b) => a + b) / ratios.length);
const criteria = { relativeTolerance, expectedBendingJ,
  maxRelativeBendingError: Math.max(...errors), orientationSpread,
  analyticalBending: errors.every(e => e <= relativeTolerance),
  orientationIndependent: orientationSpread <= relativeTolerance };
const accepted = criteria.analyticalBending && criteria.orientationIndependent;
for (const path of paths) if (hash(readFileSync(resolve(root, path))) !== sourceSha256[path])
  throw new Error(`Исходник изменился во время опыта: ${path}`);
const output = { schema: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  createdAt: new Date().toISOString(), sourceSha256, parameters: MODEL_MATERIAL,
  config: { bendingModel, radiusM, areaM2, subdivisions: [4, 8, 16, 32, 64], anglesDeg: [0, 45, 90] },
  criteria, accepted, fullMaterialAccepted: false,
  interpretation: 'проверена энергия известной поверхности; движение и полный материал не приняты', results };
const out = args.find(a => a.startsWith('--out='))?.slice(6);
if (out) { const path = resolve(root, out); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n'); console.log(`Сохранено: ${path}`); }
console.log(`Контроль цилиндра пройден: ${accepted ? 'да' : 'нет'}; ошибка опоры ${(100 * criteria.maxRelativeBendingError).toFixed(6)} %, ` +
  `различие ориентаций ${(100 * orientationSpread).toFixed(6)} %`);
if (gate && !accepted) process.exitCode = 1;
