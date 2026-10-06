// Изолированная пакетная сборка: полный контроль матриц, затем парные циклы.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),wasm=args.find(v=>v.startsWith('--assembly-wasm='))?.slice(16),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&wasm&&out&&args.length===4&&args.every(v=>/^--(input|assembly-wasm|out)=.+$/.test(v)));
const root=fileURLToPath(new URL('../',import.meta.url)),output=resolve(out),copies=output+'.sources',hash=b=>createHash('sha256').update(b).digest('hex');
assert(!existsSync(output)&&!existsSync(copies),'Нельзя перезаписывать опыт/копии');const sourceSha256={};
function copy(path){if(sourceSha256[path])return;const b=readFileSync(resolve(root,path));sourceSha256[path]=hash(b);const p=resolve(copies,path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,b,{flag:'wx'});
 for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))copy(relative(root,resolve(root,dirname(path),m[1])));}
for(const p of ['tests/lib/cloth-fluid-sail-motion.mjs','tests/lib/cloth-sparse-wasm.mjs','tests/probes/cloth-material-wasm.mjs','tests/probes/cloth-material-wasm.c','tests/probes/cloth-material-engine-check.mjs','tests/probes/cloth-assembly-wasm.mjs','tests/probes/cloth-assembly-wasm.c',relative(root,fileURLToPath(import.meta.url))])copy(p);
const direction='tests/lib/cloth-fluid-schur-direction.mjs',original=readFileSync(resolve(root,direction),'utf8');
const ordinary=`} else for(let k=0;k<soft.length;k++) {
    const {c,g}=soft[k],plan=m.fluidAssembly.soft[k];checkPlan(g,plan);let entry=0;
    for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++)matrix[plan.entries[entry++]]+=g[a][1]*g[b][1]/c.alpha;
  }`;
assert.equal(original.split(ordinary).length,2,'Нужна единственная прежняя сборка');
// После переноса используем рабочую необязательную ветку; ранний граф
// по-прежнему может получить её только внутри исследовательской копии.
const candidate=original.includes('} else if(m.assemblyKernel&&n) {')?original:original.replace(ordinary,`} else if(m.assemblyKernel&&n) {
    soft.forEach(({g},k)=>checkPlan(g,m.fluidAssembly.soft[k]));
    m.compiledAssembly??=m.assemblyKernel.compile(matrix.length,m.fluidAssembly.soft);
    m.compiledAssembly.assemble(matrix,soft);
  } else for(let k=0;k<soft.length;k++) {
    const {c,g}=soft[k],plan=m.fluidAssembly.soft[k];checkPlan(g,plan);let entry=0;
    for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++)matrix[plan.entries[entry++]]+=g[a][1]*g[b][1]/c.alpha;
  }`);
writeFileSync(resolve(copies,direction+'.original'),original,{flag:'wx'});writeFileSync(resolve(copies,direction),candidate);
const fixtures=inputs.map(path=>{const b=readFileSync(path),r=JSON.parse(b),f=r.fixture;assert.equal(r.steps.length,180);assert.equal(r.shownStep,180);assert.equal(f.dirty,false);assert(f.materialWasm);
 for(const [p,h] of Object.entries(f.sourceSha256))assert.equal(hash(execFileSync('git',['show',f.revision+':'+p],{maxBuffer:16*1024*1024})),h);
 for(const part of [f.input,f.scene,f.wasm,f.materialWasm,f.sheetProof])assert.equal(hash(readFileSync(part.path)),part.sha256);
 assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);return{path:resolve(path),sha256:hash(b),side:f.side};});
