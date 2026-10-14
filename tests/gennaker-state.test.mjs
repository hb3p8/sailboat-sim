// Снимок сохраняет историю нелинейного поиска и движение креплений, не кэш.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {Boat} from '../sim/physics.js';
import {prescribedGennaker,gennakerPose} from '../sim/gennaker-energy.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {selectGennakerMaterial} from '../sim/gennaker-material.mjs';
import {boatBodyRotation} from '../sim/axes.js';

const pack=JSON.parse(readFileSync('out/export/physics.json')),
  bytes=readFileSync('out/acceptance/cloth-sparse-20261002-simd.wasm'),
  materialBytes=readFileSync('out/acceptance/cloth-material-20261005-probe-v3.wasm'),
  fixtures=Object.fromEntries(['plus','minus'].map(side=>[side,JSON.parse(readFileSync(`out/acceptance/fluid-live-main-20261010-${side}.json`))])),
  factor=await loadSparseFactor(bytes),selected=await selectGennakerMaterial(materialBytes,fixtures.plus.recipe),results=[];
const json=value=>JSON.parse(JSON.stringify(value));
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const poseAt=i=>{
  const pose=gennakerPose(new Boat(pack));
  pose.originM[0]=1355+i*.00001;pose.originM[1]=800-i*.00002;
  pose.angles=[i*.000001,i*.000002,0];pose.orientation9=boatBodyRotation(...pose.angles);return pose;
};
for(const side of ['plus','minus'])for(const backend of ['wasm','js']) {
  const fixture=fixtures[side],kernel=backend==='wasm'?selected.kernel:undefined;
  const make=()=>prescribedGennaker(fixture,pack,poseAt(0),factor,kernel),a=make(),fresh=a.snapshot();
  a.restore(json(fresh));assert.deepEqual(json(a.snapshot()),json(fresh));
  const command=i=>({forceN:new Float64Array(297),targetPose:poseAt(i),
    sheetLengthM:fixture.sheet.lengthM+(i<9?.25:0),hS:i%3===0?1/120:1/60});
  // Известный отказ заставляет сохранить принятые 1/240 с и память поиска.
  for(let i=1;i<6;i++)a.step(command(i));
  const actual=a.motion.step.bind(a.motion);let fail=true;
  a.motion.step=(...args)=>{if(fail){fail=false;throw new Error('не доведено: контроль дробления');}return actual(...args);};
  const split=a.step(command(6));assert.equal(split.leaves.length,2);assert.equal(a.motion.prevDt,1/240);
  a.motion.step=actual;
  const state=json(a.snapshot()),b=make();b.restore(state);
  assert.deepEqual(json(b.snapshot()),state);
  // Изменение внешнего объекта не меняет расчёт после restore.
  state.motion.pos[3]+=1;assert.notEqual(b.snapshot().motion.pos[3],state.motion.pos[3]);
  const checkpoint=json(a.snapshot()),before=sha(checkpoint);
  const invalid=[s=>s.schema='unknown',s=>s.configuration+='x',s=>s.index=-1,
    s=>s.lengthM+=10,s=>s.frameOriginM[0]=null,s=>s.lastPose.orientation9[0]=2,
    s=>s.motion.pos.pop(),s=>delete s.motion.pos[3],s=>s.motion.prev[3]=NaN,s=>s.motion.lambda[0]=Infinity,
    s=>s.motion.lastMu.pop(),s=>s.motion.prevDt=-1,s=>s.motion.prevDt=1/30,
    s=>s.motion.supportMotionActive=false,s=>s.motion.fixedPositions[0].positionM[0]+=1,
    s=>s.motion.fixedPositions.reverse(),s=>s.motion.pos[3*91+2]+=.1];
  for(const mutate of invalid){const broken=structuredClone(checkpoint);mutate(broken);
    assert.throws(()=>b.restore(broken),/Некорректный снимок/);assert.equal(sha(b.snapshot()),before);}
  const continuation=[];
  for(let i=7;i<=18;i++) {
    const expected=a.step(command(i)),resumed=b.step(command(i));
    assert.deepEqual(resumed,expected);assert.deepEqual(b.snapshot(),a.snapshot());
    continuation.push(expected);
  }
  results.push({side,backend,steps:12,rejections:invalid.length,stateSha256:sha(b.snapshot()),continuationSha256:sha(continuation)});
}

// Тот же протокол через настоящий отдельный Worker: снимок запрещён в
// середине двух частей, а отказ снимка не уничтожает ожидающий continue.
const bootstrap=`import {parentPort} from 'node:worker_threads';
  globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};
  parentPort.on('message',data=>self.onmessage({data}));
  await import(${JSON.stringify(new URL('../sim/gennaker-energy-worker.mjs',import.meta.url).href)});
  parentPort.postMessage({type:'boot'});`;
async function workerSession() {
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(bootstrap)),{type:'module'});
  await once(worker,'message');
  return {worker,async request(data){const reply=once(worker,'message');worker.postMessage(data);return (await reply)[0];}};
}
const one=await workerSession(),two=await workerSession();
try {
  const init={type:'init',fixture:fixtures.plus,pack,pose:poseAt(0),bytes,materialBytes};
  assert.equal((await one.request(init)).type,'ready');
  const command={type:'step',forceN:new Float64Array(297),poses:[poseAt(0),poseAt(0)],sheetLengthM:fixtures.plus.sheet.lengthM};
  assert.equal((await one.request(command)).type,'progress');
  assert.equal((await one.request({type:'snapshot'})).type,'error');
  assert.equal((await one.request({type:'continue'})).type,'step');
  const saved=await one.request({type:'snapshot'});assert.equal(saved.type,'snapshot');
  assert.equal((await two.request({...init,state:json(saved.state)})).type,'ready');
  const corrupt=json(saved.state);corrupt.motion.prevDt=0;
  assert.equal((await two.request({type:'restore',state:corrupt})).type,'error');
  assert.deepEqual((await two.request({type:'snapshot'})).state,saved.state);
  assert.equal((await one.request(command)).type,'progress');assert.equal((await two.request(command)).type,'progress');
  const strip=({partsMs,...r})=>r;
  assert.deepEqual(strip(await two.request({type:'continue'})),strip(await one.request({type:'continue'})));
} finally {await one.worker.terminate();await two.worker.terminate();}
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-state-test-v1',results,worker:true,
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  sources:Object.fromEntries(['sim/gennaker-energy.mjs','sim/gennaker-energy-worker.mjs','tests/gennaker-state.test.mjs'].map(path=>
    [path,createHash('sha256').update(readFileSync(path)).digest('hex')]))},null,2)+'\n',{flag:'wx'});
console.log('Снимок ткани: оба борта, WASM/JS, дробление до 1/240 с, 68 атомарных отказа и настоящий Worker — пройдены. Продолжение совпало точно.');
