// Свободное вращение и общая работа: независимые массы, повороты и ткань.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fourPointBody,RigidBodyEnergyMotion,rigidBodyProperties} from './lib/cloth-rigid-body-motion.mjs';
import {IMPLICIT_TOLERANCES} from './lib/cloth-implicit-motion.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {distance} from './cloth-compliance.mjs';
import {materialSurface} from './lib/cloth-material.mjs';

const args=process.argv.slice(2),backend=args.find(a=>a.startsWith('--linear-backend='))?.slice(17)??'band-js';
const wasm=args.find(a=>a.startsWith('--wasm='))?.slice(7),output=args.find(a=>a.startsWith('--out='))?.slice(6);
const unscaledAngularControl=args.includes('--unscaled-angular-control');
assert(args.every(a=>/^--(linear-backend|wasm|out)=.+$/.test(a)||a==='--unscaled-angular-control')&&new Set(args.map(a=>a.split('=')[0])).size===args.length&&
  ['band-js','sparse-js','sparse-wasm','kkt-wasm'].includes(backend));
assert(!backend.endsWith('wasm')||wasm,'Нужен --wasm=модуль');assert(!output||!existsSync(output),'Запись нельзя перезаписывать');
const options={linearBackend:backend,wasmSparseFactor:wasm?await loadSparseFactor(readFileSync(wasm)):undefined};
const close=(a,b,tol=2e-9)=>assert(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const vector=(a,b,tol)=>a.forEach((v,d)=>close(v,b[d],tol));
const add=(a,b)=>a.map((v,d)=>v+b[d]),sub=(a,b)=>a.map((v,d)=>v-b[d]),scale=(a,s)=>a.map(v=>v*s);
const dot=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const point=(p,i)=>Array.from(p.slice(3*i,3*i+3));
const vel=(m,i,h)=>scale(sub(point(m.pos,i),point(m.prev,i)),1/h);
const nodes=[0,1,2,3],bodyOption=(attachments=[])=>({nodes:nodes.slice(),attachments,frame:'inertial-cartesian'});
const rotate=(v,axis,angle)=>add(add(scale(v,Math.cos(angle)),scale(cross(axis,v),Math.sin(angle))),scale(axis,dot(axis,v)*(1-Math.cos(angle))));
const rotation=(axis,angle)=>[0,1,2].map(i=>rotate([0,0,0].map((_,d)=>i===d?1:0),axis,angle))
  .flatMap((_,r)=>[0,1,2].map(c=>rotate([0,0,0].map((_,d)=>c===d?1:0),axis,angle)[r]));
const result={properties:[],translation:[],wrench:[],spin:[],asymmetricSpin:[],offCentre:[],board:[],material:[]};
const maxima={forceResidualN:0,hardViolationM:0,bodyBalanceN:0,workCancellationJ:0,balanceIdentityJ:0,
  energyLimitRatio:0,linearImpulseErrorNs:0,angularBalanceErrorNms:0};

function check(a,m,old,oldV,force) {
  assert(a.solver.converged);assert.equal(a.bodyFrame,'inertial-cartesian');
  assert(a.maxPhysicalResidualN<=IMPLICIT_TOLERANCES.forceToleranceN);
  assert(a.maxHardViolationM<=IMPLICIT_TOLERANCES.lengthToleranceM);
  assert(a.solver.complementarityJ<=IMPLICIT_TOLERANCES.complementarityToleranceJ);
  assert(!Object.hasOwn(a,'bodyLockMomentNm'),'Свободное тело не имеет удерживающей направляющей');
  const state=m.state(a.prediction,a.hS,m.hard.map(c=>-c.lambda/a.hS**2));
  let identity=0,displacementSum=0;
  for(let j=0;j<m.free.length;j++) {const k=m.free[j],delta=m.pos[k]-old[k];identity+=state.residual[j]*delta;displacementSum+=Math.abs(delta);}
  const energyScale=['initialKineticJ','kineticJ','initialSoftEnergyJ','softEnergyJ','appliedWorkJ','dampingWorkJ',
    'hardWorkEstimateJ','supportWorkJ','inertiaIncrementJ','materialIncrementJ'].reduce((s,k)=>s+Math.abs(a[k]),0);
  const energyLimit=IMPLICIT_TOLERANCES.forceToleranceN*displacementSum+16*m.pos.length*Number.EPSILON*energyScale;
  close(a.discreteBalanceResidualJ,identity,1e-9);
  assert(Math.abs(a.discreteBalanceResidualJ)<=energyLimit,'Работа превышает прежний силовой допуск');
  const bodyIndices=m.rigidBody.nodes;
  for(const i of bodyIndices)for(let d=0;d<3;d++) {
    const weightSum=m.rigidBody.bindings.reduce((s,b)=>s+Math.abs(b.weights.find(([node])=>node===i)[1]),0);
    assert(Math.abs(a.bodyNodeBalanceResidualN[3*i+d])<=(1+weightSum)*IMPLICIT_TOLERANCES.forceToleranceN+1e-9);
  }
  let workBound=0;
  for(const {node} of m.rigidBody.bindings)workBound+=2*IMPLICIT_TOLERANCES.lengthToleranceM*
    point(a.bodyAttachmentForceN,node).reduce((s,v)=>s+Math.abs(v),0);
  assert(Math.abs(a.bodyWorkCancellationResidualJ)<=workBound+1e-9,'Не сходится встречная работа');
  const bodyTorque=[0,0,0];
  for(const i of bodyIndices)cross(sub(point(m.pos,i),a.bodyOriginM),point(a.bodyNodeInterfaceForceN,i))
    .forEach((v,d)=>{bodyTorque[d]+=v;});
  vector(a.bodyMomentNm,bodyTorque);
  // Проверка всех физических масс не пользуется измерителем реакции тела.
  const h=a.hS,pResidual=[0,0,0],lResidual=[0,0,0];let leverSum=0,linearConstraintForce=0;
  for(const c of m.geometryConstraints)if(c.family!=='жёсткое тело')
    linearConstraintForce+=Math.abs(c.lambda/(h*h))*c.value(m.pos).grad.reduce((s,[,g])=>s+g.reduce((q,v)=>q+Math.abs(v),0),0);
  for(let i=0;i<m.mass.length;i++) {
    const p=point(m.pos,i),p0=point(old,i),v=vel(m,i,h),dv=sub(v,oldV[i]),dp=scale(dv,m.mass[i]);
    const damping=scale(oldV[i],m.mass[i]*(m.decayAtNode(i,h,Math.exp(-m.dampingHz*h))-1)/h);
    const f=add(point(force,i),damping),torque=cross(p,f);
    const deltaL=sub(cross(p,scale(v,m.mass[i])),cross(p0,scale(oldV[i],m.mass[i])));
    const increment=cross(sub(p,p0),dp);leverSum+=p.reduce((s,x)=>s+Math.abs(x),0);
    for(let d=0;d<3;d++){pResidual[d]+=dp[d]-h*f[d];lResidual[d]+=deltaL[d]+increment[d]-h*torque[d];}
  }
  const pLimit=m.mass.length*IMPLICIT_TOLERANCES.forceToleranceN*h+1e-9;
  const lLimit=h*(IMPLICIT_TOLERANCES.forceToleranceN*leverSum+IMPLICIT_TOLERANCES.lengthToleranceM*linearConstraintForce)+1e-9;
  pResidual.forEach(v=>assert(Math.abs(v)<=pLimit,'Общий импульс не ограничен силовым остатком'));
  lResidual.forEach(v=>assert(Math.abs(v)<=lLimit,'Общий момент не ограничен прежними силами/длиной'));
  maxima.forceResidualN=Math.max(maxima.forceResidualN,a.maxPhysicalResidualN);maxima.hardViolationM=Math.max(maxima.hardViolationM,a.maxHardViolationM);
  maxima.bodyBalanceN=Math.max(maxima.bodyBalanceN,...a.bodyBalanceResidualN.map(Math.abs));
  maxima.workCancellationJ=Math.max(maxima.workCancellationJ,Math.abs(a.bodyWorkCancellationResidualJ));
  maxima.balanceIdentityJ=Math.max(maxima.balanceIdentityJ,Math.abs(a.discreteBalanceResidualJ-identity));
  maxima.energyLimitRatio=Math.max(maxima.energyLimitRatio,energyLimit?Math.abs(a.discreteBalanceResidualJ)/energyLimit:0);
  maxima.linearImpulseErrorNs=Math.max(maxima.linearImpulseErrorNs,Math.hypot(...pResidual));
  maxima.angularBalanceErrorNms=Math.max(maxima.angularBalanceErrorNms,Math.hypot(...lResidual));
}
function step(m,force,h,passes=80) {
  const old=m.pos.slice(),oldDt=m.prevDt||h,oldV=Array.from(m.mass,(_,i)=>m.prevDt?vel(m,i,oldDt):[0,0,0]);
  const a=m.step(force,h,passes);check(a,m,old,oldV,force);return a;
}
function make(points,mass,attachments=[],constraints=[],extra={}) {
  return new RigidBodyEnergyMotion({positions:points,mass,rigidBody:bodyOption(attachments),constraints,dampingHz:0,...extra,...options});
}

// Прямая независимая сверка полного тензора и кинетической энергии, включая
// перенос/поворот главных осей и все три компоненты углового импульса.
for(const inertia of [[2,2,2],[2,3,4]])for(const M of [10,50])for(const angle of [0,.7]) {
  const axis=[1,2,3].map(v=>v/Math.sqrt(14)),R=rotation(axis,angle),origin=[3,-2,1];
  const body=fourPointBody({massKg:M,principalInertiaKgM2:inertia,originM:origin,orientation:R});
  const h=1/120,V=[.3,-.2,.1],omega=[.4,-.3,.2],previous=body.positionsM.slice();let kinetic=0;
  for(let i=0;i<4;i++) {
    const v=add(V,cross(omega,sub(point(body.positionsM,i),origin)));kinetic+=.5*body.massKg[i]*dot(v,v);
    for(let d=0;d<3;d++)previous[3*i+d]-=h*v[d];
  }
  const prop=rigidBodyProperties(body.positionsM,body.massKg,nodes,previous,h);
  const I=Array.from({length:9},(_,i)=>[0,1,2].reduce((s,k)=>s+R[3*Math.floor(i/3)+k]*inertia[k]*R[3*(i%3)+k],0));
  const L=[0,1,2].map(d=>dot(I.slice(3*d,3*d+3),omega));
  vector(prop.originM,origin);vector(prop.velocityMS,V);vector(prop.inertiaKgM2,I);vector(prop.angularMomentumNms,L);
  close(prop.totalMassKg,M);close(kinetic,.5*M*dot(V,V)+.5*dot(omega,L));
  result.properties.push({massKg:M,principalInertiaKgM2:inertia,angle,inertiaErrorKgM2:Math.max(...I.map((v,i)=>Math.abs(v-prop.inertiaKgM2[i])))});
}

// Центр ткани прикреплён к ЦТ: независимый общий поступательный ответ.
for(const hz of [60,120,240])for(const side of [-1,1])for(const damp of [false,true]) {
  const h=1/hz,origin=[3,-2,1],body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2],originM:origin});
  const m=make([...body.positionsM,...origin],[...body.massKg,2],[4],[],
    {dampingHz:damp?6:0,rigidBody:{...bodyOption([4]),dampingHz:damp?.7:0}});
  let x=origin.slice(),v=[side*.3,-.2,.1];m.prevDt=h;for(let i=0;i<5;i++)for(let d=0;d<3;d++)m.prev[3*i+d]-=h*v[d];
  const fBody=[side,-2,3],fCloth=[side*5,1,-.2*9.81],forces=[...Array.from({length:4},()=>scale(fBody,.25)).flat(),...fCloth];
  let errorM=0;
  for(let n=0;n<hz/4;n++) {
    const damping=scale(v,(10*(Math.exp(-(damp?.7:0)*h)-1)+2*(Math.exp(-(damp?6:0)*h)-1))/h);
    const nextV=add(v,scale(add(add(fBody,fCloth),damping),h/12)),nextX=add(x,scale(nextV,h));
    const reaction=sub(sub(scale(sub(nextV,v),2/h),fCloth),scale(v,2*(Math.exp(-(damp?6:0)*h)-1)/h));
    const a=step(m,forces,h);vector(a.bodyOriginM,nextX);vector(point(a.bodyAttachmentForceN,4),reaction);
    vector(a.bodyForceN,scale(reaction,-1));vector(a.bodyMomentNm,[0,0,0]);
    errorM=Math.max(errorM,...nextX.map((v,d)=>Math.abs(v-a.bodyOriginM[d])));x=nextX;v=nextV;
  }
  result.translation.push({hz,side,damping:damp,maxPositionErrorM:errorM});
}

