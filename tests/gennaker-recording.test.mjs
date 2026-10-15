// Повтор принимает команды/воду, а все результаты снова вычисляет модель.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Boat} from '../sim/physics.js';
import {startGennakerSimulator} from '../sim/gennaker-live.mjs';
import {GennakerRecording,validateRecording} from '../sim/gennaker-recording.mjs';
import {liveHarness,settled} from './lib/gennaker-live-harness.mjs';
const pack=JSON.parse(readFileSync('out/export/physics.json')),h=liveHarness({js:process.argv.includes('--material-js')}),results=[];
const json=x=>JSON.parse(JSON.stringify(x));
async function create(search='',record=true) {
  globalThis.location={search};const boat=new Boat(pack),sim=await startGennakerSimulator({boat,ui:h.ui(),manifestPath:'out/export/live-sail-default.json',record});return {boat,sim};
}
async function step(s,i) {
  s.sim.advance(1/30,()=>{s.boat.setWater(.0002*Math.sin(i),.0001,-.0001);},()=>{});await settled(s.sim);
}
try {
  const empty=await create(),emptyRecord=json(await empty.sim.capture((s,r)=>r));
  assert.equal((await empty.sim.replay(emptyRecord)).steps,0);empty.sim.restart();
  for(const side of ['plus','minus'])for(const wake of [1,3]) {
    const a=await create(`?physics-run=controls-v1&physics-side=${side}&physics-wake=${wake}`);
    for(let i=0;i<90;i++)await step(a,i);
    const replay=json(await a.sim.capture((end,r)=>r)),b=await create();
    const detached=await a.sim.capture((end,r)=>r);detached.inputs[0].timeS=0;
    assert.deepEqual(await a.sim.capture((end,r)=>r),replay);
    assert.equal(replay.inputs.length,89);assert.equal(replay.inputs[0].water[0],.0002*Math.sin(1));
    assert(replay.inputs.every(i=>!Object.hasOwn(i.controls,'rudder')));
    const result=await b.sim.replay(replay);assert.equal(result.exact,true);assert.deepEqual(await b.sim.capture(),replay.end);
    let rejected=0;
    for(const mutate of [r=>r.schema='wrong',r=>r.inputs[0].timeS=1,r=>r.inputs[0].dt=.1,r=>r.inputs[0].water[0]=null,
      r=>r.inputs[0].controls.windSpeed='4',r=>r.inputs[0].output.t=0,r=>r.end.engine='changed',r=>r.anchor.runtimeSha256['sim/physics.js']='changed']) {
      const bad=json(replay);mutate(bad);await assert.rejects(b.sim.replay(bad));assert.deepEqual(await b.sim.capture(),replay.end);rejected++;
    }
    const altered=json(replay);altered.inputs[20].controls.sheet+=.01;
    await assert.rejects(b.sim.replay(altered),/расходится|не совпал/);
    results.push({side,wake,steps:result.steps,rejections:rejected,physicalSha256:createHash('sha256').update(JSON.stringify({model:replay.end.model,solver:replay.end.solver,adapter:replay.end.adapter})).digest('hex')});
    a.sim.restart();b.sim.restart();
    console.log(`Повтор ${side}, wake=${wake}: ${result.steps} точных шагов, ${rejected} отказов до изменения и обнаруженная подмена команды.`);
  }
  const on=await create('?physics-run=controls-v1&physics-wake=3'),off=await create('?physics-run=controls-v1&physics-wake=3',false);
  for(let i=0;i<90;i++){await step(on,i);await step(off,i);}
  assert.deepEqual(await on.sim.capture(),await off.sim.capture());assert.equal(on.sim.performance().recording.checkpoints,3);
  assert.equal(off.sim.performance().recording.checkpoints,0);on.sim.restart();off.sim.restart();
  // Два оборота кольца: начальная сессия давно отсечена. Команды подъёма,
  // уборки и управления сохраняются наравне с шагами без новой ткани.
  const a=await create();a.boat.o.windSpeed=4;a.boat.o.windDir=140*Math.PI/180;a.boat.o.wakeSlice=3;
  for(let i=0;i<665;i++) {
    if([20,140,410].includes(i))a.boat.setGennaker(true);
    if([120,390].includes(i))a.boat.setGennaker(false);
    a.boat.o.genSheetLen=5.25+(i%80<40?.05:0);
    a.boat.o.mainUp=i<300||i>=310;
    a.boat.o.windSpeed=i>=470&&i<500?4.2:4;
    a.boat.wind.o.gust=i>=510?.02:0;
    a.boat.o.crewHike=i>=540?.1:0;
    await step(a,i);
  }
  const replay=json(await a.sim.capture((end,r)=>r));validateRecording(replay);
  assert(replay.inputs.length>=300&&replay.inputs.length<=329);
  assert(replay.anchor.model.local.body.t>10);assert(replay.inputs.some(i=>!i.controls.gennakerUp));assert(replay.inputs.some(i=>i.controls.gennakerUp));
  const b=await create();assert.equal((await b.sim.replay(replay)).exact,true);
  assert.deepEqual(await b.sim.capture(),replay.end);
  const bytes=Buffer.byteLength(JSON.stringify(replay));
  const stats=a.sim.performance().recording;assert.equal(stats.checkpoints,23);assert(stats.blocks<=11);
  console.log(`Кольцо: ${replay.inputs.length} шагов, начало ${replay.anchor.model.local.body.t} с; ${bytes} байт JSON, повтор точный.`);
  // Сбои записи не должны выдавать неполную историю за рабочую или останавливать шаги.
  const ring=new GennakerRecording();await ring.accepted({},null,async()=>{throw Error('проверка отказа снимка');});assert.throws(()=>ring.snapshot({}),/История недоступна/);
  ring.reset(replay.end);assert.equal(ring.snapshot(replay.end).inputs.length,0);
  a.sim.restart();b.sim.restart();
  const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
  if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-recording-check-v1',material:process.argv.includes('--material-js')?'js':'wasm',results,
    ring:{steps:replay.inputs.length,startS:replay.anchor.model.local.body.t,endS:replay.end.model.local.body.t,jsonBytes:bytes,stats},recordingOnOffEqual:true,
    revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sources:Object.fromEntries(['sim/gennaker-live.mjs','sim/gennaker-session.mjs','sim/gennaker-recording.mjs','tests/gennaker-recording.test.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))},null,2)+'\n',{flag:'wx'});
} finally {await h.close();}
