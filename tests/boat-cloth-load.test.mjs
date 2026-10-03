// Граница действующей модели и общего решателя: оси, ЦТ, сила и работа.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Boat} from '../sim/physics.js';
import {boatLoadPose,headingLoadToWorld,worldLoadAtOrigin,rigLoadWithoutGennaker,rigidBodyLoadForces} from './lib/boat-cloth-load.mjs';
import {fourPointBody,RigidBodyEnergyMotion} from './lib/cloth-rigid-body-motion.mjs';
import {IMPLICIT_TOLERANCES} from './lib/cloth-implicit-motion.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {stripLoadOf} from './lib/gennaker-observables.mjs';

const args=process.argv.slice(2);
assert(args.every(a=>/^--(out|linear-backend|wasm)=.+$/.test(a))&&
  new Set(args.map(a=>a.split('=')[0])).size===args.length,'Нужны уникальные --out/--linear-backend/--wasm');
const output=args.find(a=>a.startsWith('--out='))?.slice(6);
const backend=args.find(a=>a.startsWith('--linear-backend='))?.slice(17)??'band-js';
const wasmPath=args.find(a=>a.startsWith('--wasm='))?.slice(7);
assert(['band-js','sparse-js','sparse-wasm','kkt-wasm'].includes(backend),'Неизвестный способ решения');
assert(backend.endsWith('wasm')===Boolean(wasmPath),'WASM требуется только соответствующему способу решения');
const bytes=readFileSync(new URL('../out/export/physics.json',import.meta.url)),pack=JSON.parse(bytes);
const hash=b=>createHash('sha256').update(b).digest('hex');
const wasmBytes=wasmPath?readFileSync(wasmPath):undefined;
const wasmSparseFactor=wasmBytes?await loadSparseFactor(wasmBytes):undefined;
const add=(a,b)=>a.map((v,d)=>v+b[d]),sub=(a,b)=>a.map((v,d)=>v-b[d]);
const scale=(a,k)=>a.map(v=>v*k),dot=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const point=(p,i)=>Array.from(p.slice(3*i,3*i+3));
const yaw=([x,y,z],psi)=>[x*Math.cos(psi)-y*Math.sin(psi),x*Math.sin(psi)+y*Math.cos(psi),z];
// Независимый последовательный поворот, без проверяемой матрицы.
const bodyWorld=([x,y,z],psi,phi,th)=>{
  const yr=y*Math.cos(phi)-z*Math.sin(phi),zr=y*Math.sin(phi)+z*Math.cos(phi);
  return yaw([x*Math.cos(th)-zr*Math.sin(th),yr,x*Math.sin(th)+zr*Math.cos(th)],psi);
};
const close=(a,b,name)=>assert(Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(a),Math.abs(b)),`${name}: ${a} != ${b}`);
const vector=(a,b,name)=>a.forEach((v,d)=>close(v,b[d],`${name}, ${d}`));
const maxima={forceN:0,momentNm:0,powerW:0,knownPositionM:0,physicalResidualN:0};
const result={contract:'boat-cloth-load-v1',date:new Date().toISOString(),
  code:{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())},
  physicsSha256:hash(bytes),sourceSha256:{},backend,wasm:wasmPath?{path:wasmPath,sha256:hash(wasmBytes)}:null,
  poseCases:0,rigCases:0,distributionCases:0,knownSteps:0,coupledSteps:0,
  tolerances:{algebraRelative:1e-10,physical:IMPLICIT_TOLERANCES},maxima};