// Известный первый свободный поворот из покоя сферического тела:
// Fi=mi(a+alpha×ri), угол atan(h²|alpha|), ЦТ сдвигается на h²a.
for(const hz of [60,120,240])for(const axis of [[1,0,0],[0,-1,0],[1,2,3].map(v=>v/Math.sqrt(14))]) {
  const h=1/hz,origin=[3,-2,1],body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2],originM:origin});
  const m=make(body.positionsM,body.massKg),acc=[.2,-.3,.1],alpha=scale(axis,4),angle=Math.atan(4*h*h);
  const forces=nodes.flatMap(i=>scale(add(acc,cross(alpha,sub(point(body.positionsM,i),origin))),body.massKg[i]));
  const expected=nodes.flatMap(i=>add(add(origin,scale(acc,h*h)),rotate(sub(point(body.positionsM,i),origin),axis,angle)));
  const a=step(m,forces,h);vector(m.pos,expected);vector(a.bodyOriginM,add(origin,scale(acc,h*h)));
  vector(a.bodyRotationFromReference,rotation(axis,angle));
  vector(a.bodyProperties.angularMomentumNms,scale(axis,2*Math.sin(angle)/h));
  result.wrench.push({hz,axis,angleRad:angle,maxPositionErrorM:Math.max(...expected.map((v,i)=>Math.abs(v-m.pos[i])))});
}

