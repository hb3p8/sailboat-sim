// Полный парус с одним свободным углом и верёвкой до точки из пакета.
// Поле воздуха заморожено; результаты и первый отказ сохраняются отдельно.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fluidSailMotion} from '../tests/lib/cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';

const [input,output,countText='60',...extra]=process.argv.slice(2),count=Number(countText);
const wasmPath=extra.find(v=>v.startsWith('--wasm='))?.slice(7),hz=Number(extra.find(v=>v.startsWith('--hz='))?.slice(5)??60);
const rateMPS=Number(extra.find(v=>v.startsWith('--rate='))?.slice(7)??.5);
assert(input&&output&&wasmPath&&Number.isInteger(count)&&count>=1&&count<=1200&&[60,120,240].includes(hz)&&
  [0,.05,.5].includes(rateMPS)&&extra.every(v=>/^--(wasm|hz|rate)=.+$/.test(v))&&new Set(extra.map(v=>v.split('=')[0])).size===extra.length,
  'Нужны чистая исходная серия, новый JSON, число шагов, --wasm, --hz=60|120|240 и --rate=0|0.05|0.5');
assert(!existsSync(output),'Сохранённый опыт нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),source=JSON.parse(bytes);
assert.equal(source.dirty,false);assert.equal(source.phase,'complete');
for(const [p,sha] of Object.entries(source.sourceSha256))assert.equal(hash(execFileSync('git',['show',`${source.revision}:${p}`],{maxBuffer:16*1024*1024})),sha);
const physics=readFileSync('out/export/physics.json'),pack=JSON.parse(physics);assert.equal(hash(physics),source.physicsSha256);
const r=source.recipe,node=r.cols-1,q=r.positions.slice(3*node,3*node+3),lead=pack.rig.gennaker.sheet_lead_m;
// Оси лабораторной опоры совпадают с исходными осями ткани, ЦТ назначен
// в (0,0,0). Это перенос пакетной точки, не масса/ЦТ настоящего SV20.
const side=Math.sign(q[1]);assert(side!==0,'Нужен определённый борт свободного угла');
const localM=[lead[0],side*Math.abs(lead[1]),lead[2]],lengthM=Math.hypot(...q.map((v,d)=>v-localM[d]));
const sheet={node,localM,lengthM},wasmBytes=readFileSync(wasmPath),factor=await loadSparseFactor(wasmBytes),hS=1/hz;
const calculation=fluidSailMotion(r,source.config.bodyInput,factor,{hS,sheet}),m=calculation.motion;
assert.equal(m.bindings.length,2);assert(!m.bindings.some(b=>b.node===node));assert.equal(m.ropes.length,1);
const record={schema:'cloth-fluid-rope-sail-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,
  input:{path:input,sha256:hash(bytes),revision:source.revision},physicsSha256:hash(physics),
  wasm:{path:wasmPath,sha256:hash(wasmBytes)},sourceSha256:{},
  parameters:{hS,requestedSteps:count,tack:source.config.tack,rows:r.rows,cols:r.cols,sheet,packageLeadM:lead,
    bodyInput:source.config.bodyInput,addedMass6:calculation.addedMass6,material:calculation.material,
    rateMPS,control:'0–0.5 с удержание; 0.5–1 с отпускание с заданной скоростью; 1–1.5 с удержание; 1.5–2 с возврат; далее удержание',
    scope:'Лабораторные оси/ЦТ/инерция воды, прежнее поле давления/веса/сопротивления; живого воздуха, сил воды и руля нет.'},
  initial:{positionsM:Array.from(m.pos),velocityMS:Array.from(m.vel),body:structuredClone(m.body)},steps:[]};
const root=fileURLToPath(new URL('../',import.meta.url));
function addSource(url) {
  const name=relative(root,fileURLToPath(url));if(Object.hasOwn(record.sourceSha256,name))return;
  const b=readFileSync(url);record.sourceSha256[name]=hash(b);
  for(const match of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))addSource(new URL(match[1],url));
}
addSource(new URL(import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):
  v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const snapshot=()=>({positionsM:Array.from(m.pos),velocityMS:Array.from(m.vel),body:structuredClone(m.body),
  lengthsM:Array.from(m.ropeLengthsM),multipliers:Array.from(m.lastMu),lambdas:m.constraints.map(c=>c.lambda)});
const start=performance.now();let attempt=0,before;
try {
  for(attempt=1;attempt<=count;attempt++) {
    const t=attempt*hS,delta=t<=.5?0:t<=1?rateMPS*(t-.5):t<=1.5?.5*rateMPS:t<=2?.5*rateMPS-rateMPS*(t-1.5):0;
    const controls={sheetLengthM:lengthM+delta},begin=performance.now();before=snapshot();
    const audit=calculation.step(controls),rope=audit.ropes[0];
    assert(audit.maxPhysicalResidualN<=m.tolerances.forceToleranceN&&audit.maxHardViolationM<=m.tolerances.lengthToleranceM);
    assert(audit.dualViolationN<=m.tolerances.dualToleranceN&&audit.complementarityJ<=m.tolerances.complementarityToleranceJ);
    assert(Math.abs(audit.discreteBalanceResidualJ)<=audit.workLimitJ&&Math.abs(audit.bodyWorkCancellationResidualJ)<=audit.interfaceWorkLimitJ);
    assert(Math.abs(rope.controlResidualJ)<=rope.controlLimitJ);
    record.steps.push({step:attempt,timeS:t,stepMs:performance.now()-begin,controls,positionsM:Array.from(m.pos),
      body:structuredClone(m.body),forceN:Array.from(calculation.forceN),audit:serial(audit)});
  }
  record.phase='complete';
} catch(error) {
  record.phase='failed';record.failure={step:attempt,timeS:attempt*hS,message:error.message,stack:error.stack,
    audit:serial(error.audit),state:snapshot(),before};
  assert.deepEqual(record.failure.state,before,'Отказ изменил физическое состояние');process.exitCode=1;
}
record.totalMs=performance.now()-start;
record.summary={acceptedSteps:record.steps.length,tautSteps:record.steps.filter(s=>s.audit.ropes[0].tensionN>m.tolerances.dualToleranceN).length,
  maxTensionN:Math.max(0,...record.steps.map(s=>s.audit.ropes[0].tensionN)),
  maxWorkRatio:Math.max(0,...record.steps.map(s=>Math.abs(s.audit.discreteBalanceResidualJ)/s.audit.workLimitJ)),
  maxControlRatio:Math.max(0,...record.steps.map(s=>Math.abs(s.audit.ropes[0].controlResidualJ)/s.audit.ropes[0].controlLimitJ))};
writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({запись:output,состояние:record.phase,начальная_длина_м:lengthM,итог:record.summary,
  время_мс:record.totalMs,отказ:record.failure?.message}));
