// Проверка реальной связи: обычный Boat, его Rig и новая ткань обеих сторон.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Boat} from '../sim/physics.js';
import {applyDump} from '../sim/trace.js';
import {energyCloth,prescribedGennaker,gennakerPose,intermediatePose,gennakerBodyPack,localPoint,worldPoint} from '../sim/gennaker-energy.mjs';
import {rotate3} from './lib/cloth-fluid-inertia.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from './probes/cloth-material-wasm.mjs';
const pack=JSON.parse(readFileSync('out/export/physics.json'));
const factor=await loadSparseFactor(readFileSync('out/acceptance/cloth-sparse-20261002-simd.wasm'));
const material=await loadMaterialKernel(readFileSync('out/acceptance/cloth-material-20261005-probe-v3.wasm'));
const unchanged=new Boat(pack);const originalX=unchanged.x;
assert.throws(()=>applyDump(unchanged,{gennakerEnergy:{},boat:{x:999},controls:{windSpeed:9}}));
assert.equal(unchanged.x,originalX);assert.equal(unchanged.o.windSpeed,6);
const results=[],count=Number(process.env.SV20_COUPLING_STEPS??60),out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
for(const side of ['plus','minus'])for(const wind of [4,6])for(const course of (process.argv.includes('--full')?['broad','reach']:['broad'])) {
  const f=JSON.parse(readFileSync(`out/acceptance/fluid-live-main-20261010-${side}.json`));
  const b=new Boat(pack,null,{gennakerUp:true,mainUp:true,jibUp:false,localPressure:false});
  b.x=1355;b.y=800;
  b.o.windSpeed=wind;b.o.windDir=(course==='broad'?(side==='plus'?140:-140):(side==='plus'?-100:100))*Math.PI/180;
  if(course==='reach'){b.psi=side==='plus'?Math.PI:-Math.PI;b.u=4;}
  b.o.twist=8*Math.PI/180;b.o.crewMass=220;b.o.crewHike=0;
  const body=gennakerBodyPack(pack,f.recipe);b.p=body.pack;b.mass=body.pack.mass.total_kg;b.rig.p=b.p;
  assert(Math.abs(b.mass+body.budget.audit.drySailKg-pack.mass.total_kg)<1e-10);
  const c=energyCloth(f.recipe,pack);b.rig.cloth=c;
  const calc=prescribedGennaker(f,pack,gennakerPose(b),factor,material);
  let priorPose=gennakerPose(b),priorWorld=Float64Array.from(Array.from({length:c.n},(_,i)=>worldPoint(priorPose,Array.from(c.pos.slice(3*i,3*i+3)))).flat()),maxForce=0,maxLength=0,maxWorkRatio=0;
  const samples=[],start=performance.now();
  let step=0;
  try {for(;step<count;step++) {
    b.o.rudderTarget=(step<20?0:side==='plus'?4:-4)*Math.PI/180;
    b.o.genSheetLen=calc.minLengthM+(step>=15&&step<40?.25:0);
    const pose=gennakerPose(b),work=b.stepWithGennaker(1/30),part=work.next();assert(!part.done);
    c.forcesAt(b,1/60,b.rigSide,b.p.environment);
    const forceN=new Float64Array(c.frc.length);
    for(let i=0;i<c.n;i++)forceN.set(rotate3(pose.orientation9,Array.from(c.frc.slice(3*i,3*i+3))),3*i);
    const halves=[intermediatePose(priorPose,pose),pose].map(targetPose=>calc.step({forceN,targetPose,sheetLengthM:b.o.genSheetLen}));
    const result=halves[1],co=Math.cos(b.psi),si=Math.sin(b.psi),heading=v=>[co*v[0]+si*v[1],-si*v[0]+co*v[1],v[2]];
    const load={forceN:heading(result.forceN.map((v,d)=>(v+halves[0].forceN[d])/2)),
      momentNm:heading(result.momentNm.map((v,d)=>(v+halves[0].momentNm[d])/2)),audit:result.audit};
    // Сумма остальных парусов сохраняется при замене генакера, включая pitch.
    const other=structuredClone(part.value.sail.bySail.slice(0,2));
    for(let i=0;i<c.n;i++) {
      c.pos.set(localPoint(pose,Array.from(result.positions.slice(3*i,3*i+3))),3*i);
      c.prev.set(localPoint(priorPose,Array.from(priorWorld.slice(3*i,3*i+3))),3*i);
    }
    c.prevDt=1/30;priorPose=pose;priorWorld=result.positions;
    assert(work.next(load).done);
    const sail=b.rig.sailOut;
    for(let d=0;d<3;d++) {
      assert(Math.abs(sail[['fx','fy','fz'][d]]-other.reduce((s,p)=>s+p.forceN[d],load.forceN[d]))<1e-9);
      assert(Math.abs(sail[['mx','my','mz'][d]]-other.reduce((s,p)=>s+p.momentNm[d],load.momentNm[d]))<1e-9);
    }
    assert([b.x,b.y,b.psi,b.phi,b.th,b.zc,b.u,b.v].every(Number.isFinite));
    for(const h of halves) {
      maxForce=Math.max(maxForce,h.audit.maxForceResidualN);maxLength=Math.max(maxLength,h.audit.maxHardViolationM);
      maxWorkRatio=Math.max(maxWorkRatio,Math.abs(h.audit.discreteBalanceResidualJ)/h.audit.workLimitJ);
      assert(h.audit.maxForceResidualN<=1e-6);assert(h.audit.maxHardViolationM<=1e-9);
    }
    if(step%10===0)samples.push({step:step+1,t:b.t,speed:b.u,heel:b.phi,forceN:load.forceN,momentNm:load.momentNm,lengthM:result.lengthM});
  }} catch(error) {
    if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-simulator-check-v1',phase:'failed',results,
      failed:{side,wind,course,step:step+1,message:error.message,boat:{x:b.x,y:b.y,phi:b.phi,psi:b.psi,t:b.t}},
      revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:true},null,2)+'\n',{flag:'wx'});
    throw error;
  }
  b.setGennaker(false);b.p=pack;b.mass=pack.mass.total_kg;b.rig.p=pack;
  b.step(1/30);assert.equal(b.rig.cloth,null);assert.equal(b.o.jibUp,true);
  b.setGennaker(true);assert(b.rig.cloth);assert.equal(b.o.jibUp,false);
  const result={side,wind,course,steps:count,wallMs:performance.now()-start,maxForce,maxLength,maxWorkRatio,samples};results.push(result);
  console.log(`Борт ${side==='plus'?'+':'−'}, ${course==='broad'?'полный курс':'более острый курс'}, ветер ${wind}: ${count} шагов, ${result.wallMs.toFixed(0)} мс; сила ${maxForce}, длина ${maxLength}`);
}
if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-simulator-check-v1',phase:'complete',model:'boat-prescribed-energy-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  sources:Object.fromEntries(['sim/gennaker-energy.mjs','sim/gennaker-live.mjs','sim/gennaker-energy-worker.mjs','sim/physics.js','tests/gennaker-simulator.test.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),results},null,2)+'\n',{flag:'wx'});
