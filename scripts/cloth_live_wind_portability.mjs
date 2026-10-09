// Диагностика округления воздуха: строгий live-report и физические пороги прежние.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {liveWindSailMotion} from '../tests/lib/cloth-live-wind-sail-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from '../tests/probes/cloth-material-wasm.mjs';
import {loadAssemblyKernel} from '../tests/probes/cloth-assembly-wasm.mjs';
const [input,out]=process.argv.slice(2);assert(input&&out&&process.argv.length===4&&!existsSync(out));
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),r=JSON.parse(bytes),f=r.fixture;
assert.equal(r.schema,'cloth-fluid-live-result-v1');assert.equal(f.liveWind?.model,'rig-current-surface-body-projected-v1');
for(const [p,sha] of Object.entries(f.sourceSha256))assert.equal(hash(readFileSync(p)),sha);
for(const part of [f.wasm,f.materialWasm,f.assemblyWasm,f.input,f.scene])assert.equal(hash(readFileSync(part.path)),part.sha256);
const physics=readFileSync('out/export/physics.json');assert.equal(hash(physics),f.physicsSha256);
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const json=v=>JSON.parse(JSON.stringify(serial(v)));
const make=async()=>liveWindSailMotion(f.recipe,f.bodyInput,await loadSparseFactor(readFileSync(f.wasm.path)),
  {pack:JSON.parse(physics),wind:f.liveWind.wind,sheet:f.sheet,...(f.liveWind.bodyProfile?{bodyProfile:f.liveWind.bodyProfile}:{}),materialKernel:await loadMaterialKernel(readFileSync(f.materialWasm.path)),assemblyKernel:await loadAssemblyKernel(readFileSync(f.assemblyWasm.path))});
const free=await make(),recordedAir=await make(),differences={};
if(f.liveWind.bodyProfile){assert.deepEqual(r.preparation.massBudget,json(free.massBudget));assert.deepEqual(r.preparation.geometryCGM,free.geometryCGM);}
function compare(a,b,path) {
  if(typeof a==='number'&&typeof b==='number') {
    assert(Number.isFinite(a)&&Number.isFinite(b));if(a===b)return;
    const d=differences[path]??={count:0,maxAbs:0};d.count++;d.maxAbs=Math.max(d.maxAbs,Math.abs(a-b));return;
  }
  assert.equal(typeof a,typeof b,path);
  if(a&&typeof a==='object') {assert.deepEqual(Object.keys(a),Object.keys(b),path);for(const k of Object.keys(a))compare(a[k],b[k],path+'.'+k);}
  else assert.equal(a,b,path);
}
const reference=structuredClone(r);reference.environment={scope:'Синтетическая запись независимого Node-повтора; не измерение браузера.'};reference.steps=[];
// Прямой повтор считает физику без наблюдателя. Чужие браузерные timing
// нельзя переносить к нулевым часам Node или выдавать за профиль повтора.
delete reference.fixture.profileWorker;
let exactRecordedAirSteps=0,mechanicalRefusals=[];
for(const s of r.steps) {
  const a=free.step(s.controls),state=json({positions:free.motion.pos,body:free.motion.body,forceN:free.forceN,audit:a});
  compare(state.positions,s.positions,'free.positionsM');compare(state.body,s.body,'free.body');compare(state.forceN,s.forceN,'free.forceN');compare(state.audit,s.audit,'free.audit');
  const {timing,...referenceStep}=s;
  reference.steps.push({...referenceStep,...state,stepMs:0,sentAt:0,receivedAt:0,presentedAt:0});
  const preparedLoad=recordedAir.prepareLoad(s.controls);
  compare(Array.from(recordedAir.forceN),s.forceN,'airOnRecordedState.forceN');
  if(f.liveWind.bodyProfile){compare(preparedLoad.forceN,s.audit.water.totalForceN,'waterOnRecordedState.forceN');compare(preparedLoad.momentNm,s.audit.water.totalMomentNm,'waterOnRecordedState.momentNm');
    preparedLoad.forceN=Array.from(s.audit.water.totalForceN);preparedLoad.momentNm=Array.from(s.audit.water.totalMomentNm);}
  recordedAir.forceN.set(s.forceN);const m=recordedAir.solve();
  const expectedAudit={...s.audit};delete expectedAudit.air;delete expectedAudit.water;const actualAudit=json(m);delete actualAudit.air;delete actualAudit.water;
  try {assert.deepEqual(json(recordedAir.motion.pos),s.positions);assert.deepEqual(json(recordedAir.motion.body),s.body);assert.deepEqual(actualAudit,expectedAudit);exactRecordedAirSteps++;}
  catch(e){mechanicalRefusals.push({step:s.index,message:e.message.slice(0,1000)});}
}
const sourceSha256={};for(const p of ['scripts/cloth_live_wind_portability.mjs',...Object.keys(f.sourceSha256)])sourceSha256[p]=hash(readFileSync(p));
const referencePath=out+'.node-reference.json';assert(!existsSync(referencePath));writeFileSync(referencePath,JSON.stringify(reference,null,2)+'\n',{flag:'wx'});
writeFileSync(out,JSON.stringify({schema:'cloth-live-wind-portability-v1',phase:'complete',input:{path:input,sha256:hash(bytes)},sourceSha256,
  steps:r.steps.length,exactRecordedAirSteps,mechanicalRefusals,differences,reference:referencePath,
  scope:'Это диагностика расхождений чисел, без нового порога совпадения. Строгий повтор полного живого воздуха не принят. Повтор на записанных силах проверяет только механику; свободный Node-повтор не подменяет браузерную запись.'},null,2)+'\n',{flag:'wx'});
console.log(`Диагностика ${r.steps.length} шагов: ${exactRecordedAirSteps} строгих механических повторов на записанном воздухе; ${Object.keys(differences).length} числовых полей с расхождением.`);
