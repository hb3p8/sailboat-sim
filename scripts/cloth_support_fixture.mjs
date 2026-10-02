// Плавное заданное движение угла полного паруса под сохранённой нагрузкой.
// Это исследовательская постановка, не закон верёвки и не замер браузера.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {browserMotion} from '../tests/lib/cloth-browser-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {IMPLICIT_TOLERANCES} from '../tests/lib/cloth-implicit-motion.mjs';
import {supportBalance} from '../tests/lib/cloth-support-balance.mjs';

const args=process.argv.slice(2);
assert(args.length>=3 && args.length<=5,'Нужны сохранённый браузерный вход, ход в метрах, новый путь JSON, необязательные частота 60/120/240 Гц и траектория sin4/sin2');
const [input,strokeText,output,hzText='60',profile='sin4']=args, strokeM=Number(strokeText), hz=Number(hzText), hS=1/hz;
assert([60,120,240].includes(hz),'Частота задаётся как 60/120/240 Гц');
assert(['sin4','sin2'].includes(profile),'Траектория задаётся как sin4/sin2');
const exponent=profile==='sin4'?4:2;
assert(Number.isFinite(strokeM) && Math.abs(strokeM)<=.1,'Ход задаётся числом в пределах ±0.1 м');
assert(!existsSync(output),'Сохранённый опыт нельзя перезаписывать');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=readFileSync(input), source=JSON.parse(bytes), recipe=source.recipe;
assert.equal(source.schema,1); assert.equal(source.dirty,false,'Нужен вход от чистого исходного опыта');
for (const [path,sha] of Object.entries(source.sourceSha256))
  assert.equal(hash(execFileSync('git',['show',`${source.revision}:${path}`],{maxBuffer:16*1024*1024})),sha,'Исходники сохранённого входа не соответствуют его коммиту');
assert.deepEqual([recipe.rows,recipe.cols,recipe.hS,recipe.iterations],[11,9,1/60,80]);
assert.equal(recipe.fixed.length,3); assert.equal(source.measurement.warmupSteps,40);
const wasmBytes=readFileSync(source.wasm.path);
assert.equal(hash(wasmBytes),source.wasm.sha256); assert.equal(hash(readFileSync('out/export/physics.json')),source.physicsSha256);
const calculationRecipe=structuredClone(recipe);
const factor=await loadSparseFactor(wasmBytes), calculation=browserMotion(calculationRecipe,factor), motion=calculation.motion;
const node=recipe.fixed[2], origin=recipe.positions.slice(3*node,3*node+3), tack=recipe.positions.slice(3*recipe.fixed[0],3*recipe.fixed[0]+3);
const length=Math.hypot(...origin.map((v,d)=>tack[d]-v)), direction=origin.map((v,d)=>(tack[d]-v)/length);
const durationS=1, holdS=1, steps=[], warmupSteps=source.measurement.warmupSteps;
const sourcePaths=[...new Set([...Object.keys(source.sourceSha256),'scripts/cloth_support_fixture.mjs','tests/lib/cloth-support-balance.mjs'])];
const record={schema:1,createdAt:new Date().toISOString(),
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  sourceSha256:Object.fromEntries(sourcePaths.map(p=>[p,hash(readFileSync(p))])),
  input:{path:input,sha256:hash(bytes),revision:source.revision},physicsSha256:source.physicsSha256,wasm:source.wasm,
  config:{tack:source.tack,strokeM,durationS,holdS,warmupSteps,warmupHS:recipe.hS,hS,profile,tolerances:IMPLICIT_TOLERANCES,
    trajectory:`q=q0+direction*stroke*sin^${exponent}(πt/T), затем q0; направление к нижнему переднему креплению`,
    boundary:'предписанная точка, неподвижная лодка, сохранённое поле давления/тяжести/сопротивления'},
  recipe,command:{node,origin,direction},steps};