// Источник включает все статически импортируемые локальные зависимости,
// а не только верхний уровень решателя. Данные пакета имеют отдельный SHA.
const root=fileURLToPath(new URL('../',import.meta.url));
function recordSource(url) {
  const path=relative(root,fileURLToPath(url));
  if(Object.hasOwn(result.sourceSha256,path))return;
  assert(!path.startsWith('../'),'Зависимость должна быть внутри проекта');
  const content=readFileSync(url);result.sourceSha256[path]=hash(content);
  for(const match of content.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
    recordSource(new URL(match[1],url));
}
recordSource(new URL(import.meta.url));

function checkDistribution(m,load) {
  const out=rigidBodyLoadForces(m,load),F=[0,0,0],T=[0,0,0],V=[.7,-.3,.4],w=[-.2,.5,.1];
  let power=0;
  for(const i of m.rigidBody.nodes) {
    const f=point(out.forceN,i),r=sub(point(m.pos,i),out.properties.originM);
    const torque=cross(r,f),v=add(V,cross(w,r));
    for(let d=0;d<3;d++){F[d]+=f[d];T[d]+=torque[d];}
    power+=dot(f,v);
  }
  vector(F,out.load.forceN,'полная сила узлов');vector(T,out.load.momentNm,'полный момент узлов');
  const expectedPower=dot(out.load.forceN,V)+dot(out.load.momentNm,w);
  close(power,expectedPower,'мощность при произвольном жёстком движении');
  maxima.forceN=Math.max(maxima.forceN,...sub(F,out.load.forceN).map(Math.abs));
  maxima.momentNm=Math.max(maxima.momentNm,...sub(T,out.load.momentNm).map(Math.abs));
  maxima.powerW=Math.max(maxima.powerW,Math.abs(power-expectedPower));
  result.distributionCases++;
  return out;
}

// Нагрузка в точке плюс свободная пара сил. Их независимый перенос
// обнаруживает повторный крен и потерю момента при смене начала.
for(const psi of [0,.7,-2.2])for(const phi of [-.4,.55])for(const th of [-.12,.2])
for(const referenceOriginM of [[0,0,0],[100,-60,1.3]]) {
  const pose=boatLoadPose({referenceOriginM,cgBodyM:pack.mass.cg_m,psi,phi,th});
  const cg=add(referenceOriginM,bodyWorld(pack.mass.cg_m,psi,phi,th));
  vector(pose.cgWorldM,cg,'мировой ЦТ из начала геометрии');
  const origin=[2.8,0,-.05],application=[-.8,2.6,3.1],F=[-13,17,5],couple=[4,-2,7];
  const moment=add(cross(sub(application,origin),F),couple);
  const load=headingLoadToWorld({frame:'body-horizontal',originM:origin,forceN:F,momentNm:moment},pose);
  const wantF=yaw(F,psi),wantPoint=add(referenceOriginM,yaw(application,psi));
  const wantT=add(cross(sub(wantPoint,cg),wantF),yaw(couple,psi));
  vector(load.forceN,wantF,'поворот силы по курсу');vector(load.momentNm,wantT,'перенос точки и свободной пары');
  const back=worldLoadAtOrigin(load,add(referenceOriginM,yaw(origin,psi)));
  vector(back.momentNm,yaw(moment,psi),'обратный перенос момента');
  const dry=fourPointBody({massKg:pack.mass.total_kg,principalInertiaKgM2:
    [pack.mass.ixx_kg_m2,pack.mass.iyy_kg_m2,pack.mass.izz_kg_m2],originM:cg,orientation:pose.bodyToWorld});
  const m={pos:dry.positionsM,mass:dry.massKg,rigidBody:{nodes:[0,1,2,3],frame:'inertial-cartesian'}};
  checkDistribution(m,load);
  checkDistribution(m,{frame:'inertial-cartesian',originM:cg,forceN:[0,0,0],momentNm:wantT});
  // Возврат содержит свои массивы; следующий проход Rig не может их изменить.
  const owned=load.forceN.slice();F.fill(NaN);moment.fill(NaN);origin.fill(NaN);
  assert.deepEqual(load.forceN,owned);
  result.poseCases++;
}

// Настоящий Rig, оба борта и режимы давления, генакер поднят/убран.
for(const up of [false,true])for(const side of [-1,1])for(const localPressure of [false,true]) {
  const b=new Boat(pack,null,{gennakerUp:up,localPressure});
  b.o.windSpeed=6;b.o.windDir=side*140*Math.PI/180;b.o.crewMass=0;b.u=3;b.v=side*.1;
  b.x=12;b.y=-8;b.zc=-.08;
  for(let step=0;step<12;step++) {
    b.psi=.3+step*.007;b.phi=side*.3;b.th=side*(.03+step*.002);
    const out=b.rig.forces(b,b.apparentWind(),1/30);
    const pose=boatLoadPose({referenceOriginM:[b.x,b.y,b.zc],cgBodyM:pack.mass.cg_m,
      psi:b.psi,phi:b.phi,th:b.th});
    const load=rigLoadWithoutGennaker(out,pose);
    const parts=[0,1].map(i=>stripLoadOf(b.rig,b.phi,out.originM,i));
    const sum=key=>parts.reduce((s,p)=>add(s,p[key]),[0,0,0]);
    const f=yaw(sum('forceN'),b.psi),sourceOrigin=add([b.x,b.y,b.zc],yaw(out.originM,b.psi));
    const t=add(yaw(sum('momentNm'),b.psi),cross(sub(sourceOrigin,pose.cgWorldM),f));
    vector(load.forceN,f,'два оставшихся паруса');vector(load.momentNm,t,'три момента оставшихся парусов');
    if(up) {
      const old=structuredClone(out.bySail[2]);
      out.bySail[2].forceN.fill(1e12);out.bySail[2].momentNm.fill(-1e12);
      assert.deepEqual(rigLoadWithoutGennaker(out,pose),load,'старый генакер не входит в новый пакет');
      out.bySail[2]=old;
    }
    result.rigCases++;
  }
}

// Известный первый шаг сферического тела в том же общем решателе:
// CG+=h² F/M, поворот вокруг alpha на atan(h² |alpha|).
for(const hz of [60,120,240])for(const side of [-1,1]) {
  const origin=[3,-2,1],pose=boatLoadPose({referenceOriginM:origin,cgBodyM:[0,0,0],psi:.7,phi:side*.4,th:.12});
  const body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2],originM:origin,orientation:pose.bodyToWorld});
  const m=new RigidBodyEnergyMotion({positions:body.positionsM,mass:body.massKg,
    rigidBody:{nodes:[0,1,2,3],attachments:[],frame:'inertial-cartesian'},constraints:[],dampingHz:0,
    linearBackend:backend,wasmSparseFactor});
  const load=headingLoadToWorld({frame:'body-horizontal',originM:[.4,-.3,.8],
    forceN:[side*2,-3,1],momentNm:[1,side*-2,3]},pose);
  const f=checkDistribution(m,load),h=1/hz,old=m.pos.slice(),audit=m.step(f.forceN,h,80);
  assert(audit.solver.converged,'известный шаг должен довести общее уравнение');
  assert(audit.maxPhysicalResidualN<=IMPLICIT_TOLERANCES.forceToleranceN);
  assert(audit.maxHardViolationM<=IMPLICIT_TOLERANCES.lengthToleranceM);
  maxima.physicalResidualN=Math.max(maxima.physicalResidualN,audit.maxPhysicalResidualN);
  const cg=add(origin,scale(load.forceN,h*h/10)),alpha=scale(load.momentNm,.5);
  const length=Math.hypot(...alpha),axis=scale(alpha,1/length),angle=Math.atan(h*h*length);
  for(let i=0;i<4;i++) {
    const r=sub(point(old,i),origin);
    const turned=add(add(scale(r,Math.cos(angle)),scale(cross(axis,r),Math.sin(angle))),
      scale(axis,dot(axis,r)*(1-Math.cos(angle))));
    const expected=add(cg,turned);
    for(let d=0;d<3;d++) {
      const error=Math.abs(m.pos[3*i+d]-expected[d]);
      assert(error<=IMPLICIT_TOLERANCES.lengthToleranceM,'первый шаг не совпадает с независимым решением');
      maxima.knownPositionM=Math.max(maxima.knownPositionM,error);
    }
  }
  result.knownSteps++;
}

