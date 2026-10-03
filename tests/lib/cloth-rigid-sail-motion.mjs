// Полный парус на известном свободном теле. Поле задано в неподвижных
// лабораторных осях: это замороженная нагрузка, не живой расчёт воздуха.
import {materialSurface,gridTriangles,MODEL_MATERIAL} from './cloth-material.mjs';
import {RigidBodyEnergyMotion} from './cloth-rigid-body-motion.mjs';
import {distance} from '../cloth-compliance.mjs';
import {installSharedInput} from './cloth-shared-input.mjs';

export function rigidSailMotion(recipe,wasmSparseFactor) {
  const {rows,cols,reference,positions,previous,mass,board,hard,field,boat,rigidBody}=recipe;
  const n=rows*cols;
  if(recipe.loadFrame!=='inertial-cartesian-frozen' || mass.length!==n+4 ||
      reference.length!==3*n || !rigidBody.nodes.every(i=>i>=n) || recipe.fixed.length)
    throw new Error('Полный свободный парус требует отдельной четвёрки масс и замороженного инерциального входа');
  const surface=materialSurface(Float64Array.from(reference),gridTriangles(rows,cols),MODEL_MATERIAL,
    {bendingModel:'curvature',rows,cols});
  const constraints=[...surface.constraints.map(c=>({...c,unit:c.family==='bending'?'1/м':'1'})),
    ...hard.map(c=>Object.assign(distance(c.a,c.b,c.rest,0,c.unilateral),{family:c.family}))];
  const motion=new RigidBodyEnergyMotion({positions,mass,fixed:[],board,rigidBody,constraints,
    dampingHz:6,linearBackend:'kkt-wasm',wasmSparseFactor});
  motion.prev.set(previous);motion.prevDt=recipe.prevDt;
  motion.validatePose(motion.prev);
  const forceN=new Float64Array(positions.length);
  const cloth={rows,cols,n,rigidBoard:true,freeClew:false,
    pos:motion.pos.subarray(0,3*n),prev:motion.prev.subarray(0,3*n),
    frc:forceN.subarray(0,3*n),nrm:new Float64Array(3*n),pattern(){},
    velocityDt(h){return motion.prevDt>0?motion.prevDt:h;}};
  installSharedInput(cloth,field);
  return {motion,surface,forceN,step(supportTargets) {
    // Тело не получает собственного веса/воды/тяги. Их нет в постановке.
    // Вход ткани содержит прежние давление, сухой вес и сопротивление.
    cloth.forcesAt(boat,recipe.hS);
    return motion.step(forceN,recipe.hS,recipe.iterations,supportTargets);
  }};
}
