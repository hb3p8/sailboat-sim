// Выбор совместимого материала не скрывает повреждение модуля или постановки.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {Boat} from '../sim/physics.js';
import {gennakerPose} from '../sim/gennaker-energy.mjs';
import {selectGennakerMaterial} from '../sim/gennaker-material.mjs';
import {loadMaterialKernel,MaterialEngineMismatchError} from './probes/cloth-material-wasm.mjs';
import {verifyMaterialKernel} from './probes/cloth-material-engine-check.mjs';
const bytes=readFileSync('out/acceptance/cloth-material-20261005-probe-v3.wasm'),
  recipe=JSON.parse(readFileSync('out/acceptance/fluid-live-main-20261010-plus.json')).recipe;
const native=await selectGennakerMaterial(bytes,recipe);
assert.equal(native.material.backend,'wasm');assert(native.kernel);
assert.equal(native.material.checks.hypotCases,2053);
assert(native.material.checks.hessianComponents>0);
await assert.rejects(selectGennakerMaterial(Uint8Array.of(1,2,3),recipe),WebAssembly.CompileError);
await assert.rejects(selectGennakerMaterial(Uint8Array.from([0,97,115,109,1,0,0,0]),recipe),/Несовместимая/);
await assert.rejects(selectGennakerMaterial(bytes,{...recipe,rows:10}),/постановку/);
const original=Math.hypot;
try {
  // Другой последний разряд в короткой проверке загрузчика.
  Math.hypot=(...v)=>original(...v)*(v.length===3&&v[0]===1&&v[1]===2&&v[2]===3?1+Number.EPSILON:1);
  await assert.rejects(loadMaterialKernel(bytes),MaterialEngineMismatchError);
  const selected=await selectGennakerMaterial(bytes,recipe);
  assert.equal(selected.material.backend,'js');assert.equal(selected.kernel,undefined);
  assert.equal(selected.material.reason,'CLOTH_MATERIAL_ENGINE_MISMATCH');
  assert.deepEqual(selected.material.comparison.input,[1,2,3]);
  // Короткие пробы совпали, но расширенная проверка движка расходится.
  Math.hypot=(...v)=>original(...v)*(v.length===3&&v[0]===0&&v[1]===1e-300&&v[2]===0?1+Number.EPSILON:1);
  const kernel=await loadMaterialKernel(bytes);
  assert.throws(()=>verifyMaterialKernel(kernel,recipe),MaterialEngineMismatchError);
  const extended=await selectGennakerMaterial(bytes,recipe);
  assert.equal(extended.material.backend,'js');assert.equal(extended.material.comparison.name,'длина 0');
} finally {Math.hypot=original;}
const fixture=JSON.parse(readFileSync('out/acceptance/fluid-live-main-20261010-plus.json')),
  pack=JSON.parse(readFileSync('out/export/physics.json')),pose=gennakerPose(new Boat(pack)),
  sparse=readFileSync('out/acceptance/cloth-sparse-20261002-simd.wasm');
async function workerStep(mismatch) {
  const bootstrap=`import {parentPort} from 'node:worker_threads';
    globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};
    parentPort.on('message',data=>self.onmessage({data}));
    ${mismatch?`const original=Math.hypot;Math.hypot=(...v)=>original(...v)*(v.length===3&&v[0]===1&&v[1]===2&&v[2]===3?1+Number.EPSILON:1);`:''}
    await import(${JSON.stringify(new URL('../sim/gennaker-energy-worker.mjs',import.meta.url).href)});
    parentPort.postMessage({type:'initialized'});`;
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(bootstrap)),{type:'module'});
  const request=async data=>{const reply=once(worker,'message');worker.postMessage(data);return (await reply)[0];};
  try {
    assert.equal((await once(worker,'message'))[0].type,'initialized');
    const ready=await request({type:'init',fixture,pack,pose,bytes:sparse,materialBytes:bytes});
    assert.equal(ready.type,'ready');assert.equal(ready.material.backend,mismatch?'js':'wasm');
    if(mismatch)assert.equal(ready.material.reason,'CLOTH_MATERIAL_ENGINE_MISMATCH');
    const progress=await request({type:'step',forceN:new Float64Array(recipe.reference.length),poses:[pose,pose],sheetLengthM:fixture.sheet.lengthM});
    assert.equal(progress.type,'progress');
    const result=await request({type:'continue'});assert.equal(result.type,'step');
    assert.equal(result.partsMs.length,2);
    for(const a of result.audits){assert(a.maxForceResidualN<=1e-6);assert(a.maxHardViolationM<=1e-9);}
    assert(result.positions.every(Number.isFinite));
    return result;
  } finally {await worker.terminate();}
}
const nativeStep=await workerStep(false),jsStep=await workerStep(true);
const physical=({partsMs,...data})=>data;
assert.deepEqual(physical(jsStep),physical(nativeStep));
console.log('Выбор материала: строгая проверка WASM, оба отказа округления и три неисправности — пройдены. Настоящий Worker вернул одинаковый физический шаг в режимах WASM и совместимости, с паузой между частями.');
