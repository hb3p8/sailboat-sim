// Известные задачи общей ткани и обобщённой инерции воды, без CFD и Boat.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import {FluidBodyEnergyMotion} from './lib/cloth-fluid-body-motion.mjs';
import {fluidInertia,denseSolve} from './lib/cloth-fluid-inertia.mjs';
import {distance} from './cloth-compliance.mjs';
import {materialSurface,gridTriangles,MODEL_MATERIAL} from './lib/cloth-material.mjs';
import {boatBodyRotation} from '../sim/axes.js';

const args=process.argv.slice(2);assert(args.length<=1&&args.every(v=>/^--out=.+$/.test(v)));
const packBytes=readFileSync(new URL('../out/export/physics.json',import.meta.url)),pack=JSON.parse(packBytes);
const hash=b=>createHash('sha256').update(b).digest('hex');
const I9=[1,0,0,0,1,0,0,0,1],point=(p,i)=>Array.from(p.slice(3*i,3*i+3));
const add=(a,b)=>a.map((v,d)=>v+b[d]),sub=(a,b)=>a.map((v,d)=>v-b[d]),scale=(a,k)=>a.map(v=>v*k);
const dot=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const matVec=(m,v)=>Array.from({length:v.length},(_,d)=>dot(m.slice(d*v.length,(d+1)*v.length),v));
const rt=m=>[0,3,6,1,4,7,2,5,8].map(i=>m[i]);
const close=(a,b,tol=1e-9)=>assert(Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const vector=(a,b,tol)=>a.forEach((v,d)=>close(v,b[d],tol));
const diagonal6=values=>Array.from({length:36},(_,i)=>i%7===0?values[i/7]:0);
const input={dryMassKg:10,dryPrincipalInertiaKgM2:[2,3,4],addedMass6:diagonal6([1,2,3,1,25,2])};
const triangleMaterial={bulkNPerM:1000,shearNPerM:50,bendingNm:0};
const wet=fluidInertia(input),dry=fluidInertia({...input,addedMass6:new Array(36).fill(0)});
const result={schema:'cloth-fluid-body-v1',date:new Date().toISOString(),runtime:process.version,
  hardware:{cpu:cpus()[0]?.model,platform:process.platform,arch:process.arch},
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  sourceSha256:{},physicsSha256:hash(packBytes),input,cases:{translation:0,spin:0,spring:0,rope:0,gravity:0},
  refinement:[],totalAcceptedSteps:0,maxima:{forceEquivalentN:0,lengthM:0,workIdentityJ:0,energyLimitRatio:0,interfaceLimitRatio:0,convectivePowerW:0,knownCoordinateErrorM:0}};
const root=fileURLToPath(new URL('../',import.meta.url));
function source(url) {
  const path=relative(root,fileURLToPath(url));if(Object.hasOwn(result.sourceSha256,path))return;
  const bytes=readFileSync(url);result.sourceSha256[path]=hash(bytes);
  for(const m of bytes.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))source(new URL(m[1],url));
}
source(new URL(import.meta.url));

const skew=([x,y,z])=>[0,-z,y,z,0,-x,-y,x,0];
// Независимая матричная форма C=[0,-S(P);-S(P),-S(L)].
function convectiveReference(M,nu) {
  const p=matVec(M,nu),SP=skew(p.slice(0,3)),SL=skew(p.slice(3)),C=new Array(36).fill(0);
  for(let i=0;i<3;i++)for(let j=0;j<3;j++) {
    C[6*i+j+3]=-SP[3*i+j];C[6*(i+3)+j]=-SP[3*i+j];C[6*(i+3)+j+3]=-SL[3*i+j];
  }
  return matVec(C,nu);
}

function make(inertia,{positions=[],mass=[],constraints=[],attachments=[],originM=[0,0,0],R=I9,
    nu=[0,0,0,0,0,0],velocities,dampingHz=0}={}) {
  return new FluidBodyEnergyMotion({positions,mass,constraints,velocityMS:velocities,dampingHz,
    body:{inertia,originM,orientation9:R,velocity6:nu,attachments,frame:'body-cg'}});
}
const load=(nc,F=[0,0,0],T=[0,0,0],cloth=new Array(nc).fill(0))=>
  ({frame:'inertial-cartesian-cg',forceN:F,momentNm:T,clothForceN:cloth});
