// Новая энергия ткани на заданных креплениях обычного Boat.
// Это последовательная связь двух моделей, не общий неявный шаг тела и ткани.
import {Cloth} from './cloth.js';
import {ImplicitEnergyMotion} from './cloth/cloth-implicit-motion.mjs';
import {materialSurface,gridTriangles,MODEL_MATERIAL} from './cloth/cloth-material.mjs';
import {distance} from './cloth/cloth-compliance.mjs';
import {sv20SailMass} from './cloth/cloth-sv20-mass.mjs';
import {rotate3,transpose3,cross3} from './cloth/cloth-fluid-inertia.mjs';
import {boatBodyRotation} from './axes.js';

export function gennakerPose(b) {
  return {originM:[b.x,b.y,b.zc],angles:[b.psi,b.phi,b.th],orientation9:boatBodyRotation(b.psi,b.phi,b.th)};
}
export const worldPoint=(pose,p)=>rotate3(pose.orientation9,p).map((v,d)=>v+pose.originM[d]);
export const localPoint=(pose,p)=>rotate3(transpose3(pose.orientation9),p.map((v,d)=>v-pose.originM[d]));

// JSON сам превращает −0 в +0. В версионном численном снимке знак нуля
// хранится строкой; остальные числа остаются читаемыми числами в СИ.
function stateNumbers(value,reading=false) {
  if(reading&&value==='-0')return -0;
  if(!reading&&Object.is(value,-0))return '-0';
  if(Array.isArray(value))return value.map(v=>stateNumbers(v,reading));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,stateNumbers(v,reading)]));
  return value;
}

export function gennakerBodyPack(pack,recipe) {
  const budget=sv20SailMass(pack,recipe), m=pack.mass, a=budget.audit, J=a.dryInertia9;
  // Boat хранит диагональные моменты: перекрёстные члены общего стенда здесь
  // не вводятся. Прежняя диагональная водная добавка сохраняется.
  const mass={...m,total_kg:a.bodyKg,cg_m:a.bodyCGM.slice(),
    ixx_kg_m2:J[0],iyy_kg_m2:J[4],izz_kg_m2:J[8],
    added_surge:m.total_kg*m.added_surge/a.bodyKg,
    added_sway:m.total_kg*m.added_sway/a.bodyKg,
    added_roll:1+m.ixx_kg_m2*(m.added_roll-1)/J[0],
    added_yaw:m.izz_kg_m2*m.added_yaw/J[8],
    added_pitch:m.iyy_kg_m2*(m.added_pitch??.9)/J[4],
    added_heave:m.total_kg*(m.added_heave??1.2)/a.bodyKg};
  return {pack:{...pack,mass},budget};
}

export function energyCloth(recipe,pack) {
  const r=recipe,n=r.rows*r.cols;
  return Object.assign(Object.create(Cloth.prototype),{energyGennaker:true,si:2,rows:r.rows,cols:r.cols,n,nRows:r.rows,
    pos:Float64Array.from(r.positions.slice(0,3*n)),prev:Float64Array.from(r.positions.slice(0,3*n)),frc:new Float64Array(3*n),nrm:new Float64Array(3*n),
    area:new Float64Array(n),rhoAir:pack.environment.rho_air,prevDt:1/60,step(){},cut3d:true,
    dx:Float64Array.from({length:n},(_,i)=>r.reference[3*i]),dy:Float64Array.from({length:n},(_,i)=>r.reference[3*i+1]),dz:Float64Array.from({length:n},(_,i)=>r.reference[3*i+2])});
}
export function intermediatePose(a,b) {
  const angles=b.angles.map((v,d)=>a.angles[d]+Math.atan2(Math.sin(v-a.angles[d]),Math.cos(v-a.angles[d]))/2);
  return {originM:b.originM.map((v,d)=>(v+a.originM[d])/2),angles,orientation9:boatBodyRotation(...angles)};
}

