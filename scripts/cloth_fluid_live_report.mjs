// Независимый повтор браузерной записи общим уравнением; скорость отдельно.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fluidSailMotion} from '../tests/lib/cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
const [input,output]=process.argv.slice(2);assert(input&&output&&process.argv.length===4&&!existsSync(output));
const hash=b=>createHash('sha256').update(b).digest('hex');
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
// JSON не сохраняет знак нуля; физический расчёт остаётся неизменным.
const jsonSerial=v=>JSON.parse(JSON.stringify(serial(v)));
const bytes=readFileSync(input),r=JSON.parse(bytes),f=r.fixture;
assert.equal(r.schema,'cloth-fluid-live-result-v1');assert.equal(f.schema,'cloth-fluid-live-v1');
for(const [path,sha] of Object.entries(f.sourceSha256))assert.equal(hash(readFileSync(path)),sha,'Изменился исходник '+path);
for(const part of [f.input,f.wasm,f.scene])assert.equal(hash(readFileSync(part.path)),part.sha256,'Изменился сохранённый вход '+part.path);
assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);
const source=JSON.parse(readFileSync(f.input.path));
assert.deepEqual(f.recipe,source.recipe);assert.deepEqual(f.bodyInput,source.config.bodyInput);
assert.equal(Boolean(f.sheet),Boolean(f.sheetProof),'Верёвке требуется доказательство');
if(f.sheetProof) {
  const b=readFileSync(f.sheetProof.path),proof=JSON.parse(b);
  assert.equal(hash(b),f.sheetProof.sha256);assert.equal(proof.schema,'cloth-fluid-rope-sail-v1');
  assert.equal(proof.phase,'complete');assert.equal(proof.dirty,false);assert.equal(proof.revision,f.sheetProof.revision);
  assert.equal(proof.input.sha256,f.input.sha256);assert.equal(proof.physicsSha256,f.physicsSha256);
  assert.equal(proof.parameters.hS,f.recipe.hS);assert.deepEqual(proof.parameters.bodyInput,f.bodyInput);
  assert.deepEqual(proof.parameters.sheet,f.sheet);
  for(const [path,sha] of Object.entries(proof.sourceSha256))assert.equal(hash(execFileSync('git',['show',`${proof.revision}:${path}`],{maxBuffer:16*1024*1024})),sha);
}
const factor=await loadSparseFactor(readFileSync(f.wasm.path)),c=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet});
assert.deepEqual(r.initial,{positions:Array.from(c.motion.pos),body:jsonSerial(c.motion.body)});
assert(r.steps.length<=300&&Number.isInteger(r.shownStep)&&r.shownStep>=0&&r.shownStep<=r.steps.length);
const costs=[],delays=[];
for(let i=0;i<r.steps.length;i++) {
  const s=r.steps[i];assert.equal(s.index,i+1);assert.equal(s.hS,f.recipe.hS);
  const a=c.step(s.controls);
  assert.deepEqual(s.positions,jsonSerial(c.motion.pos));assert.deepEqual(s.body,jsonSerial(c.motion.body));
  assert.deepEqual(s.forceN,jsonSerial(c.forceN));assert.deepEqual(s.audit,jsonSerial(a));
  const t=a.solver;
  assert(a.maxPhysicalResidualN<=t.forceToleranceN&&a.maxHardViolationM<=t.lengthToleranceM&&
    a.dualViolationN<=t.dualToleranceN&&a.complementarityJ<=t.complementarityToleranceJ);
  assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ&&Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
  for(const rope of a.ropes??[])assert(Math.abs(rope.controlResidualJ)<=rope.controlLimitJ);
  assert(Number.isFinite(s.stepMs)&&s.stepMs>=0&&s.receivedAt>=s.sentAt);
  costs.push(s.stepMs);
  if(s.presentedAt!==undefined){assert(s.presentedAt>=s.receivedAt);delays.push(s.presentedAt-s.receivedAt);}
}
const result={schema:'cloth-fluid-live-report-v1',input,sha256:hash(bytes),revision:f.revision,dirty:f.dirty,
  valid:true,exactSteps:r.steps.length,shownStep:r.shownStep,lastAcceptedStepShown:r.shownStep===r.steps.length,
  costsMs:{mean:costs.length?costs.reduce((a,b)=>a+b,0)/costs.length:null,max:costs.length?Math.max(...costs):null},
  maxPresentationDelayMs:delays.length?Math.max(...delays):null,
  ...(f.sheet?{sheet:{proof:f.sheetProof,limits:c.sheetControl,
    minLengthM:r.steps.length?Math.min(...r.steps.map(s=>s.audit.ropes[0].lengthM)):f.sheet.lengthM,
    maxLengthM:r.steps.length?Math.max(...r.steps.map(s=>s.audit.ropes[0].lengthM)):f.sheet.lengthM,
    peakTensionN:r.steps.length?Math.max(...r.steps.map(s=>s.audit.ropes[0].tensionN)):null,
    scope:'Пик идеальной нерастяжимой верёвки не принят как реальная нагрузка.'}}:{}),
  scope:'Точное повторение записи подтверждено. Время браузерного расчёта не означает FPS, выполнение бюджета или приёмку учебного режима.'};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