// Свободное вращение имеет известный точный дискретный ответ. Непрерывное
// тело сохраняет скорость 1 рад/с, поэтому отдельно проверяем уточнение h.
for(const axis of [[1,0,0],[0,-1,0],[1,2,3].map(v=>v/Math.sqrt(14))]) {
  let previousError=Infinity;
  for(const hz of [60,120,240]) {
    const h=1/hz,origin=[0,0,0],body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2],originM:origin});
    const m=make(body.positionsM,body.massKg);let phi=Math.asin(h),angle=0;
    m.prevDt=h;m.prev.set(nodes.flatMap(i=>rotate(point(body.positionsM,i),axis,-phi)));
    let maxPositionErrorM=0,firstAngularLossNms=0,maxAngularFormulaErrorNms=0;
    for(let n=0;n<hz;n++) {
      const theta=Math.atan2(Math.sin(phi),2-Math.cos(phi));angle+=theta;
      const a=step(m,new Float64Array(12),h),expected=nodes.flatMap(i=>rotate(point(body.positionsM,i),axis,angle));
      vector(m.pos,expected);
      // L и K содержат скорость из разности двух положений. Их арифметический
      // предел выводится из того же 2e−9 м, а не назначается в единицах позиции.
      // Физический момент/работа по-прежнему ограничены в check прежними силами.
      const positionLimitM=2e-9,radius=Math.sqrt(.3),positionNormError=2*Math.sqrt(3)*positionLimitM;
      const velocityError=2*Math.sqrt(3)*positionLimitM/h,relativeVelocityError=2*velocityError;
      const referenceSpeed=radius*Math.abs(theta)/h;
      const angularLimit=10*(positionNormError*referenceSpeed+(radius+positionNormError)*relativeVelocityError);
      const angularReference=scale(axis,2*Math.sin(theta)/h);
      if(unscaledAngularControl)angularReference.forEach((v,d)=>assert(
        Math.abs(v-a.bodyProperties.angularMomentumNms[d])<=2e-9*Math.max(1,Math.abs(v)),
        `Немасштабированная сверка L: ${hz} Гц, ось ${axis}, шаг ${n+1}, компонент ${d}, `+
        `${a.bodyProperties.angularMomentumNms[d]} против ${v} Н·м·с`));
      angularReference.forEach((v,d)=>assert(Math.abs(v-a.bodyProperties.angularMomentumNms[d])<=angularLimit));
      maxAngularFormulaErrorNms=Math.max(maxAngularFormulaErrorNms,...angularReference.map((v,d)=>Math.abs(v-a.bodyProperties.angularMomentumNms[d])));
      const kineticLimit=10*velocityError*(referenceSpeed+velocityError/2);
      assert(Math.abs(a.kineticJ-2*(1-Math.cos(theta))/(h*h))<=kineticLimit);
      assert(a.kineticJ<=a.initialKineticJ+1e-9);
      maxPositionErrorM=Math.max(maxPositionErrorM,...expected.map((v,i)=>Math.abs(v-m.pos[i])));
      if(n===0)firstAngularLossNms=2*(Math.sin(phi)-Math.sin(theta))/h;
      phi=theta;
    }
    const errorRad=Math.abs(angle-1);assert(errorRad<previousError);previousError=errorRad;
    result.spin.push({hz,axis,angleRad:angle,errorRad,maxPositionErrorM,firstAngularLossNms,maxAngularFormulaErrorNms,
      finalAngularMomentumNms:2*Math.sin(phi)/h});
  }
}