function step(m,f,h,passes) {
  const a=m.step(f,h,passes),max=result.maxima,t=m.tolerances;
  assert(a.solver.converged&&a.maxPhysicalResidualN<=t.forceToleranceN&&a.maxHardViolationM<=t.lengthToleranceM);
  assert(a.dualViolationN<=t.dualToleranceN&&a.complementarityJ<=t.complementarityToleranceJ);
  assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ,'общая энергия не ограничена силовым остатком');
  const energyRoundoff=256*Number.EPSILON*Math.max(1,Math.abs(a.initialKineticJ),Math.abs(a.kineticJ),Math.abs(a.workJ),Math.abs(a.inertiaIncrementJ),Math.abs(a.materialIncrementJ));
  assert(Math.abs(a.discreteBalanceResidualJ-a.residualIdentityJ)<=energyRoundoff,'тождество работы не сходится');
  assert(Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ,'реакции создают работу');
  close(a.convectivePowerW,0,1e-10);
  max.forceEquivalentN=Math.max(max.forceEquivalentN,a.maxPhysicalResidualN);max.lengthM=Math.max(max.lengthM,a.maxHardViolationM);
  max.workIdentityJ=Math.max(max.workIdentityJ,Math.abs(a.discreteBalanceResidualJ-a.residualIdentityJ));
  max.energyLimitRatio=Math.max(max.energyLimitRatio,Math.abs(a.discreteBalanceResidualJ)/a.workLimitJ);
  max.interfaceLimitRatio=Math.max(max.interfaceLimitRatio,Math.abs(a.bodyWorkCancellationResidualJ)/a.interfaceWorkLimitJ);
  max.convectivePowerW=Math.max(max.convectivePowerW,Math.abs(a.convectivePowerW));result.totalAcceptedSteps++;return a;
}

// Полная смешанная положительная водная матрица, не только шесть диагоналей.
const B=Array.from({length:36},(_,i)=>i%7===0?1+.1*(i/7):((i*7+3)%11-5)*.04);
const fullA=Array.from({length:36},(_,i)=>[0,1,2,3,4,5].reduce((s,k)=>s+B[6*k+Math.floor(i/6)]*B[6*k+i%6],0));
const full=fluidInertia({...input,addedMass6:fullA});
for(const inertia of [dry,wet,full])for(const nu of [[1,2,3,.4,-.2,.5],[-2,.3,.5,-.7,.6,.1]]) {
  const P=matVec(inertia.matrix6,nu);vector(inertia.momentum(nu),P,1e-12);
  const reference=.5*input.dryMassKg*dot(nu.slice(0,3),nu.slice(0,3))+
    .5*input.dryPrincipalInertiaKgM2.reduce((s,v,d)=>s+v*nu[d+3]**2,0)+.5*dot(nu,matVec(inertia.addedMass6,nu));
  close(inertia.kineticJ(nu),reference,1e-12);
  vector(inertia.convective(nu),convectiveReference(inertia.matrix6,nu),1e-12);
  close(dot(nu,inertia.convective(nu)),0,1e-12);
}
assert(wet.matrix6[28]>wet.matrix6[21]+wet.matrix6[35],'проверка должна включать невозможный для сухого тела набор');
const badNu=[1,2,0,0,0,1],badC=wet.convective(badNu),missingLower=[...badC.slice(0,3),0,0,0];
result.negativeControl={omittedTranslationRotationCouplingPowerW:-dot(badNu,missingLower),fullPowerW:dot(badNu,badC)};
close(result.negativeControl.omittedTranslationRotationCouplingPowerW,2,1e-12);

