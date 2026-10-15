// Независимые энергия, бюджет и перенос инерции; назначение массы не калибруется.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {sv20SailMass,shiftAddedInertia} from '../sim/cloth/cloth-sv20-mass.mjs';
import {fluidInertia,cross3,dotN,rotate3,product3,transpose3,matrixVector} from '../sim/cloth/cloth-fluid-inertia.mjs';
import {boatBodyRotation} from '../sim/axes.js';
import {FluidBodyEnergyMotion} from './lib/cloth-fluid-body-motion.mjs';
const [out]=process.argv.slice(2);assert(out&&process.argv.length===3&&!existsSync(out));
const packBytes=readFileSync('out/export/physics.json'),pack=JSON.parse(packBytes),hash=b=>createHash('sha256').update(b).digest('hex');
const close=(a,b)=>assert(Math.abs(a-b)<=2048*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const R=boatBodyRotation(.43,-.27,.19),J=product3(product3(R,[2,0,0,0,3,0,0,0,4]),transpose3(R));
const tensor=fluidInertia({dryMassKg:10,dryInertia9:J});
for(const v of [[1,2,3,.4,-.2,.5],[-2,.3,.5,-.7,.6,.1]]) {
  const local=rotate3(transpose3(R),v.slice(3));
  close(tensor.kineticJ(v),5*dotN(v.slice(0,3),v.slice(0,3))+.5*local.reduce((s,x,k)=>s+(k+2)*x*x,0));
  close(dotN(v,tensor.convective(v)),0);
}
assert.throws(()=>fluidInertia({dryMassKg:1,dryInertia9:[1,0,0,0,10,0,0,0,1]}),/инерц|энерги/);
assert.throws(()=>fluidInertia({dryMassKg:1,dryInertia9:[2,1,0,0,3,0,0,0,4]}),/симметр/);
assert.throws(()=>fluidInertia({dryMassKg:1,dryInertia9:J,dryPrincipalInertiaKgM2:[2,3,4]}),/Некоррект/);
const I9=[1,0,0,0,1,0,0,0,1],model=new FluidBodyEnergyMotion({positions:[],mass:[],constraints:[],
  body:{inertia:tensor,originM:[0,0,0],orientation9:I9,velocity6:[.2,-.1,.3,.04,.03,-.02],attachments:[],frame:'body-cg'}});
for(let k=0;k<30;k++) {
  const a=model.step({frame:'inertial-cartesian-cg',forceN:[1,-2,.5],momentNm:[.1,.2,-.3],clothForceN:[]},1/60,80);
  assert(a.maxPhysicalResidualN<=a.solver.forceToleranceN&&Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ);
}
const results=[];
for(const side of ['plus','minus']) {
  const path=`out/acceptance/fluid-live-wind-record-20261008-${side}.json`,bytes=readFileSync(path),recipe=JSON.parse(bytes).recipe,before=structuredClone({pack,recipe});
  const b=sv20SailMass(pack,recipe),a=b.audit;assert.deepEqual({pack,recipe},before);assert.equal(a.totalDryKg,pack.mass.total_kg);
  close(a.drySailKg+a.addedAirKg,a.effectiveClothKg);assert(a.drySailKg<3&&a.effectiveClothKg>250);
  for(let d=0;d<3;d++)close(a.bodyKg*b.cgM[d]+a.drySailKg*a.removedAtM[d],a.totalDryKg*a.packageCGM[d]);
  const dryAtRem=fluidInertia({dryMassKg:a.bodyKg,dryInertia9:a.dryInertia9}).matrix6;
  const dryAtOld=shiftAddedInertia(dryAtRem,b.cgM,a.packageCGM);
  const pointMass=Array.from({length:36},(_,k)=>k%7===0&&k<21?a.drySailKg:0);
  const removed=shiftAddedInertia(pointMass,a.removedAtM,a.packageCGM);
  const old=[a.totalDryKg,a.totalDryKg,a.totalDryKg,pack.mass.ixx_kg_m2,pack.mass.iyy_kg_m2,pack.mass.izz_kg_m2];
  dryAtOld.forEach((x,k)=>close(x+removed[k],k%7===0?old[k/7]:0));
  for(const v of [[1,2,3,.4,-.2,.5],[-2,.3,.5,-.7,.6,.1]]) {
    const arm=a.packageCGM.map((x,d)=>x-b.cgM[d]),spin=cross3(v.slice(3),arm),atOld=[...v.slice(0,3).map((x,d)=>x+spin[d]),...v.slice(3)];
    close(dotN(v,matrixVector(a.addedMass6,v)),dotN(atOld,matrixVector(a.addedAtPackageCG,atOld)));
    close(dotN(v,b.inertia.convective(v)),0);
  }
  const bad=structuredClone(recipe);bad.mass.fill(.000001);assert.throws(()=>sv20SailMass(pack,bad),/инерция/);
  assert.throws(()=>sv20SailMass(pack,recipe,{allocation:'unknown'}),/выделение/);
  results.push({side,input:{path,sha256:hash(bytes)},audit:a});
}
assert.deepEqual(results[0].audit,results[1].audit);
writeFileSync(out,JSON.stringify({schema:'cloth-sv20-mass-check-v1',phase:'complete',physicsSha256:hash(packBytes),
  sources:Object.fromEntries(['tests/cloth-sv20-mass.test.mjs','sim/cloth/cloth-sv20-mass.mjs','sim/cloth/cloth-fluid-inertia.mjs'].map(p=>[p,hash(readFileSync(p))])),
  tensorSteps:30,results,scope:'Принят учёт назначенной массы/энергии и двух зеркал, не измеренная доля генакера в рангоуте или гидросилы.'},null,2)+'\n',{flag:'wx'});
console.log('Бюджет SV20: оба борта, масса/ЦТ/полная инерция, энергия переноса воды и 30 общих шагов — пройдены.');