// Независимые уравнения Эйлера и кватерниона для тела с разными главными
// инерциями. RK4 — только эталон теста, он не участвует в движении ткани.
const fromQuaternion=([w,x,y,z])=>[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y),
  2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x),2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)];
const matrixVector=(R,v)=>[0,1,2].map(d=>dot(R.slice(3*d,3*d+3),v));
const principal=[2,3,4],initialState=[1,0,0,0,.4,.7,-.2];
function eulerDerivative([w,x,y,z,wx,wy,wz]) {
  return [-(x*wx+y*wy+z*wz)/2,(w*wx+y*wz-z*wy)/2,(w*wy+z*wx-x*wz)/2,(w*wz+x*wy-y*wx)/2,
    (principal[1]-principal[2])*wy*wz/principal[0],(principal[2]-principal[0])*wz*wx/principal[1],
    (principal[0]-principal[1])*wx*wy/principal[2]];
}
function eulerReference(t,dtMax) {
  const n=Math.ceil(Math.abs(t)/dtMax),h=t/n;let state=initialState.slice();
  for(let i=0;i<n;i++) {
    const a=eulerDerivative(state),b=eulerDerivative(add(state,scale(a,h/2))),
      c=eulerDerivative(add(state,scale(b,h/2))),d=eulerDerivative(add(state,scale(c,h)));
    state=state.map((v,j)=>v+h*(a[j]+2*b[j]+2*c[j]+d[j])/6);
  }
  return state;
}
const preciseState=eulerReference(1,.0005),coarseState=eulerReference(1,.001),preciseR=fromQuaternion(preciseState);
vector(preciseState,coarseState);close(dot(preciseState.slice(0,4),preciseState.slice(0,4)),1);
const exactL=matrixVector(preciseR,preciseState.slice(4).map((v,d)=>principal[d]*v));
vector(exactL,initialState.slice(4).map((v,d)=>principal[d]*v));
close(principal.reduce((s,I,d)=>s+I*preciseState[4+d]**2/2,0),principal.reduce((s,I,d)=>s+I*initialState[4+d]**2/2,0));
let priorAsymmetricError=Infinity;
for(const hz of [60,120,240]) {
  const h=1/hz,body=fourPointBody({massKg:10,principalInertiaKgM2:principal}),m=make(body.positionsM,body.massKg);
  const priorR=fromQuaternion(eulerReference(-h,.0005));m.prevDt=h;m.prev.set(nodes.flatMap(i=>matrixVector(priorR,point(body.positionsM,i))));
  let a;for(let n=0;n<hz;n++)a=step(m,new Float64Array(12),h);
  const matrixError=Math.hypot(...preciseR.map((v,i)=>v-a.bodyRotationFromReference[i]));
  assert(matrixError<priorAsymmetricError,'Вращение не сходится к независимым уравнениям Эйлера');priorAsymmetricError=matrixError;
  result.asymmetricSpin.push({hz,principalInertiaKgM2:principal,rotationMatrixError:matrixError,
    referenceAngularMomentumNms:exactL,actualAngularMomentumNms:a.bodyProperties.angularMomentumNms,
    referenceStepAgreement:Math.max(...preciseState.map((v,i)=>Math.abs(v-coarseState[i])))});
}

