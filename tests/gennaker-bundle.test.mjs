// Новые адреса и старый исследовательский указатель дают одну физику.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Boat} from '../sim/physics.js';
import {startGennakerSimulator} from '../sim/gennaker-live.mjs';
import {liveHarness,settled} from './lib/gennaker-live-harness.mjs';
const path='data/simulator/v1/manifest.json',manifest=JSON.parse(readFileSync(path)),pack=JSON.parse(readFileSync(manifest.physics.path));
const h=liveHarness({js:process.argv.includes('--material-js')}),fetchFile=globalThis.fetch,requests=[],results=[];let packaged=false;
globalThis.fetch=async url=>{if(packaged){requests.push(url);assert(!/^\/(?:out|tests)\//.test(url),'Обычный вход не должен читать '+url);}return fetchFile(url);};
const physical=s=>({model:s.model,solver:s.solver,adapter:s.adapter,material:s.material});
try {
  for(const side of ['plus','minus'])for(const wake of [1,3]) {
    globalThis.location={search:`?physics-run=controls-v1&physics-side=${side}&physics-wake=${wake}`};
    const a=new Boat(pack),b=new Boat(pack);packaged=false;
    const old=await startGennakerSimulator({boat:a,ui:h.ui(),manifestPath:'out/export/live-sail-default.json'});packaged=true;
    const current=await startGennakerSimulator({boat:b,ui:h.ui(),manifestPath:path});
    for(let i=0;i<90;i++) {
      for(const [boat,sim] of [[a,old],[b,current]]){sim.advance(1/30,()=>boat.setWater(.0001*Math.sin(i),0,0),()=>{});await settled(sim);}
      if(i%10===0)assert.deepEqual(physical(await old.capture()),physical(await current.capture()));
    }
    const end=await current.capture();assert.deepEqual(physical(end),physical(await old.capture()));
    results.push({side,wake,steps:90,physicalSha256:createHash('sha256').update(JSON.stringify({model:end.model,solver:end.solver,adapter:end.adapter})).digest('hex')});
    old.restart();current.restart();console.log(`Упаковка ${side}, wake=${wake}: 90 состояний, точное совпадение.`);
  }
  const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
  if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-bundle-check-v1',material:process.argv.includes('--material-js')?'js':'wasm',results,
    requests:[...new Set(requests)],manifestSha256:createHash('sha256').update(readFileSync(path)).digest('hex')},null,2)+'\n',{flag:'wx'});
} finally {await h.close();}