// Тот же перенос при настоящей совместной массе: одна точка ткани
// прикреплена в ЦТ. Независимый ответ зависит от 10+2 кг, не от 10 кг.
for(const hz of [60,120,240])for(const side of [-1,1]) {
  const origin=[3,-2,1],body=fourPointBody({massKg:10,principalInertiaKgM2:[2,2,2],originM:origin});
  const m=new RigidBodyEnergyMotion({positions:[...body.positionsM,...origin],mass:[...body.massKg,2],
    rigidBody:{nodes:[0,1,2,3],attachments:[4],frame:'inertial-cartesian'},constraints:[],dampingHz:0,
    linearBackend:backend,wasmSparseFactor});
  const F=[side,4,-3],clothF=[side*6,-2,1];
  const load={frame:'inertial-cartesian',originM:origin,forceN:F,momentNm:[0,0,0]};
  const f=checkDistribution(m,load).forceN;f.set(clothF,12);
  const h=1/hz,acc=scale(add(F,clothF),1/12),expected=add(origin,scale(acc,h*h));
  const audit=m.step(f,h,80);
  assert(audit.solver.converged&&audit.maxPhysicalResidualN<=IMPLICIT_TOLERANCES.forceToleranceN);
  assert(audit.maxHardViolationM<=IMPLICIT_TOLERANCES.lengthToleranceM);
  const reaction=sub(scale(acc,2),clothF);
  vector(point(audit.bodyAttachmentForceN,4),reaction,'реакция ткани от общей массы');
  vector(audit.bodyForceN,scale(reaction,-1),'встречная реакция корпуса');
  for(let d=0;d<3;d++) {
    const error=Math.abs(audit.bodyOriginM[d]-expected[d]);
    assert(error<=IMPLICIT_TOLERANCES.lengthToleranceM,'совместная масса даёт неверный перенос');
    maxima.knownPositionM=Math.max(maxima.knownPositionM,error);
  }
  const workBound=2*IMPLICIT_TOLERANCES.lengthToleranceM*reaction.reduce((s,v)=>s+Math.abs(v),0)+1e-9;
  assert(Math.abs(audit.bodyWorkCancellationResidualJ)<=workBound,'встречная работа крепления');
  maxima.physicalResidualN=Math.max(maxima.physicalResidualN,audit.maxPhysicalResidualN);
  result.coupledSteps++;
}

