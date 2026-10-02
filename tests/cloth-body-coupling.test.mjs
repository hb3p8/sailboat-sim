// Двусторонняя поступательная связь: известные массы, работа и общий шаг.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ImplicitEnergyMotion,IMPLICIT_TOLERANCES} from './lib/cloth-implicit-motion.mjs';
import {EnergyMotion} from './lib/cloth-energy-motion.mjs';
import {distance} from './cloth-compliance.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {materialSurface} from './lib/cloth-material.mjs';
import {browserMotion} from './lib/cloth-browser-motion.mjs';
const args=process.argv.slice(2),backend=args.find(a=>a.startsWith('--linear-backend='))?.split('=')[1]??'band-js';
const wasm=args.find(a=>a.startsWith('--wasm='))?.slice(7),output=args.find(a=>a.startsWith('--out='))?.slice(6);
const legacyInputs=args.filter(a=>a.startsWith('--legacy-input=')).map(a=>a.slice(15));
assert(args.every(a=>/^--(linear-backend|wasm|out|legacy-input)=.+$/.test(a)) && ['band-js','kkt-wasm'].includes(backend));
assert(backend!=='kkt-wasm'||wasm,'Нужен --wasm=модуль');
assert(!legacyInputs.length||backend==='kkt-wasm','Сохранённая полная серия требует прежний kkt-wasm');
assert(!output||!existsSync(output),'Результат нельзя перезаписывать');
const factor=wasm?await loadSparseFactor(readFileSync(wasm)):undefined;
const close=(a,b,tolerance=2e-10)=>assert(Number.isFinite(a)&&Number.isFinite(b)&&
  Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const vector=(a,b)=>a.forEach((v,d)=>close(v,b[d]));
const bodyOption=(attachments=[1])=>({node:0,attachments,frame:'inertial-cartesian'});
const options={linearBackend:backend,wasmSparseFactor:factor};
const linearSpring=(a,b,d,rest,k)=>({alpha:1/k,family:'известная пружина',unit:'м',
  value(p){const g=[0,0,0];g[d]=1;return {C:p[3*b+d]-p[3*a+d]-rest,grad:[[a,g.map(v=>-v)],[b,g]]};}});
const result={linear:[],refinement:[],impact:[],material:[],legacy:[]};
let maxBodyResidualN=0,maxWorkCancellationJ=0,maxDiscreteBalanceJ=0,maxEnergyLimitRatio=0,maxBalanceIdentityErrorJ=0;
function auditCheck(a,motion) {
  assert(a.solver.converged);
  for(const [v,limit] of [[a.maxPhysicalResidualN,IMPLICIT_TOLERANCES.forceToleranceN],
    [a.maxHardViolationM,IMPLICIT_TOLERANCES.lengthToleranceM],
    [a.solver.complementarityJ,IMPLICIT_TOLERANCES.complementarityToleranceJ]])assert(v<=limit);
  assert.equal(a.bodyFrame,'inertial-cartesian');
  a.bodyBalanceResidualN.forEach(v=>assert(Math.abs(v)<=IMPLICIT_TOLERANCES.forceToleranceN));
  close(a.bodyWorkCancellationResidualJ,0,1e-9);
  // Силовой допуск переносится в работу через перемещение свободных координат,
  // как в supportBalance. Абсолютный 1e-9 Дж не ограничивает физический остаток.
  const state=motion.state(a.prediction,a.hS,motion.hard.map(c=>-c.lambda/a.hS**2));
  let expectedResidualJ=0,displacementSumM=0;
  for(let j=0;j<motion.free.length;j++) {
    const k=motion.free[j],delta=motion.pos[k]-motion.prev[k];
    expectedResidualJ+=state.residual[j]*delta;displacementSumM+=Math.abs(delta);
  }
  const scale=Math.abs(a.initialKineticJ)+Math.abs(a.kineticJ)+Math.abs(a.initialSoftEnergyJ)+Math.abs(a.softEnergyJ)+
    Math.abs(a.appliedWorkJ)+Math.abs(a.dampingWorkJ)+Math.abs(a.hardWorkEstimateJ)+Math.abs(a.supportWorkJ)+
    Math.abs(a.inertiaIncrementJ)+Math.abs(a.materialIncrementJ);
  const energyLimitJ=IMPLICIT_TOLERANCES.forceToleranceN*displacementSumM+16*motion.pos.length*Number.EPSILON*scale;
  close(a.discreteBalanceResidualJ,expectedResidualJ,1e-9);
  assert(Math.abs(a.discreteBalanceResidualJ)<=energyLimitJ,'Работа не ограничена прежним допуском сил');
  maxEnergyLimitRatio=Math.max(maxEnergyLimitRatio,energyLimitJ?Math.abs(a.discreteBalanceResidualJ)/energyLimitJ:0);
  maxBalanceIdentityErrorJ=Math.max(maxBalanceIdentityErrorJ,Math.abs(a.discreteBalanceResidualJ-expectedResidualJ));
  maxBodyResidualN=Math.max(maxBodyResidualN,...a.bodyBalanceResidualN.map(Math.abs));
  maxWorkCancellationJ=Math.max(maxWorkCancellationJ,Math.abs(a.bodyWorkCancellationResidualJ));
  maxDiscreteBalanceJ=Math.max(maxDiscreteBalanceJ,Math.abs(a.discreteBalanceResidualJ));
}
function velocity(motion,node,h) {return [0,1,2].map(d=>(motion.pos[3*node+d]-motion.prev[3*node+d])/h);}

// Независимое решение двух масс: масса опоры 10, прикреплённого узла 2,
// свободного узла 3 кг. К пружине обращаются как к одной неизвестной разности.
for(const hz of [60,120,240])for(const side of [-1,1])for(const damp of [false,true]) {
  const h=1/hz,k=20,M=12,m=3,rest=[side,0,0],offset=[0,.3,.4];
  const origin=[3,-2,1],v0=[.3,-.2,.1];
  const p=[...origin,...origin.map((v,d)=>v+offset[d]),...origin.map((v,d)=>v+offset[d]+rest[d]+(d===0?side*.2:0))];
  const config=bodyOption();config.dampingHz=damp?.7:0;
  const motion=new ImplicitEnergyMotion({positions:p,mass:[10,2,3],fixed:[],
    constraints:[0,1,2].map(d=>linearSpring(1,2,d,rest[d],k)),dampingHz:damp?6:0,translatingBody:config,...options});
  close(motion.bodyEffectiveMassKg,12);assert.equal(motion.w[1],0);
  // Вход не принадлежит решателю после создания.
  config.attachments[0]=2;assert.deepEqual(motion.translatingBody.attachments,[1]);
  for(let i=0;i<3;i++)for(let d=0;d<3;d++)motion.prev[3*i+d]=motion.pos[3*i+d]-h*v0[d];
  motion.prevDt=h;
  let xb=origin.slice(),xc=Array.from(motion.pos.slice(6,9)),vb=v0.slice(),vc=v0.slice(),maxPositionErrorM=0;
  for(let n=0;n<hz;n++) {
    const fbody=[side*5,0,-10*9.81],fa=[0,0,-.2*9.81],fc=[-side,0,-.3*9.81];
    const force=[...fbody,...fa,...fc],before=Array.from(motion.pos),oldVB=vb.slice();
    const expectedReaction=[0,0,0],nextB=[],nextC=[],nextVB=[],nextVC=[];
    for(let d=0;d<3;d++) {
      const db=damp?10*(Math.exp(-.7*h)-1)*vb[d]/h+2*(Math.exp(-6*h)-1)*vb[d]/h:0;
      const dc=damp?m*(Math.exp(-6*h)-1)*vc[d]/h:0;
      const pb=xb[d]+h*vb[d]+h*h*(fbody[d]+fa[d]+db)/M;
      const pc=xc[d]+h*vc[d]+h*h*(fc[d]+dc)/m;
      const extension=(pc-pb-offset[d]-rest[d])/(1+h*h*k*(1/M+1/m));
      nextB[d]=pb+h*h*k*extension/M;nextC[d]=pc-h*h*k*extension/m;
      nextVB[d]=(nextB[d]-xb[d])/h;nextVC[d]=(nextC[d]-xc[d])/h;
      const da=damp?2*(Math.exp(-6*h)-1)*vb[d]/h:0;
      expectedReaction[d]=2*(nextVB[d]-vb[d])/h-fa[d]-da-k*extension;
    }
    const a=motion.step(force,h,80);auditCheck(a,motion);
    vector(motion.pos.slice(0,3),nextB);vector(motion.pos.slice(6,9),nextC);
    vector(motion.pos.slice(3,6),nextB.map((v,d)=>v+offset[d]));
    vector(a.bodyAttachmentForceN.slice(3,6),expectedReaction);
    vector(a.bodyForceN,expectedReaction.map(v=>-v));vector(a.bodyOriginM,nextB);
    const f=a.bodyForceN,r=offset;
    vector(a.bodyMomentNm,[r[1]*f[2]-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]-r[1]*f[0]]);
    vector(a.bodyLockMomentNm,a.bodyMomentNm.map(v=>-v));
    const actualVB=velocity(motion,0,h);
    const bodyKChange=5*(actualVB.reduce((s,v)=>s+v*v,0)-oldVB.reduce((s,v)=>s+v*v,0));
    const bodyInertiaIncrement=5*actualVB.reduce((s,v,d)=>s+(v-oldVB[d])**2,0);
    const bodyExternalWork=fbody.reduce((s,v,d)=>s+v*(motion.pos[d]-before[d]),0);
    const bodyDampingWork=damp?oldVB.reduce((s,v,d)=>s+10*(Math.exp(-.7*h)-1)*v/h*(motion.pos[d]-before[d]),0):0;
    close(bodyKChange-bodyExternalWork-bodyDampingWork-a.bodyWorkJ+bodyInertiaIncrement,0,1e-9);
    // Общая внешняя тяжесть 10.5g, а инерция 15: воздух в груз не включён.
    if(!damp) {
      const totalZMomentum=12*actualVB[2]+3*velocity(motion,2,h)[2];
      close(totalZMomentum,15*v0[2]-(n+1)*h*10.5*9.81);
    }
    maxPositionErrorM=Math.max(maxPositionErrorM,...nextB.map((v,d)=>Math.abs(v-motion.pos[d])),
      ...nextC.map((v,d)=>Math.abs(v-motion.pos[6+d])));
    xb=nextB;xc=nextC;vb=nextVB;vc=nextVC;
  }
  result.linear.push({hz,side,damping:damp,maxPositionErrorM});
}

