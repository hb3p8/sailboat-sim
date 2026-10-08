// Воздух читает принятое полотно; механический шаг здесь не выполняется.
// Используется прежний Rig/Cloth.forcesAt, без новой поляры и таблицы сил.
import {Boat} from '../../sim/physics.js';
import {Cloth} from '../../sim/cloth.js';
import {checkRotation,rotate3,transpose3,cross3,finiteArray} from './cloth-fluid-inertia.mjs';

export function createClothLiveWind(pack,recipe) {
  const n=recipe.rows*recipe.cols;
  if(!pack?.environment||!pack.rig?.gennaker||recipe.reference?.length!==3*n)
    throw new Error('Живому ветру нужны физический пакет и проверенный крой');
  const b=new Boat(pack,undefined,{gennakerUp:true,mainUp:false,jibUp:false,localPressure:false});
  b.wind.o.gradient=false;b.wind.o.gust=0;b.wind.o.shift=0;
  // Rig работает в связанных осях с проекцией потока на плоскость XY.
  // Полный поворот/скорость опоры переводятся на входе и выходе адаптера.
  // Этот прежний двумерный закон воздуха не принимает срыв G1/C1.
  const c=Object.assign(Object.create(Cloth.prototype),{si:2,rows:recipe.rows,cols:recipe.cols,n,nRows:recipe.rows,
    pos:new Float64Array(3*n),prev:new Float64Array(3*n),frc:new Float64Array(3*n),nrm:new Float64Array(3*n),
    area:new Float64Array(n),rhoAir:pack.environment.rho_air??1.225,prevDt:recipe.hS,
    // Вес в общем расчёте подаётся отдельно. Нулевая area исключает лишь
    // вес из forcesAt; летящая площадь давления считается по текущим узлам.
    step(){},cut3d:true,dx:Float64Array.from({length:n},(_,i)=>recipe.reference[3*i]),
    dy:Float64Array.from({length:n},(_,i)=>recipe.reference[3*i+1]),dz:Float64Array.from({length:n},(_,i)=>recipe.reference[3*i+2])});
  b.rig.cloth=c;b.rigSide=recipe.positions[3*(recipe.cols+1)+1]<0?-1:1;
  b.psi=0;b.phi=0;b.th=0;b.u=0;b.v=0;b.r=0;b.p_=0;
  let pose,RT,speedMPS=6,fromDeg=140;
  const pointWorld=p=>rotate3(pose.orientation9,p).map((v,d)=>v+pose.originM[d]);
  const rigidVelocity=p=>{
    const spin=cross3(pose.velocity6.slice(3),p);
    return rotate3(pose.orientation9,pose.velocity6.slice(0,3).map((v,d)=>v+spin[d]));
  };
  b.apparentAt=(x,y,z)=>{
    const local=[x,y,z],world=pointWorld(local),w=b.wind.sample(world[0],world[1],Math.max(.3,world[2]),b.t,1),v=rigidVelocity(local);
    const relative=rotate3(RT,[w.x-v[0],w.y-v[1],-v[2]]);
    return {x:relative[0],y:relative[1],speed:Math.hypot(relative[0],relative[1]),angle:Math.atan2(relative[1],relative[0]),ws:w.speed};
  };
  return {model:'rig-current-surface-body-projected-v1',evaluate(motion,{windSpeedMPS=speedMPS,windFromDeg=fromDeg}={},timeS=0) {
    if(!Number.isFinite(windSpeedMPS)||windSpeedMPS<0||windSpeedMPS>12||!Number.isFinite(windFromDeg)||Math.abs(windFromDeg)>180||!Number.isFinite(timeS)||timeS<0)
      throw new Error('Живой ветер требует 0–12 м/с, направление −180…180° и конечное время');
    if(!finiteArray(motion.pos,3*n)||!finiteArray(motion.vel,3*n)||!finiteArray(motion.body?.velocity6,6)||!finiteArray(motion.body?.originM,3))
      throw new Error('Живой ветер требует конечного принятого состояния ткани и опоры');
    checkRotation(motion.body.orientation9);pose=motion.body;RT=transpose3(pose.orientation9);
    speedMPS=windSpeedMPS;fromDeg=windFromDeg;b.wind.o.speed=speedMPS;b.wind.o.dir=fromDeg*Math.PI/180;b.t=timeS;
    for(let i=0;i<n;i++) {
      const p=rotate3(RT,Array.from(motion.pos.slice(3*i,3*i+3),(v,d)=>v-pose.originM[d]));
      const rigid=rigidVelocity(p),relative=rotate3(RT,Array.from(motion.vel.slice(3*i,3*i+3),(v,d)=>v-rigid[d]));
      for(let d=0;d<3;d++){c.pos[3*i+d]=p[d];c.prev[3*i+d]=p[d]-recipe.hS*relative[d];}
    }
    b.rig.latRebuild=true;b.o.genSheetLen=motion.ropeLengthsM?.[0]??b.o.genSheetLen;
    b.rig.forces(b,b.apparentWind(),recipe.hS);c.forcesAt(b,recipe.hS,b.rigSide,pack.environment);
    const forceN=new Float64Array(3*n),totalForceN=[0,0,0],momentNm=[0,0,0];
    for(let i=0;i<n;i++) {
      const f=rotate3(pose.orientation9,Array.from(c.frc.slice(3*i,3*i+3))),r=Array.from(motion.pos.slice(3*i,3*i+3),(v,d)=>v-pose.originM[d]),m=cross3(r,f);
      for(let d=0;d<3;d++){forceN[3*i+d]=f[d];totalForceN[d]+=f[d];momentNm[d]+=m[d];}
    }
    if(!forceN.every(Number.isFinite))throw new Error('Переполнение нагрузки живого ветра');
    return {forceN,audit:{model:this.model,timeS,windSpeedMPS:speedMPS,windFromDeg:fromDeg,
      originM:Array.from(pose.originM),totalForceN,momentNm,areaM2:c.flyingAreas().reduce((s,v)=>s+v,0),
      loadPhase:'accepted-state-before-step',pressureNormalN:Array.from(c.pressureForce)}};
  }};
}
