// Короткий общий опыт полного сохранённого паруса с лабораторной водой.
// Сохраняет первый отказ/стоимость, старые серии не перезаписывает.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import {fluidSailMotion} from '../tests/lib/cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';

const [input,output,countText='1',...extra]=process.argv.slice(2),count=Number(countText);
assert(input&&output&&Number.isInteger(count)&&count>=1&&count<=1800&&
  extra.every(v=>/^--(linear-backend|wasm|hz)=.+$/.test(v))&&new Set(extra.map(v=>v.split('=')[0])).size===extra.length,
  'Нужны исходная полная серия, новый JSON, 1–1800 шагов и уникальные параметры решения');
const backend=extra.find(v=>v.startsWith('--linear-backend='))?.slice(17)??'reference-dense';
const wasmPath=extra.find(v=>v.startsWith('--wasm='))?.slice(7);
const hzText=extra.find(v=>v.startsWith('--hz='))?.slice(5);
assert(hzText==null||['60','120','240'].includes(hzText),'Уточнение времени: 60/120/240 Гц');
assert(['reference-dense','schur-wasm'].includes(backend)&&((backend==='schur-wasm')===Boolean(wasmPath)));
const wasmBytes=wasmPath?readFileSync(wasmPath):undefined,wasmSparseFactor=wasmBytes?await loadSparseFactor(wasmBytes):undefined;
assert(!existsSync(output),'Сохранённую постановку нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),source=JSON.parse(bytes);
assert.equal(source.dirty,false);assert.equal(source.phase,'complete');
for(const [path,sha] of Object.entries(source.sourceSha256))
  assert.equal(hash(execFileSync('git',['show',`${source.revision}:${path}`],{maxBuffer:16*1024*1024})),sha);
assert.equal(hash(readFileSync('out/export/physics.json')),source.physicsSha256);
const r=source.recipe,n=r.rows*r.cols;
const hS=hzText?1/Number(hzText):r.hS;
assert.deepEqual([r.rows,r.cols],[11,9]);assert.equal(r.loadFrame,'inertial-cartesian-frozen');
assert.equal(r.mass.length,n+4);assert.equal(r.fixed.length,0);
const bodyInput=source.config.bodyInput;
assert.deepEqual(bodyInput,{massKg:1000,principalInertiaKgM2:[1000,5000,5000],originM:[0,0,0]});
const calculation=fluidSailMotion(r,bodyInput,wasmSparseFactor,{linearBackend:backend,hS});
const {motion:m,forceN,addedMass6}=calculation;
const positions=Array.from(m.pos),velocity=Array.from(m.vel);
const record={schema:'cloth-fluid-sail-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,
  hardware:{cpu:cpus()[0]?.model,platform:process.platform,arch:process.arch},
  input:{path:input,sha256:hash(bytes),revision:source.revision},physicsSha256:source.physicsSha256,
  sourceSha256:{},backend,wasm:wasmPath?{path:wasmPath,sha256:hash(wasmBytes)}:null,
  parameters:{bodyInput,addedMass6,material:calculation.material,hS,tack:source.config.tack,requestedSteps:count,
    scope:'Лабораторный ЦТ и оси, заданная постоянная инерция воды; прежний замороженный воздух/вес/сопротивление ткани. Сил воды, собственного веса тела, живого Boat и CFD нет.'},
  initial:{positionsM:positions,velocityMS:velocity},steps:[]};
const root=fileURLToPath(new URL('../',import.meta.url));
function addSource(url) {
  const p=relative(root,fileURLToPath(url));if(Object.hasOwn(record.sourceSha256,p))return;
  const b=readFileSync(url);record.sourceSha256[p]=hash(b);
  for(const x of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))addSource(new URL(x[1],url));
}
addSource(new URL(import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):
  v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const start=performance.now();let attempt=0;
try {
  for(attempt=1;attempt<=count;attempt++) {
    calculation.prepareLoad();
    const old=m.pos.slice(),before=performance.now();
    const a=calculation.solve();
    const entry={step:attempt,stepMs:performance.now()-before,positionsM:Array.from(m.pos),body:structuredClone(m.body),forceN:Array.from(forceN),audit:serial(a)};
    record.steps.push(entry);
    assert(a.maxPhysicalResidualN<=m.tolerances.forceToleranceN&&a.maxHardViolationM<=m.tolerances.lengthToleranceM);
    assert(a.dualViolationN<=m.tolerances.dualToleranceN&&a.complementarityJ<=m.tolerances.complementarityToleranceJ);
    assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ);assert(Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
    assert(m.pos.every(Number.isFinite));assert(old.every(Number.isFinite));
  }
  record.phase='complete';
} catch(error) {
  record.phase='failed';record.failure={step:attempt,message:error.message,positionsM:Array.from(m.pos),body:structuredClone(m.body),forceN:Array.from(forceN)};
  process.exitCode=1;
}
record.totalMs=performance.now()-start;writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({запись:output,состояние:record.phase,принято_шагов:record.steps.length,время_мс:record.totalMs,отказ:record.failure?.message}));