// Непрерывное известное колебание: q''+k(1/M+1/m)q=0, общий ЦТ неподвижен.
let priorError=Infinity;
for(const hz of [60,120,240]) {
  const motion=new ImplicitEnergyMotion({positions:[0,0,0,0,0,0,1.2,0,0],mass:[10,2,3],
    constraints:[linearSpring(1,2,0,1,20)],translatingBody:bodyOption(),dampingHz:0,...options});
  const omega=Math.sqrt(20*(1/12+1/3)),expectedB=.24-.2*(1+.2*Math.cos(omega));
  for(let n=0;n<hz;n++) {
    const a=motion.step(new Float64Array(9),1/hz,80);auditCheck(a,motion);
    close(12*motion.pos[0]+3*motion.pos[6],3*1.2);
    close(12*velocity(motion,0,1/hz)[0]+3*velocity(motion,2,1/hz)[0],0);
  }
  const error=Math.abs(motion.pos[0]-expectedB);
  assert(error<priorError,'Связанное движение не сходится к известному колебанию');priorError=error;
  result.refinement.push({hz,bodyXM:motion.pos[0],expectedBodyXM:expectedB,errorM:error});
}

// Натяжение нити между двумя подвижными массами: скорость после события 0.2,
// импульс на саму опору 2 Н·с, потеря общей энергии 1.2 Дж во всех фазах/h.
for(const hz of [60,120,240])for(const phase of [.25,.5,.75]) {
  const h=1/hz,x=1-phase*h;
  const motion=new ImplicitEnergyMotion({positions:[0,0,0,0,0,0,x,0,0],mass:[10,2,3],
    constraints:[distance(1,2,1,0,true)],translatingBody:bodyOption(),dampingHz:0,...options});
  motion.prev[6]=x-h;motion.prevDt=h;
  let impulse=0,peak=0,loss=0;
  for(let n=0;n<3;n++) {
    const a=motion.step(new Float64Array(9),h,80);auditCheck(a,motion);
    impulse+=a.bodyForceN[0]*h;peak=Math.max(peak,Math.abs(a.bodyForceN[0]));
    loss+=a.inertiaIncrementJ-a.hardWorkEstimateJ;
  }
  vector(velocity(motion,0,h),[.2,0,0]);vector(velocity(motion,2,h),[.2,0,0]);
  close(motion.pos[6]-motion.pos[0],1);close(impulse,2);close(loss,1.2);close(motion.kinetic(),.3);
  close(peak,2*Math.max(phase,1-phase)/h);
  result.impact.push({hz,phase,impulseNs:impulse,peakN:peak,lossJ:loss});
}

