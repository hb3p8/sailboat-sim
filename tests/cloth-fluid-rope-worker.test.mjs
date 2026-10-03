// Верёвка в настоящем Worker: прежние полные кадры и новые команды скорости.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFluidWorker} from './lib/cloth-fluid-client.mjs';
import {fluidSailMotion} from './lib/cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),
  expected=args.filter(v=>v.startsWith('--expected=')).map(v=>v.slice(11)),wasm=args.find(v=>v.startsWith('--wasm='))?.slice(7),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&expected.length===2&&wasm&&args.length===(out?6:5));assert(!out||!existsSync(out),'Доказательства нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(wasm),factor=await loadSparseFactor(bytes);
const root=fileURLToPath(new URL('../',import.meta.url)),sourceSha256={};
function addSource(url){const name=relative(root,fileURLToPath(url));if(Object.hasOwn(sourceSha256,name))return;
  const b=readFileSync(url);sourceSha256[name]=hash(b);
  for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))addSource(new URL(m[1],url));}
addSource(new URL(import.meta.url));addSource(new URL('./lib/cloth-fluid-worker.mjs',import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
// Сохранённый JSON не различает 0 и -0; живые ответы сравниваются строго.
const jsonSerial=v=>JSON.parse(JSON.stringify(serial(v)));
const report={schema:'cloth-fluid-rope-worker-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,
  wasm:{path:wasm,sha256:hash(bytes)},exactSteps:0,rateSteps:0,rejectedControls:0,results:[]};
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};
  if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Проверка Worker с верёвкой остановлена: '+e.message);process.exitCode=1;});
function makeWorker(url){const code=`import {parentPort} from 'node:worker_threads';import {fluidWorkerHandler} from ${JSON.stringify(url.href)};
const handle=fluidWorkerHandler((data,transfer=[])=>parentPort.postMessage(data,transfer));parentPort.on('message',data=>{void handle(data);});`;
  const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)));
  return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){w.on(type,data=>fn(type==='message'?{data}:{message:data.message}));}};}
const snapshot=c=>({positions:Array.from(c.motion.pos),velocity:Array.from(c.motion.vel),body:structuredClone(c.motion.body),
  lengths:Array.from(c.motion.ropeLengthsM),reactions:Array.from(c.motion.lastMu),lambdas:c.motion.constraints.map(k=>k.lambda)});
for(let side=0;side<2;side++) {
  const inputBytes=readFileSync(inputs[side]),expectedBytes=readFileSync(expected[side]),s=JSON.parse(inputBytes),r=JSON.parse(expectedBytes);
  assert.equal(r.phase,'complete');assert.equal(r.dirty,false);assert.equal(r.parameters.hS,1/60);assert.equal(r.steps.length,180);
  assert.equal(r.input.sha256,hash(inputBytes));assert.equal(r.parameters.tack,s.config.tack);
  for(const p of [s,r])for(const [name,sha] of Object.entries(p.sourceSha256))assert.equal(hash(execFileSync('git',['show',`${p.revision}:${name}`],{maxBuffer:16*1024*1024})),sha);
  const sheet=r.parameters.sheet,limits={minLengthM:sheet.lengthM,maxLengthM:sheet.lengthM+.25,maxSpeedMPS:.5};
  let client=await createFluidWorker(s.recipe,s.config.bodyInput,bytes,{makeWorker,sheet});
  const result={input:inputs[side],inputSha256:hash(inputBytes),expected:expected[side],expectedSha256:hash(expectedBytes),tack:s.config.tack,sheet,limits,controlled:[]};
  report.results.push(result);
  try {
    assert.deepEqual(client.ready.sheetControl,limits);assert.deepEqual(Array.from(client.ready.positions),r.initial.positionsM);
    for(const b of r.steps){const a=await client.step(b.controls);
      assert.deepEqual(jsonSerial(a.positions),b.positionsM);assert.deepEqual(jsonSerial(a.body),b.body);assert.deepEqual(jsonSerial(a.forceN),b.forceN);assert.deepEqual(jsonSerial(a.audit),b.audit);
      report.exactSteps++;}
  } finally {await client.terminate();}
  client=await createFluidWorker(s.recipe,s.config.bodyInput,bytes,{makeWorker,sheet});
  const c=fluidSailMotion(s.recipe,s.config.bodyInput,factor,{sheet});
  try {
    for(let index=1;index<=244;index++) {
      // Повторяет три секунды цикла, затем достигает обоих ограничителей.
      const rate=index<=30?0:index<=60?.5:index<=90?0:index<=120?-.5:index<=180?0:index<=212?.5:-.5;
      const controls={sheetRateMPS:rate},a=await client.step(controls),b=c.step(controls),rope=a.audit.ropes[0];
      assert.deepEqual(Array.from(a.positions),Array.from(c.motion.pos));assert.deepEqual(a.body,c.motion.body);
      assert.deepEqual(Array.from(a.forceN),Array.from(c.forceN));assert.deepEqual(serial(a.audit),serial(b));assert.deepEqual(a.controls,controls);
      const t=a.audit.solver;assert(a.audit.maxPhysicalResidualN<=t.forceToleranceN&&a.audit.maxHardViolationM<=t.lengthToleranceM);
      assert(a.audit.dualViolationN<=t.dualToleranceN&&a.audit.complementarityJ<=t.complementarityToleranceJ);
      assert(Math.abs(a.audit.discreteBalanceResidualJ)<=a.audit.workLimitJ&&Math.abs(a.audit.bodyWorkCancellationResidualJ)<=a.audit.interfaceWorkLimitJ);
      assert(Math.abs(rope.controlResidualJ)<=rope.controlLimitJ);
      // Закрытая траектория команды, не вызов контроллера модели.
      const delta=index<=30?0:index<=60?(index-30)/120:index<=90?.25:index<=120?(120-index)/120:index<=180?0:index<=212?Math.min(.25,(index-180)/120):Math.max(0,.25-(index-212)/120);
      assert(Math.abs(rope.lengthM-sheet.lengthM-delta)<=256*Number.EPSILON*Math.max(1,sheet.lengthM)*index,'Длина расходится с независимой траекторией команды');
      if(index===211||index===212||index===243||index===244)assert(rope.controlWorkJ===0,'Команда у ограничителя должна сохранять длину');
      result.controlled.push(serial(a));report.rateSteps++;
      // Полученный снимок принадлежит вызывающему коду, не следующему шагу.
      if(index===1)a.positions[0]+=100;
    }
    await assert.rejects(client.step({sheetRateMPS:1}),/Скорость верёвки/);report.rejectedControls++;
    await assert.rejects(client.step({sheetRateMPS:0}),/После отказа/);report.rejectedControls++;
  } finally {await client.terminate();}
  for(const controls of [{sheetRateMPS:NaN},{sheetRateMPS:Infinity},{sheetRateMPS:-.6},{sheetRateMPS:.1,sheetLengthM:sheet.lengthM}]) {
    const before=snapshot(c);assert.throws(()=>c.step(controls),/Скорость верёвки/);assert.deepEqual(snapshot(c),before);report.rejectedControls++;
  }
  console.log(`Верёвка, борт ${s.config.tack}: 180 точных прежних шагов, 244 команд скорости с независимым повтором и ограничителями — пройдены.`);
}
report.phase='complete';if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Worker верёвки: ${report.exactSteps} точных шагов, ${report.rateSteps} управляемых, ${report.rejectedControls} отказов — пройдены.`);
