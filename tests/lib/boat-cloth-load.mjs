// Проверочная граница Boat/Rig и общего механического расчёта.
// Здесь переводятся уже рассчитанные нагрузки; новой аэродинамики нет.
import {boatBodyRotation} from '../../sim/axes.js';
import {rigidBodyProperties} from './cloth-rigid-body-motion.mjs';

const vector=(a,name)=>{
  if(a?.length!==3||!Array.from(a).every(Number.isFinite))
    throw new Error(`Нужен конечный вектор: ${name}`);
  return Array.from(a);
};
const add=(a,b)=>a.map((v,d)=>v+b[d]);
const sub=(a,b)=>a.map((v,d)=>v-b[d]);
const dot=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const rotate=(r,v)=>[0,1,2].map(d=>dot(r.slice(3*d,3*d+3),v));

// referenceOriginM — начало геометрии, а не ЦТ. Скорости старого Boat
// не переводятся этим помощником: их начало требует отдельной проверки.
export function boatLoadPose({referenceOriginM,cgBodyM,psi,phi,th}) {
  const origin=vector(referenceOriginM,'начало геометрии'),cg=vector(cgBodyM,'ЦТ корпуса');
  const bodyToWorld=boatBodyRotation(psi,phi,th),headingToWorld=boatBodyRotation(psi,0,0);
  return Object.freeze({referenceOriginM:Object.freeze(origin),
    cgWorldM:Object.freeze(add(origin,rotate(bodyToWorld,cg))),
    bodyToWorld:Object.freeze(bodyToWorld),headingToWorld:Object.freeze(headingToWorld)});
}

// Только инерциальные оси. Перенос начала сохраняет свободную пару сил.
export function worldLoadAtOrigin(load,originM) {
  if(load?.frame!=='inertial-cartesian') throw new Error('Нагрузка требует инерциальных декартовых осей');
  const forceN=vector(load.forceN,'сила'),momentNm=vector(load.momentNm,'момент');
  const from=vector(load.originM,'начало нагрузки'),to=vector(originM,'новое начало');
  const translated=add(momentNm,cross(sub(from,to),forceN));
  if(!translated.every(Number.isFinite)) throw new Error('Переполнение переноса момента');
  return {frame:'inertial-cartesian',originM:to,forceN,momentNm:translated};
}

export function headingLoadToWorld(load,pose) {
  if(load?.frame!=='body-horizontal') throw new Error('Нагрузка Rig должна иметь горизонтальные оси лодки');
  const force=vector(load.forceN,'сила Rig'),moment=vector(load.momentNm,'момент Rig');
  const origin=vector(load.originM,'начало нагрузки Rig');
  // Крен уже вошёл в forceN/fz и momentNm в том же проходе Rig.forces.
  // Второй поворот крена или дифферента здесь изменил бы нагрузку.
  return worldLoadAtOrigin({frame:'inertial-cartesian',
    originM:add(pose.referenceOriginM,rotate(pose.headingToWorld,origin)),
    forceN:rotate(pose.headingToWorld,force),momentNm:rotate(pose.headingToWorld,moment)},pose.cgWorldM);
}

export function rigLoadWithoutGennaker(sailOut,pose) {
  if(sailOut?.phase!=='aero-after-cloth'||sailOut.frame!=='body-horizontal'||
      !Array.isArray(sailOut.bySail)||![2,3].includes(sailOut.bySail.length))
    throw new Error('Нужна публикация Rig с двумя или тремя парусами из расчётной фазы');
  const forceN=[0,0,0],momentNm=[0,0,0];
  // Rig: грот 0, стаксель 1, генакер 2. Суммируем нужные части, не вычитаем
  // две большие суммарные силы. Реакция нового генакера входит через общие связи.
  for(const part of sailOut.bySail.slice(0,2)) {
    const f=vector(part.forceN,'сила отдельного паруса'),m=vector(part.momentNm,'момент отдельного паруса');
    for(let d=0;d<3;d++){forceN[d]+=f[d];momentNm[d]+=m[d];}
  }
  return headingLoadToWorld({frame:sailOut.frame,originM:sailOut.originM,forceN,momentNm},pose);
}

// Распределение внешней нагрузки по тем же четырём физическим массам.
// Для жёсткого мгновенного движения сохраняет силу, момент и мощность.
// Это не доказательство работы дискретного шага с меняющейся нагрузкой.
export function rigidBodyLoadForces(motion,load) {
  if(motion.rigidBody?.frame!=='inertial-cartesian')
    throw new Error('Свободное тело требует инерциальных декартовых осей');
  const nodes=motion.rigidBody.nodes;
  const properties=rigidBodyProperties(motion.pos,motion.mass,nodes);
  const translated=worldLoadAtOrigin(load,properties.originM),I=properties.inertiaKgM2;
  const rows=[0,1,2].map(d=>Array.from(I.slice(3*d,3*d+3)));
  const columns=[cross(rows[1],rows[2]),cross(rows[2],rows[0]),cross(rows[0],rows[1])];
  const determinant=dot(rows[0],columns[0]);
  if(!(Number.isFinite(determinant)&&determinant>64*Number.EPSILON*I[0]*I[4]*I[8]))
    throw new Error('Вырожденная инерция распределения нагрузки');
  const alpha=[0,1,2].map(d=>columns.reduce((s,c,k)=>s+c[d]*translated.momentNm[k],0)/determinant);
  const forceN=new Float64Array(motion.pos.length);
  for(const i of nodes) {
    const r=sub(Array.from(motion.pos.slice(3*i,3*i+3)),properties.originM);
    const tangential=cross(alpha,r);
    for(let d=0;d<3;d++)forceN[3*i+d]=motion.mass[i]*(translated.forceN[d]/properties.totalMassKg+tangential[d]);
  }
  if(!forceN.every(Number.isFinite)) throw new Error('Переполнение распределения нагрузки');
  return {forceN,load:translated,properties};
}