for(const inertia of [dry,wet])for(const hz of [60,120,240])for(const side of [-1,1])for(let axis=0;axis<3;axis++) {
  const F=new Array(3).fill(0),Fc=new Array(3).fill(0);F[axis]=side*2;Fc[axis]=side*5;
  const origin=[3,-2,1],m=make(inertia,{positions:origin,mass:[2],attachments:[0],originM:origin});
  const h=1/hz,A=inertia.matrix6[7*axis]+2,acc=scale(add(F,Fc),1/A),expected=add(origin,scale(acc,h*h));
  const a=step(m,load(3,F,[0,0,0],Fc),h);vector(m.pos,expected);
  vector(m.body.originM,expected);vector(m.body.velocity6,[...scale(acc,h),0,0,0]);
  // Разность двух реакций ограничена двумя силовыми остатками, а не
  // арифметическим допуском для координат известного решения.
  a.bodyForceN.forEach((v,d)=>assert(Math.abs(v-(Fc[d]-2*acc[d]))<=2*m.tolerances.forceToleranceN));
  result.maxima.knownCoordinateErrorM=Math.max(result.maxima.knownCoordinateErrorM,...sub(Array.from(m.pos),expected).map(Math.abs));
  result.cases.translation++;

  const T=new Array(3).fill(0);T[axis]=side*3;const body=make(inertia,{originM:origin});
  const aa=step(body,load(0,[0,0,0],T),h),omega=h*T[axis]/inertia.matrix6[7*(axis+3)],angle=2*Math.atan(h*omega/2);
  vector(body.body.velocity6,[0,0,0,...T.map((v,d)=>d===axis?omega:0)]);
  // Независимая формула Родрига для известной оси вращения.
  const unit=new Array(3).fill(0);unit[axis]=1;
  const expectedR=Array.from({length:9},(_,i)=>{
    const e=new Array(3).fill(0);e[i%3]=1;
    return add(add(scale(e,Math.cos(angle)),scale(cross(unit,e),Math.sin(angle))),scale(unit,dot(unit,e)*(1-Math.cos(angle))))[Math.floor(i/3)];
  });
  vector(aa.bodyRotation9,expectedR,1e-12);result.cases.spin++;
}

// Независимое двухмассовое уравнение одной пружины, включая переменный h.
for(const side of [-1,1])for(let axis=0;axis<3;axis++)for(const dampingHz of [0,6]) {
  const e=new Array(3).fill(0);e[axis]=side;
  const mass=[2,3],k=50,A=wet.matrix6[7*axis]+mass[0],Mb=mass[1];
  const m=make(wet,{positions:[0,0,0,...e],mass,attachments:[0],constraints:[distance(0,1,1,1/k)],dampingHz});
  let q0=0,q1=1,v0=0,v1=0;
  for(const h of [1/60,1/120,1/240,1/30]) {
    const c=q1-q0-1,decay=Math.exp(-dampingHz*h),F0=2+4+mass[0]*(decay-1)*v0/h,F1=7+Mb*(decay-1)*v1/h;
    const a=A/(h*h)+k,b=Mb/(h*h)+k,D=a*b-k*k;
    const r0=A*v0/h+F0+k*c,r1=Mb*v1/h+F1-k*c;
    const d0=(b*r0+k*r1)/D,d1=(k*r0+a*r1)/D;
    q0+=d0;q1+=d1;v0=d0/h;v1=d1/h;
    step(m,load(6,scale(e,2),[0,0,0],[...scale(e,4),...scale(e,7)]),h);
    vector(point(m.pos,0),scale(e,q0));vector(point(m.pos,1),scale(e,q1));
    vector(m.body.velocity6,[...scale(e,v0),0,0,0]);result.cases.spring++;
  }
}

// Слабина и натяжение нерастяжимой нити: независимая реакция для одного шага.
for(const side of [-1,1])for(const h of [1/60,.25])for(const limit of [1,1.1]) {
  const e=[side,0,0],mass=[2,3],A=wet.matrix6[0]+mass[0],F=5,gap=limit-1;
  const m=make(wet,{positions:[0,0,0,...e],mass,attachments:[0],constraints:[distance(0,1,limit,0,true)]});
  const tension=Math.max(0,(F/mass[1]-gap/(h*h))/(1/A+1/mass[1]));
  const d0=h*h*tension/A,d1=h*h*(F-tension)/mass[1];
  step(m,load(6,[0,0,0],[0,0,0],[0,0,0,...scale(e,F)]),h);
  vector(point(m.pos,0),scale(e,d0));vector(point(m.pos,1),scale(e,1+d1));
  assert(Math.abs(m.lastMu[0]-tension)<=2*m.tolerances.forceToleranceN);
  result.cases.rope++;
}

