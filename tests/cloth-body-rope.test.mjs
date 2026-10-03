// Управляемая верёвка: известные две массы, свободное вращение и отказ команды.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FluidBodyEnergyMotion} from './lib/cloth-fluid-body-motion.mjs';
import {fluidInertia} from './lib/cloth-fluid-inertia.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';

const args=process.argv.slice(2),wasmPath=args.find(a=>a.startsWith('--wasm='))?.slice(7),
  output=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(wasmPath&&args.every(v=>/^--(wasm|out)=.+$/.test(v))&&new Set(args.map(v=>v.split('=')[0])).size===args.length);
const bytes=readFileSync(wasmPath),factor=await loadSparseFactor(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
const root=fileURLToPath(new URL('../',import.meta.url)),sourceSha256={};
function source(url) {
  const name=relative(root,fileURLToPath(url));if(Object.hasOwn(sourceSha256,name))return;
  const b=readFileSync(url);sourceSha256[name]=hash(b);
  for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))source(new URL(m[1],url));
}
source(new URL(import.meta.url));
const report={schema:'cloth-body-rope-v1',date:new Date().toISOString(),runtime:process.version,
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,
  wasm:{path:wasmPath,sha256:hash(bytes)},acceptedSteps:0,straightCases:[],rotation:[],rejectedControls:0,
  maxima:{forceN:0,lengthM:0,workRatio:0,interfaceRatio:0,controlRatio:0,knownPositionErrorM:0,knownTensionErrorN:0}};
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack,audit:e.audit};
  if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.error(`Проверка верёвки остановлена: ${e.message}`);process.exitCode=1;});
const I9=[1,0,0,0,1,0,0,0,1],add=(a,b)=>a.map((v,d)=>v+b[d]),sub=(a,b)=>a.map((v,d)=>v-b[d]),scale=(a,k)=>a.map(v=>v*k);
const dot=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const rotate=(R,v)=>[0,1,2].map(d=>dot(R.slice(3*d,3*d+3),v)),transpose=R=>[0,3,6,1,4,7,2,5,8].map(i=>R[i]);
const near=(a,b,t=1e-9)=>assert(Math.abs(a-b)<=t*Math.max(1,Math.abs(b)),`${a} ≠ ${b}`);
const vector=(a,b,t)=>{assert.equal(a.length,b.length);a.forEach((v,d)=>near(v,b[d],t));};
const diagonal=values=>Array.from({length:36},(_,i)=>i%7===0?values[i/7]:0);
const load=(n,cloth,F=[0,0,0],T=[0,0,0],length)=>({frame:'inertial-cartesian-cg',clothForceN:cloth??new Array(3*n).fill(0),forceN:F,momentNm:T,
  ...(length==null?{}:{ropeLengthsM:[length]})});
function make(backend,inertia,{positions,mass,attachments=[],origin=[0,0,0],R=I9,nu=[0,0,0,0,0,0],velocity,ropes}) {
  return new FluidBodyEnergyMotion({positions,mass,constraints:[],ropes,velocityMS:velocity,dampingHz:0,
    linearBackend:backend,wasmSparseFactor:factor,
    body:{inertia,originM:origin,orientation9:R,velocity6:nu,attachments,frame:'body-cg'}});
}
function step(m,f,h) {
  const initialEndpoint=add(m.body.originM,rotate(m.body.orientation9,m.ropes[0].localM));
  const a=m.step(f,h),t=m.tolerances,r=a.ropes[0],max=report.maxima;
  assert(a.maxPhysicalResidualN<=t.forceToleranceN&&a.maxHardViolationM<=t.lengthToleranceM);
  assert(a.dualViolationN<=t.dualToleranceN&&a.complementarityJ<=t.complementarityToleranceJ);
  assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ&&Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
  near(a.discreteBalanceResidualJ,a.residualIdentityJ,1e-10);
  assert(Math.abs(r.controlResidualJ)<=r.controlLimitJ&&r.tensionN>=-t.dualToleranceN);
  assert(r.engagementLossJ>=-t.dualToleranceN&&r.turnLossJ>=-t.dualToleranceN);
  vector(r.bodyForceN,r.clothForceN.map(v=>-v),1e-12);
  near(r.bodyWorkJ,dot(r.bodyForceN,sub(add(m.body.originM,rotate(m.body.orientation9,r.localM)),initialEndpoint)),1e-10);
  max.forceN=Math.max(max.forceN,a.maxPhysicalResidualN);max.lengthM=Math.max(max.lengthM,a.maxHardViolationM);
  max.workRatio=Math.max(max.workRatio,Math.abs(a.discreteBalanceResidualJ)/a.workLimitJ);
  max.interfaceRatio=Math.max(max.interfaceRatio,Math.abs(a.bodyWorkCancellationResidualJ)/a.interfaceWorkLimitJ);
  max.controlRatio=Math.max(max.controlRatio,Math.abs(r.controlResidualJ)/r.controlLimitJ);
  report.acceptedSteps++;return a;
}
const dry=fluidInertia({dryMassKg:10,dryPrincipalInertiaKgM2:[2,3,4]}),
  wet=fluidInertia({dryMassKg:10,dryPrincipalInertiaKgM2:[2,3,4],addedMass6:diagonal([1,2,3,1,25,2])});