const finiteScalarAudit=result=>Object.fromEntries(Object.entries(result).filter(([k])=>!['constraintForce','hardForce','prediction','supportForceN'].includes(k)));
function accepted(audit) {
  assert.equal(audit.solver.converged,true);
  for (const [k,v] of Object.entries(IMPLICIT_TOLERANCES)) assert.equal(audit.solver[k],v);
  assert(audit.maxPhysicalResidualN<=IMPLICIT_TOLERANCES.forceToleranceN);
  assert(audit.maxHardViolationM<=IMPLICIT_TOLERANCES.lengthToleranceM);
  assert(audit.solver.complementarityJ<=IMPLICIT_TOLERANCES.complementarityToleranceJ);
  const dual=Math.max(0,...motion.hard.filter(c=>c.unilateral).map(c=>c.lambda/audit.hS**2));
  assert(dual<=IMPLICIT_TOLERANCES.dualToleranceN); return dual;
}
const start=performance.now(); let attemptedTimeS=0;
try {
  for (let i=0;i<warmupSteps;i++) {
    const audit=calculation.step(); accepted(audit);
    assert.deepEqual(Array.from(motion.pos),source.expected[i].positionsM,'Посадка изменилась относительно сохранённого входа');
    for (const [k,v] of Object.entries(source.expected[i].audit)) if (k.endsWith('J')) assert.equal(audit[k],v);
  }
  record.initial={positionsM:Array.from(motion.pos),previousM:Array.from(motion.prev),prevDt:motion.prevDt};
  calculationRecipe.hS=hS;
  for (let i=1;i<=Math.round((durationS+holdS)/hS);i++) {
    const timeS=i*hS; attemptedTimeS=timeS;
    // Конечная точка задаётся точно: sin(π) не используется как нулевое число.
    const displacementM=timeS<durationS?strokeM*Math.sin(Math.PI*timeS/durationS)**exponent:0;
    const positionM=origin.map((v,d)=>v+direction[d]*displacementM);
    record.pendingAttempt={timeS,displacementM,positionM};
    const previous=motion.pos.slice(), prior=motion.prev.slice(), priorDt=motion.prevDt;
    const t0=performance.now(), audit=calculation.step([{node,positionM}]), stepMs=performance.now()-t0;
    record.pendingAttempt.audit=finiteScalarAudit(audit);
    const dualViolationN=accepted(audit);
    if (strokeM===0 && hS===recipe.hS) {
      const expected=source.expected[warmupSteps+i-1];
      assert.deepEqual(Array.from(motion.pos),expected.positionsM,'Неподвижный контроль изменился');
      for (const [k,v] of Object.entries(expected.audit)) if (k.endsWith('J')) assert.equal(audit[k],v);
    }
    assert.deepEqual(Array.from(motion.pos.slice(3*node,3*node+3)),positionM);
    const balance=supportBalance({positions:motion.pos,previous,prior,priorDt,hS,mass:motion.mass,
      fixed:recipe.fixed,board:recipe.board,dampingHz:motion.dampingHz,appliedForceN:calculation.forceN,
      supportForceN:audit.supportForceN,forceToleranceN:IMPLICIT_TOLERANCES.forceToleranceN});
    const energyMagnitude=Math.abs(audit.kineticChangeJ)+Math.abs(audit.softEnergyChangeJ)+Math.abs(audit.appliedWorkJ)+
      Math.abs(audit.dampingWorkJ)+Math.abs(audit.hardWorkEstimateJ)+Math.abs(audit.supportWorkJ)+
      Math.abs(audit.inertiaIncrementJ)+Math.abs(audit.materialIncrementJ);
    balance.energyLimitJ+=16*motion.pos.length*Number.EPSILON*energyMagnitude;
    record.pendingAttempt.balance=balance;
    assert(Math.abs(balance.supportWorkJ-audit.supportWorkJ)<=balance.workRoundingJ+Number.EPSILON);
    assert(balance.forceN.every(v=>Math.abs(v)<=balance.forceLimitN),'Общий баланс сил');
    assert(balance.momentNm.every((v,d)=>Math.abs(v)<=balance.momentLimitNm[d]),'Общий баланс моментов');
    assert(Math.abs(audit.discreteBalanceResidualJ)<=balance.energyLimitJ,'Дискретный баланс работы');
    steps.push({timeS,displacementM,positionM,stepMs,positionsM:Array.from(motion.pos),
      appliedForceN:Array.from(calculation.forceN),supportForceN:Array.from(audit.supportForceN),
      audit:finiteScalarAudit(audit),dualViolationN,balance});
    delete record.pendingAttempt;
  }
  const maximum=fn=>Math.max(...steps.map(fn));
  record.summary={acceptedSteps:steps.length,warmupExactSteps:warmupSteps,heldExactSteps:strokeM===0 && hS===recipe.hS?steps.length:0,
    maxForceResidualN:maximum(s=>s.audit.maxPhysicalResidualN),maxHardViolationM:maximum(s=>s.audit.maxHardViolationM),
    maxComplementarityJ:maximum(s=>s.audit.solver.complementarityJ),maxDualViolationN:maximum(s=>s.dualViolationN),
    maxGlobalForceComponentN:maximum(s=>Math.max(...s.balance.forceN.map(Math.abs))),
    maxGlobalMomentComponentNm:maximum(s=>Math.max(...s.balance.momentNm.map(Math.abs))),
    maxDiscreteBalanceResidualJ:maximum(s=>Math.abs(s.audit.discreteBalanceResidualJ)),
    supportWorkJ:steps.reduce((v,s)=>v+s.audit.supportWorkJ,0),
    peakClewReactionN:maximum(s=>Math.hypot(...s.supportForceN.slice(3*node,3*node+3))),
    meanStepMs:steps.reduce((v,s)=>v+s.stepMs,0)/steps.length,maxStepMs:maximum(s=>s.stepMs)};
  record.phase='complete';
} catch (error) {
  record.phase='failed';record.failure={message:error.message,attemptedTimeS,acceptedSteps:steps.length,
    lastPositionsM:Array.from(motion.pos),lastPreviousM:Array.from(motion.prev),prevDt:motion.prevDt};
  process.exitCode=1;
}
record.wallSeconds=(performance.now()-start)/1000;
writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,phase:record.phase,summary:record.summary,failure:record.failure &&
  {message:record.failure.message,attemptedTimeS,acceptedSteps:steps.length},wallSeconds:record.wallSeconds},null,2));
