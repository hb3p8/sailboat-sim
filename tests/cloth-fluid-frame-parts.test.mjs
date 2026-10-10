// Прерываемый шаг сравнивается с сохранённым прежним кодом, а не сам с собой.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {createFluidWorker} from './lib/cloth-fluid-client.mjs';
import {liveWindSailMotion} from './lib/cloth-live-wind-sail-motion.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from './probes/cloth-material-wasm.mjs';
import {loadAssemblyKernel} from './probes/cloth-assembly-wasm.mjs';
const args=process.argv.slice(2),fixture=args.find(x=>x.startsWith('--fixture='))?.slice(10),out=args.find(x=>x.startsWith('--out='))?.slice(6);
assert(args.length===2&&fixture&&out&&!existsSync(out));
const hash=b=>createHash('sha256').update(b).digest('hex'),fb=readFileSync(fixture),f=JSON.parse(fb),graph=f.graphs.candidate;
assert(!f.dirty&&!f.profile);
const root=resolve(fixture+'.sources/candidate');
for(const [path,sha] of Object.entries(graph.sourceSha256))assert.equal(hash(readFileSync(resolve(root,path))),sha);
for(const [path,sha] of Object.entries(graph.originalSha256))assert.equal(hash(execFileSync('git',['show',graph.revision+':'+path])),sha);
const {liveWindSailMotion:oldMotion}=await import(pathToFileURL(resolve(root,'tests/lib/cloth-live-wind-sail-motion.mjs')).href);
const pack=JSON.parse(readFileSync('out/export/physics.json'));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const snapshot=m=>serial({positions:m.motion.pos,body:m.motion.body,forceN:m.forceN});
let progress=0,strict=0,rejected=0,cancelled=0;const partCounts={};
function adapter(onProgress=()=>{}) {return url=>{
 const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';import {fluidWorkerHandler} from ${JSON.stringify(url.href)};const handle=fluidWorkerHandler((d,t=[])=>parentPort.postMessage(d,t));parentPort.on('message',d=>{void handle(d);});`)));
 return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){w.on(type,data=>{if(type==='message'&&data.type==='progress')onProgress(data);fn(type==='message'?{data}:{message:data.message});});}};
};}
for(const part of f.inputs) {
 const record=JSON.parse(readFileSync(part.path)),input=record.fixture;
 const bytes=readFileSync(input.wasm.path),materialBytes=readFileSync(input.materialWasm.path),assemblyBytes=readFileSync(input.assemblyWasm.path);
 const options={pack,wind:input.liveWind.wind,sheet:input.sheet,bodyProfile:input.liveWind.bodyProfile};
 const make=async factory=>factory(input.recipe,input.bodyInput,await loadSparseFactor(bytes),{...options,materialKernel:await loadMaterialKernel(materialBytes),assemblyKernel:await loadAssemblyKernel(assemblyBytes)});
 const baseline=await make(oldMotion),current=await make(liveWindSailMotion);
 let client,lastPart=0;
 client=await createFluidWorker(input.recipe,input.bodyInput,bytes,{sheet:input.sheet,materialBytes,assemblyBytes,frameSliced:true,liveWind:{pack,...input.liveWind},makeWorker:adapter(data=>{
  assert.equal(data.part,++lastPart);assert(data.part<=2);assert(!('positions' in data)&&!('audit' in data));progress++;
  setTimeout(()=>client.resume(),2);
 })});
 try {
  assert.equal(client.ready.frameSliced,true);assert.equal(client.resume(),false);
  for(const row of record.steps) {
   lastPart=0;const promise=client.step(row.controls);
   if(row.index===1){await assert.rejects(client.step(row.controls),/Предыдущий/);rejected++;}
   const result=await promise,oldAudit=baseline.step(row.controls);
   // Промежуточные попытки не публикуют координаты, скорости и позу.
   current.prepareLoad(row.controls);const before=snapshot(current),work=current.solveIterations();let next,yields=0;
   do {next=work.next();if(!next.done){assert.deepEqual(snapshot(current),before);yields++;}} while(!next.done);
   assert(yields>0);
   const expected={...snapshot(baseline),audit:serial(oldAudit)};
   assert.deepEqual({...snapshot(current),audit:serial(next.value)},expected);
   assert.deepEqual(serial({positions:result.positions,body:result.body,forceN:result.forceN,audit:result.audit}),expected);
   assert.deepEqual(result.controls,row.controls);assert.equal(result.index,row.index);
   assert(result.frameWork.parts.length>=1&&result.frameWork.parts.length<=3);
   assert.equal(result.frameWork.parts.length,lastPart+1);assert.equal(client.resume(),false);
   partCounts[result.frameWork.parts.length]=(partCounts[result.frameWork.parts.length]??0)+1;strict++;
  }
  await assert.rejects(client.step({windSpeedMPS:-1}),/ветер/);rejected++;
  await assert.rejects(client.step({windSpeedMPS:4}),/После отказа/);rejected++;
 }finally{await client.terminate();}
 // Остановка между частями отклоняет обещание; завершённое состояние не приходит.
 let paused,signal;const waiting=new Promise(r=>signal=r);
 paused=await createFluidWorker(input.recipe,input.bodyInput,bytes,{sheet:input.sheet,materialBytes,assemblyBytes,frameSliced:true,liveWind:{pack,...input.liveWind},makeWorker:adapter(()=>signal())});
 const abandoned=paused.step(record.steps[0].controls),rejection=assert.rejects(abandoned,/остановлен/);await waiting;await paused.terminate();await rejection;cancelled++;
}
await assert.rejects(createFluidWorker({}, {},new Uint8Array(),{frameSliced:'да'}),/Разделение/);rejected++;
await assert.rejects(createFluidWorker({}, {},new Uint8Array(),{frameSliced:true,profile:true}),/Разделение/);rejected++;
writeFileSync(out,JSON.stringify({schema:'cloth-fluid-frame-parts-check-v1',phase:'complete',fixture:{path:fixture,sha256:hash(fb)},baselineRevision:graph.revision,strictPhysicalPairs:strict,progressMessages:progress,partCounts,rejected,cancelled,
 scope:'360 состояний нового синхронного и разделённого шага строго совпали с прежним кодом в одной среде. Промежуточная механика не публикуется; браузерная плавность проверяется отдельно.'},null,2)+'\n',{flag:'wx'});
console.log(`Части шага: ${strict} строгих физических пар, ${progress} пауз, ${rejected} отказов и ${cancelled} остановки — пройдены.`);
