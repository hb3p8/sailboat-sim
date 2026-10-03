// Общая постановка лабораторного паруса: CLI и браузер считают одно уравнение.
// Давление/момент и необязательная верёвка; поле воздуха остаётся замороженным.
import {FluidBodyEnergyMotion} from './cloth-fluid-body-motion.mjs';
import {fluidInertia} from './cloth-fluid-inertia.mjs';
import {materialSurface,gridTriangles,MODEL_MATERIAL} from './cloth-material.mjs';
import {installSharedForces} from './cloth-shared-input.mjs';
import {distance} from '../cloth-compliance.mjs';

export function fluidSailMotion(r,bodyInput,wasmSparseFactor,{linearBackend='schur-wasm',hS=r.hS,allowRefinementGrid=false,sheet}={}) {
  const n=r.rows*r.cols;
  const gridAccepted=r.rows===11&&r.cols===9 || allowRefinementGrid&&
    Number.isInteger(r.rows)&&Number.isInteger(r.cols)&&r.rows>=11&&r.cols>=9&&r.rows<=41&&r.cols<=33&&
    (r.rows-1)%10===0&&(r.cols-1)%8===0;
  if(!gridAccepted||r.loadFrame!=='inertial-cartesian-frozen'||r.mass.length!==n+4||r.fixed.length||
      JSON.stringify(bodyInput)!==JSON.stringify({massKg:1000,principalInertiaKgM2:[1000,5000,5000],originM:[0,0,0]}))
    throw new Error('Нужна проверенная лабораторная постановка 11×9');
  const addedDiagonal=[60,1000,1200,250,4500,3500];
  const addedMass6=Array.from({length:36},(_,i)=>i%7===0?addedDiagonal[i/7]:0);
  const inertia=fluidInertia({dryMassKg:bodyInput.massKg,dryPrincipalInertiaKgM2:bodyInput.principalInertiaKgM2,addedMass6});
  const surface=materialSurface(r.reference,gridTriangles(r.rows,r.cols),MODEL_MATERIAL,
    {bendingModel:'curvature',rows:r.rows,cols:r.cols});
  const constraints=[...surface.constraints,...r.hard.map(c=>Object.assign(distance(c.a,c.b,c.rest,0,c.unilateral),{family:c.family}))];
  const {head,end,nodes,fractions}=r.board;
  nodes.forEach((node,j)=>{if(node!==head&&node!==end)for(let d=0;d<3;d++)constraints.push({
    alpha:0,unilateral:false,family:'аффинная верхняя планка',unit:'м',value(p) {
      const t=fractions[j],e=[0,0,0];e[d]=1;
      return {C:p[3*node+d]-(1-t)*p[3*head+d]-t*p[3*end+d],
        grad:[[node,e],[head,e.map(v=>-(1-t)*v)],[end,e.map(v=>-t*v)]]};
    }});});
  const positions=r.positions.slice(0,3*n),previous=r.previous.slice(0,3*n);
  if(sheet&&(sheet.node!==r.cols-1||!r.rigidBody.attachments.includes(sheet.node)))
    throw new Error('Верёвка должна освобождать нижний задний угол паруса');
  const velocity=positions.map((v,k)=>(v-previous[k])/r.prevDt);
  const motion=new FluidBodyEnergyMotion({positions,mass:r.mass.slice(0,n),constraints,velocityMS:velocity,dampingHz:6,
    linearBackend,wasmSparseFactor,gridRows:r.rows,gridCols:r.cols,ropes:sheet?[sheet]:[],
    body:{inertia,originM:bodyInput.originM,orientation9:[1,0,0,0,1,0,0,0,1],velocity6:[0,0,0,0,0,0],
      attachments:r.rigidBody.attachments.filter(node=>!sheet||node!==sheet.node),frame:'body-cg'}});
  const forceN=new Float64Array(3*n),cloth={rows:r.rows,cols:r.cols,n,
    pos:motion.pos,prev:Float64Array.from(previous),frc:forceN,nrm:new Float64Array(3*n),pattern(){},velocityDt(){return hS;}};
  const {integrated}=installSharedForces(cloth,r.field);
  // Окно и скорость назначены для первого живого переноса: тот же диапазон
  // 0.25 м и 0.5 м/с, что в принятом лабораторном цикле 70381c0.
  // Это ограничение управления стенда, не пределы настоящей верёвки SV20.
  const sheetControl=sheet?Object.freeze({minLengthM:sheet.lengthM,maxLengthM:sheet.lengthM+.25,maxSpeedMPS:.5}):undefined;
  let load;
  function prepareLoad({pressureScale=1,yawMomentNm=0,sheetLengthM,sheetRateMPS}={}) {
    if(!Number.isFinite(pressureScale)||pressureScale<0||pressureScale>1.5||!Number.isFinite(yawMomentNm)||Math.abs(yawMomentNm)>100)
      throw new Error('Нагрузка должна быть 0–150%, внешний момент — от −100 до 100 Н·м');
    if(sheetLengthM!=null&&(!sheet||!Number.isFinite(sheetLengthM)||sheetLengthM<=0))
      throw new Error('Нужны подключённая верёвка и положительная конечная длина');
    if(sheetRateMPS!=null) {
      if(!sheetControl||!Number.isFinite(sheetRateMPS)||Math.abs(sheetRateMPS)>sheetControl.maxSpeedMPS||sheetLengthM!=null)
        throw new Error('Скорость верёвки требует подключённого угла, диапазона ±0.5 м/с и одной команды длины');
      sheetLengthM=Math.max(sheetControl.minLengthM,Math.min(sheetControl.maxLengthM,motion.ropeLengthsM[0]+hS*sheetRateMPS));
    }
    cloth.prev.set(motion.pos.map((v,k)=>v-hS*motion.vel[k]));cloth.forcesAt(r.boat,hS);
    // При единичном входе сохраняем порядок операций прежней полной серии.
    if(pressureScale!==1)for(let i=0;i<n;i++)for(let d=0;d<3;d++)forceN[3*i+d]+=(pressureScale-1)*integrated[16*i+d];
    load={frame:'inertial-cartesian-cg',clothForceN:forceN,forceN:[0,0,0],momentNm:[0,0,yawMomentNm]};
    if(sheetLengthM!=null)load.ropeLengthsM=[sheetLengthM];
  }
  function solve() {
    if(!load)throw new Error('Нагрузка шага не подготовлена');
    const audit=motion.step(load,hS,r.iterations);load=undefined;
    if(Math.abs(audit.discreteBalanceResidualJ)>audit.workLimitJ||Math.abs(audit.bodyWorkCancellationResidualJ)>audit.interfaceWorkLimitJ)
      throw new Error('Шаг не выполнил проверку работы сил');
    return audit;
  }
  return {motion,forceN,addedMass6,material:MODEL_MATERIAL,hS,sheetControl,prepareLoad,solve,
    step(controls){prepareLoad(controls);return solve();}};
}