const straightDuration=.8;
const lengthAt=t=>t<=.1?1+.4*t:t<=.2?1.04:t<=.3?1.04-.4*(t-.2):t<=.7?1:1+.4*(t-.7);
// Независимый ответ вдоль прямой: две массы и одностороннее равенство.
// Инерция прикреплённого узла учитывается один раз, без фиктивной массы конца верёвки.
for(const backend of ['reference-dense','schur-wasm'])for(const inertia of [dry,wet])for(const pinned of [false,true])
for(const side of [-1,1])for(let axis=0;axis<3;axis++)for(const hz of [60,120,240]) {
  const e=[0,0,0];e[axis]=side;const origin=[3,-2,1],local=scale(e,.3),initial=add(origin,scale(e,1.3));
  const A=inertia.matrix6[7*axis]+(pinned?3:0),B=2,F=5,Fbody=2,h=1/hz,node=pinned?1:0;
  const positions=pinned?[...origin,...initial]:initial,mass=pinned?[3,B]:[B];
  const velocity=pinned?[...scale(e,.15),...scale(e,.05)]:scale(e,.05);
  const m=make(backend,inertia,{positions,mass,attachments:pinned?[0]:[],origin,nu:[...scale(e,.15),0,0,0],velocity,
    ropes:[{node,localM:local,lengthM:1}]});
  let q0=0,q1=1.3,v0=.15,v1=.05,L=1,slack=0,taut=0,maxError=0,peakTensionN=0,haulWorkJ=0;
  const phaseCounts=Array.from({length:5},()=>({slack:0,taut:0}));
  for(let i=1;i<=Math.round(hz*straightDuration);i++) {
    const newL=lengthAt(i*h),bodyPred=q0+h*v0+h*h*Fbody/A,clothPred=q1+h*v1+h*h*F/B;
    const tension=Math.max(0,(clothPred-bodyPred-.3-newL)/(h*h*(1/A+1/B)));
    // Локальная проверка реакции использует только вход шага и закрытую
    // формулу двух масс, чтобы не умножать старую ошибку скорости на 1/h.
    const bOld=dot(sub(m.body.originM,origin),e),cOld=dot(sub(Array.from(m.pos.slice(3*node,3*node+3)),origin),e);
    const bPred=bOld+h*dot(m.body.velocity6.slice(0,3),e)+h*h*Fbody/A;
    const cPred=cOld+h*dot(Array.from(m.vel.slice(3*node,3*node+3)),e)+h*h*F/B;
    const localT=Math.max(0,(cPred-bPred-.3-newL)/(h*h*(1/A+1/B)));
    const localBody=bPred+h*h*localT/A,localCloth=cPred-h*h*localT/B;
    const tensionLimitN=2*m.tolerances.forceToleranceN+2*m.tolerances.lengthToleranceM/(h*h*(1/A+1/B));
    const oldQ0=q0,oldQ1=q1;q0=bodyPred+h*h*tension/A;q1=clothPred-h*h*tension/B;
    v0=(q0-oldQ0)/h;v1=(q1-oldQ1)/h;
    const f=pinned?[0,0,0,...scale(e,F)]:scale(e,F),a=step(m,load(mass.length,f,scale(e,Fbody),[0,0,0],newL),h),r=a.ropes[0];
    vector(m.body.originM,add(origin,scale(e,q0)),2e-9);
    vector(Array.from(m.pos.slice(3*node,3*node+3)),add(origin,scale(e,q1)),2e-9);
    vector(m.body.velocity6,[...scale(e,v0),0,0,0],2e-8);vector(m.body.orientation9,I9,1e-10);
    assert(Math.abs(r.tensionN-localT)<=tensionLimitN,'Реакция не ограничена прежними допусками сил/длины');
    assert(Math.abs(r.controlWorkJ+localT*(newL-L))<=tensionLimitN*Math.abs(newL-L)+1e-12);
    const expectedWork=-localT*((localCloth-localBody)-(cOld-bOld));
    assert(Math.abs(r.actualWorkJ-expectedWork)<=tensionLimitN*Math.abs((localCloth-localBody)-(cOld-bOld))+
      4*Math.abs(localT)*m.tolerances.lengthToleranceM+1e-12);
    vector(r.bodyMomentNm,[0,0,0],1e-10);
    const err=Math.abs(r.tensionN-tension);maxError=Math.max(maxError,err);
    peakTensionN=Math.max(peakTensionN,r.tensionN);if(newL<L)haulWorkJ+=r.controlWorkJ;
    report.maxima.knownTensionErrorN=Math.max(report.maxima.knownTensionErrorN,err);
    report.maxima.knownPositionErrorM=Math.max(report.maxima.knownPositionErrorM,
      ...m.body.originM.map((v,d)=>Math.abs(v-(origin[d]+e[d]*q0))));
    const time=i*h,phase=time<=.1?0:time<=.2?1:time<=.3?2:time<=.7?3:4;
    if(tension>1e-6){taut++;phaseCounts[phase].taut++;}else {slack++;phaseCounts[phase].slack++;near(r.tensionN,0,1e-8);}
    L=newL;
  }
  assert(slack>0&&taut>0,'Опыт должен содержать провисание и натяжение');
  assert(phaseCounts[0].slack>0&&phaseCounts[2].taut>0&&phaseCounts[3].taut>0&&phaseCounts[3].slack>0&&phaseCounts[4].slack>0&&haulWorkJ>0);
  report.straightCases.push({backend,wet:inertia===wet,pinned,side,axis,hz,slack,taut,phaseCounts,
    peakTensionN,haulWorkJ,maxTensionErrorN:maxError});
}