// Настоящий материал одного треугольника. Два угла закреплены на подвижной
// опоре; её ориентацию держит направляющая с опубликованным моментом.
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
for(const hz of [60,120,240])for(const side of [-1,1])for(const drift of [false,true]) {
  const h=1/hz,origin=[3,-2,1],initialV=drift?[1.3,-.2,.1]:[0,0,0],mass=[10,2,3,4];
  const points=[...origin,...origin,...origin.map((v,d)=>v+(d===1?1:0)),...origin.map((v,d)=>v+(d===0?side:0))];
  const surface=materialSurface(points,[[1,3,2]],{bulkNPerM:1000,shearNPerM:50,bendingNm:0});
  const motion=new ImplicitEnergyMotion({positions:points,mass,constraints:surface.constraints,
    translatingBody:bodyOption([1,2]),dampingHz:0,...options});
  for(let i=0;i<4;i++)for(let d=0;d<3;d++)motion.prev[3*i+d]=motion.pos[3*i+d]-h*initialV[d];
  motion.prevDt=h;
  const force=[0,0,0,0,0,0,0,0,0,side*5,0,0];
  let maxMomentumErrorNs=0,maxAngularBalanceErrorNms=0;
  for(let n=0;n<hz/4;n++) {
    const old=motion.pos.slice(),vold=mass.map((_,i)=>velocity(motion,i,h));
    const a=motion.step(force,h,80);auditCheck(a,motion);
    const momentum=[0,0,0],angularChange=[0,0,0],angularIncrement=[0,0,0],externalMoment=[0,0,0];
    let pointScale=0;
    for(let i=0;i<4;i++) {
      const p=Array.from(motion.pos.slice(3*i,3*i+3)),p0=Array.from(old.slice(3*i,3*i+3));
      const v=velocity(motion,i,h),pForce=force.slice(3*i,3*i+3);
      const before=cross(p0,vold[i].map(x=>x*mass[i])),after=cross(p,v.map(x=>x*mass[i]));
      const increment=cross(p.map((x,d)=>x-p0[d]),v.map((x,d)=>mass[i]*(x-vold[i][d])));
      const torque=cross(p,pForce);pointScale+=p.reduce((s,x)=>s+Math.abs(x),0);
      for(let d=0;d<3;d++) {
        momentum[d]+=mass[i]*v[d];angularChange[d]+=after[d]-before[d];
        angularIncrement[d]+=increment[d];externalMoment[d]+=torque[d];
      }
    }
    const expected=initialV.map((v,d)=>19*v+(d===0?side*5*(n+1)*h:0));
    const err=momentum.map((v,d)=>v-expected[d]);
    err.forEach(v=>assert(Math.abs(v)<=IMPLICIT_TOLERANCES.forceToleranceN*6*(n+1)*h+1e-9));
    // Для неявного Эйлера остаётся дискретный член Δr×Δp. Момент направляющей
    // внешний, и его нельзя выдать за сохранение углового импульса свободной лодки.
    const angularError=angularChange.map((v,d)=>v+angularIncrement[d]-h*(externalMoment[d]+a.bodyLockMomentNm[d]));
    angularError.forEach(v=>assert(Math.abs(v)<=IMPLICIT_TOLERANCES.forceToleranceN*h*pointScale+1e-9));
    maxMomentumErrorNs=Math.max(maxMomentumErrorNs,Math.hypot(...err));
    maxAngularBalanceErrorNms=Math.max(maxAngularBalanceErrorNms,Math.hypot(...angularError));
  }
  result.material.push({hz,side,initialDrift:drift,maxMomentumErrorNs,maxAngularBalanceErrorNms});
}