// Прикреплённая вне ЦТ масса 2 кг, внешняя сила 5 Н: полный ответ двух
// масс с поворотом. Не используются функции оценки ориентации или реакции.
for(const hz of [60,120,240])for(const side of [-1,1]) {
  const h=1/hz,body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2]}),r=[side,0,0],M=12,mass=2;
  const motion=make([...body.positionsM,...r],[...body.massKg,mass],[4]);
  const combinedCG=scale(r,mass/M),effectiveI=2+10*mass/M,torque=side*5*(1-mass/M),angle=Math.atan(h*h*torque/effectiveI);
  const nextCG=add(combinedCG,[0,5*h*h/M,0]),rotated=rotate(r,[0,0,1],angle),bodyCG=sub(nextCG,scale(rotated,mass/M));
  const expected=nodes.flatMap(i=>add(bodyCG,rotate(point(body.positionsM,i),[0,0,1],angle)));
  expected.push(...add(bodyCG,rotated));const force=new Float64Array(15);force[13]=5;
  const a=step(motion,force,h),expectedReaction=sub(scale(sub(point(expected,4),r),mass/(h*h)),[0,5,0]);
  vector(motion.pos,expected);vector(a.bodyOriginM,bodyCG);vector(point(a.bodyAttachmentForceN,4),expectedReaction);
  vector(a.bodyRotationFromReference,rotation([0,0,1],angle));
  vector(a.bodyForceN,scale(expectedReaction,-1));vector(a.bodyMomentNm,cross(rotated,scale(expectedReaction,-1)));
  result.offCentre.push({hz,side,angleRad:angle,bodyForceN:a.bodyForceN,bodyMomentNm:a.bodyMomentNm,
    maxPositionErrorM:Math.max(...expected.map((v,i)=>Math.abs(v-motion.pos[i])))});
}

