// Настоящий Worker: независимая проба не меняет физику, индекс или команды.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFluidWorker} from './lib/cloth-fluid-client.mjs';
import {fluidWorkerHandler} from './lib/cloth-fluid-worker.mjs';
import {validateExecutionProbe} from './lib/cloth-execution-probe.mjs';
const args=process.argv.slice(2),inputs=args.filter(a=>a.startsWith('--input=')).map(a=>a.slice(8)),
 wasm=args.find(a=>a.startsWith('--wasm='))?.slice(7),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&wasm&&out&&args.length===4&&!existsSync(out));
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(wasm),root=fileURLToPath(new URL('../',import.meta.url)),sourceSha256={};
function source(url){const p=relative(root,fileURLToPath(url));if(sourceSha256[p])return;const b=readFileSync(url);sourceSha256[p]=hash(b);
 for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))source(new URL(m[1],url));}
source(new URL(import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const physical=r=>serial({index:r.index,hS:r.hS,positions:r.positions,body:r.body,forceN:r.forceN,audit:r.audit,controls:r.controls});
function makeWorker(url){const code=`import {parentPort} from 'node:worker_threads';import {fluidWorkerHandler} from ${JSON.stringify(url.href)};
const handle=fluidWorkerHandler((data,transfer=[])=>parentPort.postMessage(data,transfer));parentPort.on('message',data=>{void handle(data);});`;
 const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)));
 return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){w.on(type,data=>fn(type==='message'?{data}:{message:data.message}));}};}
const report={schema:'cloth-fluid-execution-worker-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,wasm:{path:wasm,sha256:hash(bytes)},exactPairs:0,oldExactSteps:0,rejected:0,results:[]};
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Проверка независимой пробы остановлена: '+e.message);process.exitCode=1;});
for(const input of inputs){
 const b=readFileSync(input),record=JSON.parse(b),f=record.fixture;assert.equal(f.wasm.sha256,hash(bytes));assert.equal(record.steps.length,180);
 const ordinary=await createFluidWorker(f.recipe,f.bodyInput,bytes,{sheet:f.sheet,profile:true,makeWorker}),measured=await createFluidWorker(f.recipe,f.bodyInput,bytes,{sheet:f.sheet,profile:true,probe:true,makeWorker}),checkpoints=[];
 try {
  assert.equal(ordinary.probe,undefined);assert.equal(ordinary.ready.probe,undefined);assert.equal(measured.ready.probe,true);
  assert.deepEqual(Array.from(measured.ready.positions),record.initial.positions);
  assert.deepEqual(measured.ready.body,record.initial.body);
  const probe=async index=>{const p=await measured.probe();assert.equal(p.type,'probe');assert.equal(p.index,index);validateExecutionProbe(p.probe);checkpoints.push(p);};
  await probe(0);
  for(const old of record.steps){const a=await ordinary.step(old.controls),b=await measured.step(old.controls);
   assert.deepEqual(physical(a),physical(b));assert.deepEqual(JSON.parse(JSON.stringify(physical(b))),physical(old));report.exactPairs++;report.oldExactSteps++;
   assert.equal(b.timing.linear.factorCalls,b.timing.wasm.numericFactorizations);
   if([60,120,180].includes(old.index))await probe(old.index);
  }
  // Последний контроль следует и за пробой 180, чтобы выявить отложенную порчу.
  const controls={pressureScale:1,yawMomentNm:0,sheetRateMPS:0};
  assert.deepEqual(physical(await ordinary.step(controls)),physical(await measured.step(controls)));report.exactPairs++;
  const pending=measured.probe();await assert.rejects(measured.probe(),/ещё не завершён/);report.rejected++;validateExecutionProbe((await pending).probe);
  await assert.rejects(measured.step({pressureScale:2}),/Нагрузка/);report.rejected++;
  await assert.rejects(measured.probe(),/После отказа/);report.rejected++;
 }finally{await ordinary.terminate();await measured.terminate();}
 report.results.push({input,sha256:hash(b),side:f.side,checkpoints});
 console.log(`Независимая проба, ${f.side==='plus'?'первая':'другая'} сторона: 181 строгая пара, 180 прежних шагов, пробы 0/60/120/180 и отказы пройдены.`);
}
let created=false;await assert.rejects(createFluidWorker({}, {},bytes,{probe:1,makeWorker(){created=true;}}),/логическим/);assert.equal(created,false);report.rejected++;
for(const command of [{type:'init',probe:'да'},{type:'probe'}]){
 const messages=[],handle=fluidWorkerHandler(data=>messages.push(data));await handle({id:0,...command});assert.equal(messages[0].type,'error');
 await handle({id:1,type:'step'});assert.match(messages[1].message,/После отказа/);report.rejected+=2;
}
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Проба Worker: ${report.exactPairs} точных пар, ${report.oldExactSteps} прежних шагов, ${report.rejected} отказов — пройдены.`);