// Отрицательный контроль задержанной реакции: M=10 и прикреплённая масса 20.
// Каждый расчёт закреплённого узла точен, но a_n=(1-(-2)^n)/30 неустойчиво.
const h=1/60,lagged=new ImplicitEnergyMotion({positions:[0,0,0],mass:[20],fixed:[0],constraints:[],dampingHz:0,...options});
let x=0,v=0,oldReaction=0,createdWorkJ=0;
const laggedSteps=[];
for(let n=1;n<=8;n++) {
  const acceleration=(1-oldReaction)/10,nextV=v+h*acceleration,nextX=x+h*nextV;
  const a=lagged.step([0,0,0],h,80,[{node:0,positionM:[nextX,0,0]}]);
  assert(a.solver.converged);close(a.discreteBalanceResidualJ,0,1e-9);
  const reaction=a.supportForceN[0],interfaceWorkErrorJ=(reaction-oldReaction)*(nextX-x);
  close(acceleration,(1-(-2)**n)/30);createdWorkJ+=interfaceWorkErrorJ;
  laggedSteps.push({step:n,accelerationMS2:acceleration,interfaceWorkErrorJ});
  x=nextX;v=nextV;oldReaction=reaction;
}
assert(Math.abs(laggedSteps.at(-1).accelerationMS2)>200/30 && createdWorkJ>0);
const joined=new ImplicitEnergyMotion({positions:[0,0,0,0,0,0],mass:[10,20],constraints:[],
  translatingBody:bodyOption(),dampingHz:0,...options});
