// Полная память воздуха: снимок проходит JSON и не разогревает след заново.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Boat} from '../sim/physics.js';
import {dumpCore,applyDump} from '../sim/trace.js';
const pack=JSON.parse(readFileSync('out/export/physics.json')),D=Math.PI/180,results=[];
const json=v=>JSON.parse(JSON.stringify(v));
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function nextStep(boat,i,side) {
  boat.o.sheet=(i<15?25:33)*D;boat.o.windSpeed=i<30?5:6;
  boat.o.rudderTarget=(i<20?0:side*4)*D;boat.o.crewHike=i<40?0:side*.3;
  boat.o.freeWake=boat.o.wakeForces=i<25||i>=35;
  boat.setWater(.003*Math.sin(i/9),.001*Math.sin(i/7),.001*Math.cos(i/11));boat.step(1/30);
}
for(const gennakerUp of [false,true])for(const wakeSlice of [1,3])for(const count of [0,1,2,3,35]) {
  const b=new Boat(pack,null,{gennakerUp,wakeSlice});
  for(let i=0;i<count;i++)b.step(1/30);
  const state=json(b.rig.airSnapshot()),c=new Boat(pack,null,{gennakerUp,wakeSlice});
  c.rig.airRestore(state);assert.deepEqual(c.rig.airSnapshot(),state);
  if(count===0){b.rig.ensureWake();const early=json(b.rig.airSnapshot());c.rig.airRestore(early);assert.deepEqual(c.rig.airSnapshot(),early);}
}
for(const side of [-1,1])for(const wakeSlice of [1,3]) {
  const b=new Boat(pack,null,{wakeSlice,windDir:side*85*D});b.x=1355;b.y=800;b.u=3;
  b.wind.o.gust=.15;b.wind.o.shift=7*D;
  for(let i=0;i<45;i++)b.step(1/30);
  const c=new Boat(pack);applyDump(c,dumpCore(b));
  const saved=json(b.rig.airSnapshot());c.rig.airRestore(saved);
  assert.deepEqual(c.rig.airSnapshot(),saved);
  // Владение копией и сохранение ссылок, по которым стареют скорости.
  saved.rig.lvx[0]+=1;assert.notEqual(c.rig.lvx[0],saved.rig.lvx[0]);
  assert.equal(c.rig.wake.aged[0],c.rig.lvx);assert.equal(c.rig.wake.aged[3],c.rig.wake.sx);
  const before=sha(c.rig.airSnapshot()),valid=json(c.rig.airSnapshot());
  const invalid=[s=>s.schema='unknown',s=>s.configuration+='x',s=>delete s.rig.fPrev,
    s=>s.rig.alphaLag.pop(),s=>s.rig.fPrev[0]=NaN,s=>delete s.rig.alphaLag[0],
    s=>s.rig.latOn[0]=2,s=>s.rig.latCool[0]=-1,s=>s.rig.fWas[0]=.5,
    s=>s.rig.latWarm[0]=32768,s=>delete s.rig.lvy,s=>s.rig.typo=1,
    s=>s.rig.sailOut.phase='after-boat',s=>s.rig.sailOut.bySail.pop(),
    s=>s.rig.stripCalc[0].q.pop(),s=>s.rig.stripState[0].drive=Infinity,
    s=>s.lattice.gamma.pop(),s=>s.lattice.n++,s=>s.lattice.core=-1,
    s=>s.lattice.panels[0].nrm[1]=null,s=>s.wake.fil++,s=>s.wake.len++,
    s=>s.wake.n=1000,s=>s.wake.slice=0,s=>s.wake.rc[0]=-1,s=>s.wake.ring[0]=2,
    s=>s.wake.sel[0]=-1,s=>s.wake.hold=true,s=>s.wake.warm=0,
    s=>s.wake.aged.pop(),s=>s.wake.aged.push(s.wake.aged[0]),s=>s.wake.aged[0]='__proto__.x',
    s=>delete s.wake.sy,s=>s.wake=null,s=>delete s.wake,s=>s.extra=0];
  for(const mutate of invalid){const bad=structuredClone(valid);mutate(bad);
    assert.throws(()=>c.rig.airRestore(bad),/Некорректный снимок воздуха/);assert.equal(sha(c.rig.airSnapshot()),before);}
  const reset=new Boat(pack);applyDump(reset,dumpCore(c));reset.rig.airRestore(valid);reset.rig.wake.invalidate();nextStep(reset,0,side);
  let resetForceDeltaN=0;
  const continued=createHash('sha256');
  for(let i=0;i<60;i++) {
    for(const boat of [b,c])nextStep(boat,i,side);
    if(i===0)resetForceDeltaN=Math.max(...['fx','fy','fz'].map(k=>Math.abs(reset.rig.sailOut[k]-b.rig.sailOut[k])));
    assert.deepEqual(dumpCore(c).boat,dumpCore(b).boat);
    assert.deepEqual(c.rig.airSnapshot(),b.rig.airSnapshot());
    continued.update(JSON.stringify({boat:dumpCore(b).boat,air:b.rig.airSnapshot()}));
  }
  if(wakeSlice===3)assert(resetForceDeltaN>0,'Сброс удержанных скоростей должен быть различимым отрицательным контролем');
  results.push({side,wakeSlice,continuedSteps:60,rejections:invalid.length,resetForceDeltaN,sha256:continued.digest('hex')});
}
// Неизвестное поле модели должно потребовать явного решения о его памяти.
const unknown=new Boat(pack);unknown.rig.unclassifiedState=1;
assert.throws(()=>unknown.rig.airSnapshot(),/не описано поле Rig/);
delete unknown.rig.unclassifiedState;unknown.rig.lattice.unclassifiedState=1;
assert.throws(()=>unknown.rig.airSnapshot(),/не описано поле Lattice/);
delete unknown.rig.lattice.unclassifiedState;unknown.rig.ensureWake().unclassifiedState=1;
assert.throws(()=>unknown.rig.airSnapshot(),/не описано поле Wake/);
const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
if(out)writeFileSync(out,JSON.stringify({schema:'rig-air-state-test-v1',results,initialStates:20,
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  sourceSha256:Object.fromEntries(['sim/aero.js','sim/vlm.js','sim/rig-air-state.js','tests/rig-air-state.test.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))},null,2)+'\n',{flag:'wx'});
console.log('Снимок воздуха: 20 начальных состояний, 240 шагов продолжения с обоих бортов при wakeSlice 1/3 и '+results.reduce((s,r)=>s+r.rejections,0)+' атомарных отказа — пройдены.');