// Вес сухого тела/ткани при меняющейся водной инерции, вода не является грузом.
for(const inertia of [dry,wet])for(const h of [1/60,1/120,1/240]) {
  const m=make(inertia,{positions:[0,0,0],mass:[2],attachments:[0]});
  const totalWeight=(input.dryMassKg+2)*9.81,acc=-totalWeight/(inertia.matrix6[14]+2);
  step(m,load(3,[0,0,-input.dryMassKg*9.81],[0,0,0],[0,0,-2*9.81]),h);
  close(m.body.originM[2],acc*h*h);result.cases.gravity++;
}

// Независимые непрерывные уравнения общего тела с тремя точечными массами.
// Треугольник имеет настоящее растяжение/перекос, изгиб здесь отсутствует.
function totalMatrix(inertia,local,mass) {
  const M=inertia.matrix6.slice();
  local.forEach((r,i)=>{
    const S=skew(r),B=Array.from({length:18},(_,k)=>k%6<3?(Math.floor(k/6)===k%6?1:0):-S[3*Math.floor(k/6)+k%6-3]);
    for(let a=0;a<6;a++)for(let b=0;b<6;b++)M[6*a+b]+=mass[i]*[0,1,2].reduce((s,d)=>s+B[6*d+a]*B[6*d+b],0);
  });return M;
}
function derivative(y,M) {
  const nu=y.slice(0,6),R=y.slice(6,15),w=skew(nu.slice(3));
  const dnu=Array.from(denseSolve(M,convectiveReference(M,nu).map(v=>-v)));
  const dR=Array.from({length:9},(_,i)=>[0,1,2].reduce((s,k)=>s+R[3*Math.floor(i/3)+k]*w[3*k+i%3],0));
  return [...dnu,...dR,...matVec(R,nu.slice(0,3))];
}
function reference(M,nu,R,origin) {
  let y=[...nu,...R,...origin];const samples=[y.slice()],h=1/7680;
  for(let i=1;i<=7680;i++) {
    const a=derivative(y,M),b=derivative(add(y,scale(a,h/2)),M),c=derivative(add(y,scale(b,h/2)),M),d=derivative(add(y,scale(c,h)),M);
    y=y.map((v,k)=>v+h*(a[k]+2*b[k]+2*c[k]+d[k])/6);
    if(i%32===0)samples.push(y.slice());
  }
  const initial=worldMomentum(M,nu,R,origin),final=worldMomentum(M,y.slice(0,6),y.slice(6,15),y.slice(15));
  vector(final.P,initial.P);vector(final.L,initial.L);close(dot(y.slice(0,6),matVec(M,y.slice(0,6))),dot(nu,matVec(M,nu)));
  return samples;
}
function worldMomentum(M,nu,R,origin) {
  const b=matVec(M,nu),P=matVec(R,b.slice(0,3));return {P,L:add(cross(origin,P),matVec(R,b.slice(3)))};
}
function measuredMomentum(m) {
  const p=worldMomentum(m.inertia.matrix6,m.body.velocity6,m.body.orientation9,m.body.originM);
  for(let i=0;i<m.mass.length;i++) {
    const P=scale(point(m.vel,i),m.mass[i]);p.P=add(p.P,P);p.L=add(p.L,cross(point(m.pos,i),P));
  }return p;
}
for(const side of [-1,1]) {
  const local=[[1.1,side*.3,.2],[-.2,side*.9,.1],[.3,side*-.5,.7]],mass=[1,.7,.9];
  const nu=[1,side*1.5,.3,side*.2,-.1,side*.25],origin=[.3,side*-.4,.2],R=I9;
  const M=totalMatrix(wet,local,mass),ref=reference(M,nu,R,origin),initial=worldMomentum(M,nu,R,origin);
  const records=[];
  for(const hz of [60,120,240]) {
    const positions=local.flatMap(r=>add(origin,matVec(R,r)));
    const velocities=local.flatMap(r=>matVec(R,add(nu.slice(0,3),cross(nu.slice(3),r))));
    const material=materialSurface(positions,[[0,1,2]],triangleMaterial);
    const m=make(wet,{positions,mass,attachments:[0,1,2],originM:origin,R,nu,velocities,constraints:material.constraints});
    const errors={velocity6:0,originM:0,rotation9:0,clothRmsM:0,linearMomentumNs:0,angularMomentumNms:0};
    const startEnergy=wet.kineticJ(nu)+mass.reduce((s,v,i)=>s+.5*v*dot(point(velocities,i),point(velocities,i)),0);
    let finalAudit;
    for(let i=1;i<=hz;i++) {
      finalAudit=step(m,load(9),1/hz);
      const wanted=ref[i*240/hz],wantedR=wanted.slice(6,15),wantedOrigin=wanted.slice(15);
      errors.velocity6=Math.max(errors.velocity6,Math.hypot(...sub(m.body.velocity6,wanted.slice(0,6))));
      errors.originM=Math.max(errors.originM,Math.hypot(...sub(m.body.originM,wantedOrigin)));
      errors.rotation9=Math.max(errors.rotation9,Math.hypot(...sub(m.body.orientation9,wantedR)));
      const q=local.flatMap(r=>add(wantedOrigin,matVec(wantedR,r)));
      errors.clothRmsM=Math.max(errors.clothRmsM,Math.sqrt(dot(sub(Array.from(m.pos),q),sub(Array.from(m.pos),q))/3));
      const measured=measuredMomentum(m);
      errors.linearMomentumNs=Math.max(errors.linearMomentumNs,Math.hypot(...sub(measured.P,initial.P)));
      errors.angularMomentumNms=Math.max(errors.angularMomentumNms,Math.hypot(...sub(measured.L,initial.L)));
      assert(finalAudit.kineticJ<=startEnergy+finalAudit.workLimitJ,'свободная система создала энергию');
    }
    records.push({hz,errors,energyLossJ:startEnergy-finalAudit.kineticJ});
  }
  for(let i=1;i<records.length;i++)for(const [key,value] of Object.entries(records[i].errors))
    assert(value<records[i-1].errors[key],`уточнение времени не уменьшило ${key}`);
  result.refinement.push({side,referenceHz:7680,totalMatrix6:M,records});
}

