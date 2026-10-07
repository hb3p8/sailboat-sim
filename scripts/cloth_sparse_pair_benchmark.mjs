// Полные независимые модели в одном процессе; порядок чередуется на каждом шаге.
// Сохраняет отдельные времена/CPU обоих вариантов, не заменяет первую серию.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===2&&input&&out&&args.every(a=>/^--(input|out)=.+$/.test(a))&&!existsSync(out)&&!existsSync(out+'.sources'));
const bytes=readFileSync(input),source=JSON.parse(bytes),hash=b=>createHash('sha256').update(b).digest('hex'),root=fileURLToPath(new URL('../',import.meta.url));
assert.equal(source.phase,'complete');assert(source.checkedSteps===1080&&source.inputs.length===2);
for(const [variant,mapping] of [['baseline',source.baselineSha256],['candidate',source.sourceSha256]])for(const [path,h] of Object.entries(mapping))
  assert.equal(hash(readFileSync(resolve(input+'.sources',variant,path))),h);
for(const f of source.inputs){assert.equal(hash(readFileSync(f.path)),f.sha256);const r=JSON.parse(readFileSync(f.path));
  for(const part of [r.fixture.wasm,r.fixture.materialWasm,r.fixture.assemblyWasm])assert.equal(hash(readFileSync(part.path)),part.sha256);}
if(source.linearCandidate)assert.equal(hash(readFileSync(source.linearCandidate.path)),source.linearCandidate.sha256);
mkdirSync(out+'.sources',{recursive:true});writeFileSync(out+'.sources/pair-tool.mjs',readFileSync(fileURLToPath(import.meta.url)),{flag:'wx'});
const runner=String.raw`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {cpus} from 'node:os';
const [sources,input,candidate,pairArg,out]=process.argv.slice(1),pair=Number(pairArg),record=JSON.parse(readFileSync(input)),f=record.fixture;
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const contexts={},times={baseline:[],candidate:[]},states={baseline:[],candidate:[]},preparation={};
for(const variant of pair%2?['baseline','candidate']:['candidate','baseline']){
  const url=pathToFileURL(sources+'/'+variant+'/tests/lib/cloth-fluid-sail-motion.mjs'),start=performance.now(),
    {fluidSailMotion}=await import(url),{loadSparseFactor}=await import(new URL('./cloth-sparse-wasm.mjs',url)),
    {loadMaterialKernel}=await import(new URL('../probes/cloth-material-wasm.mjs',url)),{verifyMaterialKernel}=await import(new URL('../probes/cloth-material-engine-check.mjs',url)),
    {loadAssemblyKernel}=await import(new URL('../probes/cloth-assembly-wasm.mjs',url)),{verifyAssemblyKernel}=await import(new URL('../probes/cloth-assembly-engine-check.mjs',url));
  const factor=await loadSparseFactor(readFileSync(variant==='candidate'&&candidate!=='-'?candidate:f.wasm.path)),
    materialKernel=await loadMaterialKernel(readFileSync(f.materialWasm.path)),assemblyKernel=await loadAssemblyKernel(readFileSync(f.assemblyWasm.path));
  assert.deepEqual(verifyMaterialKernel(materialKernel,f.recipe),record.preparation.material.validation);
  assert.deepEqual(verifyAssemblyKernel(assemblyKernel,f.recipe),record.preparation.assembly.validation);
  contexts[variant]=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel,assemblyKernel});preparation[variant]=performance.now()-start;
  assert.deepEqual(JSON.parse(JSON.stringify(serial({positions:contexts[variant].motion.pos,body:contexts[variant].motion.body}))),record.initial);
}
assert.deepEqual(serial(contexts.baseline.motion.pos),serial(contexts.candidate.motion.pos));
for(const s of record.steps){const pairStates={};
  for(const variant of (s.index+pair)%2?['candidate','baseline']:['baseline','candidate']) {
    const c=contexts[variant],p0=process.cpuUsage(),t0=process.threadCpuUsage(),start=performance.now(),audit=c.step(s.controls),stepMs=performance.now()-start,
      thread=process.threadCpuUsage(t0),cpu=process.cpuUsage(p0);
    times[variant].push({index:s.index,stepMs,threadCpuMs:(thread.user+thread.system)/1000,processCpuMs:(cpu.user+cpu.system)/1000});
    const state=serial({positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit});pairStates[variant]=state;states[variant].push(state);
    assert.deepEqual(JSON.parse(JSON.stringify(state)),{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});
  }
  assert.deepEqual(pairStates.candidate,pairStates.baseline,'Полная строгая пара одного шага, включая знак нуля');
}
writeFileSync(out,JSON.stringify({pair,runtime:process.version,v8:process.versions.v8,hardware:{cpu:cpus()[0]?.model,arch:process.arch,platform:process.platform},preparation,times,states},null,2)+'\n',{flag:'wx'});`;
const result={schema:'cloth-sparse-pair-benchmark-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),source:{path:input,sha256:hash(bytes)},
  toolSha256:hash(readFileSync(fileURLToPath(import.meta.url))),runs:[],exactPairs:0,
  rule:'Три пары каждого борта в новых процессах. Внутри процесса два независимых графа/модели/памяти; порядок каждой пары шагов чередуется, первого шага прежний→новый в 1/3 и обратно в 2. CPU потока/процесса и время каждого шага исключают сверку/сериализацию; подготовка и первые шаги сохранены. Общего CPU окна на вариант здесь нет: он общий для процесса. Это Node, не браузер/60 Гц.'};
process.once('uncaughtException',e=>{result.phase='failed';result.failure={message:e.message,stack:e.stack};writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.error('Чередование шагов остановлено: '+e.message);process.exitCode=1;});
for(let pair=1;pair<=3;pair++)for(const f of source.inputs){const path=resolve(out+'.sources',`${f.side}-${pair}.json`);
  execFileSync(process.execPath,['--input-type=module','-e',runner,resolve(input+'.sources'),f.path,source.linearCandidate?resolve(source.linearCandidate.path):'-',String(pair),path],{cwd:root,maxBuffer:1024*1024});
  const b=readFileSync(path),r=JSON.parse(b);assert.equal(r.states.baseline.length,180);assert.deepEqual(r.states.candidate,r.states.baseline);
  for(const variant of ['baseline','candidate'])assert(r.times[variant].length===180&&r.times[variant].every(x=>Object.values(x).every(v=>Number.isFinite(v)&&v>=0)));
  const {states,...summary}=r;result.runs.push({side:f.side,path:relative(root,path),sha256:hash(b),...summary});result.exactPairs+=180;
  const means=Object.fromEntries(['baseline','candidate'].map(v=>[v,r.times[v].slice(1).reduce((s,x)=>s+x.threadCpuMs,0)/179]));
  console.log(`Чередование ${pair}/${f.side==='plus'?'первая':'другая'}: 180 строгих пар; CPU шага ${means.baseline.toFixed(3)} → ${means.candidate.toFixed(3)} мс.`);
}
result.phase='complete';writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