// Медленное отпускание нагруженной верёвки совершает отрицательную работу.
// Встречная сила внутрь паруса освобождает верёвку, она не толкает узел.
for(const backend of ['reference-dense','schur-wasm'])for(const side of [-1,1])for(const h of [1/60,1/120,1/240])
for(const inward of [false,true]) {
  const v=inward?0:.4,F=inward?-5:0,newL=inward?1:1+.01*h,A=10,B=2;
  const m=make(backend,dry,{positions:[side,0,0],mass:[B],velocity:[side*v,0,0],
    ropes:[{node:0,localM:[0,0,0],lengthM:1}]});
  const T=Math.max(0,(1+h*v+h*h*F/B-newL)/(h*h*(1/A+1/B)));
  const a=step(m,load(1,[side*F,0,0],[0,0,0],[0,0,0],newL),h),r=a.ropes[0];
  near(r.tensionN,T,1e-7);near(r.controlWorkJ,-T*(newL-1),1e-9);
  if(inward){assert.equal(r.tensionN,0);assert(r.slackM>0);}else {assert(r.tensionN>0&&r.controlWorkJ<0);}
}
for(const backend of ['reference-dense','schur-wasm']) {
  const m=make(backend,dry,{positions:[0,0,0],mass:[2],ropes:[{node:0,localM:[0,0,0],lengthM:1}]});
  assert.equal(step(m,load(1,[1,0,0]),1/60).ropes[0].tensionN,0);
}

