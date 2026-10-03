// Нерастяжимая верёвка между узлом ткани и точкой в осях тела.
// Длина задаётся командой шага; реакция не может толкать ткань.
import {finiteArray,rotate3} from './cloth-fluid-inertia.mjs';

export function bodyRopes(ropes,nodeCount) {
  if(!Array.isArray(ropes)||ropes.some(r=>!Number.isInteger(r?.node)||r.node<0||r.node>=nodeCount||
      !finiteArray(r.localM,3)||!(Number.isFinite(r.lengthM)&&r.lengthM>0)))
    throw new Error('Некорректная верёвка или точка на теле');
  return Object.freeze(ropes.map(r=>Object.freeze({node:r.node,
    localM:Object.freeze(Array.from(r.localM)),lengthM:r.lengthM})));
}

export function ropeValue(rope,q,pose,lengthM) {
  const rotated=rotate3(pose.orientation9,rope.localM);
  const endpointM=pose.originM.map((v,d)=>v+rotated[d]);
  const relativeM=endpointM.map((v,d)=>q[3*rope.node+d]-v),distanceM=Math.hypot(...relativeM);
  const direction=relativeM.map(v=>distanceM>0?v/distanceM:0);
  return {C:distanceM-lengthM,grad:[[rope.node,direction]],direction,endpointM,relativeM,distanceM,lengthM};
}
