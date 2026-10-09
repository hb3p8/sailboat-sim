// Отрицательный контроль: затухание мировой скорости узла тормозит всё тело.
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {FluidBodyEnergyMotion} from './lib/cloth-fluid-body-motion.mjs';
import {fluidInertia,rotate3} from './lib/cloth-fluid-inertia.mjs';
import {boatBodyRotation} from '../sim/axes.js';
const [out]=process.argv.slice(2);assert(out&&process.argv.length===3&&!existsSync(out));
const cases=[];
for(const nodeKg of [2,250])for(const R of [[1,0,0,0,1,0,0,0,1],boatBodyRotation(.3,-.2,.1)])for(const dampingHz of [0,6]) {
  const bodyKg=10,v=[1,.3,-.2],world=rotate3(R,v),initialP=world.map(x=>(bodyKg+nodeKg)*x),h=1/60;
  const b=new FluidBodyEnergyMotion({positions:[0,0,0],mass:[nodeKg],velocityMS:world,constraints:[],dampingHz,
    body:{inertia:fluidInertia({dryMassKg:bodyKg,dryPrincipalInertiaKgM2:[2,3,4]}),originM:[0,0,0],orientation9:R,velocity6:[...v,0,0,0],attachments:[0],frame:'body-cg'}});
  const a=b.step({frame:'inertial-cartesian-cg',forceN:[0,0,0],momentNm:[0,0,0],clothForceN:[0,0,0]},h,80);
  const bodyV=rotate3(b.body.orientation9,b.body.velocity6.slice(0,3)),finalP=bodyV.map((x,d)=>bodyKg*x+nodeKg*b.vel[d]);
  const expectedP=world.map(x=>(bodyKg+nodeKg*Math.exp(-dampingHz*h))*x);
  // Два независимых векторных остатка (тело и один узел), каждый ≤sqrt(3)*Ftol.
  const impulseTolerance=2*Math.sqrt(3)*h*a.solver.forceToleranceN+
    128*Number.EPSILON*(bodyKg+nodeKg)*Math.hypot(...world);
  assert(Math.hypot(...finalP.map((x,d)=>x-expectedP[d]))<=impulseTolerance);
  assert(a.maxPhysicalResidualN<=a.solver.forceToleranceN&&Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ);
  const loss=initialP.map((x,d)=>x-finalP[d]);
  if(!dampingHz)assert(Math.hypot(...loss)<=impulseTolerance);else assert(Math.hypot(...loss)>.1);
  cases.push({nodeKg,dampingHz,initialP,finalP,expectedP,loss,impulseTolerance,audit:a});
}
const hash=b=>createHash('sha256').update(b).digest('hex');writeFileSync(out,JSON.stringify({schema:'cloth-rigid-damping-check-v1',phase:'complete',cases,
  sources:Object.fromEntries(['tests/cloth-rigid-damping.test.mjs','tests/lib/cloth-fluid-body-motion.mjs'].map(p=>[p,hash(readFileSync(p))])),
  scope:'6/с сохранены как назначенный отрицательный лабораторный контроль. Для свободной SV20 нулевая мировая численная сила сохраняет импульс; воздушное/водное сопротивление проверяется отдельно.'},null,2)+'\n',{flag:'wx'});
console.log('Равномерное движение: 8 известных случаев; мировое затухание 6/с теряет импульс, без него импульс сохранён.');
