// Публичный контракт сессии: настоящий адаптер, две независимые лодки/Worker.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Boat} from '../sim/physics.js';
import {applyDump,dumpCore} from '../sim/trace.js';
import {startGennakerSimulator} from '../sim/gennaker-live.mjs';
import {liveHarness,settled} from './lib/gennaker-live-harness.mjs';
const pack=JSON.parse(readFileSync('out/export/physics.json')),h=liveHarness({js:process.argv.includes('--material-js')}),results=[];
const json=x=>JSON.parse(JSON.stringify(x)),sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function create(search) {
  globalThis.location={search};const boat=new Boat(pack),ui=h.ui();
  const sim=await startGennakerSimulator({boat,ui,manifestPath:'out/export/live-sail-default.json'});return {boat,sim};
}
async function step({boat,sim}){sim.advance(1/30,()=>boat.setWater(0,0,0),()=>{});await settled(sim);}
try {
  for(const side of ['plus','minus'])for(const wake of [1,3]) {
    const search=`?physics-run=controls-v1&physics-side=${side}&physics-wake=${wake}`,a=await create(search);
    // Пустая сессия тоже должна проходить JSON и обратную загрузку.
    const empty=json(await a.sim.capture());await a.sim.restore(empty);assert.deepEqual(await a.sim.capture(),empty);
    for(let i=0;i<30;i++)await step(a);
    const saved=json(await a.sim.capture()),b=await create('');await b.sim.restore(saved);
    assert.deepEqual(await b.sim.capture(),saved);
    const invalid=[s=>s.schema='unknown',s=>s.runtimeSha256['sim/physics.js']='x',s=>s.physicsSha256='x',s=>s.engine='x',
      s=>s.environment.terrainHash='x',s=>s.environment.ui='game',s=>s.side='wrong',s=>s.source.sha256='x',s=>s.adapter.steps=-1,
      s=>s.adapter.scenario.applied=0,s=>s.adapter.scenario.startS=1,s=>s.adapter.scenario.command.sheetM+=1,
      s=>s.model.local.body.u=null,s=>s.model.local.controls.windSpeed='9',s=>s.model.local.controls.typo=1,
      s=>s.model.local.controls.localPressure=true,s=>s.model.local.wind.gradient=1,s=>s.model.local.cloth.prev.pop(),
      s=>s.model.local.cloth.pos[3]+=.1,s=>s.model.air.rig.fPrev.pop(),s=>s.model.air.wake.aged.pop(),
      s=>s.solver.motion.lambda.pop(),s=>s.solver.motion.prevDt=1/30];
    for(const mutate of invalid){const broken=structuredClone(saved);mutate(broken);await assert.rejects(b.sim.restore(broken));assert.deepEqual(await b.sim.capture(),saved);}
    h.breakNextInit();await assert.rejects(b.sim.restore(saved));assert.deepEqual(await b.sim.capture(),saved);
    // Запрос во время шага ждёт принятия обеих частей, а не сохраняет половину.
    a.sim.advance(1/30,()=>{},()=>{});const boundaryPromise=a.sim.capture();a.sim.frame();
    const boundary=await boundaryPromise;await step(b);assert.deepEqual(await b.sim.capture(),boundary);
    const hash=createHash('sha256');
    for(let i=31;i<90;i++) {
      await step(a);await step(b);const expected=await a.sim.capture(),actual=await b.sim.capture();assert.deepEqual(actual,expected);hash.update(JSON.stringify({model:expected.model,solver:expected.solver,adapter:expected.adapter}));
    }
    assert.equal(b.sim.performance().scenario.done,true);
    const final=await b.sim.capture();final.runtimeSha256=Object.fromEntries(Object.entries(final.runtimeSha256).reverse());
    await b.sim.restore(final);
    results.push({side,wake,continuedSteps:60,rejections:invalid.length+1,physicalSha256:hash.digest('hex')});
    a.sim.restart();b.sim.restart();
    console.log(`Сессия ${side}, wake=${wake}: точное продолжение до конца манёвра и ${invalid.length+1} атомарных отказа.`);
  }
  const manual=await create('');manual.boat.o.windSpeed=4;manual.boat.o.windDir=140*Math.PI/180;manual.boat.setGennaker(true);
  for(let i=0;i<15;i++)await step(manual);
  const saved=await manual.sim.capture(),copy=await create('');await copy.sim.restore(json(saved));
  assert.equal(saved.adapter.scenario,null);assert.deepEqual(await copy.sim.capture(),saved);
  for(let i=0;i<20;i++){for(const s of [manual,copy]){s.boat.o.genSheetLen=5.3;s.boat.o.mainUp=i<10;s.boat.o.rudderTarget=.03;await step(s);}assert.deepEqual(await copy.sim.capture(),await manual.sim.capture());}
  for(const s of [manual,copy]){s.boat.setGennaker(false);await step(s);}
  const lowered=await manual.sim.capture();await copy.sim.restore(json(lowered));assert.deepEqual(await copy.sim.capture(),lowered);
  const legacy=dumpCore(new Boat(pack));await copy.sim.legacyLoad(candidate=>applyDump(candidate,legacy));assert.equal(copy.boat.o.gennakerUp,false);
  assert.equal(Object.hasOwn(copy.boat,'seaHs'),false);
  copy.boat.o.localPressure={panels:32};await assert.rejects(copy.sim.capture());copy.boat.o.localPressure=false;
  manual.sim.restart();copy.sim.restart();
  console.log('Обычное управление без сценария, грот/руль/шкот, уборка генакера и прежний дамп без ткани — пройдены.');
  const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
  if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-session-test-v1',manualControls:true,lowered:true,legacyWithoutCloth:true,material:process.argv.includes('--material-js')?'js':'wasm',results,
    revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
    sourceSha256:Object.fromEntries(['sim/gennaker-live.mjs','sim/gennaker-session.mjs','sim/gennaker-worker-channel.mjs','sim/gennaker-scenario.mjs','tests/gennaker-session.test.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))},null,2)+'\n',{flag:'wx'});
} finally {await h.close();}
