// Независимые движения, реакции и работа предписанных закреплений.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ImplicitEnergyMotion,IMPLICIT_TOLERANCES} from './lib/cloth-implicit-motion.mjs';
import {EnergyMotion} from './lib/cloth-energy-motion.mjs';
import {distance} from './cloth-compliance.mjs';
import {materialSurface,gridTriangles,MODEL_MATERIAL} from './lib/cloth-material.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';

const args=process.argv.slice(2), backendArg=args.find(a=>a.startsWith('--linear-backend=')), wasmArg=args.find(a=>a.startsWith('--wasm='));
if(args.some(a=>a!==backendArg && a!==wasmArg) || new Set(args).size!==args.length) throw new Error('Допустимы --linear-backend=способ и --wasm=путь');
const backend={linearBackend:backendArg?.slice(17)??'band-js',
  ...(wasmArg?{wasmSparseFactor:await loadSparseFactor(readFileSync(wasmArg.slice(7)))}:{})};
const close=(a,b,tol=1e-10)=>assert(Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const point=(origin,e,x)=>origin.map((v,d)=>v+e[d]*x);
const targets=(node,positionM)=>[{node,positionM}];
let maxForceResidualN=0,maxBalanceResidualJ=0;
function check(a) {
  assert(a.solver.converged); assert(a.solver.maxForceResidualN<=IMPLICIT_TOLERANCES.forceToleranceN);
  assert(a.maxPhysicalResidualN<=IMPLICIT_TOLERANCES.forceToleranceN);
  assert(a.maxHardViolationM<=IMPLICIT_TOLERANCES.lengthToleranceM);
  close(a.discreteBalanceResidualJ,0);
  maxForceResidualN=Math.max(maxForceResidualN,a.maxPhysicalResidualN);
  maxBalanceResidualJ=Math.max(maxBalanceResidualJ,Math.abs(a.discreteBalanceResidualJ));
}

// Неподвижная точка компенсирует заданную внешнюю силу и не совершает работы.
const held=new ImplicitEnergyMotion({positions:[0,0,0],mass:[2],fixed:[0],constraints:[],...backend});
let a=held.step([2,-3,4],1/60,80,[]); check(a);
assert.deepEqual(Array.from(a.supportForceN),[-2,3,-4]); close(a.supportWorkJ,0);

// Пружина с движущимся концом: скалярное решение, без численной ткани.
// Проверяются поворот/зеркало/перенос, смена h, торможение и оба направления.
for(const [e,origin] of [[[1,0,0],[0,0,0]],[[-1,0,0],[0,0,0]],
    [[2,-1,3].map(v=>v/Math.sqrt(14)),[3,-5,2]]]) {
  const K=40,m0=2,m1=3,L=1,dampingHz=6;
  const motion=new ImplicitEnergyMotion({positions:[...point(origin,e,0),...point(origin,e,L)],
    mass:[m0,m1],fixed:[0],constraints:[distance(0,1,L,1/K)],dampingHz,...backend});
  let t=0,s=0,x=L,vs=0,vx=0;
  for(let n=0;n<40;n++) {
    const h=[1/30,1/60,1/120][n%3],nextT=t+h,nextS=.03*Math.sin(2*Math.PI*nextT);
    const F0=-.4,F1=2,decay=Math.exp(-dampingHz*h),pred=x+decay*vx*h+h*h*F1/m1;
    const nextX=(m1*pred/(h*h)+K*(nextS+L))/(m1/(h*h)+K);
    const nextVs=(nextS-s)/h,nextVx=(nextX-x)/h,extension=nextX-nextS-L,priorExtension=x-s-L;
    const reaction=m0*(nextVs-vs)/h-F0-m0*(decay-1)*vs/h-K*extension;
    a=motion.step([...e.map(v=>v*F0),...e.map(v=>v*F1)],h,80,targets(0,point(origin,e,nextS))); check(a);
    motion.pos.slice(3).forEach((v,d)=>close(v,point(origin,e,nextX)[d]));
    a.supportForceN.slice(0,3).forEach((v,d)=>close(v,e[d]*reaction));
    close(a.kineticJ,.5*m0*nextVs**2+.5*m1*nextVx**2);
    close(a.supportWorkJ,reaction*(nextS-s));
    close(a.appliedWorkJ,F0*(nextS-s)+F1*(nextX-x));
    close(a.inertiaIncrementJ,.5*m0*(nextVs-vs)**2+.5*m1*(nextVx-vx)**2);
    close(a.materialIncrementJ,.5*K*(extension-priorExtension)**2);
    t=nextT;s=nextS;x=nextX;vs=nextVs;vx=nextVx;
  }
}
console.log('ок: пружина, реакции/работа, поворот, зеркало, перенос, переменный подшаг и обратное движение');

// Аффинная планка без условия длины: независимая полная матрица масс 2×2.
const mass=[2,3,5],fractions=[0,.4,1],board={head:0,end:2,nodes:[0,1,2],fractions};
const initial=[0,0,0,.8,0,0,2,0,0],Mh=3.08,Me=5.48,Mhe=.72;
const affine=new ImplicitEnergyMotion({positions:initial,mass,fixed:[0],board,constraints:[],dampingHz:6,...backend});
const delta=[.01,-.02,.03],h=1/60;
a=affine.step(new Array(9).fill(0),h,80,targets(0,delta));check(a);
for(let d=0;d<3;d++) {
  close(affine.pos[6+d],initial[6+d]-Mhe/Me*delta[d]);
  close(a.supportForceN[d],(Mh-Mhe*Mhe/Me)*delta[d]/(h*h));
}
close(a.supportWorkJ,(Mh-Mhe*Mhe/Me)*dot(delta,delta)/(h*h));
const accepted=affine.pos.slice();
// Без новой команды голова удерживается на месте; её прежняя скорость
// всё ещё входит в предсказание. Нельзя терять смешанный член на этом шаге.
a=affine.step(new Array(9).fill(0),1/120,80);check(a);
affine.pos.forEach((v,i)=>close(v,accepted[i]));
console.log('ок: полная масса аффинной планки, смешанный член и удержание после движения');

// Длина жёсткой планки: перенос вдоль её оси двигает всю её массу.
for(const e of [[1,0,0],[-1,0,0],[2,-1,3].map(v=>v/Math.sqrt(14))]) {
  const origin=[3,-5,2],p=fractions.flatMap(t=>point(origin,e,2*t));
  const rigid=new ImplicitEnergyMotion({positions:p,mass,fixed:[0],board,
    constraints:[distance(0,2,2,0)],dampingHz:0,...backend});
  const shift=.01,totalMass=10;
  a=rigid.step(new Array(9).fill(0),h,80,targets(0,point(origin,e,shift)));check(a);
  for(let i=0;i<3;i++) for(let d=0;d<3;d++) close(rigid.pos[3*i+d],p[3*i+d]+e[d]*shift);
  a.supportForceN.slice(0,3).forEach((v,d)=>close(v,totalMass*e[d]*shift/(h*h)));
  close(a.kineticJ,.5*totalMass*(shift/h)**2);close(a.supportWorkJ,totalMass*(shift/h)**2);
  const torque=[0,0,0];
  for(let i=0;i<3;i++) {
    const f=e.map(v=>mass[i]*v*shift/(h*h)),m=cross(Array.from(rigid.pos.slice(3*i,3*i+3)),f);
    m.forEach((v,d)=>{torque[d]+=v;});
  }
  cross(Array.from(rigid.pos.slice(0,3)),Array.from(a.supportForceN.slice(0,3))).forEach((v,d)=>close(v,torque[d]));
}
console.log('ок: жёсткая планка, вся масса, сила/момент и работа в трёх направлениях');

// Поперечное движение головы: известный минимум на окружности вокруг новой
// головы. Предсказание включает смешанную массу, а конец свободно вращается.
for(const side of [-1,1]) {
  const rigid=new ImplicitEnergyMotion({positions:initial,mass,fixed:[0],board,
    constraints:[distance(0,2,2,0)],dampingHz:0,...backend});
  const head=[0,side*.02,0],pred=[2,-Mhe/Me*head[1],0],relative=pred.map((v,d)=>v-head[d]);
  const norm=Math.hypot(...relative),u=relative.map(v=>v/norm),end=head.map((v,d)=>v+2*u[d]);
  const mu=Me*(norm-2)/(h*h),reaction=head.map((v,d)=>(Mh*v+Mhe*(end[d]-initial[6+d]))/(h*h)-mu*u[d]);
  a=rigid.step(new Array(9).fill(0),h,80,targets(0,head));check(a);
  rigid.pos.slice(6).forEach((v,d)=>close(v,end[d]));
  a.supportForceN.slice(0,3).forEach((v,d)=>close(v,reaction[d]));
  close(a.supportWorkJ,dot(reaction,head));
}
console.log('ок: свободный поворот жёсткой планки при поперечном движении головы');

// Полное полотно должно сохранять форму при равномерном переносе всех
// закреплений и согласованной начальной скорости всех его масс.
const rows=4,cols=5,referenceCloth=[];
for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) {
  const x=c/(cols-1),y=r/(rows-1);
  referenceCloth.push(x,y,.05*x*y+.02*Math.sin(Math.PI*y)*Math.sin(Math.PI*x));
}
const surface=materialSurface(referenceCloth,gridTriangles(rows,cols),MODEL_MATERIAL,{bendingModel:'curvature',rows,cols});
const head=(rows-1)*cols,end=rows*cols-1,rest=Math.hypot(...referenceCloth.slice(3*end).map((v,d)=>v-referenceCloth[3*head+d]));
const cloth=new ImplicitEnergyMotion({positions:referenceCloth,mass:new Array(rows*cols).fill(.3),fixed:[0,cols-1,head],
  board:{head,end,nodes:Array.from({length:cols},(_,i)=>head+i),fractions:Array.from({length:cols},(_,i)=>i/(cols-1))},
  constraints:[...surface.constraints,distance(head,end,rest,0)],dampingHz:0,gridRows:rows,gridCols:cols,...backend});
