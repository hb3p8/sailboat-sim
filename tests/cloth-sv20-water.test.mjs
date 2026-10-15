// Проверка геометрического интеграла воды, осей, зеркала руля и мощности затухания.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createSV20Water} from './lib/cloth-sv20-water.mjs';
import {boatBodyRotation} from '../sim/axes.js';
import {rotate3,cross3,dotN,product3} from '../sim/cloth/cloth-fluid-inertia.mjs';
import {Buoyancy} from '../sim/buoyancy.js';
import {fluidInertia} from '../sim/cloth/cloth-fluid-inertia.mjs';
import {FluidBodyEnergyMotion} from './lib/cloth-fluid-body-motion.mjs';
import {rudderAngleAfter} from '../sim/rudder.js';
import {sv20BodyAngles} from './lib/cloth-sv20-water.mjs';
import {displacementSpeedLimit} from '../sim/hydro.js';
const [out]=process.argv.slice(2);assert(out&&process.argv.length===3&&!existsSync(out));
const bytes=readFileSync('out/export/physics.json'),p=JSON.parse(bytes),cg=p.mass.cg_m,water=createSV20Water(p,cg,p.mass.total_kg);
const close=(a,b)=>assert(Math.abs(a-b)<=2048*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const b={originM:cg.slice(),orientation9:[1,0,0,0,1,0,0,0,1],velocity6:[0,0,0,0,0,0]},before=structuredClone(b),s=water.evaluate(b);assert.deepEqual(b,before);
const hyd=new Buoyancy(p).at(0,0,0),buoy=s.audit.parts[0];
assert.deepEqual(buoy.forceN,[0,0,p.environment.rho_water*p.environment.g*hyd.volume]);
assert.deepEqual(buoy.momentNm,cross3([hyd.cbx-cg[0],hyd.cby-cg[1],hyd.cbz-cg[2]],buoy.forceN));
const shifted=water.evaluate({...b,originM:b.originM.map((v,d)=>v+[12,-8,0][d])});
assert.deepEqual(shifted.forceN,s.forceN);assert.deepEqual(shifted.momentNm,s.momentNm);
const moving={...b,orientation9:boatBodyRotation(.2,.3,-.1),velocity6:[.8,.1,.02,.04,-.03,.06]};
moving.originM=rotate3(moving.orientation9,cg);const load=water.evaluate(moving,{rudderDeg:8});
const damp=load.audit.parts.at(-1),power=dotN(damp.forceN,rotate3(moving.orientation9,moving.velocity6.slice(0,3)))+dotN(damp.momentNm,rotate3(moving.orientation9,moving.velocity6.slice(3)));
close(power,load.audit.dampingPowerW);assert(power<0);
const yaw=boatBodyRotation(Math.PI/2,0,0),turned={...moving,orientation9:product3(yaw,moving.orientation9),originM:rotate3(yaw,moving.originM)};
const t=water.evaluate(turned,{rudderDeg:8});
rotate3(yaw,load.forceN).forEach((v,d)=>close(v,t.forceN[d]));rotate3(yaw,load.momentNm).forEach((v,d)=>close(v,t.momentNm[d]));
const rudder=[];
for(const deg of [-10,0,10])rudder.push(water.evaluate({...b,velocity6:[1,0,0,0,0,0]},{rudderDeg:deg}).audit.parts.find(q=>q.name==='Руль'));
close(rudder[0].forceN[0],rudder[2].forceN[0]);close(rudder[0].forceN[1],-rudder[2].forceN[1]);close(rudder[0].momentNm[2],-rudder[2].momentNm[2]);assert(Math.abs(rudder[0].momentNm[2])>1);
for(const k of ['forceN','momentNm'])for(let d=0;d<3;d++)close(load[k][d],load.audit.parts.reduce((sum,q)=>sum+q[k][d],0));
assert.throws(()=>water.evaluate(b,{rudderDeg:26}),/руль/);
assert.throws(()=>water.evaluate({...b,velocity6:[displacementSpeedLimit(p)+.1,0,0,0,0,0]}),/глиссир/);
assert.throws(()=>water.evaluate({...b,orientation9:boatBodyRotation(0,0,.8)}),/дифферент/);
// Известное тело без паруса: ход сначала задан, два руля дают встречные повороты.
const m=p.mass,A=[m.total_kg*m.added_surge,m.total_kg*m.added_sway,m.total_kg*m.added_heave,m.ixx_kg_m2*(m.added_roll-1),m.iyy_kg_m2*m.added_pitch,m.izz_kg_m2*m.added_yaw];
const inertia=fluidInertia({dryMassKg:m.total_kg,dryPrincipalInertiaKgM2:[m.ixx_kg_m2,m.iyy_kg_m2,m.izz_kg_m2],addedMass6:Array.from({length:36},(_,k)=>k%7===0?A[k/7]:0)});
const turns=[];
for(const target of [-10,0,10]) {
  const body=new FluidBodyEnergyMotion({positions:[],mass:[],constraints:[],body:{inertia,originM:cg.slice(),orientation9:b.orientation9.slice(),velocity6:[1,0,0,0,0,0],attachments:[],frame:'body-cg'}});
  const row={targetDeg:target,steps:[]};let rudder=0;
  for(let k=0;k<60;k++) {
    const previous=rudder;rudder=rudderAngleAfter(rudder,target*Math.PI/180,1/60);assert(Math.abs(rudder-previous)<=(26*(Math.PI/180))/60+Number.EPSILON);
    const F=water.evaluate(body.body,{rudderDeg:rudder*180/Math.PI}),audit=body.step({frame:'inertial-cartesian-cg',forceN:F.forceN,momentNm:F.momentNm,clothForceN:[]},1/60,80);
    assert(audit.maxPhysicalResidualN<=audit.solver.forceToleranceN&&Math.abs(audit.discreteBalanceResidualJ)<=audit.workLimitJ);
    row.steps.push({body:structuredClone(body.body),audit,water:F.audit});
  }
  row.headingRad=sv20BodyAngles(body.body.orientation9).psi;turns.push(row);
}
assert(turns[0].headingRad>0&&turns[2].headingRad<0&&Math.abs(turns[1].headingRad)<1e-8);
close(turns[0].headingRad,-turns[2].headingRad);
const hash=v=>createHash('sha256').update(v).digest('hex');writeFileSync(out,JSON.stringify({schema:'cloth-sv20-water-check-v1',phase:'complete',physicsSha256:hash(bytes),
  sources:Object.fromEntries(['tests/cloth-sv20-water.test.mjs','tests/lib/cloth-sv20-water.mjs','sim/hydro.js'].map(q=>[q,hash(readFileSync(q))])),
  resting:s.audit,moving:load.audit,rudder,turns,scope:'Спокойная вода/малый ход, без экипажа и нового воздушного закона; эти проверки не принимают управляемый учебный манёвр.'},null,2)+'\n',{flag:'wx'});
console.log('Вода SV20: плавучесть, три момента, перенос/поворот, зеркало руля и отрицательная мощность затухания — пройдены.');
