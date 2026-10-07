// Чередующиеся повторы живых команд на неизменяемых копиях двух реализаций.
// Измеряется расчёт Node; браузерный бюджет проверяется отдельно.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8));
const prior=args.find(v=>v.startsWith('--baseline='))?.slice(11),out=args.find(v=>v.startsWith('--out='))?.slice(6);
const candidateWasm=args.find(v=>v.startsWith('--candidate-wasm='))?.slice(17);
assert(inputs.length===2&&prior&&out&&args.length===4+Boolean(candidateWasm)&&args.every(v=>/^--(input|baseline|out|candidate-wasm)=.+$/.test(v)),
  'Нужны две --input, --baseline и --out; допустим отдельный --candidate-wasm');
const output=resolve(out),copies=output+'.sources',root=fileURLToPath(new URL('../',import.meta.url));
assert(!existsSync(output)&&!existsSync(copies),'Результат и копии исходников нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex');
const baseline=execFileSync('git',['rev-parse',prior],{encoding:'utf8'}).trim();
assert.equal(typeof process.threadCpuUsage,'function','Нужен Node с CPU отдельного потока');
const sourceSha256={},baselineSha256={},changed=[];
function copyModule(path) {
  if(Object.hasOwn(sourceSha256,path))return;
  const now=readFileSync(resolve(root,path)),old=execFileSync('git',['show',`${baseline}:${path}`],{maxBuffer:16*1024*1024});
  sourceSha256[path]=hash(now);baselineSha256[path]=hash(old);if(hash(now)!==hash(old))changed.push(path);
  for(const [version,bytes] of [['candidate',now],['baseline',old]]) {
    const target=resolve(copies,version,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});
  }
  const imports=b=>[...b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map(m=>relative(root,resolve(root,dirname(path),m[1])));
  assert.deepEqual(imports(now),imports(old),'Два варианта должны иметь тот же граф импортов');imports(now).forEach(copyModule);
}
copyModule('tests/lib/cloth-fluid-sail-motion.mjs');
// Загрузчик вызывается динамически в дочернем повторе, вне графа фабрики.
copyModule('tests/lib/cloth-sparse-wasm.mjs');
copyModule('tests/lib/cloth-sparse-kernel.c');
// Сам измеритель не входит в сравниваемый граф физики, но остаётся в записи.
mkdirSync(copies,{recursive:true});
writeFileSync(resolve(copies,'benchmark-tool.mjs'),readFileSync(fileURLToPath(import.meta.url)),{flag:'wx'});
for(const path of ['tests/probes/cloth-material-wasm.mjs','tests/probes/cloth-material-engine-check.mjs',
  'tests/probes/cloth-assembly-wasm.mjs','tests/probes/cloth-assembly-engine-check.mjs'])copyModule(path);
assert((changed.length>0||candidateWasm)&&changed.every(p=>['tests/lib/cloth-fluid-schur-direction.mjs','tests/lib/cloth-fluid-body-motion.mjs',
  'tests/lib/cloth-material.mjs','tests/lib/cloth-sparse-wasm.mjs','tests/lib/cloth-fluid-inertia.mjs'].includes(p)),
  'Опыт ограничен материалом, направлением, малыми матричными операциями и оболочкой общего расчёта');