const clothInitial=cloth.pos.slice(),velocity=[.1,-.03,.07];cloth.prevDt=h;
cloth.prev.forEach((v,k)=>{cloth.prev[k]=v-velocity[k%3]*h;});
for(let n=1;n<=12;n++) {
  const command=Array.from(cloth.fixed,node=>({node,positionM:Array.from(clothInitial.slice(3*node,3*node+3),(v,d)=>v+velocity[d]*n*h)}));
  a=cloth.step(new Array(referenceCloth.length).fill(0),h,80,command);check(a);
  cloth.pos.forEach((v,k)=>close(v,clothInitial[k]+velocity[k%3]*n*h));
  close(a.kineticJ,.5*6*dot(velocity,velocity));close(a.supportWorkJ,0);
}
console.log('ок: перенос полного полотна с планкой сохраняет форму, скорость и энергию');

// Известная траектория отдельной массы q=a t²/2. Дискретная работа:
// W=m|a|²/2 − m|a|² h²/4; ошибка непрерывного ответа уменьшается вчетверо.
const acceleration=[.4,-.2,.1],norm2=dot(acceleration,acceleration),refinement=[];
for(const hz of [60,120,240]) {
  const body=new ImplicitEnergyMotion({positions:[0,0,0],mass:[2],fixed:[0],constraints:[],dampingHz:0,...backend});
  let work=0;
  for(let n=1;n<=hz;n++) {a=body.step([0,0,0],1/hz,80,targets(0,acceleration.map(v=>.5*v*(n/hz)**2)));check(a);work+=a.supportWorkJ;}
  close(work,norm2-.5*norm2/(hz*hz));close(a.kineticJ,norm2*(1-.5/hz)**2);
  refinement.push({hz,workJ:work,errorJ:Math.abs(work-norm2)});
}
close(refinement[0].errorJ/refinement[1].errorJ,4,1e-7);close(refinement[1].errorJ/refinement[2].errorJ,4,1e-7);
console.log(JSON.stringify({проверка:'сходимость работы заданной траектории',refinement}));

