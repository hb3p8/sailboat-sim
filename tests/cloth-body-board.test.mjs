// Общая масса поступательной опоры и аффинной планки: независимые решения.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ImplicitEnergyMotion,IMPLICIT_TOLERANCES} from './lib/cloth-implicit-motion.mjs';
import {distance} from './cloth-compliance.mjs';
import {materialSurface} from './lib/cloth-material.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';

const args=process.argv.slice(2),backend=args.find(a=>a.startsWith('--linear-backend='))?.slice(17)??'band-js';
const wasm=args.find(a=>a.startsWith('--wasm='))?.slice(7),output=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.every(a=>/^--(linear-backend|wasm|out)=.+$/.test(a)) && new Set(args).size===args.length &&
  ['band-js','sparse-js','sparse-wasm','kkt-wasm'].includes(backend),'Некорректные параметры проверки');
assert(!backend.endsWith('wasm')||wasm,'Нужен --wasm=модуль');
assert(!output||!existsSync(output),'Запись нельзя перезаписывать');
const options={linearBackend:backend,wasmSparseFactor:wasm?await loadSparseFactor(readFileSync(wasm)):undefined};
const close=(a,b,tol=2e-9)=>assert(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const vector=(a,b,tol)=>a.forEach((v,d)=>close(v,b[d],tol));
const dot=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const add=(a,b)=>a.map((v,d)=>v+b[d]),sub=(a,b)=>a.map((v,d)=>v-b[d]),scale=(a,s)=>a.map(v=>v*s);
const point=(p,i)=>Array.from(p.slice(3*i,3*i+3));
const velocity=(m,i,h)=>scale(sub(point(m.pos,i),point(m.prev,i)),1/h);
const masses=[10,2,3,5,3],offset=[.2,.3,.4],directOffset=[-.1,.5,.2],fractions=[0,.4,1];
const boardOption=()=>({head:1,end:3,nodes:[1,2,3],fractions:fractions.slice()});
const bodyOption=()=>({node:0,attachments:[1,4],frame:'inertial-cartesian'});
// Числа получены непосредственно из пяти физических масс, независимо от w.
const A=16.08,B=5.48,C=.72,D=A*B-C*C,T=23,relativeMass=D/T;
const inverse=(a,b)=>[(B*a-C*b)/D,(A*b-C*a)/D];
const positions=(body,end)=>[...body,...add(body,offset),...add(scale(add(body,offset),.6),scale(end,.4)),...end,...add(body,directOffset)];
const make=(p,constraints=[],extra={})=>new ImplicitEnergyMotion({positions:p,mass:masses,board:boardOption(),
  translatingBody:bodyOption(),constraints,dampingHz:0,...extra,...options});
const result={linear:[],rigid:[],refinement:[],material:[]};
const maxima={forceResidualN:0,bodyResidualN:0,workCancellationJ:0,balanceIdentityJ:0,energyLimitRatio:0,
  momentumErrorNs:0,angularErrorNms:0};

function check(a,m) {
  assert(a.solver.converged);assert.equal(a.bodyFrame,'inertial-cartesian');
  assert(a.maxPhysicalResidualN<=IMPLICIT_TOLERANCES.forceToleranceN);
  assert(a.maxHardViolationM<=IMPLICIT_TOLERANCES.lengthToleranceM);
  assert(a.solver.complementarityJ<=IMPLICIT_TOLERANCES.complementarityToleranceJ);
  a.bodyBalanceResidualN.forEach(v=>assert(Math.abs(v)<=IMPLICIT_TOLERANCES.forceToleranceN));
  close(a.bodyWorkCancellationResidualJ,0,1e-9);
  const state=m.state(a.prediction,a.hS,m.hard.map(c=>-c.lambda/a.hS**2));
  let identity=0,displacementSum=0;
  for(let j=0;j<m.free.length;j++) {
    const k=m.free[j],delta=m.pos[k]-m.prev[k];identity+=state.residual[j]*delta;displacementSum+=Math.abs(delta);
  }
  const energyScale=['initialKineticJ','kineticJ','initialSoftEnergyJ','softEnergyJ','appliedWorkJ','dampingWorkJ',
    'hardWorkEstimateJ','supportWorkJ','inertiaIncrementJ','materialIncrementJ'].reduce((s,k)=>s+Math.abs(a[k]),0);
  const limit=IMPLICIT_TOLERANCES.forceToleranceN*displacementSum+16*m.pos.length*Number.EPSILON*energyScale;
  close(a.discreteBalanceResidualJ,identity,1e-9);
  assert(Math.abs(a.discreteBalanceResidualJ)<=limit,'Остаток работы превышает прежний силовой допуск');
  maxima.forceResidualN=Math.max(maxima.forceResidualN,a.maxPhysicalResidualN);
  maxima.bodyResidualN=Math.max(maxima.bodyResidualN,...a.bodyBalanceResidualN.map(Math.abs));
  maxima.workCancellationJ=Math.max(maxima.workCancellationJ,Math.abs(a.bodyWorkCancellationResidualJ));
  maxima.balanceIdentityJ=Math.max(maxima.balanceIdentityJ,Math.abs(a.discreteBalanceResidualJ-identity));
  maxima.energyLimitRatio=Math.max(maxima.energyLimitRatio,limit?Math.abs(a.discreteBalanceResidualJ)/limit:0);
}

function balances(m,a,old,oldV,force,dampingForce) {
  const h=a.hS,pError=[0,0,0],lError=[0,0,0];let pointScale=0;
  for(let i=0;i<m.mass.length;i++) {
    const p=point(m.pos,i),p0=point(old,i),v=velocity(m,i,h),dp=scale(sub(v,oldV[i]),m.mass[i]);
    const f=add(point(force,i),point(dampingForce,i));
    const deltaL=sub(cross(p,scale(v,m.mass[i])),cross(p0,scale(oldV[i],m.mass[i])));
    const increment=cross(sub(p,p0),dp),torque=cross(p,f);
    pointScale+=p.reduce((s,x)=>s+Math.abs(x),0);
    for(let d=0;d<3;d++) {pError[d]+=dp[d]-h*f[d];lError[d]+=deltaL[d]+increment[d]-h*torque[d];}
  }
  for(let d=0;d<3;d++)lError[d]-=h*a.bodyLockMomentNm[d];
  const count=m.free.length;
  pError.forEach(v=>assert(Math.abs(v)<=IMPLICIT_TOLERANCES.forceToleranceN*h*count+1e-9));
  lError.forEach(v=>assert(Math.abs(v)<=IMPLICIT_TOLERANCES.forceToleranceN*h*pointScale+1e-9));
  const pe=Math.hypot(...pError),le=Math.hypot(...lError);
  maxima.momentumErrorNs=Math.max(maxima.momentumErrorNs,pe);maxima.angularErrorNms=Math.max(maxima.angularErrorNms,le);
  return {pe,le};
}

// Известная энергия с несколькими узлами. Сумма коэффициентов нулевая:
// перенос всей системы не меняет пружину, оба конца участвуют в её градиенте.
const coefficients=[-.4,.1,.3,.2,-.2],gammaBody=-.32,gammaEnd=.32,k=20;
function springs(rest) {return [0,1,2].map(d=>({alpha:1/k,family:'известная многоточечная пружина',unit:'м',
  value(p){return {C:coefficients.reduce((s,v,i)=>s+v*p[3*i+d],0)-rest[d],
    grad:coefficients.map((v,i)=>[i,[0,0,0].map((_,axis)=>axis===d?v:0)])};}}));}
for(const hz of [60,120,240])for(const side of [-1,1])for(const damp of [false,true]) {
  const firstH=1/hz,body=[3,-2,1],end=add(add(body,offset),[2*side,.1,.2]),p=positions(body,end);
  // Нулевой вектор покоя не задаёт внешнего направления; сумма трёх
  // энергий инвариантна к вращению и не создаёт собственного момента.
  const rest=[0,0,0];
  const ownDamping=damp?.7:0,clothDamping=damp?6:0;
  const motion=make(p,springs(rest),{dampingHz:clothDamping,translatingBody:{...bodyOption(),dampingHz:ownDamping}});
  close(motion.bodyEffectiveMassKg,A);close(motion.boardMass,B);close(motion.boardCrossMass,C);
  const startV=[.3,-.2,.1];let xb=body.slice(),xe=end.slice(),vb=startV.slice(),ve=startV.slice(),priorH=firstH;
  motion.prev.set(positions(sub(xb,scale(vb,firstH)),sub(xe,scale(ve,firstH))));motion.prevDt=firstH;
  let maxPositionErrorM=0,maxReactionErrorN=0;
  for(let n=0;n<hz/4;n++) {
    // Переменный h проверяет, что смешанная масса не теряет историю скоростей.
    const h=(n%3===1?.5:n%3===2?1.5:1)/hz;
    const f=[[side,0,-10*9.81],[0,.2,-.2*9.81],[0,-.1,-.3*9.81],[side*5,1,-.5*9.81],[0,0,-.3*9.81]];
    const old=positions(xb,xe),prior=positions(sub(xb,scale(vb,priorH)),sub(xe,scale(ve,priorH)));
    const oldV=masses.map((_,i)=>scale(sub(point(old,i),point(prior,i)),1/priorH));
    const damping=masses.map((mass,i)=>scale(oldV[i],mass*(Math.exp(-(i===0?ownDamping:clothDamping)*h)-1)/h));
    const qBody=[0,1,2].map(d=>f[0][d]+damping[0][d]+f[4][d]+damping[4][d]+f[1][d]+damping[1][d]+.6*(f[2][d]+damping[2][d]));
    const qEnd=[0,1,2].map(d=>.4*(f[2][d]+damping[2][d])+f[3][d]+damping[3][d]);
    const predictedBody=[],predictedEnd=[];
    for(let d=0;d<3;d++) {const acc=inverse(qBody[d],qEnd[d]);
      predictedBody[d]=xb[d]+h*vb[d]+h*h*acc[0];predictedEnd[d]=xe[d]+h*ve[d]+h*h*acc[1];}
    const predicted=positions(predictedBody,predictedEnd),nextBody=[],nextEnd=[],extension=[];
    const massGradient=inverse(gammaBody,gammaEnd),denominator=1+h*h*k*(gammaBody*massGradient[0]+gammaEnd*massGradient[1]);
    for(let d=0;d<3;d++) {
      extension[d]=(coefficients.reduce((s,v,i)=>s+v*predicted[3*i+d],0)-rest[d])/denominator;
      nextBody[d]=predictedBody[d]-h*h*k*extension[d]*massGradient[0];
      nextEnd[d]=predictedEnd[d]-h*h*k*extension[d]*massGradient[1];
    }
    const next=positions(nextBody,nextEnd),nextV=masses.map((_,i)=>scale(sub(point(next,i),point(old,i)),1/h));
    const raw=masses.map((mass,i)=>[0,1,2].map(d=>mass*(nextV[i][d]-oldV[i][d])/h-f[i][d]-damping[i][d]+k*extension[d]*coefficients[i]));
    const headReaction=add(raw[1],scale(raw[2],.6)),bodyReaction=scale(add(headReaction,raw[4]),-1);
    const a=motion.step(f.flat(),h,80);check(a,motion);
    vector(motion.pos,next);vector(a.bodyAttachmentForceN.slice(3,6),headReaction);vector(a.bodyForceN,bodyReaction);
    vector(a.bodyMomentNm,scale(add(cross(offset,headReaction),cross(directOffset,raw[4])),-1));
    close(a.bodyWorkJ,dot(bodyReaction,sub(nextBody,xb)));
    close(a.kineticJ,.5*masses.reduce((s,m,i)=>s+m*dot(nextV[i],nextV[i]),0));
    balances(motion,a,old,oldV,f.flat(),damping.flat());
    maxPositionErrorM=Math.max(maxPositionErrorM,...next.map((v,i)=>Math.abs(v-motion.pos[i])));
    maxReactionErrorN=Math.max(maxReactionErrorN,...headReaction.map((v,d)=>Math.abs(v-a.bodyAttachmentForceN[3+d])));
    vb=scale(sub(nextBody,xb),1/h);ve=scale(sub(nextEnd,xe),1/h);xb=nextBody;xe=nextEnd;priorH=h;
  }
  result.linear.push({hz,side,damping:damp,maxPositionErrorM,maxReactionErrorN});
}

// Независимый первый шаг с жёсткой длиной: после предсказания фиксирован
// общий ЦТ, а относительный вектор проецируется на окружность/сферу.
for(const hz of [60,120,240])for(const axis of [[1,0,0],[-1,0,0],[2,-1,3].map(v=>v/Math.sqrt(14))]) {
  const h=1/hz,body=[3,-2,1],end=add(add(body,offset),scale(axis,2)),motion=make(positions(body,end),[distance(1,3,2,0)]);
  const v=[.3,-.2,.1],relativeVelocity=[-.04,.2,.1];
  const old=motion.pos.slice(),prior=positions(sub(body,scale(v,h)),sub(end,scale(add(v,relativeVelocity),h)));
  motion.prev.set(prior);motion.prevDt=h;
  const oldV=masses.map((_,i)=>scale(sub(point(old,i),point(prior,i)),1/h));
  const forces=[[1,-2,3],[.1,.2,.3],[-.3,.4,1],[5,-3,2],[-1,2,-1]],qb=[],qe=[];
  for(let d=0;d<3;d++) {
    const f0=forces[0][d]+forces[1][d]+.6*forces[2][d]+forces[4][d],f1=.4*forces[2][d]+forces[3][d];
    const acc=inverse(f0,f1);qb[d]=body[d]+h*v[d]+h*h*acc[0];qe[d]=end[d]+h*(v[d]+relativeVelocity[d])+h*h*acc[1];
  }
  const relative=sub(sub(qe,qb),offset),norm=Math.hypot(...relative),u=scale(relative,1/norm),delta=scale(u,2-norm);
  const nextBody=sub(qb,scale(delta,(B+C)/T)),nextEnd=add(qe,scale(delta,(A+C)/T)),next=positions(nextBody,nextEnd);
  const mu=relativeMass*(norm-2)/(h*h),hard=forces.map(()=>[0,0,0]);hard[1]=scale(u,mu);hard[3]=scale(u,-mu);
  const nextV=masses.map((_,i)=>scale(sub(point(next,i),point(old,i)),1/h));
  const raw=masses.map((mass,i)=>sub(sub(scale(sub(nextV[i],oldV[i]),mass/h),forces[i]),hard[i]));
  const expectedHead=add(raw[1],scale(raw[2],.6)),expectedBody=scale(add(expectedHead,raw[4]),-1);
  const a=motion.step(forces.flat(),h,80);check(a,motion);
  vector(motion.pos,next);vector(a.bodyForceN,expectedBody);vector(a.bodyAttachmentForceN.slice(3,6),expectedHead);
  close(motion.constraints[0].lambda,-mu*h*h);
  const errors=balances(motion,a,old,oldV,forces.flat(),new Array(old.length).fill(0));
  result.rigid.push({hz,axis,maxPositionErrorM:Math.max(...next.map((v,i)=>Math.abs(v-motion.pos[i]))),
    momentumErrorNs:errors.pe,angularErrorNms:errors.le});
}

// Непрерывное внутреннее колебание проверяет уточнение времени и общий ЦТ.
let previousError=Infinity;
for(const hz of [60,120,240]) {
  const h=1/hz,body=[0,0,0],end=add(offset,[2.2,0,0]);
  const spring={alpha:1/20,family:'известная пружина',value(p){return {C:p[9]-p[3]-2,grad:[[1,[-1,0,0]],[3,[1,0,0]]]};}};
  const motion=make(positions(body,end),[spring]);
  const expectedBodyX=(B+C)/T*.2*(1-Math.cos(Math.sqrt(20/relativeMass)));
  const initialCentre=masses.reduce((s,m,i)=>s+m*motion.pos[3*i],0);
  for(let n=0;n<hz;n++) {
    const a=motion.step(new Float64Array(15),h,80);check(a,motion);
    close(masses.reduce((s,m,i)=>s+m*motion.pos[3*i],0),initialCentre);
    close(masses.reduce((s,m,i)=>s+m*velocity(motion,i,h)[0],0),0);
  }
  const errorM=Math.abs(motion.pos[0]-expectedBodyX);assert(errorM<previousError);previousError=errorM;
  result.refinement.push({hz,bodyXM:motion.pos[0],expectedBodyXM:expectedBodyX,errorM});
}

// Настоящее полотно из трёх треугольников, аффинная верхняя кромка и
// удерживаемый на опоре нижний угол. Ветер задан известной внешней силой.
for(const hz of [60,120,240])for(const side of [-1,1])for(const drift of [false,true]) {
  const h=1/hz,body=[3,-2,1],head=add(body,offset),end=add(head,[2*side,0,0]);
  const p=[...body,...head,...add(head,[.8*side,0,0]),...end,...add(head,[0,-1,0]),...add(head,[2*side,-1,0])];
  const material=materialSurface(p,[[4,5,2],[4,2,1],[5,3,2]],{bulkNPerM:1000,shearNPerM:50,bendingNm:0});
  const mass=[...masses,4],motion=new ImplicitEnergyMotion({positions:p,mass,board:boardOption(),translatingBody:bodyOption(),
    constraints:[...material.constraints,distance(1,3,2,0)],dampingHz:0,...options});
  const startV=drift?[1.3,-.2,.1]:[0,0,0];
  for(let i=0;i<mass.length;i++)for(let d=0;d<3;d++)motion.prev[3*i+d]-=h*startV[d];motion.prevDt=h;
  const force=[1,-.5,0,0,0,0,0,0,0,0,0,0,0,0,0,2*side,0,1];let pe=0,le=0;
  for(let n=0;n<hz/4;n++) {
    const old=motion.pos.slice(),oldV=mass.map((_,i)=>velocity(motion,i,h)),a=motion.step(force,h,80);check(a,motion);
    const errors=balances(motion,a,old,oldV,force,new Array(p.length).fill(0));pe=Math.max(pe,errors.pe);le=Math.max(le,errors.le);
  }
  result.material.push({hz,side,initialDrift:drift,maxMomentumErrorNs:pe,maxAngularErrorNms:le});
}

// Отрицательный контроль: удаление C из обеих диагоналей создаёт общий
// импульс даже при единственной известной внешней силе на свободном конце.
const forceN=5,h=1/60,exact=inverse(0,forceN),diagonal=[0,forceN/B];
const wrongMomentumNs=h*((A+C)*diagonal[0]+(B+C)*diagonal[1]-forceN);
close(h*((A+C)*exact[0]+(B+C)*exact[1]),h*forceN);assert(Math.abs(wrongMomentumNs)>IMPLICIT_TOLERANCES.forceToleranceN*h);
const unforced=make(positions([0,0,0],add(offset,[2,0,0]))),f=new Float64Array(15);f[9]=forceN;
const freeAudit=unforced.step(f,h,80);check(freeAudit,unforced);
close(velocity(unforced,0,h)[0]/h,exact[0]);close(velocity(unforced,3,h)[0]/h,exact[1]);
assert.throws(()=>unforced.project(distance(1,3,2,0),h),/требует полного уравнения/);
result.diagonalControl={massMatrixKg:[[A,C],[C,B]],exactAccelerationMS2:exact,diagonalAccelerationMS2:diagonal,wrongMomentumNs};

// Полный отказ не переносит скрытое движение в следующий шаг; конфигурация
// принадлежит расчёту, прямое изменение промежуточных узлов не является командой.
const nonlinear=make(positions([0,0,0],add(offset,[2,0,0])),[distance(1,3,2,0),distance(4,3,1,.05)]);
const snapshot=m=>({pos:Array.from(m.pos),prev:Array.from(m.prev),prevDt:m.prevDt,lambda:m.constraints.map(c=>c.lambda),
  mu:m.lastMu?Array.from(m.lastMu):undefined,active:m.supportMotionActive,fixed:Array.from(m.fixedPositions)});
const before=snapshot(nonlinear),load=new Float64Array(15);load.set([15,12,8],9);
assert.throws(()=>nonlinear.step(load,.1,1),/не доведено|Не найден/);assert.deepEqual(snapshot(nonlinear),before);
check(nonlinear.step(load,.1,80),nonlinear);
for(const field of ['pos','prev']) {
  const saved=snapshot(nonlinear),old=nonlinear[field][6];nonlinear[field][6]+=.001;
  assert.throws(()=>nonlinear.step(load,h,80),/вне общего шага/);nonlinear[field][6]=old;assert.deepEqual(snapshot(nonlinear),saved);
}
const descriptor=boardOption(),bodyDescriptor=bodyOption(),owned=make(positions([0,0,0],add(offset,[2,0,0])),[],
  {board:descriptor,translatingBody:bodyDescriptor});descriptor.fractions[1]=.8;bodyDescriptor.attachments[0]=2;
assert.deepEqual(owned.board.fractions,fractions);assert.deepEqual(owned.translatingBody.attachments,[1,4]);
assert.throws(()=>{owned.board.fractions[1]=.8;},TypeError);
for(const attachments of [[4],[1,2,4],[1,3,4]])
  assert.throws(()=>make(positions([0,0,0],add(offset,[2,0,0])),[],{translatingBody:{...bodyOption(),attachments}}),/верхнее крепление/);
assert.throws(()=>make(positions([0,0,0],add(offset,[2,0,0])),[],{board:{...boardOption(),nodes:[0,1,3],fractions:[.5,0,1]}}),/верхнее крепление/);
result.verification=maxima;
if(output) {
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const paths=['tests/cloth-body-board.test.mjs','tests/lib/cloth-energy-motion.mjs','tests/lib/cloth-implicit-motion.mjs',
    'tests/lib/cloth-linear-solve.mjs','tests/lib/cloth-kkt-direction.mjs','tests/lib/cloth-sparse-solve.mjs',
    'tests/lib/cloth-sparse-wasm.mjs','tests/cloth-compliance.mjs','tests/lib/cloth-material.mjs'];
  writeFileSync(output,JSON.stringify({schema:1,createdAt:new Date().toISOString(),
    revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
    sourceSha256:Object.fromEntries(paths.map(p=>[p,hash(readFileSync(p))])),
    wasm:wasm?{path:wasm,sha256:hash(readFileSync(wasm))}:null,linearBackend:backend,tolerances:IMPLICIT_TOLERANCES,
    scope:'Поступательная опора, распределённая масса аффинной планки, жёсткая длина и известное полотно. Ориентацию опоры удерживает направляющая. Это не свободное вращение лодки и не G4.',result},null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({проверка:'совместное движение опоры и верхней планки',способ:backend,result,output},null,2));