// Независимая непрерывная задача: сферическое тело в мировых осях,
// точечная масса и постоянно натянутая верёвка. RK4 не использует общий
// решатель, его поворот Кэли, градиенты связей или численные направления.
const totalMass=12,totalI=7,clothMass=2.5,L=1.2,duration=.5;
const spherical=fluidInertia({dryMassKg:10,dryPrincipalInertiaKgM2:[4,4,4],addedMass6:diagonal([2,2,2,3,3,3])});
const baseR=[Math.cos(.45),-Math.sin(.45),0,Math.sin(.45),Math.cos(.45),0,0,0,1],baseLocal=[.4,.25,-.15];
const unit=scale([.7,.65,.3],1/Math.hypot(.7,.65,.3)),baseOrigin=[1,-2,.5],baseV=[.1,.02,-.03],baseW=[.12,-.05,.2];
const baseLever=rotate(baseR,baseLocal),baseQ=add(add(baseOrigin,baseLever),scale(unit,L));
const baseClothV=add(add(baseV,cross(baseW,baseLever)),scale(cross(unit,[0,0,1]),.15));
const baseF=add(scale(unit,5),[0,.6,-.2]),baseFB=[.5,-.3,.2],baseTB=[.1,.08,-.04];
const solutions=new Map(),mirrors=new Map();
for(const side of [1,-1]) {
  const P=[1,side,1],polar=a=>a.map((v,d)=>v*P[d]),axial=a=>polar(a).map(v=>v*side);
  const R=baseR.map((v,k)=>v*P[Math.floor(k/3)]*P[k%3]),local=polar(baseLocal),F=polar(baseF),FB=polar(baseFB),TB=axial(baseTB);
  const initial=[...polar(baseQ),...polar(baseClothV),...polar(baseOrigin),...polar(baseV),...R,...axial(baseW)];
  function rhs(y) {
    const q=y.slice(0,3),v=y.slice(3,6),o=y.slice(6,9),V=y.slice(9,12),R=y.slice(12,21),w=y.slice(21,24);
    const lever=rotate(R,local),relative=sub(q,add(o,lever)),d=Math.hypot(...relative),u=scale(relative,1/d);
    const vr=sub(sub(v,V),cross(w,lever)),transverse2=Math.max(0,dot(vr,vr)-dot(vr,u)**2);
    const rCrossU=cross(lever,u),den=1/clothMass+1/totalMass+dot(rCrossU,rCrossU)/totalI;
    const freeRelative=sub(sub(sub(scale(F,1/clothMass),scale(FB,1/totalMass)),cross(scale(TB,1/totalI),lever)),cross(w,cross(w,lever)));
    const T=(dot(u,freeRelative)+transverse2/d)/den;assert(T>0,'Контроль RK4 должен оставаться натянутым');
    const clothAcc=scale(sub(F,scale(u,T)),1/clothMass),bodyAcc=scale(add(FB,scale(u,T)),1/totalMass);
    const angularAcc=scale(add(TB,scale(rCrossU,T)),1/totalI),dR=new Array(9);
    for(let col=0;col<3;col++){const a=cross(w,[R[col],R[3+col],R[6+col]]);for(let row=0;row<3;row++)dR[3*row+col]=a[row];}
    return [...v,...clothAcc,...V,...bodyAcc,...dR,...angularAcc];
  }
  function rk4(h) {
    let y=initial.slice();for(let i=0;i<Math.round(duration/h);i++) {
      const a=rhs(y),b=rhs(add(y,scale(a,h/2))),c=rhs(add(y,scale(b,h/2))),d=rhs(add(y,scale(c,h)));
      y=y.map((v,k)=>v+h*(a[k]+2*b[k]+2*c[k]+d[k])/6);
    }return y;
  }
  const reference=rk4(1/7680),referenceCoarser=rk4(1/3840);
  const rkError=Math.max(...sub(reference,referenceCoarser).map(Math.abs));assert(rkError<1e-9);
  const referenceDistance=Math.hypot(...sub(reference.slice(0,3),add(reference.slice(6,9),rotate(reference.slice(12,21),local))));
  near(referenceDistance,L,1e-10);
  for(const backend of ['reference-dense','schur-wasm']) {
    const errors=[];
    for(const hz of [60,120,240]) {
      const bodyNu=[...rotate(transpose(R),polar(baseV)),...rotate(transpose(R),axial(baseW))];
      const m=make(backend,spherical,{positions:polar(baseQ),mass:[clothMass],origin:polar(baseOrigin),R,nu:bodyNu,
        velocity:polar(baseClothV),ropes:[{node:0,localM:local,lengthM:L}]});
      let maxT=0,minT=Infinity,maxTorque=0;
      for(let j=0;j<hz*duration;j++) {
        const a=step(m,load(1,F,FB,TB),1/hz),r=a.ropes[0];
        assert(r.tensionN>0);maxT=Math.max(maxT,r.tensionN);minT=Math.min(minT,r.tensionN);maxTorque=Math.max(maxTorque,Math.hypot(...r.bodyMomentNm));
        const lever=rotate(a.bodyRotation9,local),u=scale(sub(Array.from(m.pos),add(a.bodyOriginM,lever)),1/r.distanceM);
        vector(r.bodyForceN,scale(u,r.tensionN),1e-10);
        // Момент и работа измеряются из двух фактических положений точки.
        // Усреднённое плечо известно из их полусуммы, без helper Кэли.
        const oldR=m.previousMeasuredRotation??R;
        const averageLever=scale(add(rotate(oldR,local),lever),.5);
        vector(r.bodyMomentNm,cross(averageLever,r.bodyForceN),1e-10);
        m.previousMeasuredRotation=a.bodyRotation9.slice();
      }
      assert(maxTorque>.1,'Крепление должно давать ненулевой момент');
      const final=[...m.pos,...m.vel,...m.body.originM,...rotate(m.body.orientation9,m.body.velocity6.slice(0,3)),
        ...m.body.orientation9,...rotate(m.body.orientation9,m.body.velocity6.slice(3))];
      const maximum=(start,end)=>Math.max(...sub(final.slice(start,end),reference.slice(start,end)).map(Math.abs));
      const error={positionM:Math.max(maximum(0,3),maximum(6,9)),velocityMS:Math.max(maximum(3,6),maximum(9,12)),
        rotationElement:maximum(12,21),angularVelocityRadS:maximum(21,24)};errors.push(error);
      const key=`${side}:${hz}`;if(backend==='reference-dense')solutions.set(key,final);else vector(final,solutions.get(key),2e-7);
      const mirrorKey=`${backend}:${hz}`;
      if(side===1)mirrors.set(mirrorKey,final);else {
        const other=mirrors.get(mirrorKey),expected=[...polar(other.slice(0,3)),...polar(other.slice(3,6)),
          ...polar(other.slice(6,9)),...polar(other.slice(9,12)),
          ...other.slice(12,21).map((v,k)=>v*P[Math.floor(k/3)]*P[k%3]),...axial(other.slice(21,24))];
        vector(final,expected,1e-10);
      }
      report.rotation.push({backend,side,hz,error,rk4Difference:rkError,minTensionN:minT,maxTensionN:maxT,maxMomentNm:maxTorque});
    }
    for(const component of Object.keys(errors[0]))assert(errors[1][component]<errors[0][component]&&errors[2][component]<errors[1][component],
      `Ответ ${component} должен приближаться к независимому непрерывному решению`);
  }
}

