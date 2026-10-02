// Браузерный вход команд: точный повтор принятой диагностической траектории.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {browserMotion} from '../tests/lib/cloth-browser-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {IMPLICIT_TOLERANCES} from '../tests/lib/cloth-implicit-motion.mjs';
const args=process.argv.slice(2);
assert.equal(args.length,3,'Нужны полный опыт движения угла, чистый снимок сборки и новый путь браузерного входа');
const [input,scenePath,output]=args,hash=b=>createHash('sha256').update(b).digest('hex');
assert(!existsSync(output),'Сохранённый вход нельзя перезаписывать');
const bytes=readFileSync(input), original=JSON.parse(bytes),recipe=original.recipe;
assert.equal(original.phase,'complete');assert.equal(original.dirty,false);
assert.deepEqual([recipe.rows,recipe.cols,original.config.hS,original.config.profile],[11,9,1/60,'sin4']);
assert.deepEqual([original.config.durationS,original.config.holdS,original.config.warmupSteps],[1,1,40]);
assert([-.05,0,.05].includes(original.config.strokeM));
const observational=new Set(['scripts/cloth_browser_review.mjs','scripts/cloth_full_scene_review.mjs','scripts/cloth_browser_report.mjs']);
for (const [path,sha] of Object.entries(original.sourceSha256)) {
  assert.equal(hash(execFileSync('git',['show',`${original.revision}:${path}`],{maxBuffer:16*1024*1024})),sha);
  if (!observational.has(path)) assert.equal(hash(readFileSync(path)),sha,'Изменился физический источник: '+path);
}
const parentBytes=readFileSync(original.input.path),parent=JSON.parse(parentBytes);
assert.equal(hash(parentBytes),original.input.sha256);assert.deepEqual(parent.recipe,recipe);
const wasmBytes=readFileSync(original.wasm.path);assert.equal(hash(wasmBytes),original.wasm.sha256);
assert.equal(hash(readFileSync('out/export/physics.json')),original.physicsSha256);
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const dirty=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());
assert.equal(dirty,false,'Для браузерной серии нужен чистый коммит');
const sceneBytes=readFileSync(scenePath),build=JSON.parse(sceneBytes.toString().match(/^const BUILD = (.+);$/m)[1]);
assert(!build.dirty && revision.startsWith(build.commit),'Снимок сборки должен принадлежать текущему чистому коммиту');
assert.equal(hash(sceneBytes),hash(readFileSync('sim/index.html')));
const assets=['assets/sky.jpg','assets/crew.glb','viewer/vendor/draco/draco_wasm_wrapper.js','viewer/vendor/draco/draco_decoder.wasm'];
if(JSON.parse(sceneBytes.toString().match(/^const TERRAIN_PACK = (.+);$/m)[1]))assets.push('assets/terrain.glb');
const sceneBuild={path:scenePath,sha256:hash(sceneBytes),build,assets:Object.fromEntries(assets.map(p=>[p,hash(readFileSync(p))]))};
const calculation=browserMotion(recipe,await loadSparseFactor(wasmBytes)),motion=calculation.motion,expected=[];
const summarize=({constraintForce,hardForce,prediction,supportForceN,...rest})=>rest;
function check(audit,positions,energies,reactions) {
  assert.deepEqual(Array.from(motion.pos),positions,'Движение отличается от прежнего полного опыта');
  for (const [k,v] of Object.entries(energies)) if(k.endsWith('J'))assert.equal(audit[k],v);
  if(reactions)assert.deepEqual(Array.from(audit.supportForceN),reactions);
  for(const [k,v] of Object.entries(IMPLICIT_TOLERANCES))assert.equal(audit.solver[k],v);
  assert(audit.solver.converged && audit.maxPhysicalResidualN<=IMPLICIT_TOLERANCES.forceToleranceN &&
    audit.maxHardViolationM<=IMPLICIT_TOLERANCES.lengthToleranceM && audit.solver.complementarityJ<=IMPLICIT_TOLERANCES.complementarityToleranceJ);
  assert(motion.hard.filter(c=>c.unilateral).every(c=>c.lambda/recipe.hS**2<=IMPLICIT_TOLERANCES.dualToleranceN));
}
for(let i=0;i<40;i++) {
  const audit=calculation.step();check(audit,parent.expected[i].positionsM,parent.expected[i].audit);
  expected.push({positionsM:Array.from(motion.pos),audit:summarize(audit)});
}
assert.deepEqual(Array.from(motion.pos),original.initial.positionsM);
assert.deepEqual(Array.from(motion.prev),original.initial.previousM);
assert.equal(motion.prevDt,original.initial.prevDt);
for(const frame of original.steps) {
  const supportTargets=[{node:original.command.node,positionM:frame.positionM}];
  const audit=calculation.step(supportTargets);check(audit,frame.positionsM,frame.audit,frame.supportForceN);
  expected.push({positionsM:Array.from(motion.pos),audit:summarize(audit),supportTargets,supportForceN:Array.from(audit.supportForceN)});
}
assert.equal(expected.length,160);
const action=original.config.strokeM===0?'held':original.config.strokeM>0?'inward':'outward';
const paths=[...new Set([...Object.keys(original.sourceSha256),'scripts/cloth_support_browser_fixture.mjs','scripts/cloth_browser_report.mjs'])];
writeFileSync(output,JSON.stringify({schema:1,revision,dirty,baseline:{path:input,sha256:hash(bytes),revision:original.revision},
  physicsSha256:original.physicsSha256,wasm:original.wasm,tack:original.config.tack,recipe,sceneBuild,
  sourceSha256:Object.fromEntries(paths.map(p=>[p,hash(readFileSync(p))])),
  supportCommands:{action,node:original.command.node,strokeM:original.config.strokeM,profile:'sin4',durationS:1,holdS:1},
  measurement:{warmupSteps:40,liveSteps:120,durationS:2},expected,
  nodeComparison:{maxDifferenceM:0,maxEnergyDifferenceJ:0,maxSupportDifferenceN:0,steps:160}},null,2)+'\n',{flag:'wx'});
console.log(`Браузерный вход ${output}: все 160 шагов точны по координатам/энергии, реакции 120 рабочих шагов точны; команда ${action}.`);
