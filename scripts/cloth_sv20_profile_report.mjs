// Разбор настоящего профиля SV20; строгая механика подтверждается отдельно.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [plus,minus,plusProof,minusProof,out]=process.argv.slice(2);
assert(process.argv.length===7&&plus&&minus&&plusProof&&minusProof&&out&&!existsSync(out));
const hash=b=>createHash('sha256').update(b).digest('hex'),rows=[],files={};
function read(path){const bytes=readFileSync(path);files[path]={sha256:hash(bytes),bytes:bytes.length};return JSON.parse(bytes);}
for(const [path,proofPath,side] of [[plus,plusProof,'plus'],[minus,minusProof,'minus']]) {
  const r=read(path),p=read(proofPath),f=r.fixture;
  assert.equal(r.schema,'cloth-fluid-live-result-v1');assert.equal(f.side,side);assert.equal(f.dirty,false);
  assert.equal(f.liveWind.bodyProfile,'sv20-rig-budget-point-v1');assert.equal(f.liveWind.worldVelocityDampingHz,0);
  assert.equal(f.recipe.hS,1/60);assert.equal(f.profileWorker,true);assert.equal(r.steps.length,180);assert.equal(r.shownStep,180);
  assert.equal(p.phase,'complete');assert.equal(p.input.path,path);assert.equal(p.input.sha256,files[path].sha256);
  assert.equal(p.exactRecordedAirSteps,180);assert.deepEqual(p.mechanicalRefusals,[]);
  for(const [source,sha] of Object.entries(f.sourceSha256)) {
    assert.equal(hash(readFileSync(source)),sha);assert.equal(hash(execFileSync('git',['show',`${f.revision}:${source}`])),sha);
    assert.equal(p.sourceSha256[source],sha);files[source]={sha256:sha,bytes:readFileSync(source).length};
  }
  for(const part of [f.input,f.sheetProof,f.wasm,f.materialWasm,f.assemblyWasm,f.scene]) {
    const bytes=readFileSync(part.path);assert.equal(hash(bytes),part.sha256);files[part.path]={sha256:hash(bytes),bytes:bytes.length};
  }
  assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);
  const epsilon=1e-6;
  for(const s of r.steps) {
    const a=s.audit,k=a.solver,t=s.timing;assert(t);assert.equal(s.visibilityState,'visible');
    assert(a.maxPhysicalResidualN<=k.forceToleranceN&&a.maxHardViolationM<=k.lengthToleranceM&&a.dualViolationN<=k.dualToleranceN&&a.complementarityJ<=k.complementarityToleranceJ);
    assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ&&Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
    assert(a.application.dryCloth&&a.application.submergedNodes===0);
    for(const rope of a.ropes)assert(Math.abs(rope.controlResidualJ)<=rope.controlLimitJ);
    for(const key of ['loadMs','physicsMs','snapshotMs','handlerMs'])assert(Number.isFinite(t[key])&&t[key]>=0);
    assert(Math.abs(t.loadMs+t.physicsMs-s.stepMs)<=epsilon&&Math.abs(t.handlerMs-s.stepMs-t.snapshotMs)<=epsilon);
    assert.deepEqual(Object.keys(t.stages).sort(),['audit','bodyState','direction','readSoft','state','validateState']);
    for(const v of Object.values(t.stages))assert(Number.isInteger(v.calls)&&v.calls>=0&&Number.isFinite(v.selfMs)&&v.selfMs>=-epsilon&&Number.isFinite(v.inclusiveMs)&&v.inclusiveMs+epsilon>=v.selfMs);
    assert(Object.values(t.stages).reduce((sum,v)=>sum+v.selfMs,0)<=t.physicsMs+epsilon);
    assert(t.linear.factorMs>=0&&t.linear.solveMs>=0&&t.linear.factorMs+t.linear.solveMs<=t.stages.direction.inclusiveMs+epsilon);
    assert.equal(t.linear.factorCalls,t.wasm.numericFactorizations);assert(t.stages.direction.calls>=a.solver.iterations);
  }
  const steps=r.steps.slice(1),sum=fn=>steps.reduce((s,v)=>s+fn(v),0),total=sum(s=>s.stepMs),costs=steps.map(s=>s.stepMs).sort((a,b)=>a-b);
  const stages=Object.fromEntries(Object.keys(steps[0].timing.stages).map(key=>[key,{meanMs:sum(s=>s.timing.stages[key].selfMs)/179,percent:100*sum(s=>s.timing.stages[key].selfMs)/total,calls:sum(s=>s.timing.stages[key].calls)}]));
  rows.push({side,input:path,mechanicalProof:proofPath,revision:f.revision,environment:r.environment,exactMechanicalSteps:180,drySteps:180,
    firstStepMs:r.steps[0].stepMs,workingSteps:179,meanMs:total/179,p95Ms:costs[Math.ceil(.95*179)-1],maxMs:costs.at(-1),
    above60HzBudget:costs.filter(v=>v>1000/60).length,channelMs:r.wallMs,channelRate:3000/r.wallMs,
    load:{meanMs:sum(s=>s.timing.loadMs)/179,percent:100*sum(s=>s.timing.loadMs)/total,scope:'Воздух и вода вместе; отдельные доли не измерены'},
    stages,linear:{meanMs:sum(s=>s.timing.linear.factorMs+s.timing.linear.solveMs)/179,
      percent:100*sum(s=>s.timing.linear.factorMs+s.timing.linear.solveMs)/total,
      factorMeanMs:sum(s=>s.timing.linear.factorMs)/179,solveMeanMs:sum(s=>s.timing.linear.solveMs)/179,
      factorCalls:sum(s=>s.timing.linear.factorCalls),scope:'Входит в direction; повторно к сумме стадий не прибавляется'},
    snapshotMeanMs:sum(s=>s.timing.snapshotMs)/179,
    unobservedPhysicsMeanMs:sum(s=>s.timing.physicsMs-Object.values(s.timing.stages).reduce((a,v)=>a+v.selfMs,0))/179});
}
files['scripts/cloth_sv20_profile_report.mjs']={sha256:hash(readFileSync('scripts/cloth_sv20_profile_report.mjs')),bytes:readFileSync('scripts/cloth_sv20_profile_report.mjs').length};
writeFileSync(out,JSON.stringify({schema:'cloth-sv20-profile-report-v1',phase:'complete',rows,files,
  scope:'Профиль меняет стоимость. Доли взяты из настоящих браузерных рабочих шагов 2–180, интервалы по часам, не CPU. Механика точно повторена на записанных силах. Один цикл каждого борта не доказывает устойчивые 60 Гц или ускорение относительно прежней другой сессии.'},null,2)+'\n',{flag:'wx'});
console.log('Профиль SV20: 360 сухих/строгих механических шагов, времена и вложенные стадии проверены.');