for(let n=1;n<=8;n++) {
  const a=joined.step([1,0,0,0,0,0],h,80);auditCheck(a,joined);
  close(joined.pos[0],h*h*n*(n+1)/(2*30));close(velocity(joined,0,h)[0],n*h/30);
}
result.laggedControl={steps:laggedSteps,createdWorkJ,joinedAccelerationMS2:1/30};

// Полный возврат после недоведённого нелинейного шага, затем допустимый повтор.
const nonlinear=new ImplicitEnergyMotion({positions:[0,0,0,0,.3,.4,0,-.3,0,1.2,.8,.9],mass:[10,2,2,3],
  constraints:[distance(1,3,1,.05),distance(2,3,1,.03)],translatingBody:bodyOption([1,2]),dampingHz:0,...options});
const snapshot=m=>({pos:Array.from(m.pos),prev:Array.from(m.prev),prevDt:m.prevDt,
  lambda:m.constraints.map(c=>c.lambda),mu:m.lastMu?Array.from(m.lastMu):undefined,
  fixedPositions:Array.from(m.fixedPositions),active:m.supportMotionActive});
const before=snapshot(nonlinear);
assert.throws(()=>nonlinear.step([0,0,0,0,0,0,0,0,0,15,12,8],.1,1),/не доведено|Не найден/);
assert.deepEqual(snapshot(nonlinear),before);
auditCheck(nonlinear.step([0,0,0,0,0,0,0,0,0,15,12,8],.1,80),nonlinear);
assert.throws(()=>nonlinear.step(new Float64Array(12),h,80,[{node:1,positionM:[0,0,0]}]),/команда/);
for(const field of ['pos','prev']) {
  const saved=snapshot(nonlinear),oldValue=nonlinear[field][3];nonlinear[field][3]+=.001;
  assert.throws(()=>nonlinear.step(new Float64Array(12),h,80),/вне общего шага/);
  nonlinear[field][3]=oldValue;assert.deepEqual(snapshot(nonlinear),saved);
}
assert.throws(()=>{nonlinear.translatingBody.attachments[0]=3;},TypeError);
for(const bad of [{node:1,attachments:[1]},{node:0,attachments:[1,1]},
  {node:0,attachments:[3]},{node:0,attachments:[1],frame:'body-horizontal'},
  {node:0,attachments:[1],dampingHz:-1}])
  assert.throws(()=>new ImplicitEnergyMotion({positions:[0,0,0,1,0,0],mass:[10,2],constraints:[],
    translatingBody:{...bodyOption(),...bad},dampingHz:0,...options}),/Поступательная/);
assert.throws(()=>new ImplicitEnergyMotion({positions:[0,0,0,1,0,0],mass:[10,2],constraints:[],fixed:[1],
  translatingBody:bodyOption(),...options}),/Поступательная/);
assert.throws(()=>new EnergyMotion({positions:[0,0,0,1,0,0],mass:[10,2],constraints:[],
  translatingBody:bodyOption()}),/Поступательная/);
assert.throws(()=>new ImplicitEnergyMotion({positions:[0,0,0,0,0,0,2,0,1,0,0,1],mass:[10,2,1,1],constraints:[],
  fixed:[3],board:{head:3,end:2,nodes:[3,2],fractions:[0,1]},translatingBody:bodyOption(),...options}),/без планки/);

