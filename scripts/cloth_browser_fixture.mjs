// Подготовить неизменяемый вход браузерного измерения и сверить каждый шаг.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';
import { installSharedInput, sharedInputFromCloth } from '../tests/lib/cloth-shared-input.mjs';
import { installEnergyExperiment } from '../tests/lib/cloth-energy-experiment.mjs';
import { constraintFamily } from '../tests/lib/cloth-mechanics.mjs';
import { loadSparseFactor } from '../tests/lib/cloth-sparse-wasm.mjs';
import { browserMotion } from '../tests/lib/cloth-browser-motion.mjs';

const hash = x => createHash('sha256').update(x).digest('hex');
const args = process.argv.slice(2);
assert(args.length === 3, 'Нужны исходный JSON, модуль WASM и новый путь JSON');
const [input, wasmPath, output] = args;
const originalBytes = readFileSync(input), original = JSON.parse(originalBytes);
const config = original.config;
assert(config.seconds === 1 && config.iter === 80 && config.clothHz === 30 && config.sharedInput &&
  config.joinedCutProfile && config.linearBackend === 'kkt-wasm' && original.phase === 'complete', 'Нужна принятая короткая постановка');
const baseline = original.results.find(r => r.rows === 11 && r.cols === 9);
assert(baseline, 'Нет сетки 11×9');
const packBytes = readFileSync('out/export/physics.json');
assert.equal(hash(packBytes), original.physicsSha256);
// Единственное разрешённое изменение прежних физических исходников — защита CLI.
const browserGuard = s => s.replace("import { pathToFileURL } from 'node:url';\n", '')
  .replace("if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {", '')
  .replace("// Командные примеры доступны в Node; сами ограничения работают и в браузере.\nif (typeof process !== 'undefined' && process.argv[1] &&\n    import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {", '');
for (const [path, sha] of Object.entries(original.sourceSha256)) {
  const bytes = readFileSync(path);
  if (path === 'tests/cloth-compliance.mjs') {
    const prior = execFileSync('git', ['show', `${original.revision}:${path}`], { encoding: 'utf8' });
    assert.equal(hash(prior), sha); assert.equal(browserGuard(bytes.toString()), browserGuard(prior));
  } else assert.equal(hash(bytes), sha, `Изменился исходник ${path}`);
}
const wasmBytes = readFileSync(wasmPath);
assert.equal(hash(wasmBytes), original.linearWasm.sha256);
const factor = await loadSparseFactor(wasmBytes), pack = JSON.parse(packBytes), b = new Boat(pack);
const D = Math.PI / 180, tack = config.tack;
const wrap = x => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
b.o.freeWake = true; b.o.wakeForces = true; b.o.crewHike = -tack; b.o.crewMass = 219.9;
b.wind.o.gust = 0; b.wind.o.shift = 0; b.setGennaker(true);
b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = 9;
b.reset(); b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = 3; b.psi = (100 - tack * 140) * D;
for (let i = 0; i < 900; i++) {
  b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * wrap((100 - tack * 140) * D - b.psi) - .9 * b.r)));
  b.step(1 / 30);
}
const options = { rows: 11, cols: 9, iter: 80, rigidBoard: true, continuousCut: true, joinedCutProfile: true };
const source = new Cloth(b.rig.sails[2], 2, options);
source.advance = function (...args) { this.forcesAt(...args); };
assert(source.step(b, 1 / 30));
const field = sharedInputFromCloth(source, b);
assert(field.values.every((v,i) => v === original.sharedInputField.values[i]), 'Изменилось общее поле');
const cloth = new Cloth(b.rig.sails[2], 2, options);
installSharedInput(cloth, field);
const energy = installEnergyExperiment(cloth, { implicit: true, linearBackend: 'kkt-wasm', wasmSparseFactor: factor });
const advance = cloth.advance;
let recipe, repeat, maxDifferenceM = 0;
const expected = [];
const error = (a, z) => Math.max(...Array.from({ length: a.length / 3 }, (_, i) =>
  Math.hypot(...a.slice(3*i, 3*i+3).map((v, d) => v - z[3*i+d]))));
cloth.advance = function (...args) {
  if (!recipe) {
    const hard = [];
    for (let k = 0; k < this.ci.length; k++) {
      const family = constraintFamily(this, k);
      if (['foot', 'luff', 'leech'].includes(family)) hard.push({ a: this.ci[k], b: this.cj[k], rest: this.rest[k], unilateral: true, family });
    }
    hard.push({ a: this.head, b: this.boardEnd, rest: this.boardRest, unilateral: false, family: 'board' });
    const nodes = Array.from({ length: this.cols }, (_, c) => this.head + c);
    recipe = { rows: this.rows, cols: this.cols, hS: 1/60, iterations: this.iter,
      reference: Array.from({ length: this.n*3 }, (_, k) => [this.dx, this.dy, this.dz][k%3][Math.floor(k/3)]),
      positions: Array.from(this.pos), previous: Array.from(this.prev), prevDt: this.prevDt,
      mass: Array.from(this.mass), fixed: [this.tack, this.head, this.clew],
      board: { head: this.head, end: this.boardEnd, nodes, fractions: nodes.map(i => this.boardFraction[i]) }, hard,
      field: { ...field, values: Array.from(field.values) }, boat: { phi: b.phi, p: { mass: { cg_m: b.p.mass.cg_m } } } };
    repeat = browserMotion(recipe, factor);
  }
  advance.apply(this, args);
  const audit = repeat.step();
  maxDifferenceM = Math.max(maxDifferenceM, error(this.pos, repeat.motion.pos));
  assert(maxDifferenceM <= 1e-8, 'Браузерная постановка изменила движение');
  const { constraintForce, hardForce, prediction, ...summary } = audit;
  expected.push({ positionsM: Array.from(repeat.motion.pos), audit: summary });
};
assert(cloth.step(b, 1/30)); b.p.rig.gennaker.clew_arc_r = 0;
assert(error(cloth.pos, baseline.samples[0].positionsM) <= 1e-8);
energy.reset();
for (let i = 0; i < 30; i++) assert(cloth.step(b, 1/30));
assert(error(cloth.pos, baseline.positionsM ?? baseline.samples.at(-1).positionsM) <= 1e-8);
assert.equal(expected.length, 100);
const paths = [...Object.keys(original.sourceSha256), 'scripts/cloth_browser_fixture.mjs', 'tests/lib/cloth-browser-motion.mjs',
  'scripts/cloth_browser_review.mjs', 'sim/cloth-browser-review.html', 'viewer/vendor/three.webgpu.js'];
paths.push('tests/lib/cloth-browser-client.mjs','tests/lib/cloth-browser-worker.mjs');
const sourceSha256 = Object.fromEntries(paths.map(p => [p, hash(readFileSync(p))]));
writeFileSync(output, JSON.stringify({ schema: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
  baseline: { path: input, sha256: hash(originalBytes), revision: original.revision },
  physicsSha256: hash(packBytes), wasm: { path: wasmPath, sha256: hash(wasmBytes) }, sourceSha256,
  tack, recipe, expected, nodeComparison: { maxDifferenceM, steps: expected.length } }, null, 2) + '\n', { flag: 'wx' });
console.log(`Браузерный вход ${output}: ${expected.length} шагов, отличие от штатного подключения ${maxDifferenceM.toExponential(3)} м; прежние кадры 0/1 с совпали.`);
