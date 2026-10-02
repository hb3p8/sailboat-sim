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

// Предписанный перенос всех закреплений плоского полотна. Все точки,
// кроме конца верхней планки, заданы явно или исключены через неё.
// При движении вдоль планки известны движение всей массы и работа.
const moving=structuredClone(recipe);moving.fixed=Array.from({length:13},(_,i)=>i);
const driven=await createMotionWorker(moving,readFileSync(path),{makeWorker});
const close=(a,b)=>assert(Math.abs(a-b)<1e-9*Math.max(1,Math.abs(b)),`${a} != ${b}`);
try {
  const shift=.01,h=moving.hS,totalMass=16;
  const command=moving.fixed.map(node=>({node,positionM:points.slice(3*node,3*node+3).map((v,d)=>v+(d===0?shift:0))}));
  const pending=driven.step(command);
  await assert.rejects(driven.step(command),/ещё не завершён/);
  const moved=await pending;assert.equal(moved.index,0);
  moved.positions.forEach((v,k)=>close(v,points[k]+(k%3===0?shift:0)));
  close(moved.audit.kineticJ,.5*totalMass*(shift/h)**2);
  close(moved.audit.supportWorkJ,totalMass*(shift/h)**2);
  close(moved.audit.discreteBalanceResidualJ,0);
  close(moved.supportForceN.reduce((sum,v,k)=>sum+(k%3===0?v:0),0),totalMass*shift/(h*h));
  const savedPosition=moved.positions.slice(),savedReaction=moved.supportForceN.slice();
  // Конец планки свободен: такая команда отклоняется, индекс и состояние
  // предыдущего принятого шага сохраняются. Следующий обычный шаг удерживает.
  await assert.rejects(driven.step([{node:15,positionM:[10,0,0]}]),/команда закрепления/);
  const held=await driven.step();assert.equal(held.index,1);
  held.positions.forEach((v,k)=>close(v,savedPosition[k]));
  close(held.audit.kineticJ,0);close(held.audit.supportWorkJ,0);close(held.audit.discreteBalanceResidualJ,0);
  assert.deepEqual(moved.positions,savedPosition);assert.deepEqual(moved.supportForceN,savedReaction);
} finally {await driven.terminate();}
console.log('ок: реальный перенос команды креплений, вся масса/работа, реакции отдельным снимком, отказ без потери шага и удержание');

const limited=structuredClone(moving);limited.iterations=1;
const transactional=await createMotionWorker(limited,readFileSync(path),{makeWorker});
try {
  const initial=await transactional.step();assert.equal(initial.index,0);
  await assert.rejects(transactional.step([{node:12,positionM:[0,3,.2]}]),/не доведено|Не найден/);
  const recovered=await transactional.step();assert.equal(recovered.index,1);
  assert.deepEqual(Array.from(recovered.positions),points);
  close(recovered.audit.kineticJ,0);close(recovered.audit.softEnergyJ,0);
  assert.equal(recovered.supportForceN,undefined,'Отклонённая команда не включает режим движения закреплений');
} finally {await transactional.terminate();}
console.log('ок: недоведённая подвижная команда в реальном Worker возвращает всю историю, следующий шаг пригоден');

// Наблюдение не меняет арифметику. Деформированное полотно требует настоящих
// линейных решений; сравниваются все поля двух последовательных расчётов.
const deformed=structuredClone(recipe);deformed.positions[17]=.025;deformed.previous=deformed.positions.slice();
const plain=await createMotionWorker(deformed,readFileSync(path),{makeWorker});
const profiled=await createMotionWorker(deformed,readFileSync(path),{makeWorker,profile:true});
let factors=0;
try {
  assert.deepEqual(plain.ready.positions,profiled.ready.positions);
  for(let i=0;i<6;i++) {
    const targets=i<3?undefined:[{node:3,positionM:[3+.001*(i-2),0,0]}];
    const a=await plain.step(targets),b=await profiled.step(targets);
    for(const key of ['positions','audit','supportForceN','dualViolationN','wasmMemory','index'])assert.deepEqual(a[key],b[key],key);
    assert.equal(a.timing,undefined);assert(b.timing);
    const t=b.timing;factors+=t.factorCalls;
    assert(t.factorMs>=0 && t.solveMs>=0 && t.snapshotMs>=0);
    assert(t.otherStepMs>=-Number.EPSILON*32*Math.max(1,b.timeMs));
    assert.equal(t.handlerMs,b.timeMs+t.snapshotMs);
  }
  assert(factors>0,'Должен быть проверен реальный линейный расчёт');
  await assert.rejects(profiled.step([{node:15,positionM:[10,0,0]}]),/команда закрепления/);
  const a=await plain.step(),b=await profiled.step();
  assert.equal(b.index,6);assert.deepEqual(a.positions,b.positions);assert.deepEqual(a.audit,b.audit);
} finally {await plain.terminate();await profiled.terminate();}
await assert.rejects(createMotionWorker(recipe,readFileSync(path),{makeWorker,profile:'да'}),/логическим/);
console.log('ок: наблюдение реального Worker сохраняет все физические поля/счётчики точно, отдельные стадии и отказ');