assert.equal(new Set(fixtures.map(f=>f.side)).size,2);
const runner=String.raw`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {cpus} from 'node:os';
const [source,input,assemblyPath,version,out]=process.argv.slice(1),r=JSON.parse(readFileSync(input)),f=r.fixture;
const {fluidSailMotion}=await import(pathToFileURL(source)),{loadSparseFactor}=await import(new URL('./cloth-sparse-wasm.mjs',pathToFileURL(source))),
{loadMaterialKernel}=await import(new URL('../probes/cloth-material-wasm.mjs',pathToFileURL(source))),{verifyMaterialKernel}=await import(new URL('../probes/cloth-material-engine-check.mjs',pathToFileURL(source))),
{loadAssemblyKernel}=await import(new URL('../probes/cloth-assembly-wasm.mjs',pathToFileURL(source)));
const before=performance.now(),cpuBefore=process.cpuUsage(),factor=await loadSparseFactor(readFileSync(f.wasm.path)),materialKernel=await loadMaterialKernel(readFileSync(f.materialWasm.path));
assert.deepEqual(verifyMaterialKernel(materialKernel,f.recipe),r.preparation.material.validation);
const assemblyKernel=version==='js'?undefined:await loadAssemblyKernel(readFileSync(assemblyPath));let matrices=0,elements=0;
const c=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel});
if(assemblyKernel)c.motion.assemblyKernel=version==='audit'?{compile(length,plans){const compiled=assemblyKernel.compile(length,plans);return{assemble(matrix,soft){const expected=matrix.slice();compiled.assemble(matrix,soft);
 for(let k=0;k<soft.length;k++){const {g,c}=soft[k];let entry=0;for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++)expected[plans[k].entries[entry++]]+=g[a][1]*g[b][1]/c.alpha;}
 for(let i=0;i<length;i++)assert(Object.is(matrix[i],expected[i]),'Расходится реальная матрица '+i);matrices++;elements+=length;}};}}:assemblyKernel;
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const json=v=>JSON.parse(JSON.stringify(serial(v)));assert.deepEqual(json({positions:c.motion.pos,body:c.motion.body}),r.initial);
const rows=[],states=[];
for(const s of r.steps){const p0=process.cpuUsage(),t0=process.threadCpuUsage(),start=performance.now(),audit=c.step(s.controls),stepMs=performance.now()-start,thread=process.threadCpuUsage(t0),cpu=process.cpuUsage(p0);
 const state=json({index:s.index,controls:s.controls,positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit});assert.deepEqual(state,{index:s.index,controls:s.controls,positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});states.push(state);
 rows.push({index:s.index,stepMs,threadCpuMs:(thread.user+thread.system)/1000,processCpuMs:(cpu.user+cpu.system)/1000});}
const cpu=process.cpuUsage(cpuBefore);writeFileSync(out,JSON.stringify({version,runtime:process.version,v8:process.versions.v8,hardware:{cpu:cpus()[0]?.model,arch:process.arch,platform:process.platform},rows,states,matrices,elements,
 assembly:c.motion.compiledAssembly?.statistics?.(),cpu:{userMs:cpu.user/1000,systemMs:cpu.system/1000,wallMs:performance.now()-before}},null,2)+'\n',{flag:'wx'});`;
const result={schema:'cloth-fluid-assembly-benchmark-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,candidateSha256:hash(candidate),wasm:{path:wasm,sha256:hash(readFileSync(wasm))},inputs:fixtures,runs:[],checkedSteps:0,rule:'Native-материал обоих вариантов прежний. Сначала все обычные матрицы по Object.is, затем три чередующиеся пары каждого борта в новых процессах. Время/CPU шага исключают сверку; первый шаг/подготовка сохранены. Кандидат существует только в копиях, живой код не меняется.'};
process.once('uncaughtException',e=>{result.phase='failed';result.failure={message:e.message,stack:e.stack};writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.error('Опыт сборки остановлен: '+e.message);process.exitCode=1;});
function run(f,version,pair){const path=resolve(copies,`${f.side}-${pair}-${version}.json`);execFileSync(process.execPath,['--input-type=module','-e',runner,resolve(copies,'tests/lib/cloth-fluid-sail-motion.mjs'),f.path,resolve(wasm),version,path],{cwd:root,maxBuffer:1024*1024});const b=readFileSync(path),r=JSON.parse(b);assert.equal(r.rows.length,180);const {states,...summary}=r;result.runs.push({side:f.side,pair,path:relative(root,path),sha256:hash(b),...summary});
 console.log(`Сборка, ${f.side==='plus'?'первая':'другая'} сторона, ${version}, серия ${pair}: 180 точных шагов, первый ${r.rows[0].stepMs.toFixed(2)} мс, рабочее среднее ${(r.rows.slice(1).reduce((s,v)=>s+v.stepMs,0)/179).toFixed(2)} мс.`);return r;}
for(const f of fixtures){const r=run(f,'audit',0);assert(r.matrices>700&&r.elements>1e7);}
for(let pair=1;pair<=3;pair++)for(const f of fixtures){const versions={};for(const version of pair%2?['js','wasm']:['wasm','js'])versions[version]=run(f,version,pair);assert.deepEqual(versions.js.states,versions.wasm.states);result.checkedSteps+=180;}
result.phase='complete';writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(`Сборка: ${result.checkedSteps} шагов каждого варианта сохранили всю историю.`);