// Отказ не меняет принятые координаты/скорости, команды, множители и режим.
const snapshot=m=>({pos:Array.from(m.pos),prev:Array.from(m.prev),dt:m.prevDt,lambda:m.constraints.map(c=>c.lambda),
  mu:m.lastMu?Array.from(m.lastMu):null,targets:Array.from(m.fixedPositions),active:m.supportMotionActive});
const pinned=new ImplicitEnergyMotion({positions:[0,0,0,1,0,0],mass:[1,1],fixed:[0,1],constraints:[distance(0,1,1,0)],...backend});
pinned.step(new Array(6).fill(0),h,80,[]);let before=snapshot(pinned);
assert.throws(()=>pinned.step(new Array(6).fill(0),h,80,targets(1,[2,0,0])),/связь между неподвижными/);
assert.deepEqual(snapshot(pinned),before);
for(const command of [targets(2,[0,0,0]),targets(0,[NaN,0,0]),[...targets(0,[0,0,0]),...targets(0,[0,0,0])]]) {
  assert.throws(()=>pinned.step(new Array(6).fill(0),h,80,command),/команда|дважды/);assert.deepEqual(snapshot(pinned),before);
}
a=pinned.step(new Array(6).fill(0),h,80,[...targets(0,[.01,0,0]),...targets(1,[1.01,0,0])]);check(a);
const reference=[0,0,0,1,0,0,0,1,0];
const nonlinear=new ImplicitEnergyMotion({positions:reference,mass:[1,1,1],fixed:[0,2],
  constraints:materialSurface(reference,[[0,1,2]],{bulkNPerM:1000,shearNPerM:50,bendingNm:0}).constraints,...backend});
nonlinear.step([0,0,0,10,0,0,0,0,0],h,80);before=snapshot(nonlinear);
assert.throws(()=>nonlinear.step([0,0,0,500,0,0,0,0,0],h,1,targets(0,[.2,0,0])),/не доведено|Не найден/);
assert.deepEqual(snapshot(nonlinear),before);
const approximate=new EnergyMotion({positions:[0,0,0],mass:[1],fixed:[0],constraints:[]});
assert.throws(()=>approximate.step([0,0,0],h,1,targets(0,[.1,0,0])),/полного уравнения/);
console.log('ок: несовместимая команда, неверный ввод, недоведённый шаг, полный возврат состояния и запрет приближённого режима');
console.log(JSON.stringify({проверка:'подвижные закрепления',способ:backend.linearBackend,maxForceResidualN,maxBalanceResidualJ}));