// Планка вдоль силы: все 20 кг движутся вместе, а сила на 10 кг тела
// равна 2.5 Н. Промежуточные массы сохранены, голова находится в ЦТ.
for(const hz of [60,120,240])for(const side of [-1,1]) {
  const h=1/hz,body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2]}),cloth=[0,0,0,.8*side,0,0,2*side,0,0];
  const m=make([...body.positionsM,...cloth],[...body.massKg,2,3,5],[4],[distance(4,6,2,0)],
    {board:{head:4,end:6,nodes:[4,5,6],fractions:[0,.4,1]}});
  const force=new Float64Array(21);force[18]=side*5;const a=step(m,force,h),shift=side*.25*h*h;
  close(a.bodyOriginM[0],shift);vector(a.bodyForceN,[side*2.5,0,0]);vector(a.bodyMomentNm,[0,0,0]);
  for(let i=0;i<7;i++)close(m.pos[3*i],(i<4?body.positionsM[3*i]:cloth[3*(i-4)])+shift);
  result.board.push({hz,side,bodyForceN:a.bodyForceN,bodyXM:a.bodyOriginM[0]});
}

// Полотно с настоящей энергией, два закрепления на свободном теле,
// распределённая верхняя планка, обе стороны и меняющийся центр моментов.
for(const hz of [60,120,240])for(const side of [-1,1])for(const drift of [false,true]) {
  const h=1/hz,origin=[3,-2,1],body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2],originM:origin});
  const head=add(origin,[side*.2,.3,.4]),points=[...body.positionsM,...head,...add(head,[.8*side,0,0]),
    ...add(head,[2*side,0,0]),...add(head,[0,-1,0]),...add(head,[2*side,-1,0])];
  const material=materialSurface(points,[[7,8,5],[7,5,4],[8,6,5]],{bulkNPerM:1000,shearNPerM:50,bendingNm:0});
  const m=make(points,[...body.massKg,2,3,5,3,4],[4,7],[...material.constraints,distance(4,6,2,0)],
    {board:{head:4,end:6,nodes:[4,5,6],fractions:[0,.4,1]},dampingHz:6});
  if(drift) {
    const V=[side*1.3,-.2,.1],axis=[0,0,1];
    for(let i=0;i<9;i++)m.prev.set(sub(add(origin,rotate(sub(point(m.pos,i),origin),axis,-side*.2*h)),scale(V,h)),3*i);
    m.prevDt=h;
  }
  const forces=new Float64Array(27);forces.set([side*2,0,1],24);
  let maxBodyMomentNm=0,bodyOriginEndM;
  for(let n=0;n<hz/4;n++) {
    const a=step(m,forces,h);maxBodyMomentNm=Math.max(maxBodyMomentNm,Math.hypot(...a.bodyMomentNm));bodyOriginEndM=a.bodyOriginM;
  }
  result.material.push({hz,side,initialDriftAndSpin:drift,maxBodyMomentNm,bodyOriginEndM});
}

