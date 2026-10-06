// Независимый повтор браузерной записи общим уравнением; скорость отдельно.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fluidSailMotion} from '../tests/lib/cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from '../tests/probes/cloth-material-wasm.mjs';
import {verifyMaterialKernel} from '../tests/probes/cloth-material-engine-check.mjs';
import {loadAssemblyKernel} from '../tests/probes/cloth-assembly-wasm.mjs';
import {verifyAssemblyKernel} from '../tests/probes/cloth-assembly-engine-check.mjs';
const [input,output]=process.argv.slice(2);assert(input&&output&&process.argv.length===4&&!existsSync(output));
const hash=b=>createHash('sha256').update(b).digest('hex');
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
// JSON не сохраняет знак нуля; физический расчёт остаётся неизменным.
const jsonSerial=v=>JSON.parse(JSON.stringify(serial(v)));
const bytes=readFileSync(input),r=JSON.parse(bytes),f=r.fixture;
assert.equal(r.schema,'cloth-fluid-live-result-v1');assert.equal(f.schema,'cloth-fluid-live-v1');
assert(f.profileWorker===undefined||typeof f.profileWorker==='boolean');
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
let materialKernel,materialValidation;
if(f.materialWasm!==undefined) {
  assert(f.materialWasm?.path&&/^[a-f0-9]{64}$/.test(f.materialWasm.sha256),'Некорректное происхождение материала');
  const b=readFileSync(f.materialWasm.path);assert.equal(hash(b),f.materialWasm.sha256,'Изменился WASM материала');
  materialKernel=await loadMaterialKernel(b);materialValidation=verifyMaterialKernel(materialKernel,f.recipe);
  assert.equal(r.preparation.material.backend,'wasm');assert.deepEqual(r.preparation.material.validation,materialValidation);
  assert(Number.isFinite(r.preparation.material.checkMs)&&r.preparation.material.checkMs>=0);
} else assert.equal(r.preparation.material,undefined,'Материал результата отличается от входа');
let assemblyKernel,assemblyValidation;
if(f.assemblyWasm!==undefined) {
  assert(f.assemblyWasm?.path&&/^[a-f0-9]{64}$/.test(f.assemblyWasm.sha256),'Некорректное происхождение сборки');
  const b=readFileSync(f.assemblyWasm.path);assert.equal(hash(b),f.assemblyWasm.sha256,'Изменился WASM сборки');
  assemblyKernel=await loadAssemblyKernel(b);assemblyValidation=verifyAssemblyKernel(assemblyKernel,f.recipe);
  assert.equal(r.preparation.assembly.backend,'wasm');assert.deepEqual(r.preparation.assembly.validation,assemblyValidation);
  assert(Number.isFinite(r.preparation.assembly.checkMs)&&r.preparation.assembly.checkMs>=0);
} else assert.equal(r.preparation.assembly,undefined,'Сборка результата отличается от входа');
const factor=await loadSparseFactor(readFileSync(f.wasm.path)),c=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel,assemblyKernel});
assert.deepEqual(r.initial,{positions:Array.from(c.motion.pos),body:jsonSerial(c.motion.body)});
assert(r.steps.length<=300&&Number.isInteger(r.shownStep)&&r.shownStep>=0&&r.shownStep<=r.steps.length);
const costs=[],delays=[],timings=[];
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
  assert.equal(Boolean(s.timing),Boolean(f.profileWorker),'Режим наблюдения отличается от входа');
  if(s.timing) {
    const t=s.timing,epsilon=1e-6;
    for(const k of ['loadMs','physicsMs','snapshotMs','handlerMs'])assert(Number.isFinite(t[k])&&t[k]>=0,'Некорректное время '+k);
    assert(Math.abs(t.loadMs+t.physicsMs-s.stepMs)<=epsilon&&Math.abs(t.handlerMs-s.stepMs-t.snapshotMs)<=epsilon);
    assert.deepEqual(Object.keys(t.stages).sort(),['audit','bodyState','direction','readSoft','state','validateState']);
    for(const row of Object.values(t.stages))assert(Number.isInteger(row.calls)&&row.calls>=0&&
      Number.isFinite(row.inclusiveMs)&&Number.isFinite(row.selfMs)&&row.selfMs>=-epsilon&&row.inclusiveMs+epsilon>=row.selfMs);
    assert(Object.values(t.stages).reduce((sum,row)=>sum+row.selfMs,0)<=t.physicsMs+epsilon,'Стадии суммируются дважды');
    assert(t.linear.factorMs>=0&&t.linear.solveMs>=0&&t.linear.factorMs+t.linear.solveMs<=t.stages.direction.inclusiveMs+epsilon);
    for(const [k,v] of Object.entries(t.wasm))assert(Number.isInteger(v)&&v>=0,'Неверный счётчик WASM '+k);
    assert.equal(t.linear.factorCalls,t.wasm.numericFactorizations);
    assert(Number.isInteger(t.linear.solveCalls)&&t.linear.solveCalls>=0);
    assert(t.stages.direction.calls>=a.solver.iterations&&t.stages.audit.calls>=1);
    timings.push(t);
  }
  costs.push(s.stepMs);
  if(s.presentedAt!==undefined){assert(s.presentedAt>=s.receivedAt);delays.push(s.presentedAt-s.receivedAt);}
}
const result={schema:'cloth-fluid-live-report-v1',input,sha256:hash(bytes),revision:f.revision,dirty:f.dirty,
  valid:true,exactSteps:r.steps.length,shownStep:r.shownStep,lastAcceptedStepShown:r.shownStep===r.steps.length,
  costsMs:{mean:costs.length?costs.reduce((a,b)=>a+b,0)/costs.length:null,max:costs.length?Math.max(...costs):null},
  maxPresentationDelayMs:delays.length?Math.max(...delays):null,
  ...(materialValidation?{material:{backend:'wasm',module:f.materialWasm,validation:materialValidation}}:{}),
  ...(assemblyValidation?{assembly:{backend:'wasm',module:f.assemblyWasm,validation:assemblyValidation}}:{}),
  ...(f.profileWorker?{timing:{profile:true,steps:timings.length,
    loadTotalMs:timings.reduce((sum,t)=>sum+t.loadMs,0),physicsTotalMs:timings.reduce((sum,t)=>sum+t.physicsMs,0),
    snapshotTotalMs:timings.reduce((sum,t)=>sum+t.snapshotMs,0),
    stages:Object.fromEntries(Object.keys(timings[0]?.stages??{}).map(k=>[k,
      Object.fromEntries(['calls','inclusiveMs','selfMs'].map(v=>[v,timings.reduce((sum,t)=>sum+t.stages[k][v],0)]))])),
    linear:Object.fromEntries(['factorMs','solveMs','factorCalls','solveCalls'].map(k=>[k,timings.reduce((sum,t)=>sum+t.linear[k],0)])),
    scope:'Наблюдение меняет стоимость исполнения; интервалы включают остановки потока. Вложенные стадии используют selfMs; линейное время входит в direction.'}}:{}),
  ...(f.sheet?{sheet:{proof:f.sheetProof,limits:c.sheetControl,
    minLengthM:r.steps.length?Math.min(...r.steps.map(s=>s.audit.ropes[0].lengthM)):f.sheet.lengthM,
    maxLengthM:r.steps.length?Math.max(...r.steps.map(s=>s.audit.ropes[0].lengthM)):f.sheet.lengthM,
    peakTensionN:r.steps.length?Math.max(...r.steps.map(s=>s.audit.ropes[0].tensionN)):null,
    scope:'Пик идеальной нерастяжимой верёвки не принят как реальная нагрузка.'}}:{}),
  scope:'Точное повторение записи подтверждено. Время браузерного расчёта не означает FPS, выполнение бюджета или приёмку учебного режима.'};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
