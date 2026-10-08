// Настоящий поток точно повторяет живой воздух/общую механику и отказы.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {createFluidWorker} from './lib/cloth-fluid-client.mjs';
import {liveWindSailMotion} from './lib/cloth-live-wind-sail-motion.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from './probes/cloth-material-wasm.mjs';
import {loadAssemblyKernel} from './probes/cloth-assembly-wasm.mjs';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),out=args.find(a=>a.startsWith('--out='))?.slice(6);assert(args.length===2&&input&&out&&!existsSync(out));
const bytes=readFileSync(input),r=JSON.parse(bytes),pack=JSON.parse(readFileSync('out/export/physics.json')),hash=b=>createHash('sha256').update(b).digest('hex');assert.equal(r.phase,'complete');
function makeWorker(url){const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';import {fluidWorkerHandler} from ${JSON.stringify(url.href)};const handle=fluidWorkerHandler((d,t=[])=>parentPort.postMessage(d,t));parentPort.on('message',d=>{void handle(d);});`)));
  return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(t,fn){w.on(t,d=>fn(t==='message'?{data:d}:{message:d.message}));}};}
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
let exact=0,rejected=0;
for(const run of r.runs){const f=JSON.parse(readFileSync(run.input.path)),client=await createFluidWorker(f.recipe,f.bodyInput,readFileSync(f.wasm.path),{makeWorker,sheet:f.sheet,materialBytes:readFileSync(f.materialWasm.path),assemblyBytes:readFileSync(f.assemblyWasm.path),liveWind:{pack,wind:{speedMPS:6,fromDeg:run.tack*run.angle}}});
  const direct=liveWindSailMotion(f.recipe,f.bodyInput,await loadSparseFactor(readFileSync(f.wasm.path)),{pack,sheet:f.sheet,
    materialKernel:await loadMaterialKernel(readFileSync(f.materialWasm.path)),assemblyKernel:await loadAssemblyKernel(readFileSync(f.assemblyWasm.path)),wind:{speedMPS:6,fromDeg:run.tack*run.angle}});
  try{assert.equal(client.ready.liveWind.model,'rig-current-surface-body-projected-v1');for(const s of run.steps){const x=await client.step(s.controls),audit=direct.step(s.controls),actual=serial({positions:x.positions,body:x.body,forceN:x.forceN,audit:x.audit});
    assert.deepEqual(actual,serial({positions:direct.motion.pos,body:direct.motion.body,forceN:direct.forceN,audit}));
    assert.deepEqual(JSON.parse(JSON.stringify(actual)),{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});exact++;}
    await assert.rejects(client.step({windSpeedMPS:-1}),/ветер/);rejected++;await assert.rejects(client.step({windSpeedMPS:6}),/После отказа/);rejected++;
  }finally{await client.terminate();}}
writeFileSync(out,JSON.stringify({schema:'cloth-live-wind-worker-check-v1',phase:'complete',input:{path:input,sha256:hash(bytes)},exactPairs:exact,rejected},null,2)+'\n',{flag:'wx'});
console.log(`Живой ветер в настоящем Worker: ${exact} строгих пар, ${rejected} отказов — пройдены.`);