// Узлы корпуса не обязаны быть первыми: нагрузка не попадает на ткань.
const shiftedBody=fourPointBody({massKg:10,principalInertiaKgM2:[2,3,4],originM:[1,-2,.5]});
const shifted={pos:Float64Array.from([4,2,1,-1,3,0,...shiftedBody.positionsM]),
  mass:Float64Array.from([.1,.2,...shiftedBody.massKg]),
  rigidBody:{nodes:[2,3,4,5],frame:'inertial-cartesian'}};
const shiftedLoad={frame:'inertial-cartesian',originM:[0,0,0],forceN:[2,3,4],momentNm:[-1,4,2]};
const shiftedOut=checkDistribution(shifted,shiftedLoad);
assert.deepEqual(Array.from(shiftedOut.forceN.slice(0,6)),[0,0,0,0,0,0]);
assert.throws(()=>rigidBodyLoadForces({...shifted,rigidBody:{...shifted.rigidBody,frame:'body'}},shiftedLoad),/инерциальных/);
assert.throws(()=>rigidBodyLoadForces(shifted,{...shiftedLoad,forceN:[NaN,0,0]}),/конечный/);
const degenerate={pos:Float64Array.from([0,0,0,1,0,0,2,0,0,3,0,0]),mass:new Float64Array(4).fill(1),
  rigidBody:{nodes:[0,1,2,3],frame:'inertial-cartesian'}};
assert.throws(()=>rigidBodyLoadForces(degenerate,shiftedLoad),/Вырожденная/);

const m=pack.mass;
// Независимый аудит коэффициентов действующего Boat, без экипажа.
const translationKg=[m.total_kg*(1+m.added_surge),m.total_kg*(1+m.added_sway),m.total_kg*(1+m.added_heave)];
const rotationKgM2=[m.ixx_kg_m2*m.added_roll,m.iyy_kg_m2*(1+m.added_pitch),m.izz_kg_m2*(1+m.added_yaw)];
assert(translationKg[0]!==translationKg[1]&&translationKg[1]!==translationKg[2]);
assert(rotationKgM2[1]>rotationKgM2[0]+rotationKgM2[2],'отрицательный контроль требует несовместимой физической инерции');
assert.throws(()=>fourPointBody({massKg:m.total_kg,principalInertiaKgM2:rotationKgM2}),/не задаёт/);
result.massAudit={crewMassKg:0,dryBoatMassKg:m.total_kg,dryCgM:m.cg_m,
  dryPrincipalInertiaKgM2:[m.ixx_kg_m2,m.iyy_kg_m2,m.izz_kg_m2],
  rigBudget:m.budget.find(x=>x.name==='Рангоут и паруса'),
  effectiveTranslationKg:translationKg,effectiveRotationKgM2:rotationKgM2,
  rotationTriangleDeficitKgM2:rotationKgM2[1]-rotationKgM2[0]-rotationKgM2[2],
  fourPhysicalMassesCanRepresentWater:false};

const p=boatLoadPose({referenceOriginM:[0,0,0],cgBodyM:[0,0,0],psi:0,phi:0,th:0});
assert.throws(()=>headingLoadToWorld({frame:'body'},p),/горизонтальные/);
assert.throws(()=>worldLoadAtOrigin({frame:'body-horizontal'},[0,0,0]),/инерциальных/);
assert.throws(()=>rigLoadWithoutGennaker({phase:'до расчёта'},p),/расчётной фазы/);
assert.throws(()=>boatLoadPose({referenceOriginM:[0,NaN,0],cgBodyM:[0,0,0],psi:0,phi:0,th:0}),/конечный/);
if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(`ок (${backend}): ${result.poseCases} переводов, ${result.rigCases} состояний Rig, ${result.distributionCases} распределений, ${result.knownSteps} шагов тела и ${result.coupledSteps} общих шагов с тканью; сила, момент, мощность и исключение прежнего генакера`);
console.log(`аудит: эффективные массы воды ${translationKg.map(x=>x.toFixed(1)).join('/')} кг; инерция дифферента превышает сумму двух других на ${result.massAudit.rotationTriangleDeficitKgM2.toFixed(6)} кг·м² — четырёх физических масс недостаточно`);
