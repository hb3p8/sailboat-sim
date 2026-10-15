// Измерение не должно скрывать отставание или менять шаг настоящего Worker.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Worker as NodeWorker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {GennakerMetrics} from '../sim/gennaker-metrics.mjs';
import {gennakerScenario} from '../sim/gennaker-scenario.mjs';
import {startGennakerSimulator} from '../sim/gennaker-live.mjs';
import {prescribedGennaker,gennakerPose} from '../sim/gennaker-energy.mjs';
import {Boat} from '../sim/physics.js';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
let time=0;const clock=new GennakerMetrics({now:()=>time,profile:true});
time=100;clock.state('running');time=1100;clock.accepted(.5);
assert.equal(clock.snapshot().tempo,.5);assert.equal(clock.snapshot().lagS,.5);
clock.state('preparing');time=3100;clock.state('running');time=4100;clock.accepted(.5);
clock.visibility(true);time=8100;clock.accepted(.1);clock.visibility(false);
clock.frame({paused:true});time=10100;clock.frame({paused:false});
clock.state('failed');time=11100;const snap=clock.snapshot();
assert.deepEqual(snap.phaseMs,{startup:100,preparing:2000,running:2000,paused:2000,hidden:4000,failed:1000,complete:0});
assert.equal(snap.activeModelS,1);assert.equal(snap.excludedModelS,.1);assert.equal(snap.tempo,.5);
assert.throws(()=>clock.tick(0),/возрастать/);clock.reset();assert.equal(clock.snapshot().steps,0);
clock.state('running');clock.frame();time+=16;clock.frame();clock.visibility(true);time+=5000;clock.visibility(false);clock.frame();
assert.deepEqual(clock.snapshot().frameIntervalsMs,[16]);
let at=0;const scheduler=new GennakerMetrics({now:()=>at});scheduler.state('running');
at=33.2;assert.equal(scheduler.due(1/30),false);at=66.4;assert.equal(scheduler.due(1/30),true);scheduler.accepted(1/30);
at=99.6;assert.equal(scheduler.due(1/30),true);scheduler.accepted(1/30);
scheduler.visibility(true);at=5099.6;assert.equal(scheduler.due(1/30),false);scheduler.visibility(false);
assert.equal(scheduler.due(1/30),false);at=5100.6;assert.equal(scheduler.due(1/30),true);
assert.throws(()=>gennakerScenario('?physics-run=unknown',5),/Неизвестный/);
assert.throws(()=>gennakerScenario('?physics-run=controls-v1&physics-wake=2',5),/Сценарий/);
const fixture=JSON.parse(readFileSync('out/acceptance/fluid-live-main-20261010-plus.json')),
  pack=JSON.parse(readFileSync('out/export/physics.json')),
  factor=await loadSparseFactor(readFileSync('out/acceptance/cloth-sparse-20261002-simd.wasm'));
