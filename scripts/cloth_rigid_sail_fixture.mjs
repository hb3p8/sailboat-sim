// Полный сохранённый парус на лабораторной свободной опоре. Новая запись
// хранит каждое принятое состояние и первый отказ без перезаписи данных.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {browserMotion} from '../tests/lib/cloth-browser-motion.mjs';
import {fourPointBody} from '../tests/lib/cloth-rigid-body-motion.mjs';
import {rigidSailBalance} from '../tests/lib/cloth-rigid-sail-balance.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {IMPLICIT_TOLERANCES as tol} from '../tests/lib/cloth-implicit-motion.mjs';
const args=process.argv.slice(2);
assert(args.length>=2&&args.length<=4,'Нужны прежняя полная серия, новый JSON, частота 60/120/240 и длительность в секундах');
const [input,output,hzText='60',durationText='1']=args,hz=Number(hzText),durationS=Number(durationText),hS=1/hz;
assert([60,120,240].includes(hz)&&durationS>0&&durationS<=5&&Number.isInteger(durationS*hz));
assert(!existsSync(output),'Сохранённый опыт нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),source=JSON.parse(bytes);
assert.equal(source.dirty,false);assert.equal(source.phase,'complete');
assert.deepEqual([source.recipe.rows,source.recipe.cols,source.config.strokeM],[11,9,0]);
for(const [p,sha] of Object.entries(source.sourceSha256))
  assert.equal(hash(execFileSync('git',['show',`${source.revision}:${p}`],{maxBuffer:16*1024*1024})),sha);
const wasmBytes=readFileSync(source.wasm.path);
assert.equal(hash(wasmBytes),source.wasm.sha256);assert.equal(hash(readFileSync('out/export/physics.json')),source.physicsSha256);
const factor=await loadSparseFactor(wasmBytes),warm=browserMotion(structuredClone(source.recipe),factor);
for(let i=0;i<source.config.warmupSteps;i++)warm.step();
assert.deepEqual(Array.from(warm.motion.pos),source.initial.positionsM,'Посадка полного паруса изменилась');
assert.deepEqual(Array.from(warm.motion.prev),source.initial.previousM);assert.equal(warm.motion.prevDt,source.initial.prevDt);
// Заранее выбранная лабораторная опора: объёмная, вытянутая вдоль первой
// оси. Эти числа не получены подгонкой и не заменяют параметры яхты.
const bodyInput={massKg:1000,principalInertiaKgM2:[1000,5000,5000],originM:[0,0,0]};
const body=fourPointBody(bodyInput),n=source.recipe.rows*source.recipe.cols;
const recipe={...structuredClone(source.recipe),hS,fixed:[],
  positions:[...warm.motion.pos,...body.positionsM],previous:[...warm.motion.prev,...body.positionsM],
  prevDt:warm.motion.prevDt,mass:[...source.recipe.mass,...body.massKg],
  rigidBody:{nodes:[n,n+1,n+2,n+3],attachments:source.recipe.fixed.slice(),frame:'inertial-cartesian',dampingHz:0},
  loadFrame:'inertial-cartesian-frozen'};
const calculation=browserMotion(recipe,factor),m=calculation.motion;
const paths=[...new Set([...Object.keys(source.sourceSha256),'scripts/cloth_rigid_sail_fixture.mjs',
  'tests/lib/cloth-rigid-body-motion.mjs','tests/lib/cloth-rigid-sail-motion.mjs','tests/lib/cloth-rigid-sail-balance.mjs'])];
const record={schema:1,createdAt:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  sourceSha256:Object.fromEntries(paths.map(p=>[p,hash(readFileSync(p))])),input:{path:input,sha256:hash(bytes),revision:source.revision},
  wasm:source.wasm,physicsSha256:source.physicsSha256,recipe,
  config:{tack:source.config.tack,durationS,hS,warmupExactSteps:source.config.warmupSteps,tolerances:tol,bodyInput,
    scope:'Замороженные лабораторные оси нагрузки, сухой вес и линейное сопротивление ткани; свободная опора без собственного веса, воды, удерживающей направляющей и живого воздуха'},steps:[]};
const start=performance.now();let attemptedTimeS=0;
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):
  v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
