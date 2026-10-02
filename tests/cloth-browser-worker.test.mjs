// Настоящий отдельный поток: известное неподвижное полотно и атомарный отказ.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createMotionWorker} from './lib/cloth-browser-client.mjs';
const path=process.argv.find(s=>s.startsWith('--wasm='))?.slice(7);
assert(path && process.argv.length===3,'Нужен --wasm=путь');
const points=Array.from({length:16},(_,i)=>[i%4,Math.floor(i/4),0]).flat();
const fieldValues=new Array(16*16).fill(0); for(let i=0;i<16;i++)fieldValues[16*i+6]=9;
const recipe={rows:4,cols:4,hS:1/60,iterations:80,reference:points,positions:points,previous:points,prevDt:0,
  mass:new Array(16).fill(1),fixed:[0,3,12],board:{head:12,end:15,nodes:[12,13,14,15],fractions:[0,1/3,2/3,1]},
  hard:[{a:12,b:15,rest:3,unilateral:false,family:'board'}],
  field:{rows:4,cols:4,components:16,values:fieldValues},boat:{phi:0,p:{mass:{cg_m:[0,0,0]}}}};
function makeWorker(url) {
  const source=`import {parentPort} from 'node:worker_threads';import {motionWorkerHandler} from ${JSON.stringify(url.href)};
    const handle=motionWorkerHandler((data,transfer=[])=>parentPort.postMessage(data,transfer));parentPort.on('message',data=>{void handle(data);});`;
  const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)));
  return {postMessage:(...a)=>w.postMessage(...a),terminate:()=>w.terminate(),addEventListener(type,fn){
    w.on(type,data=>fn(type==='message'?{data}:{message:data.message}));}};
}
const client=await createMotionWorker(recipe,readFileSync(path),{makeWorker});
try {
  assert.deepEqual(Array.from(client.ready.positions),points);
  const first=client.step(); await assert.rejects(client.step(),/ещё не завершён/);
  const result=await first; assert.equal(result.index,0); assert.deepEqual(Array.from(result.positions),points);
  assert.equal(result.audit.kineticJ,0); assert.equal(result.audit.softEnergyJ,0);
  const next=await client.step();assert.equal(next.index,1);assert.deepEqual(Array.from(next.positions),points);
  assert.deepEqual(Array.from(result.positions),points,'Предыдущий снимок не меняется после нового шага');
  const pending=client.step();const rejected=assert.rejects(pending,/остановлен/); await client.terminate();await rejected;
  await assert.rejects(client.step(),/остановлен/);
} finally {await client.terminate();}
const broken=structuredClone(recipe);broken.hard[0].rest=2;broken.iterations=1;
const failed=await createMotionWorker(broken,readFileSync(path),{makeWorker});
try {await assert.rejects(failed.step(),/не доведено|Не найден/);}finally{await failed.terminate();}
console.log('ок: реальный отдельный поток, известная форма/энергия, порядок, независимые снимки, остановка и отказ');