const attempts=[],calc=prescribedGennaker(fixture,pack,gennakerPose(new Boat(pack)),factor,undefined,{observeAttempt:a=>attempts.push(a)});
const physicalStep=calc.motion.step.bind(calc.motion);let failOnce=true;
calc.motion.step=(...args)=>{if(failOnce){failOnce=false;throw new Error('не доведено: известный отказ для проверки учёта повторов');}return physicalStep(...args);};
const retried=calc.step({forceN:new Float64Array(297),targetPose:gennakerPose(new Boat(pack)),sheetLengthM:fixture.sheet.lengthM});
assert.deepEqual(attempts.map(a=>[a.depth,a.accepted]),[[0,false],[1,true],[1,true]]);
assert.equal(retried.leaves.length,2);assert(attempts.every(a=>Number.isFinite(a.ms)&&a.ms>=0));
// DOM/сеть здесь минимальные адаптеры. Это проверка обычного контроллера с
// настоящей лодкой и Worker, не измерение сцены/WebGPU или мобильного браузера.
const elements=new Map();
const element=id=>{if(!elements.has(id))elements.set(id,{style:{},dataset:{},value:'',checked:false,textContent:'',dispatchEvent(){},append(){}});return elements.get(id);};
globalThis.document={hidden:false,addEventListener(){},getElementById:element,createElement:()=>({style:{},dataset:{}})};
globalThis.innerWidth=1000;globalThis.innerHeight=800;
globalThis.fetch=async url=>{try{const data=readFileSync(new URL('.'+url,new URL('../',import.meta.url)));return {ok:true,arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)};}catch{return {ok:false};}};
const workers=new Set();let failNextWorkerStep=false,progressObserver;
globalThis.Worker=class {
  constructor(url) {
    const bootstrap=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};parentPort.on('message',data=>self.onmessage({data}));await import(${JSON.stringify(url.href)});parentPort.postMessage({type:'boot'});`;
    this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(bootstrap)),{type:'module'});workers.add(this.worker);
    this.waiting=[];this.worker.on('message',data=>{if(data.type==='boot'){this.ready=true;for(const m of this.waiting)this.worker.postMessage(m);this.waiting=[];}else {if(data.type==='progress')progressObserver?.();this.onmessage?.({data});}});
    this.worker.on('error',error=>this.onerror?.({message:error.message}));
  }
  postMessage(data){if(failNextWorkerStep&&data.type==='step'){failNextWorkerStep=false;data={...data,forceN:new Float64Array(data.forceN.length).fill(NaN)};}if(this.ready)this.worker.postMessage(data);else this.waiting.push(data);}
  terminate(){workers.delete(this.worker);return this.worker.terminate();}
};
async function run(profile,fps,side='plus',wake=1,schedule='message') {
  globalThis.location={search:`?physics-run=controls-v1&physics-side=${side}&physics-wake=${wake}&physics-profile=${profile?1:0}&physics-schedule=${schedule}`};
  const b=new Boat(pack),ui=Object.fromEntries(['genpressure','wind','winddir','gensheet','genup','jibup','mainup'].map(k=>[k,element(k)]));
  const sim=await startGennakerSimulator({boat:b,ui,manifestPath:'out/export/live-sail-default.json',gameUI:false});
  const startupMs=sim.performance().phaseMs.startup;sim.restart();assert.equal(sim.performance().phaseMs.startup,startupMs);
  const physicalFrames=[],capture=()=>physicalFrames.push({
    boat:Object.fromEntries(['x','y','psi','u','v','r','phi','p_','t','rigSide','zc','w','th','q','hike','rigRate'].map(k=>[k,b[k]])),
    cloth:b.rig.cloth?{positions:Array.from(b.rig.cloth.pos),previous:Array.from(b.rig.cloth.prev),prevDt:b.rig.cloth.prevDt}:null});
  const start=performance.now();let summary,acc=0,last=start;
  while(performance.now()-start<20000) {
    const now=performance.now();acc+=Math.min(.25,(now-last)/1000);last=now;
    sim.observeFrame({timestamp:now,paused:false,hidden:false});
    if(!sim.busy&&sim.canAdvance(1/30,acc))sim.advance(1/30,()=>{},capture);
    if(sim.busy||acc>=1/30)acc=0;
    sim.frame();summary=sim.performance();
    if(summary.phase==='failed')throw new Error(summary.failure?.message??'Отказ сценария');
    if(summary.scenario.done&&!sim.busy)break;
    await delay(1000/fps);
  }
  assert(summary.scenario.done,'Сценарий должен завершиться за 20 с');assert.equal(summary.steps,90);
  assert.equal(summary.queued,0);assert.equal(summary.phase,'complete');
  assert.equal(physicalFrames.length,90);
  const physical={frames:physicalFrames,boat:[b.x,b.y,b.zc,b.psi,b.phi,b.th,b.u,b.v],state:b.gennakerEnergy.state,
    history:b.gennakerEnergy.history.map(({frames,partsMs,...r})=>r)};
  const profiled=summary.records.filter(r=>r.gennakerUp);
  if(profile) {
    assert.equal(profiled.length,80);
    for(const r of profiled){assert(r.timings.rigMs>=0);assert(r.timings.workerComputeMs>0);assert.equal(r.attempts.length,2);
      assert(r.attempts.flat().every(a=>a.ms>=0));}
  } else assert.equal(summary.records.length,0);
  sim.restart();assert.equal(sim.performance().steps,0);assert.equal(sim.performance().scenario.done,false);
  return {physical,summary:{...summary,driverFPS:fps,physicalSha256:createHash('sha256').update(JSON.stringify(physical)).digest('hex')}};
}
try {
  const ordinary=await run(false,120,'plus',1,'frame'),profiled=await run(true,30);
  assert.deepEqual(profiled.physical,ordinary.physical);
  console.log(`Обычный контроллер: 90 состояний совпали точно с измерителями и без них при заданных 30/120 Гц; темп ${profiled.summary.tempo.toFixed(3)} / ${ordinary.summary.tempo.toFixed(3)}.`);
  const sixty=await run(true,60),fast=await run(true,120),frameThirty=await run(true,30,'plus',1,'frame');
  for(const sample of [sixty,fast,frameThirty])assert.deepEqual(sample.physical,ordinary.physical);
  const other=await run(true,60,'minus',3);
  console.log(`Расписания frame/message и 30/60/120 Гц: полные состояния совпали. Темп при 30: ${frameThirty.summary.tempo.toFixed(3)} → ${profiled.summary.tempo.toFixed(3)}.`);
  globalThis.location={search:'?physics-profile=1'};
  const failedBoat=new Boat(pack),failedUI=Object.fromEntries(['genpressure','wind','winddir','gensheet','genup','jibup','mainup'].map(k=>[k,element(k)]));
  const failedSim=await startGennakerSimulator({boat:failedBoat,ui:failedUI,manifestPath:'out/export/live-sail-default.json'});
  failedBoat.setGennaker(true);failedUI.genup.checked=true;failNextWorkerStep=true;failedSim.advance(1/30,()=>{},()=>{});
  const errorStart=performance.now();while(failedSim.performance().phase!=='failed'&&performance.now()-errorStart<5000){failedSim.frame();await delay(5);}
  assert.equal(failedSim.performance().phase,'failed');assert.equal(failedSim.performance().steps,0);
  assert.equal(failedSim.performance().failure.attempts[0][0].accepted,false);
  failedUI.genup.checked=false;failedBoat.setGennaker(false);await delay(35);
  assert(failedSim.canAdvance(1/30,1/30),'После отказа UI должен прочитать уборку генакера');
  failedSim.advance(1/30,()=>{},()=>{});assert.equal(failedSim.performance().steps,1);assert.equal(failedSim.performance().phase,'running');
  const recoveredStart=performance.now();while(failedSim.busy&&performance.now()-recoveredStart<5000){failedSim.frame();await delay(1);}
  assert.equal(failedSim.busy,false);failedSim.restart();
  console.log('Отказ настоящего Worker записан; уборка паруса через обычный UI возобновляет физику.');
  const waterBoat=new Boat(pack,null,{windSpeed:4,windDir:140*Math.PI/180,twist:8*Math.PI/180,crewMass:220}),
    waterUI=Object.fromEntries(['genpressure','wind','winddir','gensheet','genup','jibup','mainup'].map(k=>[k,element(k)])),
    waterSim=await startGennakerSimulator({boat:waterBoat,ui:waterUI,manifestPath:'out/export/live-sail-default.json'});
  waterBoat.x=1355;waterBoat.y=800;waterBoat.setGennaker(true);
  progressObserver=()=>waterBoat.setWater(.04,-.02,.03);
  const inputWater={zM:.0002,slopeEast:.0001,slopeNorth:-.0001};
  waterSim.advance(1/30,()=>waterBoat.setWater(inputWater.zM,inputWater.slopeEast,inputWater.slopeNorth),()=>{});
  const waterStart=performance.now();while(waterSim.busy&&performance.now()-waterStart<5000){waterSim.frame();await delay(5);}
  assert.equal(waterSim.busy,false);assert.equal(waterSim.performance().phase,'running');
  assert.deepEqual(waterBoat.gennakerEnergy.history[0].waterInput,inputWater);
  assert.equal(waterBoat.waveZ,.04);progressObserver=undefined;waterSim.restart();
  console.log('Вход воды сохранён до ожидания Worker; последующий ответ воды его не подменил.');
  const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
  if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-metrics-check-v1',scope:'node-controller-real-worker-not-browser',
    revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
    sources:Object.fromEntries(['sim/gennaker-live.mjs','sim/gennaker-metrics.mjs','sim/gennaker-scenario.mjs',
      'sim/gennaker-energy.mjs','sim/gennaker-energy-worker.mjs','sim/physics.js','sim/aero.js','sim/vlm.js','sim/rig-air-state.js','tests/gennaker-metrics.test.mjs',
      'out/export/physics.json','out/export/live-sail-default.json'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),
    waterInputObserved:{saved:inputWater,later:[.04,-.02,.03]},
    runs:[ordinary.summary,profiled.summary,sixty.summary,fast.summary,frameThirty.summary,other.summary]},null,2)+'\n',{flag:'wx'});
  console.log('Часы: подготовка, пауза, фон и отказ разделены; неудачный родитель и оба дочерних шага записаны. Второй борт/wakeSlice=3 и перезапуск проверены.');
} finally {await Promise.all([...workers].map(w=>w.terminate()));}