// Отрицательный контроль: BE не сохраняет угловой импульс буквально.
// Его дискретный член уже проверен выше; скрытая компенсация запрещена.
result.angularControl={hz:60,firstLossNms:result.spin[0].firstAngularLossNms,
  note:'Свободный неявный шаг имеет Δr×Δp и затухание, даже при нулевом внешнем моменте. Уточнение h уменьшает ошибку; точное сохранение L не заявляется.'};
assert(result.angularControl.firstLossNms>IMPLICIT_TOLERANCES.forceToleranceN/60);

const body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2]});
const badStep=make([...body.positionsM,1,0,0,2,.8,.3],[...body.massKg,2,3],[4],[distance(4,5,.5,.03)]);
const snapshot=m=>({pos:Array.from(m.pos),prev:Array.from(m.prev),dt:m.prevDt,lambda:m.constraints.map(c=>c.lambda),
  mu:m.lastMu?Array.from(m.lastMu):undefined,active:m.supportMotionActive,fixed:Array.from(m.fixedPositions)});
const before=snapshot(badStep),f=new Float64Array(18);f.set([10,15,8],15);
assert.throws(()=>badStep.step(f,.1,1),/не доведено|Не найден/);assert.deepEqual(snapshot(badStep),before);step(badStep,f,.1);
for(const field of ['pos','prev']) {
  const saved=snapshot(badStep),value=badStep[field][12];badStep[field][12]+=.001;
  assert.throws(()=>badStep.step(f,1/60,80),/вне общего шага/);badStep[field][12]=value;assert.deepEqual(snapshot(badStep),saved);
}
const descriptor=bodyOption([4]),owned=make([...body.positionsM,1,0,0],[...body.massKg,2],[4],[],{rigidBody:descriptor});
descriptor.nodes[0]=4;descriptor.attachments[0]=0;assert.deepEqual(owned.rigidBody.nodes,nodes);assert.deepEqual(owned.rigidBody.attachments,[4]);
assert.throws(()=>{owned.rigidBody.bindings[0].weights[0][1]=0;},TypeError);
// Шесть длин не различают зеркало. Принятие такого предсказания меняло бы
// ориентацию скачком; постпроверка обязана вернуть и историю, и множители.
const reflection=make(body.positionsM,body.massKg),reflectionBefore=snapshot(reflection),reflectionForce=new Float64Array(12),hReflection=1/60;
for(let i=0;i<4;i++)for(let d=0;d<3;d++) {
  const target=i===0?1:i===1?0:i;
  reflectionForce[3*i+d]=body.massKg[i]*(body.positionsM[3*target+d]-body.positionsM[3*i+d])/(hReflection*hReflection);
}
assert.throws(()=>reflection.step(reflectionForce,hReflection,80),/Отражённая ориентация/);
assert.deepEqual(snapshot(reflection),reflectionBefore);
for(const principalInertiaKgM2 of [[-1,2,2],[1,2,3],[1,1,3]])
  assert.throws(()=>fourPointBody({massKg:10,principalInertiaKgM2}),/инерция|Инерция/);