export function prescribedGennaker(fixture,pack,pose,factor,materialKernel,{observeAttempt}={}) {
  const r=fixture.recipe,n=r.rows*r.cols,anchor=n;
  if(n!==99||!fixture.sheet)throw new Error('Живой перенос требует сетку 11×9 и верёвку');
  // Неподвижное начало инерциальных осей у места подъёма: те же уравнения,
  // но тонкие верхние элементы не вычитают километровые координаты карты.
  const frameOriginM=pose.originM.slice(),positions=r.positions.slice(0,3*n),mass=r.mass.slice(0,n);
  const framePose=p=>({...p,originM:p.originM.map((v,d)=>v-frameOriginM[d])});
  for(let i=0;i<n;i++)positions.splice(3*i,3,...rotate3(pose.orientation9,positions.slice(3*i,3*i+3)));
  positions.push(...rotate3(pose.orientation9,fixture.sheet.localM));mass.push(1);
  const surface=materialSurface(r.reference,gridTriangles(r.rows,r.cols),MODEL_MATERIAL,
    {bendingModel:'curvature',rows:r.rows,cols:r.cols,materialKernel});
  const rope=distance(fixture.sheet.node,anchor,fixture.sheet.lengthM,0,true);
  const constraints=[...surface.constraints,...r.hard.map(c=>Object.assign(distance(c.a,c.b,c.rest,0,c.unilateral),{family:c.family})),rope];
  const fixed=[0,r.board.head,anchor];
  const motion=new ImplicitEnergyMotion({positions,mass,constraints,fixed,board:r.board,
    dampingHz:0,linearBackend:'kkt-wasm',wasmSparseFactor:factor});
  // Последний узел — геометрическая точка крепления верёвки, без массы.
  motion.mass[anchor]=0;
  const budget=sv20SailMass(pack,r),referenceSupports=fixed.map(i=>i===anchor?fixture.sheet.localM:r.positions.slice(3*i,3*i+3));
  let index=0,lengthM=fixture.sheet.lengthM,lastPose=pose;
  const minLengthM=lengthM,maxLengthM=lengthM+.25;
  // Версия задаёт состояние между принятыми подшагами. Кэш разложения и
  // рабочие буферы материала не несут истории: после загрузки строятся заново.
  const configuration=JSON.stringify({recipe:r,sheet:fixture.sheet,mass:pack.mass,
    gravity:pack.environment.g,material:MODEL_MATERIAL});
  const calculation={motion,budget,minLengthM,maxLengthM,snapshot() {
    return stateNumbers({schema:'gennaker-prescribed-state-v1',configuration,index,lengthM,
      frameOriginM:frameOriginM.slice(),lastPose:structuredClone(lastPose),
      motion:{pos:Array.from(motion.pos),prev:Array.from(motion.prev),prevDt:motion.prevDt,
        lambda:motion.constraints.map(c=>c.lambda),lastMu:motion.lastMu?Array.from(motion.lastMu):null,
        supportMotionActive:motion.supportMotionActive,
        fixedPositions:Array.from(motion.fixedPositions,([node,positionM])=>({node,positionM:positionM.slice()}))}});
  },restore(state) {
    // Вся проверка предшествует записи. В частности, повреждённая скорость,
    // множитель или закрепление не оставляют половину нового состояния.
    state=stateNumbers(state,true);
    const bad=()=>{throw new Error('Некорректный снимок расчёта генакера');};
    const vector=(v,n)=>Array.isArray(v)&&v.length===n&&Array.from(v).every(Number.isFinite);
    const validPose=p=>p&&vector(p.originM,3)&&vector(p.angles,3)&&vector(p.orientation9,9)&&
      p.orientation9.every((v,i)=>v===boatBodyRotation(...p.angles)[i]);
    if(state?.schema!=='gennaker-prescribed-state-v1'||state.configuration!==configuration||
        !Number.isSafeInteger(state.index)||state.index<0||!Number.isFinite(state.lengthM)||
        state.lengthM<minLengthM||state.lengthM>maxLengthM||!vector(state.frameOriginM,3)||!validPose(state.lastPose))bad();
    const s=state.motion;
    if(!s||!vector(s.pos,motion.pos.length)||!vector(s.prev,motion.prev.length)||
        !vector(s.lambda,motion.constraints.length)||
        !(s.lastMu===null||vector(s.lastMu,motion.hard.length))||
        !(state.index===0?s.prevDt===0:[1/60,1/120,1/240].includes(s.prevDt))||
        typeof s.supportMotionActive!=='boolean'||s.supportMotionActive!==(state.index>0)||
        (state.index===0?s.lastMu!==null:s.lastMu===null)||!Array.isArray(s.fixedPositions)||s.fixedPositions.length!==fixed.length)bad();
    for(let j=0;j<fixed.length;j++) {
      const f=s.fixedPositions[j];
      if(f?.node!==fixed[j]||!vector(f.positionM,3)||f.positionM.some((v,d)=>v!==s.pos[3*f.node+d]))bad();
      const expected=worldPoint({...state.lastPose,originM:state.lastPose.originM.map((v,d)=>v-state.frameOriginM[d])},referenceSupports[j]);
      if(expected.some((v,d)=>Math.abs(v-f.positionM[d])>32*Number.EPSILON*Math.max(1,Math.abs(v),Math.abs(f.positionM[d]))))bad();
    }
    const {head,end,nodes,fractions}=motion.board;
    for(const field of [s.pos,s.prev])for(let j=0;j<nodes.length;j++)for(let d=0;d<3;d++) {
      const a=field[3*nodes[j]+d],b=field[3*head+d]+fractions[j]*(field[3*end+d]-field[3*head+d]);
      if(Math.abs(a-b)>32*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)))bad();
    }
    // Снимок после шага обязан удовлетворять тем же жёстким ограничениям,
    // что и принятый ответ решателя. Допуск для загрузки не расширяется.
    if(state.index>0)for(let j=0;j<motion.hard.length;j++) {
      const c=motion.hard[j],value=j===motion.hard.length-1?
        distance(fixture.sheet.node,anchor,state.lengthM,0,true).value:c.value;
      const {C}=value(s.pos);
      if(!Number.isFinite(C)||(c.unilateral?Math.max(0,C):Math.abs(C))>motion.lengthToleranceM)bad();
    }
    const copy=structuredClone(state);
    frameOriginM.splice(0,3,...copy.frameOriginM);lastPose=copy.lastPose;index=copy.index;lengthM=copy.lengthM;
    motion.pos.set(copy.motion.pos);motion.prev.set(copy.motion.prev);motion.prevDt=copy.motion.prevDt;
    motion.constraints.forEach((c,i)=>{c.lambda=copy.motion.lambda[i];});
    if(copy.motion.lastMu===null)delete motion.lastMu;else motion.lastMu=Float64Array.from(copy.motion.lastMu);
    motion.supportMotionActive=copy.motion.supportMotionActive;
    motion.fixedPositions=new Map(copy.motion.fixedPositions.map(f=>[f.node,f.positionM]));
    setLength(lengthM);
  },step(command,depth=0) {
    const hS=command.hS??1/60,from=lastPose;
    const attemptStart=observeAttempt?performance.now():0;
    try {const result=advance({...command,hS});
      observeAttempt?.({hS,depth,accepted:true,iterations:result.audit.iterations,ms:performance.now()-attemptStart});
      lastPose=command.targetPose;return result;
    } catch(error) {
      observeAttempt?.({hS,depth,accepted:false,reason:error.message,ms:performance.now()-attemptStart});
      if(hS<=1/240||!(/не доведено|Не найден убывающий|Не сошёлся выбор кромок|не положительна/.test(error.message)))throw error;
      const middle=intermediatePose(from,command.targetPose);
      const a=calculation.step({...command,targetPose:middle,hS:hS/2},depth+1),b=calculation.step({...command,hS:hS/2},depth+1);
      const leaves=[...(a.leaves??[a.audit]),...(b.leaves??[b.audit])];
      return {...b,forceN:b.forceN.map((v,d)=>(v+a.forceN[d])/2),momentNm:b.momentNm.map((v,d)=>(v+a.momentNm[d])/2),leaves,
        audit:{...b.audit,substeps:leaves.length,refinement:{hS,message:error.message},
          maxForceResidualN:Math.max(...leaves.map(v=>v.maxForceResidualN)),maxHardViolationM:Math.max(...leaves.map(v=>v.maxHardViolationM))}};
    }
  }};
  function setLength(valueM) {
    const value=distance(fixture.sheet.node,anchor,valueM,0,true).value;
    rope.value=value;motion.constraints.at(-1).value=value;motion.hard.at(-1).value=value;
  }
  function advance({forceN,targetPose,sheetLengthM,hS}) {
    if(forceN.length!==3*n||!forceN.every(Number.isFinite)||![1/60,1/120,1/240].includes(hS))
      throw new Error('Требуется конечная узловая нагрузка и шаг ткани 1/60, 1/120 или 1/240 с');
    const requested=Math.max(minLengthM,Math.min(maxLengthM,sheetLengthM));
    const priorLengthM=lengthM;
    lengthM+=Math.max(-.5*hS,Math.min(.5*hS,requested-lengthM));
    // distance захватывает rest; меняется только явная команда верёвки.
    setLength(lengthM);
    const load=new Float64Array(3*(n+1));load.set(forceN);
    for(let i=0;i<n;i++)load[3*i+2]-=budget.dryNodalKg[i]*pack.environment.g;
    const solverPose=framePose(targetPose),targets=fixed.map((node,j)=>({node,positionM:worldPoint(solverPose,referenceSupports[j])}));
    const oldPos=motion.pos.slice(),oldPrev=motion.prev.slice(),priorDt=motion.prevDt||hS;
    let audit;
    try {audit=motion.step(load,hS,r.iterations,targets);} catch(error) {
      lengthM=priorLengthM;
      setLength(lengthM);
      throw error;
    }
    const workLimitJ=motion.forceToleranceN*motion.free.reduce((sum,k)=>sum+Math.abs(motion.pos[k]-motion.prev[k]),0)+
      128*Number.EPSILON*Math.max(1,...['kineticJ','initialKineticJ','softEnergyJ','initialSoftEnergyJ','appliedWorkJ','supportWorkJ','inertiaIncrementJ','materialIncrementJ'].map(k=>Math.abs(audit[k])));
    if(Math.abs(audit.discreteBalanceResidualJ)>workLimitJ)
      throw new Error('Не выполнен баланс работы заданных креплений');
    const force=[0,0,0],moment=[0,0,0],origin=worldPoint(solverPose,budget.cgM);
    for(const i of fixed) {
      const f=Array.from(audit.supportForceN.slice(3*i,3*i+3),v=>-v);
      const lever=Array.from(motion.pos.slice(3*i,3*i+3),(v,d)=>v-origin[d]),m=cross3(lever,f);
      for(let d=0;d<3;d++){force[d]+=f[d];moment[d]+=m[d];}
    }
    // Независимая сумма внешней нагрузки минус ускорение всех узлов.
    // Внутренние силы материала и кромок не входят в эту проверку.
    const balanceForce=[0,0,0],balanceMoment=[0,0,0];let maxLeverM=0;
    for(let i=0;i<n;i++) {
      const lever=Array.from(motion.pos.slice(3*i,3*i+3),(v,d)=>v-origin[d]);
      maxLeverM=Math.max(maxLeverM,Math.hypot(...lever));
      const f=[0,1,2].map(d=>{const k=3*i+d;return load[k]-motion.mass[i]*((motion.pos[k]-oldPos[k])/hS-(oldPos[k]-oldPrev[k])/priorDt)/hS;});
      const m=cross3(lever,f);for(let d=0;d<3;d++){balanceForce[d]+=f[d];balanceMoment[d]+=m[d];}
    }
    const forceBalanceResidualN=force.map((v,d)=>v-balanceForce[d]),momentBalanceResidualNm=moment.map((v,d)=>v-balanceMoment[d]);
    const forceBalanceLimitN=motion.free.length*motion.forceToleranceN,
      momentBalanceLimitNm=2*maxLeverM*forceBalanceLimitN;
    if(Math.max(...forceBalanceResidualN.map(Math.abs))>forceBalanceLimitN||Math.max(...momentBalanceResidualNm.map(Math.abs))>momentBalanceLimitNm)
      throw new Error('Реакции не согласованы с изменением импульса ткани');
    return {index:++index,positions:motion.pos.slice(0,3*n).map((v,k)=>v+frameOriginM[k%3]),velocity:motion.pos.slice(0,3*n).map((v,k)=>(v-motion.prev[k])/hS),
      targetPose,forceN:force,momentNm:moment,lengthM,audit:{model:'boat-prescribed-energy-v1',
        hS,forceBalanceResidualN,momentBalanceResidualNm,forceBalanceLimitN,momentBalanceLimitNm,maxForceResidualN:audit.solver.maxForceResidualN,maxHardViolationM:audit.maxHardViolationM,
        workLimitJ,discreteBalanceResidualJ:audit.discreteBalanceResidualJ,supportWorkJ:audit.supportWorkJ,
        tensionN:Math.max(0,-motion.constraints.at(-1).lambda/(hS*hS)),iterations:audit.solver.iterations}};
  }
  return calculation;
}
