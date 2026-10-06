// Настоящий Worker: отдельный сборщик, полный ответ обоих бортов и отказы.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {relative,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFluidWorker} from './lib/cloth-fluid-client.mjs';
import {fluidWorkerHandler} from './lib/cloth-fluid-worker.mjs';
import {loadAssemblyKernel} from './probes/cloth-assembly-wasm.mjs';
import {verifyAssemblyKernel} from './probes/cloth-assembly-engine-check.mjs';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),
  wasm=args.find(v=>v.startsWith('--wasm='))?.slice(7),material=args.find(v=>v.startsWith('--material-wasm='))?.slice(16),
  assembly=args.find(v=>v.startsWith('--assembly-wasm='))?.slice(16),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&wasm&&material&&assembly&&out&&args.length===6&&args.every(v=>/^--(input|wasm|material-wasm|assembly-wasm|out)=.+$/.test(v))&&!existsSync(out)&&!existsSync(out+'.sources'));
const bytes=readFileSync(wasm),materialBytes=readFileSync(material),assemblyBytes=readFileSync(assembly),hash=b=>createHash('sha256').update(b).digest('hex'),root=fileURLToPath(new URL('../',import.meta.url)),sourceSha256={};
function source(url) {
  const path=relative(root,fileURLToPath(url));if(sourceSha256[path])return;const b=readFileSync(url);sourceSha256[path]=hash(b);
  const target=resolve(out+'.sources',path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,b,{flag:'wx'});
  for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))source(new URL(m[1],url));
}
source(new URL(import.meta.url));source(new URL('./probes/cloth-assembly-wasm.c',import.meta.url));source(new URL('./probes/cloth-material-wasm.c',import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const physical=r=>serial({index:r.index,hS:r.hS,positions:r.positions,body:r.body,forceN:r.forceN,audit:r.audit,controls:r.controls});
function makeWorker(url) {
  const code=`import {parentPort} from 'node:worker_threads';import {fluidWorkerHandler} from ${JSON.stringify(url.href)};
const handle=fluidWorkerHandler((data,transfer=[])=>parentPort.postMessage(data,transfer));parentPort.on('message',data=>{void handle(data);});`;
  const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)));
  return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){w.on(type,data=>fn(type==='message'?{data}:{message:data.message}));}};
}
const report={schema:'cloth-fluid-assembly-worker-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,v8:process.versions.v8,sourceSha256,
  wasm:{path:wasm,sha256:hash(bytes)},materialWasm:{path:material,sha256:hash(materialBytes)},assemblyWasm:{path:assembly,sha256:hash(assemblyBytes)},exactBackendPairs:0,exactProfilePairs:0,rejected:0,results:[]};
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Сборка Worker остановлена: '+e.message);process.exitCode=1;});
assert.equal(new Set(inputs.map(p=>JSON.parse(readFileSync(p)).fixture.side)).size,2);
for(const path of inputs) {
  const input=readFileSync(path),record=JSON.parse(input),f=record.fixture;assert.equal(record.steps.length,180);
  assert.equal(f.wasm.sha256,hash(bytes));assert.equal(f.materialWasm.sha256,hash(materialBytes));
  const variants=[],initials=[];
  for(const [native,profile] of [[false,false],[true,false],[true,true]]) {
    const originals=[bytes,materialBytes,assemblyBytes].map(v=>Buffer.from(v)),client=await createFluidWorker(f.recipe,f.bodyInput,bytes,{sheet:f.sheet,profile,makeWorker,materialBytes,...(native?{assemblyBytes}:{})}),states=[];
    try {
      [bytes,materialBytes,assemblyBytes].forEach((v,i)=>assert.deepEqual(v,originals[i]));assert.equal(Boolean(client.ready.assembly),native);
      initials.push(serial({positions:client.ready.positions,body:client.ready.body}));assert.equal(client.ready.material.backend,'wasm');
      if(native){assert.equal(client.ready.assembly.backend,'wasm');assert.equal(client.ready.assembly.validation.abi,1);assert.equal(client.ready.assembly.validation.matrices,8);assert.equal(client.ready.assembly.validation.elements,184332);assert(client.ready.assembly.checkMs>=0);}
      if(profile)assert(Math.abs(client.ready.compileMs+client.ready.modelMs-client.ready.setupMs)<1e-6);
      for(const old of record.steps) {
        const r=await client.step(old.controls),state=physical(r);assert.deepEqual(JSON.parse(JSON.stringify(state)),physical(old));assert.equal(Boolean(r.timing),profile);states.push(state);
        if(profile){assert.equal(r.timing.linear.factorCalls,r.timing.wasm.numericFactorizations);assert(Math.abs(r.timing.loadMs+r.timing.physicsMs-r.stepMs)<1e-6);}
      }
      const saved=structuredClone(states.at(-1));await assert.rejects(client.step({pressureScale:2}),/Нагрузка/);report.rejected++;
      await assert.rejects(client.step(),/После отказа/);report.rejected++;assert.deepEqual(states.at(-1),saved);
    } finally {await client.terminate();}
    variants.push(states);report.results.push({path,sha256:hash(input),side:f.side,assembly:native?'wasm':'js',profile,preparation:{material:client.ready.material,...(native?{assembly:client.ready.assembly}:{})},exactSteps:180});
  }
  assert.deepEqual(initials[0],initials[1]);assert.deepEqual(initials[1],initials[2]);assert.deepEqual(variants[0],variants[1]);assert.deepEqual(variants[1],variants[2]);report.exactBackendPairs+=180;report.exactProfilePairs+=180;
  console.log(`Сборка Worker, ${f.side==='plus'?'первая':'другая'} сторона: 180 строгих пар сборки и 180 пар наблюдения, включая знак нуля.`);
}
const first=JSON.parse(readFileSync(inputs[0])).fixture;
let created=false;await assert.rejects(createFluidWorker({}, {},bytes,{assemblyBytes:1,makeWorker(){created=true;}}),/байты/);assert.equal(created,false);report.rejected++;
for(const invalid of [Uint8Array.from([0,97,115,109,1,0,0,0]),materialBytes]) {
  await assert.rejects(createFluidWorker(first.recipe,first.bodyInput,bytes,{makeWorker,sheet:first.sheet,assemblyBytes:invalid}),/Несовместимая/);report.rejected++;
}
const messages=[],handle=fluidWorkerHandler(data=>messages.push(data));await handle({id:0,type:'init',assemblyBytes:'да'});assert.match(messages.at(-1).message,/байты/);assert.equal(messages.at(-1).index,0);report.rejected++;
await handle({id:1,type:'step'});assert.match(messages.at(-1).message,/После отказа/);assert.equal(messages.at(-1).index,0);report.rejected++;
const kernel=await loadAssemblyKernel(assemblyBytes);
for(const corruption of ['value','zero','skip']) {
  const bad={compile(length,plans){const compiled=kernel.compile(length,plans);return {assemble(matrix,soft){compiled.assemble(matrix,soft);if(corruption==='value')matrix[0]+=1;else if(corruption==='zero'){const i=matrix.findIndex(v=>Object.is(v,-0));assert(i>=0);matrix[i]=0;}else matrix.fill(0);}};}};
  assert.throws(()=>verifyAssemblyKernel(bad,first.recipe),/расходится/);report.rejected++;
}
assert.throws(()=>verifyAssemblyKernel(kernel,{...first.recipe,rows:21}),/постановку/);report.rejected++;
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Сборка: ${report.exactBackendPairs} строгих пар, ${report.exactProfilePairs} пар наблюдения, ${report.rejected} отказов — пройдены.`);
