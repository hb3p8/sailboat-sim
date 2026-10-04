// Настоящий Worker: наблюдение стадий сохраняет весь прежний физический ответ.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFluidWorker} from './lib/cloth-fluid-client.mjs';
import {fluidWorkerHandler} from './lib/cloth-fluid-worker.mjs';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),
  wasm=args.find(v=>v.startsWith('--wasm='))?.slice(7),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&wasm&&args.length===(out?4:3));assert(!out||!existsSync(out));
const bytes=readFileSync(wasm),hash=b=>createHash('sha256').update(b).digest('hex');
const root=fileURLToPath(new URL('../',import.meta.url)),sourceSha256={};
function addSource(url){const path=relative(root,fileURLToPath(url));if(sourceSha256[path])return;
  const b=readFileSync(url);sourceSha256[path]=hash(b);
  for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))addSource(new URL(m[1],url));}
addSource(new URL(import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?
  Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const physical=r=>serial({positions:r.positions,body:r.body,forceN:r.forceN,audit:r.audit,controls:r.controls});
function makeWorker(url){const code=`import {parentPort} from 'node:worker_threads';import {fluidWorkerHandler} from ${JSON.stringify(url.href)};
const handle=fluidWorkerHandler((data,transfer=[])=>parentPort.postMessage(data,transfer));parentPort.on('message',data=>{void handle(data);});`;
  const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)));
  return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){w.on(type,data=>fn(type==='message'?{data}:{message:data.message}));}};}
const report={schema:'cloth-fluid-profile-worker-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,
  wasm:{path:wasm,sha256:hash(bytes)},exactPairs:0,rejected:0,results:[]};
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};
  if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Наблюдение Worker остановлено: '+e.message);process.exitCode=1;});
assert.equal(new Set(inputs.map(p=>JSON.parse(readFileSync(p)).fixture.side)).size,2);
for(const path of inputs) {
  const inputBytes=readFileSync(path),record=JSON.parse(inputBytes),f=record.fixture;
  assert.equal(f.wasm.sha256,hash(bytes));assert.equal(record.steps.length,180);
  const variants=[];
  for(const profile of [false,true]) {
    const client=await createFluidWorker(f.recipe,f.bodyInput,bytes,{sheet:f.sheet,profile,makeWorker}),states=[],timings=[];
    try {
      assert.deepEqual(Array.from(client.ready.positions),record.initial.positions);assert.deepEqual(client.ready.body,record.initial.body);
      assert.equal(Boolean(client.ready.profile),profile);
      if(profile)assert(Math.abs(client.ready.compileMs+client.ready.modelMs-client.ready.setupMs)<1e-6);
      for(const old of record.steps) {
        const r=await client.step(old.controls),state=physical(r);
        assert.equal(r.index,old.index);assert.equal(Boolean(r.timing),profile);
        assert.deepEqual(JSON.parse(JSON.stringify(state)),physical(old));states.push(state);
        if(profile) {
          const t=r.timing,epsilon=1e-6;
          assert(t.loadMs>=0&&t.physicsMs>=0&&t.snapshotMs>=0);
          assert(Math.abs(t.loadMs+t.physicsMs-r.stepMs)<epsilon&&Math.abs(t.handlerMs-r.stepMs-t.snapshotMs)<epsilon);
          assert.equal(t.linear.factorCalls,t.wasm.numericFactorizations);
          assert(t.stages.validateState.calls===1&&t.stages.audit.calls>=1&&t.stages.state.calls>0);
          assert(Object.values(t.stages).every(s=>s.calls>=0&&Number.isFinite(s.selfMs)&&s.selfMs>=-epsilon&&s.selfMs<=s.inclusiveMs+epsilon));
          assert(Object.values(t.stages).reduce((sum,s)=>sum+s.selfMs,0)<=t.physicsMs+epsilon);
          timings.push(t);
        }
      }
      await assert.rejects(client.step({pressureScale:2}),/Нагрузка/);report.rejected++;
      await assert.rejects(client.step(),/После отказа/);report.rejected++;
    } finally {await client.terminate();}
    variants.push({states,timings});
  }
  // Строгое сравнение живых ответов сохраняет также знак нуля.
  assert.deepEqual(variants[0].states,variants[1].states);report.exactPairs+=180;
  report.results.push({path,sha256:hash(inputBytes),side:f.side,exactPairs:180,timings:variants[1].timings});
  console.log(`Стадии Worker, ${f.side==='plus'?'первая':'другая'} сторона: 180 прежних ответов и пар с наблюдением совпали точно.`);
}
let created=false;
await assert.rejects(createFluidWorker({}, {},bytes,{profile:1,makeWorker(){created=true;}}),/логическим/);
assert.equal(created,false);report.rejected++;
const messages=[],handle=fluidWorkerHandler(data=>messages.push(data));
await handle({id:0,type:'init',profile:'да'});assert.match(messages[0].message,/логическим/);
await handle({id:1,type:'step'});assert.match(messages[1].message,/После отказа/);report.rejected+=2;
report.phase='complete';if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Наблюдение: ${report.exactPairs} точных пар настоящего Worker, ${report.rejected} отказов — пройдены.`);
