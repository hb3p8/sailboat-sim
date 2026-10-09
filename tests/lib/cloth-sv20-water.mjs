// Первое водное соединение: спокойная вода, малый ход, без экипажа/глиссирования.
// Формулы корпуса/крыльев/демпфирования читаются из общих модулей симулятора.
import {Buoyancy} from '../../sim/buoyancy.js';
import {appendageForces,waterDamping,hullResistance,hullLateral,hullHeelYaw,displacementSpeedLimit} from '../../sim/hydro.js';
import {checkRotation,rotate3,cross3,finiteArray} from './cloth-fluid-inertia.mjs';

export function sv20BodyAngles(R) {
  checkRotation(R);
  return {phi:Math.atan2(R[7],R[8]),th:Math.asin(Math.max(-1,Math.min(1,R[6]))),psi:Math.atan2(R[3],R[0])};
}

export function createSV20Water(pack,geometryCGM,bodyKg) {
  const buoy=new Buoyancy(pack);
  if(!buoy.ready||!finiteArray(geometryCGM,3)||!(bodyKg>0))throw new Error('Нужны геометрия плавучести, ЦТ и сухая масса');
  const cg=Array.from(geometryCGM),env=pack.environment,pm=pack.mass;
  return {evaluate(body,{rudderDeg=0}={}) {
    if(!finiteArray(body?.originM,3)||!finiteArray(body?.velocity6,6)||!Number.isFinite(rudderDeg)||Math.abs(rudderDeg)>25)
      throw new Error('Нужны конечная поза/скорость и руль −25…25°');
    const R=body.orientation9,{phi,th}=sv20BodyAngles(R),nu=body.velocity6;
    if(Math.abs(th)>.7)throw new Error('Водный опыт пока ограничен дифферентом ±0.7 рад');
    const geometryOriginM=body.originM.map((v,d)=>v-rotate3(R,cg)[d]);
    const localVelocity=p=>{const spin=cross3(nu.slice(3),p.map((v,d)=>v-cg[d]));return nu.slice(0,3).map((v,d)=>v+spin[d]);};
    const packV=localVelocity(pm.cg_m);
    const speedLimitMPS=displacementSpeedLimit(pack);
    if(Math.hypot(packV[0],packV[1])>speedLimitMPS)throw new Error(`Водный опыт ограничен началом глиссирования (${speedLimitMPS.toFixed(2)} м/с)`);
    const hyd=buoy.at(geometryOriginM[2],phi,th),k=pack.foils.keel,r=pack.foils.rudder;
    const kv=localVelocity([k.x_m,0,k.z_centre_m]),rv=localVelocity([r.x_m,0,r.z_centre_m]);
    const appendages=appendageForces(pack,{keelU:kv[0],keelV:kv[1],rudderU:rv[0],rudderSway:rv[1],rudderAngle:rudderDeg*Math.PI/180});
    const parts=[];
    function atPoint(name,p,forceWorldN,freeMomentWorldNm=[0,0,0]) {
      const arm=rotate3(R,p.map((v,d)=>v-cg[d])),moment=cross3(arm,forceWorldN);
      parts.push({name,forceN:forceWorldN,momentNm:moment.map((v,d)=>v+freeMomentWorldNm[d])});
    }
    function bodyForce(name,p,F,T=[0,0,0]){atPoint(name,p,rotate3(R,F),rotate3(R,T));}
    atPoint('Плавучесть',[hyd.cbx,hyd.cby,hyd.cbz],[0,0,env.rho_water*env.g*hyd.volume]);
    atPoint('Вес сухого корпуса',cg,[0,0,-bodyKg*env.g]);
    bodyForce('Киль и бульб',[k.x_m,0,k.z_centre_m],[appendages.keelFx,appendages.kf.fy,0]);
    bodyForce('Руль',[r.x_m,0,r.z_centre_m],[appendages.rudFx,appendages.rf.fy,0]);
    const drag=-Math.sign(packV[0]||1)*hullResistance(pack,Math.abs(packV[0]),Math.abs(phi)*180/Math.PI);
    const hull=hullLateral(pack,phi,packV[1],nu[5]),dragZ=-.5*pack.hydrostatics.draft_canoe_m;
    bodyForce('Сопротивление корпуса',[pm.cg_m[0],0,dragZ],[drag,hull.fy,0],[0,0,hull.mz+hullHeelYaw(pack,packV[0],phi)]);
    const sp=Math.sin(phi),cp=Math.cos(phi),ct=Math.cos(th),tt=Math.tan(th);
    // Скорости углов и сопряжённый им момент; мощность сохраняется полностью.
    const psiRate=(sp*nu[4]+cp*nu[5])/ct,pitchRate=-cp*nu[4]+sp*nu[5],rollRate=nu[3]-Math.sin(th)*psiRate;
    const worldV=rotate3(R,nu.slice(0,3));
    const damping=waterDamping(pack,hyd,{massKg:pm.total_kg,rollInertia:pm.ixx_kg_m2*pm.added_roll,
      rollRate,pitchRate,heaveRate:worldV[2]});
    const roll=damping.rollMomentNm,pitch=-damping.pitchResistanceNm;
    const torque=[roll,-tt*sp*roll-cp*pitch,-tt*cp*roll+sp*pitch];
    atPoint('Затухание качки',cg,[0,0,-damping.heaveResistanceN],rotate3(R,torque));
    const forceN=[0,0,0],momentNm=[0,0,0];
    for(const p of parts)for(let d=0;d<3;d++){forceN[d]+=p.forceN[d];momentNm[d]+=p.momentNm[d];}
    return {forceN,momentNm,audit:{model:'sv20-flat-water-slow-v1',originM:Array.from(body.originM),geometryOriginM,
      rudderDeg,speedLimitMPS,hyd,parts,totalForceN:forceN,totalMomentNm:momentNm,
      dampingPowerW:roll*rollRate+pitch*pitchRate-damping.heaveResistanceN*worldV[2],
      scope:'Спокойная вода до исходного начала глиссирования, без экипажа/течения/волн. Полная скорость точки крыла; прежний скос киля и оценки демпфирования.'}};
  }};
}
