// Каждый шаг полного свободного паруса проходит через настоящий Worker.
// Сверка всех чисел и атомарного отказа; время Node не является FPS браузера.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {createMotionWorker} from './lib/cloth-browser-client.mjs';
const args=process.argv.slice(2),inputs=args.filter(a=>a.startsWith('--input=')).map(a=>a.slice(8));
const output=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(inputs.length&&args.every(a=>/^--(input|out)=.+$/.test(a)));
assert(!output||!existsSync(output),'Результат нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex');
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):
  v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
function makeWorker(url) {
  const source=`import {parentPort} from 'node:worker_threads';import {motionWorkerHandler} from ${JSON.stringify(url.href)};
    const handle=motionWorkerHandler((data,transfer=[])=>parentPort.postMessage(data,transfer));parentPort.on('message',data=>{void handle(data);});`;
  const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)));
  return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){
    w.on(type,data=>fn(type==='message'?{data}:{message:data.message}));}};
}
const results=[];
for(const path of inputs) {
  const bytes=readFileSync(path),r=JSON.parse(bytes);
  assert.equal(r.phase,'complete');assert.equal(r.recipe.loadFrame,'inertial-cartesian-frozen');
  for(const [p,sha] of Object.entries(r.sourceSha256))assert.equal(hash(readFileSync(p)),sha,'Вход не соответствует текущему исходнику');
  const wasm=readFileSync(r.wasm.path);assert.equal(hash(wasm),r.wasm.sha256);
  const client=await createMotionWorker(r.recipe,wasm,{makeWorker,profile:true}),times=[];
  const ready=serial(client.ready);let saved;
  try {
    for(let i=0;i<r.steps.length;i++) {
      // Ошибка команды на свободную точку не принимает шаг и не меняет историю.
      if(i===1)await assert.rejects(client.step([{node:r.recipe.rigidBody.attachments[0],positionM:[0,0,0]}]),/команда закрепления/);
      const begin=performance.now(),a=await client.step(),expected=r.steps[i];
      assert.equal(a.index,i);assert.deepEqual(Array.from(a.positions),expected.positionsM);
      const {supportForceN,...expectedAudit}=expected.audit;
      assert.deepEqual(serial(a.audit),expectedAudit,'Все поля физического аудита');
      assert.deepEqual(serial(a.supportForceN),supportForceN);assert.equal(a.dualViolationN,expected.dualViolationN);
      assert(a.timing.factorMs>=0&&a.timing.solveMs>=0&&a.timing.snapshotMs>=0);
      if(saved)assert.deepEqual(saved.value,saved.copy,'Снимок реакции не изменяется после нового шага');
      saved={value:a.audit.bodyNodeInterfaceForceN,copy:a.audit.bodyNodeInterfaceForceN.slice()};
      times.push({index:i,requestMs:performance.now()-begin,timeMs:a.timeMs,timing:a.timing,wasmMemory:a.wasmMemory});
    }
  }finally{await client.terminate();}
  results.push({path,sha256:hash(bytes),exactSteps:r.steps.length,ready,times,
    meanStepMs:times.reduce((s,x)=>s+x.timeMs,0)/times.length,maxStepMs:Math.max(...times.map(x=>x.timeMs))});
}
const record={schema:1,createdAt:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  runtime:{node:process.version,platform:process.platform,arch:process.arch},
  sourceSha256:Object.fromEntries(['tests/cloth-rigid-sail-worker.test.mjs','tests/lib/cloth-browser-worker.mjs',
    'tests/lib/cloth-browser-client.mjs','tests/lib/cloth-worker-timing.mjs'].map(p=>[p,hash(readFileSync(p))])),results};
if(output)writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,results:results.map(({path,exactSteps,meanStepMs,maxStepMs})=>({path,exactSteps,meanStepMs,maxStepMs})),
  verification:'Все положения/силы/работа/свойства тела совпали точно; команда отклоняется атомарно; снимок реакции принадлежит получателю'},null,2));