const linearCandidate=candidateWasm?{path:candidateWasm,sha256:hash(readFileSync(candidateWasm))}:undefined;
const fixtures=inputs.map(path=>{
  const b=readFileSync(path),r=JSON.parse(b),f=r.fixture;
  assert.equal(r.schema,'cloth-fluid-live-result-v1');assert.equal(f.dirty,false);assert.equal(r.steps.length,180);assert.equal(r.shownStep,180);
  assert(f.sheet&&f.sheetProof,'Нужен полный проверенный цикл со свободным углом');
  for(const [p,sha] of Object.entries(f.sourceSha256))assert.equal(hash(execFileSync('git',['show',`${f.revision}:${p}`],{maxBuffer:16*1024*1024})),sha);
  for(const part of [f.input,f.wasm,f.scene,f.sheetProof,...(f.materialWasm?[f.materialWasm]:[]),
    ...(f.assemblyWasm?[f.assemblyWasm]:[])])assert.equal(hash(readFileSync(part.path)),part.sha256);
  if(linearCandidate)assert.notEqual(linearCandidate.sha256,f.wasm.sha256,'Кандидат модуля должен отличаться от прежнего');
  assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);
  const source=JSON.parse(readFileSync(f.input.path)),proof=JSON.parse(readFileSync(f.sheetProof.path));
  assert.equal(source.phase,'complete');assert.equal(source.dirty,false);
  assert.deepEqual(f.recipe,source.recipe);assert.deepEqual(f.bodyInput,source.config.bodyInput);
  assert.equal(proof.phase,'complete');assert.equal(proof.dirty,false);assert.equal(proof.revision,f.sheetProof.revision);
  assert.equal(proof.input.sha256,f.input.sha256);assert.equal(proof.physicsSha256,f.physicsSha256);
  assert.deepEqual(f.sheet,proof.parameters.sheet);assert.deepEqual(f.bodyInput,proof.parameters.bodyInput);
  for(const s of [source,proof])for(const [p,sha] of Object.entries(s.sourceSha256))
    assert.equal(hash(execFileSync('git',['show',`${s.revision}:${p}`],{maxBuffer:16*1024*1024})),sha);
  return {path:resolve(path),sha256:hash(b),side:f.side,fixture:f};
});
assert.equal(new Set(fixtures.map(f=>f.side)).size,2,'Нужны обе стороны');
const runner=String.raw`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {cpus} from 'node:os';
const [modulePath,input,output,linearPath]=process.argv.slice(1),r=JSON.parse(readFileSync(input)),f=r.fixture;
const {fluidSailMotion}=await import(pathToFileURL(modulePath));
const {loadSparseFactor}=await import(new URL('./cloth-sparse-wasm.mjs',pathToFileURL(modulePath)));
const {loadMaterialKernel}=await import(new URL('../probes/cloth-material-wasm.mjs',pathToFileURL(modulePath))),
{verifyMaterialKernel}=await import(new URL('../probes/cloth-material-engine-check.mjs',pathToFileURL(modulePath))),
{loadAssemblyKernel}=await import(new URL('../probes/cloth-assembly-wasm.mjs',pathToFileURL(modulePath))),
{verifyAssemblyKernel}=await import(new URL('../probes/cloth-assembly-engine-check.mjs',pathToFileURL(modulePath)));
const linearBytes=readFileSync(linearPath),{createHash}=await import('node:crypto'),
  linear={path:linearPath,sha256:createHash('sha256').update(linearBytes).digest('hex')};
const begin=performance.now(),before=process.cpuUsage(),factor=await loadSparseFactor(linearBytes);
const materialKernel=f.materialWasm?await loadMaterialKernel(readFileSync(f.materialWasm.path)):undefined,
assemblyKernel=f.assemblyWasm?await loadAssemblyKernel(readFileSync(f.assemblyWasm.path)):undefined;
if(materialKernel)assert.deepEqual(verifyMaterialKernel(materialKernel,f.recipe),r.preparation.material.validation);
else assert.equal(r.preparation.material,undefined);
if(assemblyKernel)assert.deepEqual(verifyAssemblyKernel(assemblyKernel,f.recipe),r.preparation.assembly.validation);
else assert.equal(r.preparation.assembly,undefined);
const c=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel,assemblyKernel}),times=[],stepCpu=[],stepThreadCpuMs=[],states=[];
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const json=v=>JSON.parse(JSON.stringify(serial(v)));
assert.deepEqual(r.initial,json({positions:c.motion.pos,body:c.motion.body}));
for(const s of r.steps) {
  const cpuBeforeStep=process.cpuUsage(),threadBeforeStep=process.threadCpuUsage(),start=performance.now(),audit=c.step(s.controls);
  times.push(performance.now()-start);const thread=process.threadCpuUsage(threadBeforeStep),usage=process.cpuUsage(cpuBeforeStep);
  stepThreadCpuMs.push((thread.user+thread.system)/1000);
  stepCpu.push({userMs:usage.user/1000,systemMs:usage.system/1000});
  const state=json({positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit});
  assert.deepEqual(state,{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});states.push(state);
}
const cpu=process.cpuUsage(before),wallMs=performance.now()-begin,sorted=times.slice(1).sort((a,b)=>a-b);
writeFileSync(output,JSON.stringify({runtime:process.version,hardware:{cpu:cpus()[0]?.model,platform:process.platform,arch:process.arch},
firstMs:times[0],followingMeanMs:times.slice(1).reduce((s,v)=>s+v,0)/(times.length-1),followingP90Ms:sorted[Math.ceil(.9*sorted.length)-1],followingMaxMs:Math.max(...times.slice(1)),
stepTotalMs:times.reduce((s,v)=>s+v,0),stepTimesMs:times,stepCpu,stepThreadCpuMs,
followingThreadCpuMs:stepThreadCpuMs.slice(1).reduce((sum,v)=>sum+v,0),
followingCpu:Object.fromEntries(['userMs','systemMs'].map(k=>[k,stepCpu.slice(1).reduce((sum,v)=>sum+v[k],0)])),
cpu:{userMs:cpu.user/1000,systemMs:cpu.system/1000,wallMs},
modules:{linear,material:f.materialWasm??null,assembly:f.assemblyWasm??null},states},null,2)+'\n',{flag:'wx'});`;
const report={schema:'cloth-fluid-live-benchmark-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),baselineRevision:baseline,
  toolSha256:hash(readFileSync(fileURLToPath(import.meta.url))),sourceSha256,baselineSha256,changedSources:changed,
  ...(linearCandidate?{linearCandidate}:{}),
  inputs:fixtures.map(({path,sha256,side})=>({path,sha256,side})),runs:[],checkedSteps:0,
  rule:'Три пары каждого борта, порядок вариантов чередуется. Материал и сборщик выбираются из записи и проходят её проверку до измерения шагов. Таймер шага и CPU каждого шага исключают сверку/запись; CPU рабочего потока сохранён отдельно, CPU окна включает сверку и подготовку WASM/модели. CPU процесса учитывает все потоки, в том числе возможную компиляцию; измерение шагов добавляет вызовы часов и cpuUsage/threadCpuUsage. Все времена/первые шаги сохранены, followingCpu/followingThreadCpuMs относятся к 2–180. Node, не браузер.'};
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};
  writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Парный опыт остановлен: '+e.message);process.exitCode=1;});
