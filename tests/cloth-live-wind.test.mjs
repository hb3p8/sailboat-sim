// Ветер относительно принятой формы: штиль, перенос, поворот и общий интеграл.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createClothLiveWind} from './lib/cloth-live-wind.mjs';
import {rotate3,cross3} from '../sim/cloth/cloth-fluid-inertia.mjs';
const args=process.argv.slice(2),out=args.find(a=>a.startsWith('--out='))?.slice(6);assert(args.length===1&&out&&!existsSync(out));
const pack=JSON.parse(readFileSync('out/export/physics.json')),f=JSON.parse(readFileSync('out/acceptance/fluid-live-snapshots-old-20261008-plus.json')),r=f.recipe;
const I=[1,0,0,0,1,0,0,0,1],Z=[0,-1,0,1,0,0,0,0,1],v=[2,-1,.3],omega=[.1,-.05,.07];
function state(R=I,origin=[0,0,0],velocity6=[0,0,0,0,0,0]) {
  const pos=Float64Array.from(r.positions.slice(0,3*r.rows*r.cols)),vel=new Float64Array(pos.length);
  for(let i=0;i<pos.length/3;i++) {const p=Array.from(pos.slice(3*i,3*i+3)),world=rotate3(R,p),spin=cross3(velocity6.slice(3),p),speed=rotate3(R,velocity6.slice(0,3).map((x,d)=>x+spin[d]));
    for(let d=0;d<3;d++){pos[3*i+d]=origin[d]+world[d];vel[3*i+d]=speed[d];}}
  return {pos,vel,body:{orientation9:R.slice(),originM:origin.slice(),velocity6:velocity6.slice()},ropeLengthsM:[f.sheet.lengthM]};
}
// Прежний Rig начинает переход между постановками с нулевой силы.
// Проверяем всю короткую историю, а ненулевую нагрузку — после 0.5 с.
const sample=(m,speed=6,dir=140)=>{const air=createClothLiveWind(pack,r);let result;
  for(let k=0;k<30;k++)result=air.evaluate(m,{windSpeedMPS:speed,windFromDeg:dir},k*r.hS);return result;};
const close=(a,b,tol=2e-10)=>assert(Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const quiet=state(),before=structuredClone(quiet),calm=sample(quiet,0);assert(calm.forceN.every(x=>x===0));assert.deepEqual(quiet,before);
const a=sample(quiet),shifted=state(I,[23,-17,2]),b=sample(shifted);assert(Math.hypot(...a.audit.totalForceN)>1);a.forceN.forEach((x,i)=>close(x,b.forceN[i]));
const rotated=sample(state(Z),6,-130);for(let i=0;i<a.forceN.length/3;i++){const expected=rotate3(Z,Array.from(a.forceN.slice(3*i,3*i+3)));expected.forEach((x,d)=>close(rotated.forceN[3*i+d],x));}
// При движении вместе с однородным ветром кажущийся поток нулевой.
const w=6,from=140*Math.PI/180,following=state(I,[0,0,0],[-w*Math.cos(from),-w*Math.sin(from),0,0,0,0]);
assert(sample(following,6).forceN.every(x=>Math.abs(x)<1e-10));
// Мощность суммарной силы/момента равна работе тех же узловых сил.
const moving=state(I,[1,2,3],[...v,...omega]),load=sample(moving);let power=0;const force=[0,0,0],moment=[0,0,0];
for(let i=0;i<moving.pos.length/3;i++){const F=Array.from(load.forceN.slice(3*i,3*i+3)),p=Array.from(moving.pos.slice(3*i,3*i+3),(x,d)=>x-moving.body.originM[d]),M=cross3(p,F);
  for(let d=0;d<3;d++){force[d]+=F[d];moment[d]+=M[d];power+=F[d]*moving.vel[3*i+d];}}
force.forEach((x,d)=>close(x,load.audit.totalForceN[d]));moment.forEach((x,d)=>close(x,load.audit.momentNm[d]));
close(power,force.reduce((s,x,d)=>s+x*v[d],0)+moment.reduce((s,x,d)=>s+x*omega[d],0));
// Перенос начала механики в ЦТ не должен менять геометрию/скорость воздуха.
const geometryCGM=[2.83,0,-.05],spinCG=cross3(omega,geometryCGM),atCG=structuredClone(moving);
atCG.body.originM=moving.body.originM.map((x,d)=>x+geometryCGM[d]);
atCG.body.velocity6=[...v.map((x,d)=>x+spinCG[d]),...omega];
const cgAir=createClothLiveWind(pack,r,{geometryCGM});let cgLoad;
for(let k=0;k<30;k++)cgLoad=cgAir.evaluate(atCG,{windSpeedMPS:6,windFromDeg:140},k*r.hS);
load.forceN.forEach((x,k)=>close(x,cgLoad.forceN[k]));
const shiftedMoment=cross3(geometryCGM,load.audit.totalForceN);
load.audit.momentNm.forEach((x,d)=>close(x-shiftedMoment[d],cgLoad.audit.momentNm[d]));
const held=structuredClone(a);sample(state(),8);assert.deepEqual(a,held);
let rejected=0;for(const controls of [{windSpeedMPS:-1},{windSpeedMPS:13},{windFromDeg:NaN},{windFromDeg:181}]){assert.throws(()=>createClothLiveWind(pack,r).evaluate(quiet,controls),/ветер/);rejected++;assert.deepEqual(quiet,before);}
const hash=b=>createHash('sha256').update(b).digest('hex');writeFileSync(out,JSON.stringify({schema:'cloth-live-wind-check-v1',phase:'complete',rejected,
  staticForceN:a.audit.totalForceN,staticMomentNm:a.audit.momentNm,powerW:power,frame:'inertial-cartesian-cg',
  sources:Object.fromEntries(['tests/lib/cloth-live-wind.mjs','out/export/physics.json'].map(p=>[p,hash(readFileSync(p))]))},null,2)+'\n',{flag:'wx'});
console.log('Живой ветер: штиль, движение с потоком, перенос/поворот/начало в ЦТ, сила/три момента/мощность, владение и 4 отказа — пройдены.');