// Смена мировых осей при нагрузке деформируемого настоящего треугольника.
const local=[0,0,0,1,.1,0,.2,.8,.15],mass=[.4,.3,.2],R=boatBodyRotation(.7,-.3,.12),origin=[2,-1,.5];
const F=[1,-2,3],T=[.3,.2,-.1],clothF=[0,1,-.5,2,0,-.7,-1,2,.3];
const surface=materialSurface(local,[[0,1,2]],triangleMaterial);
const base=make(full,{positions:local,mass,attachments:[0],constraints:surface.constraints});
const rotatedPositions=[0,1,2].flatMap(i=>add(origin,matVec(R,point(local,i))));
const rotatedSurface=materialSurface(rotatedPositions,[[0,1,2]],triangleMaterial);
const rotated=make(full,{positions:rotatedPositions,mass,attachments:[0],originM:origin,R,constraints:rotatedSurface.constraints});
for(let i=0;i<6;i++) {
  const a=step(base,load(9,F,T,clothF),1/120);
  const b=step(rotated,load(9,matVec(R,F),matVec(R,T),[0,1,2].flatMap(j=>matVec(R,point(clothF,j)))),1/120);
  const want=[0,1,2].flatMap(j=>add(origin,matVec(R,point(base.pos,j))));
  vector(rotated.pos,want);vector(rotated.body.velocity6,base.body.velocity6);
  close(b.kineticJ,a.kineticJ);close(b.softEnergyJ,a.softEnergyJ);close(b.workJ,a.workJ);
}
result.frameAndMaterialSteps=12;

// Малое полотно с действующим изгибом: свободные внутренние узлы,
// два крепления к телу, прежние размерные K/G/B и кривизна на сетке 4×4.
const patchPositions=Array.from({length:16},(_,i)=>{
  const row=Math.floor(i/4),col=i%4;return [.4+.3*row,-.5+.3*col,1+.04*(row*row+col)];
}).flat();
const patch=materialSurface(patchPositions,gridTriangles(4,4),MODEL_MATERIAL,{bendingModel:'curvature',rows:4,cols:4});
const clothPatch=make(wet,{positions:patchPositions,mass:new Array(16).fill(.1),
  attachments:[0,12],constraints:patch.constraints,dampingHz:6});
