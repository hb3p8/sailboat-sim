// Реальные Worker: JS/новый материал, профиль, владение байтами и безопасный отказ.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFluidWorker} from './lib/cloth-fluid-client.mjs';
import {fluidWorkerHandler} from './lib/cloth-fluid-worker.mjs';
import {loadMaterialKernel} from './probes/cloth-material-wasm.mjs';
import {verifyMaterialKernel} from './probes/cloth-material-engine-check.mjs';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),
 wasm=args.find(v=>v.startsWith('--wasm='))?.slice(7),materialWasm=args.find(v=>v.startsWith('--material-wasm='))?.slice(16),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&wasm&&materialWasm&&out&&args.length===5&&args.every(v=>/^--(input|wasm|material-wasm|out)=.+$/.test(v))&&!existsSync(out));
const bytes=readFileSync(wasm),materialBytes=readFileSync(materialWasm),hash=b=>createHash('sha256').update(b).digest('hex'),root=fileURLToPath(new URL('../',import.meta.url)),sourceSha256={};
function addSource(url) {
 const path=relative(root,fileURLToPath(url));if(sourceSha256[path])return;const b=readFileSync(url);sourceSha256[path]=hash(b);
 for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))addSource(new URL(m[1],url));
}
addSource(new URL(import.meta.url));addSource(new URL('./probes/cloth-material-wasm.c',import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const physical=r=>serial({index:r.index,hS:r.hS,positions:r.positions,body:r.body,forceN:r.forceN,audit:r.audit,controls:r.controls});
function makeWorker(url) {
 const code=`import {parentPort} from 'node:worker_threads';import {fluidWorkerHandler} from ${JSON.stringify(url.href)};
const handle=fluidWorkerHandler((data,transfer=[])=>parentPort.postMessage(data,transfer));parentPort.on('message',data=>{void handle(data);});`;
 const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)));
 return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){w.on(type,data=>fn(type==='message'?{data}:{message:data.message}));}};
}
const report={schema:'cloth-fluid-material-worker-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,v8:process.versions.v8,sourceSha256,
 wasm:{path:wasm,sha256:hash(bytes)},materialWasm:{path:materialWasm,sha256:hash(materialBytes)},exactBackendPairs:0,exactProfilePairs:0,rejected:0,results:[]};
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Материал Worker остановлен: '+e.message);process.exitCode=1;});
assert.equal(new Set(inputs.map(p=>JSON.parse(readFileSync(p)).fixture.side)).size,2);
for(const path of inputs) {
 const input=readFileSync(path),record=JSON.parse(input),f=record.fixture;assert.equal(record.steps.length,180);assert.equal(f.wasm.sha256,hash(bytes));
 const variants=[],initials=[];
 for(const [native,profile] of [[false,false],[true,false],[true,true]]) {
  const before=Buffer.from(materialBytes),linearBefore=Buffer.from(bytes),client=await createFluidWorker(f.recipe,f.bodyInput,bytes,{sheet:f.sheet,profile,makeWorker,...(native?{materialBytes}:{})}),states=[];
  try {
   assert.deepEqual(materialBytes,before);assert.deepEqual(bytes,linearBefore);assert.equal(Boolean(client.ready.material),native);
   initials.push(serial({positions:client.ready.positions,body:client.ready.body}));
   if(native){assert.equal(client.ready.material.backend,'wasm');assert.equal(client.ready.material.validation.hypotCases,2053);assert(client.ready.material.validation.hessianComponents>1e6&&client.ready.material.checkMs>=0);}
   if(profile)assert(Math.abs(client.ready.compileMs+client.ready.modelMs-client.ready.setupMs)<1e-6);
   for(const old of record.steps) {
    const r=await client.step(old.controls),state=physical(r);assert.deepEqual(JSON.parse(JSON.stringify(state)),physical(old));assert.equal(Boolean(r.timing),profile);states.push(state);
    if(profile){assert.equal(r.timing.linear.factorCalls,r.timing.wasm.numericFactorizations);assert(Math.abs(r.timing.loadMs+r.timing.physicsMs-r.stepMs)<1e-6);}
   }
   const saved=structuredClone(states.at(-1));await assert.rejects(client.step({pressureScale:2}),/Нагрузка/);report.rejected++;
   await assert.rejects(client.step(),/После отказа/);report.rejected++;assert.deepEqual(states.at(-1),saved);
  } finally {await client.terminate();}
  variants.push(states);
  report.results.push({path,sha256:hash(input),side:f.side,backend:native?'wasm':'js',profile,material:client.ready.material,exactSteps:180});
 }
 assert.deepEqual(initials[0],initials[1]);assert.deepEqual(initials[1],initials[2]);
 assert.deepEqual(variants[0],variants[1]);assert.deepEqual(variants[1],variants[2]);report.exactBackendPairs+=180;report.exactProfilePairs+=180;
 console.log(`Материал Worker, ${f.side==='plus'?'первая':'другая'} сторона: 180 строгих пар JS/WASM и 180 пар наблюдения совпали, включая знак нуля.`);
}
const first=JSON.parse(readFileSync(inputs[0])).fixture;
let created=false;await assert.rejects(createFluidWorker({}, {},bytes,{materialBytes:1,makeWorker(){created=true;}}),/байты/);assert.equal(created,false);report.rejected++;
await assert.rejects(createFluidWorker(first.recipe,first.bodyInput,bytes,{makeWorker,sheet:first.sheet,materialBytes:Uint8Array.from([0,97,115,109,1,0,0,0])}),/Несовместимая/);report.rejected++;
const messages=[],handle=fluidWorkerHandler(data=>messages.push(data));
await handle({id:0,type:'init',materialBytes:'да'});assert.match(messages.at(-1).message,/байты/);assert.equal(messages.at(-1).index,0);report.rejected++;
await handle({id:1,type:'step'});assert.match(messages.at(-1).message,/После отказа/);assert.equal(messages.at(-1).index,0);report.rejected++;
const kernel=await loadMaterialKernel(materialBytes);
assert.throws(()=>verifyMaterialKernel({...kernel,hypot3:()=>-0},first.recipe),/расходится/);report.rejected++;
for(const corruption of ['valueInto','hessianInto']) {
 const bad={...kernel,createSurface(){const surface=kernel.createSurface();return {...surface,compile(d){const g=surface.compile(d),call=g[corruption];return {...g,[corruption](...args){const r=call(...args);if(corruption==='valueInto')r[0]+=1;else args[2][0][0]+=1;return r;}};}};}};
 assert.throws(()=>verifyMaterialKernel(bad,first.recipe),/расходится/);report.rejected++;
}
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Материал: ${report.exactBackendPairs} строгих пар движков, ${report.exactProfilePairs} пар наблюдения, ${report.rejected} отказов — пройдены.`);