assert.throws(()=>fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2],orientation:[-1,0,0,0,1,0,0,0,1]}),/поворот/);
assert.throws(()=>rigidBodyProperties(body.positionsM,body.massKg,nodes,body.positionsM,-1),/Некорректные данные/);
for(const extra of [{rigidBody:{...bodyOption(),nodes:[0,1,2,2]}},{rigidBody:{...bodyOption([0])}},
  {rigidBody:{...bodyOption(),frame:'body-horizontal'}},{fixed:[0]},{translatingBody:{node:0,attachments:[4]}}])
  assert.throws(()=>make(body.positionsM,body.massKg,[],[],extra),/Свободное тело/);
result.verification=maxima;
if(output) {
  const hash=b=>createHash('sha256').update(b).digest('hex'),paths=['tests/cloth-rigid-body-coupling.test.mjs',
    'tests/lib/cloth-rigid-body-motion.mjs','tests/lib/cloth-energy-motion.mjs','tests/lib/cloth-implicit-motion.mjs',
    'tests/lib/cloth-linear-solve.mjs','tests/lib/cloth-kkt-direction.mjs','tests/lib/cloth-sparse-solve.mjs',
    'tests/lib/cloth-sparse-wasm.mjs','tests/cloth-compliance.mjs','tests/lib/cloth-material.mjs'];
  writeFileSync(output,JSON.stringify({schema:1,createdAt:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256:Object.fromEntries(paths.map(p=>[p,hash(readFileSync(p))])),
    wasm:wasm?{path:wasm,sha256:hash(readFileSync(wasm))}:null,linearBackend:backend,tolerances:IMPLICIT_TOLERANCES,
    scope:'Свободное объёмное тело, одна система физических масс и жёстких связей, известные движения и малое полотно. Воздух/нагрузка заданы извне; это не живой Boat и не G1–G4/C1.',result},null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({проверка:'свободное тело и ткань в общем шаге',способ:backend,result,output},null,2));