const snapshot=m=>({positions:Array.from(m.pos),velocity:Array.from(m.vel),body:structuredClone(m.body),
  lengths:Array.from(m.ropeLengthsM),reactions:Array.from(m.lastMu),lambdas:m.constraints.map(c=>c.lambda)});
const simple=()=>make('schur-wasm',dry,{positions:[1,0,0],mass:[2],ropes:[{node:0,localM:[0,0,0],lengthM:1}]});
for(const lengths of [[0],[-1],[NaN],[Infinity],[],[1,2]]) {
  const m=simple(),before=snapshot(m);
  assert.throws(()=>m.step({...load(1,[5,0,0]),ropeLengthsM:lengths},1/60),/Некорректная/);
  assert.deepEqual(snapshot(m),before);report.rejectedControls++;
}
for(const r of [{node:-1,localM:[0,0,0],lengthM:1},{node:1,localM:[0,0,0],lengthM:1},
  {node:0,localM:[0,NaN,0],lengthM:1},{node:0,localM:[0,0,0],lengthM:0}]) {
  assert.throws(()=>make('schur-wasm',dry,{positions:[1,0,0],mass:[2],ropes:[r]}),/Некорректная верёвка/);report.rejectedControls++;
}
{
  const m=simple(),before=snapshot(m),direction=m.direction;
  m.direction=()=>{const e=new Error('Отказ направления');e.code='CLOTH_SPARSE_FACTOR_REJECTED';throw e;};
  assert.throws(()=>m.step(load(1,[5,0,0],[0,0,0],[0,0,0],.99),1/60),/Отказ направления/);
  assert.deepEqual(snapshot(m),before);m.direction=direction;
  const a=step(m,load(1,[5,0,0],[0,0,0],[0,0,0],.99),1/60);
  near(a.ropes[0].oldLengthM,1);near(m.ropeLengthsM[0],.99);report.rejectedControls++;
}
for(const kind of ['control','balance','interface']) {
  const m=simple(),before=snapshot(m),audit=m.audit;
  m.audit=function(...args){const a=audit.apply(this,args);
    if(kind==='control')a.ropes[0].controlResidualJ=2*a.ropes[0].controlLimitJ;
    else if(kind==='balance')a.discreteBalanceResidualJ=2*a.workLimitJ;
    else a.bodyWorkCancellationResidualJ=2*a.interfaceWorkLimitJ;
    return a;};
  assert.throws(()=>m.step(load(1,[5,0,0],[0,0,0],[0,0,0],.99),1/60),/баланс работы/);
  assert.deepEqual(snapshot(m),before);report.rejectedControls++;
}
{
  const m=simple();m.pos[0]=1.1;const before=snapshot(m);
  assert.throws(()=>m.step(load(1,[0,0,0]),1/60),/переставлена/);
  assert.deepEqual(snapshot(m),before);report.rejectedControls++;
}
report.phase='complete';if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Верёвка: ${report.acceptedSteps} принятых шагов, ${report.straightCases.length} известных прямолинейных опытов, ${report.rotation.length} вращательных, ${report.rejectedControls} отказов с сохранением состояния — пройдены.`);
console.log(JSON.stringify({максимумы:report.maxima,вращение:report.rotation}));
