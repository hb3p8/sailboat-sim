// Полные парные циклы одной JS-постановки с обычным/отдельным материалом.
// Сверяются все команды и физические поля прежней браузерной записи.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),
 wasm=args.find(v=>v.startsWith('--material-wasm='))?.slice(16),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&wasm&&out&&args.length===4&&args.every(v=>/^--(input|material-wasm|out)=.+$/.test(v)));
const root=fileURLToPath(new URL('../',import.meta.url)),output=resolve(out),copies=output+'.sources',hash=b=>createHash('sha256').update(b).digest('hex');
assert(!existsSync(output)&&!existsSync(copies),'Запись и исходники нельзя перезаписывать');
const sourceSha256={};
function copy(path) {
 if(sourceSha256[path])return;const b=readFileSync(resolve(root,path));sourceSha256[path]=hash(b);
 const target=resolve(copies,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,b,{flag:'wx'});
 for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))copy(relative(root,resolve(root,dirname(path),m[1])));
}
for(const p of ['tests/lib/cloth-fluid-sail-motion.mjs','tests/lib/cloth-sparse-wasm.mjs','tests/probes/cloth-material-wasm.mjs','tests/probes/cloth-material-wasm.c'])copy(p);
copy(relative(root,fileURLToPath(import.meta.url)));
const fixtures=inputs.map(path=>{
 const b=readFileSync(path),r=JSON.parse(b),f=r.fixture;assert.equal(r.schema,'cloth-fluid-live-result-v1');assert.equal(r.steps.length,180);assert.equal(r.shownStep,180);assert.equal(f.dirty,false);assert(f.sheet&&f.sheetProof);
 for(const [p,sha] of Object.entries(f.sourceSha256))assert.equal(hash(execFileSync('git',['show',f.revision+':'+p],{maxBuffer:16*1024*1024})),sha);
 for(const part of [f.input,f.wasm,f.scene,f.sheetProof])assert.equal(hash(readFileSync(part.path)),part.sha256);
 assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);
 return {path:resolve(path),sha256:hash(b),side:f.side};
});
assert.equal(new Set(fixtures.map(f=>f.side)).size,2);
const runner=String.raw`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {cpus} from 'node:os';
const [source,input,materialWasm,version,out]=process.argv.slice(1),r=JSON.parse(readFileSync(input)),f=r.fixture;
const {fluidSailMotion}=await import(pathToFileURL(source));const {loadSparseFactor}=await import(new URL('./cloth-sparse-wasm.mjs',pathToFileURL(source)));
const {loadMaterialKernel}=await import(new URL('../probes/cloth-material-wasm.mjs',pathToFileURL(source)));
const start=performance.now(),cpuBefore=process.cpuUsage(),factor=await loadSparseFactor(readFileSync(f.wasm.path));
const materialKernel=version==='wasm'?await loadMaterialKernel(readFileSync(materialWasm)):undefined;
assert.equal(typeof process.threadCpuUsage,'function','Нужен Node с CPU текущего потока');
const c=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel}),times=[],stepCpu=[],threadCpu=[],states=[];
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const json=v=>JSON.parse(JSON.stringify(serial(v)));assert.deepEqual(json({positions:c.motion.pos,body:c.motion.body}),r.initial);
for(const s of r.steps) {
 const before=process.cpuUsage(),threadBefore=process.threadCpuUsage(),begin=performance.now(),audit=c.step(s.controls);times.push(performance.now()-begin);
 const own=process.threadCpuUsage(threadBefore);threadCpu.push({userMs:own.user/1000,systemMs:own.system/1000});
 const cpu=process.cpuUsage(before);stepCpu.push({userMs:cpu.user/1000,systemMs:cpu.system/1000});
 const state=json({index:s.index,controls:s.controls,positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit});
 assert.deepEqual(state,{index:s.index,controls:s.controls,positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});states.push(state);
}
const cpu=process.cpuUsage(cpuBefore);
writeFileSync(out,JSON.stringify({version,runtime:process.version,v8:process.versions.v8,hardware:{cpu:cpus()[0]?.model,platform:process.platform,arch:process.arch},
 firstMs:times[0],followingMeanMs:times.slice(1).reduce((s,v)=>s+v,0)/179,timesMs:times,stepCpu,threadCpu,
 followingCpu:Object.fromEntries(['userMs','systemMs'].map(k=>[k,stepCpu.slice(1).reduce((s,v)=>s+v[k],0)])),
 followingThreadCpu:Object.fromEntries(['userMs','systemMs'].map(k=>[k,threadCpu.slice(1).reduce((s,v)=>s+v[k],0)])),
 cpu:{userMs:cpu.user/1000,systemMs:cpu.system/1000,wallMs:performance.now()-start},states},null,2)+'\n',{flag:'wx'});`;
const record={schema:'cloth-material-wasm-benchmark-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,
 toolSha256:hash(readFileSync(fileURLToPath(import.meta.url))),wasm:{path:wasm,sha256:hash(readFileSync(wasm))},inputs:fixtures,runs:[],checkedSteps:0,
 rule:'По три чередующиеся пары каждого борта, новый процесс каждого варианта, 180 прежних команд. CPU шагов исключает проверку/запись; CPU всего окна включает подготовку. Все первые шаги сохранены. stepCpu учитывает потоки процесса, threadCpu — текущий поток; часы добавляют работу. Node, не браузер.'};
process.once('uncaughtException',e=>{record.phase='failed';record.failure={message:e.message,stack:e.stack};writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});console.error('Парный опыт материала остановлен: '+e.message);process.exitCode=1;});
for(let pair=1;pair<=3;pair++)for(const f of fixtures) {
 const results={};
 for(const version of pair%2?['js','wasm']:['wasm','js']) {
  const path=resolve(copies,`${f.side}-${pair}-${version}.json`);
  execFileSync(process.execPath,['--input-type=module','-e',runner,resolve(copies,'tests/lib/cloth-fluid-sail-motion.mjs'),f.path,resolve(wasm),version,path],{cwd:root,maxBuffer:1024*1024});
  const b=readFileSync(path),r=JSON.parse(b);results[version]=r;assert.equal(r.states.length,180);assert.equal(r.stepCpu.length,180);
  assert.equal(r.threadCpu.length,180);
  assert([...r.stepCpu,...r.threadCpu].every(v=>Object.values(v).every(n=>Number.isFinite(n)&&n>=0)));
  const {states,...timing}=r;record.runs.push({pair,side:f.side,path:relative(root,path),sha256:hash(b),...timing});
  console.log(`Пара ${pair}, ${f.side==='plus'?'первая':'другая'} сторона, ${version==='wasm'?'WASM':'JS'}: первый ${r.firstMs.toFixed(2)} мс, рабочее среднее ${r.followingMeanMs.toFixed(2)} мс, CPU рабочего окна ${(r.followingCpu.userMs+r.followingCpu.systemMs).toFixed(2)} мс.`);
 }
 assert.deepEqual(results.js.states,results.wasm.states);record.checkedSteps+=180;
}
record.phase='complete';writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});console.log(`Материал: ${record.checkedSteps} шагов каждого варианта совпали с записью и между собой.`);