// Старый режим без опоры: все кадры/реакции/скалярные поля полного паруса
// должны остаться точно прежними, а не только последний удачный кадр.
for(const path of legacyInputs) {
  const bytes=readFileSync(path),raw=JSON.parse(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
  assert.equal(raw.phase,'complete');assert.equal(raw.dirty,false);assert.deepEqual(raw.config.tolerances,IMPLICIT_TOLERANCES);
  for(const [p,sha] of Object.entries(raw.sourceSha256))
    assert.equal(hash(execFileSync('git',['show',`${raw.revision}:${p}`],{maxBuffer:16*1024*1024})),sha);
  assert.equal(hash(readFileSync(raw.wasm.path)),raw.wasm.sha256);assert.equal(hash(readFileSync(wasm)),raw.wasm.sha256);
  assert.equal(hash(readFileSync('out/export/physics.json')),raw.physicsSha256);
  const inputBytes=readFileSync(raw.input.path);assert.equal(hash(inputBytes),raw.input.sha256);
  const reference=JSON.parse(inputBytes),recipe=structuredClone(raw.recipe),calculation=browserMotion(recipe,factor);
  for(let i=0;i<raw.config.warmupSteps;i++) {
    const a=calculation.step();assert.deepEqual(Array.from(calculation.motion.pos),reference.expected[i].positionsM);
    for(const [k,v] of Object.entries(reference.expected[i].audit))if(k.endsWith('J'))assert.equal(a[k],v);
  }
  assert.deepEqual(Array.from(calculation.motion.pos),raw.initial.positionsM);
  assert.deepEqual(Array.from(calculation.motion.prev),raw.initial.previousM);assert.equal(calculation.motion.prevDt,raw.initial.prevDt);
  recipe.hS=raw.config.hS;
  for(const expected of raw.steps) {
    const a=calculation.step([{node:raw.command.node,positionM:expected.positionM}]);
    assert.deepEqual(Array.from(calculation.motion.pos),expected.positionsM);
    assert.deepEqual(Array.from(a.supportForceN),expected.supportForceN);
    assert.deepEqual(Array.from(calculation.forceN),expected.appliedForceN);
    const scalar=Object.fromEntries(Object.entries(a).filter(([k])=>!['constraintForce','hardForce','prediction','supportForceN'].includes(k)));
    assert.deepEqual(scalar,expected.audit);
  }
  result.legacy.push({path,sha256:hash(bytes),revision:raw.revision,warmupSteps:raw.config.warmupSteps,
    liveSteps:raw.steps.length,exactPositions:true,exactReactions:true,exactAudits:true});
}

result.verification={maxBodyResidualN,maxWorkCancellationJ,maxDiscreteBalanceJ,maxEnergyLimitRatio,maxBalanceIdentityErrorJ};
if(output) {
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const sourcePaths=['tests/cloth-body-coupling.test.mjs','tests/lib/cloth-energy-motion.mjs',
    'tests/lib/cloth-implicit-motion.mjs','tests/lib/cloth-linear-solve.mjs','tests/lib/cloth-kkt-direction.mjs',
    'tests/lib/cloth-sparse-solve.mjs','tests/cloth-compliance.mjs','tests/lib/cloth-sparse-wasm.mjs',
    'tests/lib/cloth-material.mjs','tests/lib/cloth-browser-motion.mjs','tests/lib/cloth-shared-input.mjs'];
  writeFileSync(output,JSON.stringify({schema:1,createdAt:new Date().toISOString(),
    revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
    sourceSha256:Object.fromEntries(sourcePaths.map(p=>[p,hash(readFileSync(p))])),
    wasm:wasm?{path:wasm,sha256:hash(readFileSync(wasm))}:null,linearBackend:backend,tolerances:IMPLICIT_TOLERANCES,
    scope:'Известные массы, один общий подшаг в инерциальных осях. Опора движется поступательно, вращение удерживается внешней направляющей. Это не полный парус, свободная лодка или G4.',result},null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({проверка:'двусторонняя поступательная связь опоры и ткани',способ:backend,
  linear:result.linear,refinement:result.refinement,impact:result.impact,laggedControl:result.laggedControl,
  material:result.material,legacy:result.legacy,verification:result.verification,output},null,2));
