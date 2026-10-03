// Настоящий Worker: полный повтор обеих сторон и управляемые нагрузки.
// Доказательство относится к общей лабораторной модели, а не к скорости браузера.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {createFluidWorker} from './lib/cloth-fluid-client.mjs';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8));
const expected=args.filter(v=>v.startsWith('--expected=')).map(v=>v.slice(11));
const wasm=args.find(v=>v.startsWith('--wasm='))?.slice(7),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&expected.length===2&&wasm&&args.length===(out?6:5));
assert(!out||!existsSync(out),'Запись нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex');
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
function makeWorker(url) {
  const code=`import {parentPort} from 'node:worker_threads';import {fluidWorkerHandler} from ${JSON.stringify(url.href)};
    const handle=fluidWorkerHandler((data,transfer=[])=>parentPort.postMessage(data,transfer));parentPort.on('message',data=>{void handle(data);});`;
  const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)));
  return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){w.on(type,data=>fn(type==='message'?{data}:{message:data.message}));}};
}
const results=[];
for(let side=0;side<2;side++) {
  const source=JSON.parse(readFileSync(inputs[side])),reference=JSON.parse(readFileSync(expected[side]));
  const client=await createFluidWorker(source.recipe,source.config.bodyInput,readFileSync(wasm),{makeWorker});
  try {
    for(let i=0;i<60;i++) {
      const a=await client.step(),b=reference.steps[i];
      assert.equal(a.index,i+1);
      assert.deepEqual(Array.from(a.positions),b.positionsM);assert.deepEqual(a.body,b.body);
      assert.deepEqual(Array.from(a.forceN),b.forceN);assert.deepEqual(serial(a.audit),b.audit);
    }
    const controlled=[];
    for(let i=0;i<60;i++) {
      // Непрерывный поворот и уменьшение/восстановление давления после секунды посадки.
      const t=i/59,controls={pressureScale:1-.2*Math.sin(Math.PI*t),yawMomentNm:(side===0?1:-1)*40*Math.sin(Math.PI*t)};
      const a=await client.step(controls),v=a.audit;
      assert.deepEqual(a.controls,controls);assert(a.positions.every(Number.isFinite));
      assert(v.maxPhysicalResidualN<=v.solver.forceToleranceN&&v.maxHardViolationM<=v.solver.lengthToleranceM);
      assert(v.dualViolationN<=v.solver.dualToleranceN&&v.complementarityJ<=v.solver.complementarityToleranceJ);
      assert(Math.abs(v.discreteBalanceResidualJ)<=v.workLimitJ&&Math.abs(v.bodyWorkCancellationResidualJ)<=v.interfaceWorkLimitJ);
      controlled.push(serial(a));
    }
    await assert.rejects(client.step({pressureScale:2}),/Нагрузка/);
    await assert.rejects(client.step(),/После отказа/);
    results.push({side:source.config.tack,input:inputs[side],inputSha256:hash(readFileSync(inputs[side])),
      expected:expected[side],expectedSha256:hash(readFileSync(expected[side])),exactSteps:60,controlled});
  } finally {await client.terminate();}
}
if(out)writeFileSync(out,JSON.stringify({schema:'cloth-fluid-worker-proof-v1',wasm,wasmSha256:hash(readFileSync(wasm)),results},null,2)+'\n',{flag:'wx'});
console.log('Общий Worker: 120 шагов точного повтора, 120 шагов смены нагрузки, остановка после отказа — пройдены.');
