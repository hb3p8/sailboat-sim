// Точный повтор сохранённой команды с наблюдением натяжения жёстких кромок.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {browserMotion} from '../tests/lib/cloth-browser-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
const [input,output]=process.argv.slice(2);
assert(input && output && process.argv.length===4,'Нужны сохранённое движение угла и новый путь событий');
assert(!existsSync(output),'Сохранённые события нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'), bytes=readFileSync(input), record=JSON.parse(bytes);
assert.equal(record.phase,'complete');assert.equal(record.dirty,false);
for (const [path,sha] of Object.entries(record.sourceSha256)) {
  assert.equal(hash(readFileSync(path)),sha,'Текущая модель отличается от опыта');
  assert.equal(hash(execFileSync('git',['show',`${record.revision}:${path}`],{maxBuffer:16*1024*1024})),sha);
}
assert.equal(hash(readFileSync(record.input.path)),record.input.sha256);
assert.equal(hash(readFileSync('out/export/physics.json')),record.physicsSha256);
const wasmBytes=readFileSync(record.wasm.path);assert.equal(hash(wasmBytes),record.wasm.sha256);
const recipe=structuredClone(record.recipe), calculation=browserMotion(recipe,await loadSparseFactor(wasmBytes)), motion=calculation.motion;
for (let i=0;i<record.config.warmupSteps;i++) calculation.step();
assert.deepEqual(Array.from(motion.pos),record.initial.positionsM);
assert.deepEqual(Array.from(motion.prev),record.initial.previousM);
assert.equal(motion.prevDt,record.initial.prevDt);
recipe.hS=record.config.hS;
function extensionSpeed(c,positions,velocity) {
  const delta=[0,1,2].map(d=>positions[3*c.b+d]-positions[3*c.a+d]),length=Math.hypot(...delta);
  return delta.reduce((sum,v,d)=>sum+v*(velocity[3*c.b+d]-velocity[3*c.a+d]),0)/length;
}
assert.equal(motion.hard.length,recipe.hard.length);
const frames=[];
for (const frame of record.steps) {
  const old=motion.pos.slice(),prior=motion.prev.slice(),dt=motion.prevDt;
  const oldVelocity=old.map((v,k)=>(v-prior[k])/dt);
  const gaps=motion.hard.map(c=>c.value(old).C);
  const audit=calculation.step([{node:record.command.node,positionM:frame.positionM}]);
  assert.deepEqual(Array.from(motion.pos),frame.positionsM,'Повтор не совпал с сохранённым движением');
  assert.deepEqual(Array.from(audit.supportForceN),frame.supportForceN);
  for (const [k,v] of Object.entries(frame.audit)) if (k.endsWith('J')) assert.equal(audit[k],v);
  const velocity=motion.pos.map((v,k)=>(v-old[k])/recipe.hS);
  frames.push({timeS:frame.timeS,hard:motion.hard.map((c,i)=>({index:i,a:recipe.hard[i].a,b:recipe.hard[i].b,family:c.family,unilateral:c.unilateral,
    previousGapM:gaps[i],gapM:c.value(motion.pos).C,tensionN:-c.lambda/recipe.hS**2,impulseNs:-c.lambda/recipe.hS,
    beforeExtensionSpeedMps:extensionSpeed(recipe.hard[i],old,oldVelocity),afterExtensionSpeedMps:extensionSpeed(recipe.hard[i],motion.pos,velocity)}))});
}
assert(frames.every(f=>f.hard.every(c=>Number.isFinite(c.beforeExtensionSpeedMps) && Number.isFinite(c.afterExtensionSpeedMps))));
writeFileSync(output,JSON.stringify({schema:1,createdAt:new Date().toISOString(),
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  toolSha256:hash(readFileSync(new URL(import.meta.url))),
  input:{path:input,sha256:hash(bytes),revision:record.revision,modelCommitVerified:true},
  config:record.config,rule:'точные координаты/реакции/энергия исходного опыта; диагностические множители кромок, не принятые нагрузки лодки',
  exactSteps:frames.length,frames},null,2)+'\n',{flag:'wx'});
const peak=frames.flatMap(f=>f.hard.filter(c=>c.unilateral).map(c=>({timeS:f.timeS,...c}))).sort((a,b)=>b.tensionN-a.tensionN)[0];
const firstFootPeak=frames.map(f=>({timeS:f.timeS,...f.hard.find(c=>c.family==='foot')})).sort((a,b)=>b.tensionN-a.tensionN)[0];
console.log(JSON.stringify({output,exactSteps:frames.length,peak,firstFootPeak},null,2));
