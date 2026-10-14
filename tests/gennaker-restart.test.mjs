// Совместный повтор из компонентов М1; это пока не загрузчик обычного UI.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Boat} from '../sim/physics.js';
import {dumpCore} from '../sim/trace.js';
import {energyCloth,prescribedGennaker,gennakerPose,intermediatePose,gennakerBodyPack,localPoint,worldPoint} from '../sim/gennaker-energy.mjs';
import {rotate3} from './lib/cloth-fluid-inertia.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {selectGennakerMaterial} from '../sim/gennaker-material.mjs';
const pack=JSON.parse(readFileSync('out/export/physics.json')),
  factor=await loadSparseFactor(readFileSync('out/acceptance/cloth-sparse-20261002-simd.wasm')),
  fixtures=Object.fromEntries(['plus','minus'].map(side=>[side,JSON.parse(readFileSync(`out/acceptance/fluid-live-main-20261010-${side}.json`))])),
  selected=process.argv.includes('--material-js')?{kernel:undefined,material:{backend:'js',reason:'explicit-test'}}:
    await selectGennakerMaterial(readFileSync('out/acceptance/cloth-material-20261005-probe-v3.wasm'),fixtures.plus.recipe),results=[];
const json=v=>JSON.parse(JSON.stringify(v)),D=Math.PI/180;
function localNumbers(v,read=false) {
  if(read&&v==='-0')return -0;if(!read&&Object.is(v,-0))return '-0';
  if(ArrayBuffer.isView(v)||Array.isArray(v))return Array.from(v,x=>localNumbers(x,read));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,localNumbers(x,read)]));return v;
}
function create(fixture,wind,wakeSlice) {
  const b=new Boat(pack,null,{gennakerUp:true,mainUp:true,jibUp:false,localPressure:false,wakeSlice});
  b.x=1355;b.y=800;b.o.windSpeed=wind;b.o.windDir=(fixture.side==='plus'?140:-140)*D;
  b.o.twist=8*D;b.o.crewMass=220;b.o.crewHike=0;
  b.p=gennakerBodyPack(pack,fixture.recipe).pack;b.mass=b.p.mass.total_kg;b.rig.p=b.p;
  const cloth=energyCloth(fixture.recipe,pack);b.rig.cloth=cloth;
  const pose=gennakerPose(b),calc=prescribedGennaker(fixture,pack,pose,factor,selected.kernel);
  return {b,cloth,calc,pose,world:Float64Array.from(Array.from({length:cloth.n},(_,i)=>worldPoint(pose,Array.from(cloth.pos.slice(3*i,3*i+3)))).flat())};
}
function capture(s) {
  const core=dumpCore(s.b);
  return {local:localNumbers({boat:core.boat,controls:core.controls,wind:core.wind,
    water:[s.b.waveZ,s.b.waveSE,s.b.waveSN],pos:s.cloth.pos,prev:s.cloth.prev,prevDt:s.cloth.prevDt,
    pose:s.pose,world:s.world}),air:s.b.rig.airSnapshot(),solver:s.calc.snapshot()};
}
function restore(fixture,wind,wakeSlice,state) {
  const s=create(fixture,wind,wakeSlice),v=localNumbers(state.local,true);
  Object.assign(s.b,v.boat);Object.assign(s.b.o,v.controls);Object.assign(s.b.wind.o,v.wind);s.b.setWater(...v.water);
  s.cloth.pos.set(v.pos);s.cloth.prev.set(v.prev);s.cloth.prevDt=v.prevDt;
  s.pose=v.pose;s.world=Float64Array.from(v.world);s.b.rig.airRestore(state.air);s.calc.restore(state.solver);return s;
}
function step(s,fixture,i) {
  const {b,cloth,calc}=s,sign=fixture.side==='plus'?1:-1;
  b.o.rudderTarget=(i<20?0:sign*4)*D;b.o.crewHike=i<45?0:sign*.15;
  b.o.genSheetLen=calc.minLengthM+(i>=15&&i<40?.25:0);
  // Малое известное изменение поверхности — вход повторения, не калибровка воды.
  b.setWater(.0002*Math.sin(i/9),.0001*Math.sin(i/7),.0001*Math.cos(i/11));
  const pose=gennakerPose(b),work=b.stepWithGennaker(1/30);assert(!work.next().done);
  cloth.forcesAt(b,1/60,b.rigSide,b.p.environment);
  const forceN=new Float64Array(cloth.frc.length);
  for(let j=0;j<cloth.n;j++)forceN.set(rotate3(pose.orientation9,Array.from(cloth.frc.slice(3*j,3*j+3))),3*j);
  const halves=[intermediatePose(s.pose,pose),pose].map(targetPose=>calc.step({forceN,targetPose,sheetLengthM:b.o.genSheetLen}));
  const result=halves[1],c=Math.cos(b.psi),sn=Math.sin(b.psi),heading=v=>[c*v[0]+sn*v[1],-sn*v[0]+c*v[1],v[2]];
  for(let j=0;j<cloth.n;j++) {
    cloth.pos.set(localPoint(pose,Array.from(result.positions.slice(3*j,3*j+3))),3*j);
    cloth.prev.set(localPoint(s.pose,Array.from(s.world.slice(3*j,3*j+3))),3*j);
  }
  cloth.prevDt=1/30;s.pose=pose;s.world=result.positions;
  const load={forceN:heading(result.forceN.map((v,d)=>(v+halves[0].forceN[d])/2)),
    momentNm:heading(result.momentNm.map((v,d)=>(v+halves[0].momentNm[d])/2)),audit:result.audit};
  // Асинхронное чтение воды во время ожидания не должно подменять захваченный
  // Boat вход. Следующий шаг снова получит собственные три известных числа.
  b.setWater(.07,-.02,.03);assert(work.next(load).done);
  return {halves,nodalAirForceN:Array.from(forceN),load};
}
for(const side of ['plus','minus'])for(const wind of [4,6])for(const wakeSlice of [1,3]) {
  const fixture=fixtures[side],a=create(fixture,wind,wakeSlice);
  for(let i=0;i<30;i++)step(a,fixture,i);
  const checkpoint=json(capture(a)),b=restore(fixture,wind,wakeSlice,checkpoint);
  assert.deepEqual(capture(b),checkpoint);
  const hash=createHash('sha256');
  for(let i=30;i<60;i++) {
    const expected=step(a,fixture,i),actual=step(b,fixture,i);assert.deepEqual(actual,expected);
    const state=capture(a);assert.deepEqual(capture(b),state);hash.update(JSON.stringify({state,result:expected}));
  }
  results.push({side,wind,wakeSlice,restoredAtS:1,continuedSteps:30,physicalSha256:hash.digest('hex')});
  console.log(`Совместный повтор: ${side}, ветер ${wind}, wakeSlice=${wakeSlice} — 30 состояний совпали точно.`);
}
const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-restart-test-v1',scope:'node-components-not-ui-loader',material:selected.material,results,
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  sourceSha256:Object.fromEntries(['sim/aero.js','sim/vlm.js','sim/rig-air-state.js','sim/physics.js','sim/gennaker-energy.mjs','tests/gennaker-restart.test.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))},null,2)+'\n',{flag:'wx'});