for(let pair=1;pair<=3;pair++)for(const fixture of fixtures) {
  const records={};
  for(const version of pair%2?['baseline','candidate']:['candidate','baseline']) {
    const path=resolve(copies,`${fixture.side}-${pair}-${version}.json`);
    const linear=version==='candidate'&&linearCandidate?linearCandidate:fixture.fixture.wasm;
    execFileSync(process.execPath,['--input-type=module','-e',runner,resolve(copies,version,'tests/lib/cloth-fluid-sail-motion.mjs'),fixture.path,path,linear.path],{cwd:root,maxBuffer:1024*1024});
    const bytes=readFileSync(path),r=JSON.parse(bytes);records[version]=r;
    assert.equal(r.stepCpu.length,180);
    assert.deepEqual(r.modules.linear,linear,'Измерялся другой линейный модуль');
    assert(r.stepCpu.every(v=>Object.values(v).every(n=>Number.isFinite(n)&&n>=0)));
    for(const values of [r.stepTimesMs,r.stepThreadCpuMs])assert(values.length===180&&values.every(v=>Number.isFinite(v)&&v>=0));
    const {states,...timing}=r;report.runs.push({pair,version,side:fixture.side,path:relative(root,path),sha256:hash(bytes),...timing});
    console.log(`Пара ${pair}, ${fixture.side==='plus'?'первая':'другая'} сторона, ${version==='candidate'?'новый':'прежний'} код: первый ${r.firstMs.toFixed(2)} мс, следующие ${r.followingMeanMs.toFixed(2)} мс; CPU окна ${(r.cpu.userMs+r.cpu.systemMs).toFixed(2)} мс.`);
  }
  assert.deepEqual(records.candidate.states,records.baseline.states);report.checkedSteps+=180;
}
report.phase='complete';writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Парные повторы: ${report.checkedSteps} шагов каждого варианта совпали точно с записью и между собой.`);