let patchAudit;
for(let i=0;i<6;i++) {
  const oldOrigin=clothPatch.body.originM.slice(),old=clothPatch.pos.slice();
  patchAudit=step(clothPatch,load(48,[.2,-.1,.1],[.1,.05,-.07],
    Array.from({length:48},(_,k)=>k%3===2?.15:k%3===1?.03:0)),1/120);
  const torque=[0,0,0];
  for(const node of [0,12]) {
    const lever=scale(add(sub(point(old,node),oldOrigin),sub(point(clothPatch.pos,node),clothPatch.body.originM)),.5);
    const f=scale(point(patchAudit.bodyAttachmentForceN,node),-1),t=cross(lever,f);
    for(let d=0;d<3;d++)torque[d]+=t[d];
  }
  vector(patchAudit.bodyMomentNm,torque);
}
const patchEval=patch.evaluate(clothPatch.pos);assert(patchEval.bendingJ>0,'контроль должен затронуть энергию изгиба');
result.curvaturePatch={rows:4,cols:4,steps:6,parameters:MODEL_MATERIAL,
  finalSoftEnergyJ:patchAudit.softEnergyJ,bulkJ:patchEval.bulkJ,shearJ:patchEval.shearJ,bendingJ:patchEval.bendingJ};

// Коэффициенты SV20 — явная проверочная гипотеза в связанных осях ЦТ.
// Текущее Boat смешивает горизонтальные/связанные оси; это не его перенос.
const pm=pack.mass,dryI=[pm.ixx_kg_m2,pm.iyy_kg_m2,pm.izz_kg_m2];
const added=diagonal6([pm.total_kg*pm.added_surge,pm.total_kg*pm.added_sway,pm.total_kg*pm.added_heave,
  dryI[0]*(pm.added_roll-1),dryI[1]*pm.added_pitch,dryI[2]*pm.added_yaw]);
const boatInertia=fluidInertia({dryMassKg:pm.total_kg,dryPrincipalInertiaKgM2:dryI,addedMass6:added});
const boatControl=make(boatInertia,{nu:[1,.2,-.1,.08,-.03,.04]});
const boatAudit=step(boatControl,load(0,[10,-20,15],[3,-4,5]),1/60);
result.boatCoefficientControl={dryMassKg:pm.total_kg,matrix6:boatInertia.matrix6,addedMass6:added,
  forceEquivalentResidualN:boatAudit.maxPhysicalResidualN,workResidualJ:boatAudit.discreteBalanceResidualJ};

// Отказы оставляют всё принятое состояние, включая реакции и множители.
const snapshot=m=>({pos:Array.from(m.pos),vel:Array.from(m.vel),body:structuredClone(m.body),mu:Array.from(m.lastMu),lambda:m.constraints.map(c=>c.lambda)});
const rejected=make(wet,{nu:[1,2,.5,.8,-.6,.4]});
const before=snapshot(rejected);
assert.throws(()=>rejected.step(load(0),.2,1),/не доведён|убывающий/);assert.deepEqual(snapshot(rejected),before);
assert.throws(()=>rejected.step(load(0,[NaN,0,0]),1/60),/Некорректная/);assert.deepEqual(snapshot(rejected),before);
const asymmetricA=input.addedMass6.slice();asymmetricA[1]=1;
assert.throws(()=>fluidInertia({...input,addedMass6:asymmetricA}),/симметричной/);
assert.throws(()=>fluidInertia({...input,addedMass6:diagonal6([-1,0,0,0,0,0])}),/неотрицательную/);
assert.throws(()=>make(wet,{R:[-1,0,0,0,1,0,0,0,1]}),/ориентацию/);

if(args[0])writeFileSync(args[0].slice(6),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(`ок: ${result.totalAcceptedSteps} общих шагов, из них ${Object.values(result.cases).reduce((s,v)=>s+v,0)} известных; оба зеркала, уточнение времени, материал/изгиб, нить/пружина/сухой вес и полный отказ`);
console.log(JSON.stringify({максимумы:result.maxima,отрицательный_контроль:result.negativeControl}));