try {
  for(let i=1;i<=durationS*hz;i++) {
    attemptedTimeS=i*hS;const old=m.pos.slice(),prior=m.prev.slice(),priorDt=m.prevDt,t0=performance.now();
    const a=calculation.step(),stepMs=performance.now()-t0;
    const audit=Object.fromEntries(Object.entries(a).filter(([k])=>!['prediction','constraintForce','hardForce'].includes(k)).map(([k,v])=>[k,serial(v)]));
    const balance=rigidSailBalance(m,a,old,prior,priorDt,calculation.forceN);
    const dualViolationN=Math.max(0,...m.hard.filter(c=>c.unilateral).map(c=>c.lambda/hS**2));
    record.pendingAttempt={timeS:attemptedTimeS,audit,balance};
    assert(a.solver.converged);for(const [k,v] of Object.entries(tol))assert.equal(a.solver[k],v);
    assert(a.maxPhysicalResidualN<=tol.forceToleranceN);assert(a.maxHardViolationM<=tol.lengthToleranceM);
    assert(balance.maxNodeResidualN<=tol.forceToleranceN,'Независимый понодальный силовой остаток');
    assert(a.solver.complementarityJ<=tol.complementarityToleranceJ);assert(dualViolationN<=tol.dualToleranceN);
    assert(Math.abs(a.discreteBalanceResidualJ)<=balance.energyLimitJ,'Общая работа');
    assert(Math.abs(a.discreteBalanceResidualJ-balance.identityJ)<=1e-9,'Независимое тождество работы');
    assert(balance.linearNs.every(v=>Math.abs(v)<=balance.linearLimitNs),'Общий импульс');
    assert(balance.angularNms.every(v=>Math.abs(v)<=balance.angularLimitNms),'Общий момент');
    assert(balance.bodyAngularNms.every(v=>Math.abs(v)<=balance.bodyMomentLimitNms),'Момент свободной опоры');
    assert(Math.abs(a.bodyWorkCancellationResidualJ)<=balance.workLimitJ,'Встречная работа');
    for(const node of recipe.rigidBody.nodes)for(let d=0;d<3;d++) {
      const sum=m.rigidBody.bindings.reduce((s,b)=>s+Math.abs(b.weights.find(([i])=>i===node)[1]),0);
      assert(Math.abs(a.bodyNodeBalanceResidualN[3*node+d])<=(1+sum)*tol.forceToleranceN+1e-9,'Реакция на тело');
    }
    record.steps.push({timeS:attemptedTimeS,stepMs,positionsM:Array.from(m.pos),appliedForceN:Array.from(calculation.forceN),audit,dualViolationN,balance});
    delete record.pendingAttempt;
  }
  const steps=record.steps,max=f=>Math.max(...steps.map(f)),last=steps.at(-1).audit;
  const turnAngles=steps.map((s,i)=> {
    const R=s.audit.bodyRotationFromReference,P=i?steps[i-1].audit.bodyRotationFromReference:[1,0,0,0,1,0,0,0,1];
    return Math.acos(Math.max(-1,Math.min(1,(R.reduce((v,x,j)=>v+x*P[j],0)-1)/2)));
  });
  record.phase='complete';record.summary={acceptedSteps:steps.length,
    maxForceResidualN:max(s=>s.audit.maxPhysicalResidualN),maxHardViolationM:max(s=>s.audit.maxHardViolationM),
    maxEnergyLimitRatio:max(s=>Math.abs(s.audit.discreteBalanceResidualJ)/s.balance.energyLimitJ),
    maxLinearResidualNs:max(s=>Math.hypot(...s.balance.linearNs)),maxAngularResidualNms:max(s=>Math.hypot(...s.balance.angularNms)),
    maxBodyAngularResidualNms:max(s=>Math.hypot(...s.balance.bodyAngularNms)),
    maxWorkCancellationJ:max(s=>Math.abs(s.audit.bodyWorkCancellationResidualJ)),
    maxIndependentNodeResidualN:max(s=>s.balance.maxNodeResidualN),
    bodyOriginM:last.bodyOriginM,bodyVelocityMS:last.bodyProperties.velocityMS,
    bodyRotationAngleRad:Math.acos(Math.max(-1,Math.min(1,(last.bodyRotationFromReference[0]+last.bodyRotationFromReference[4]+last.bodyRotationFromReference[8]-1)/2))),
    bodyAngularMomentumNms:last.bodyProperties.angularMomentumNms,
    maxBodyAngularSpeedRadS:Math.max(...turnAngles)/hS,
    bodyNumericalAngularIncrementNms:[0,1,2].map(d=>steps.reduce((s,x)=>s+x.balance.bodyIncrementNms[d],0)),
    bodyNumericalAngularIncrementNormSumNms:steps.reduce((s,x)=>s+Math.hypot(...x.balance.bodyIncrementNms),0),
    meanStepMs:steps.reduce((s,x)=>s+x.stepMs,0)/steps.length,maxStepMs:max(s=>s.stepMs)};
}catch(e){record.phase='failed';record.failure={message:e.message,attemptedTimeS,acceptedSteps:record.steps.length,
  positionsM:Array.from(m.pos),previousM:Array.from(m.prev),prevDt:m.prevDt};process.exitCode=1;}
record.wallSeconds=(performance.now()-start)/1000;
writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,phase:record.phase,summary:record.summary,failure:record.failure&&
  {message:record.failure.message,attemptedTimeS,acceptedSteps:record.steps.length},wallSeconds:record.wallSeconds},null,2));
