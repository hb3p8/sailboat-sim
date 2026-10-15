// Границы обычного/точного направления измеряются только в сохранённой копии.
// Исходная модель и живой стенд не получают наблюдателя.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {instrumentDirection,instrumentSparse} from '../tests/probes/cloth-direction-instrument.mjs';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&out&&args.length===3&&args.every(v=>/^--(input|out)=.+$/.test(v)));
const root=fileURLToPath(new URL('../',import.meta.url)),output=resolve(out),copies=output+'.sources',hash=b=>createHash('sha256').update(b).digest('hex');
assert(!existsSync(output)&&!existsSync(copies),'Нельзя перезаписывать запись/копии');const sourceSha256={};
function copy(path){if(sourceSha256[path])return;const b=readFileSync(resolve(root,path));sourceSha256[path]=hash(b);const target=resolve(copies,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,b,{flag:'wx'});
 for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))copy(relative(root,resolve(root,dirname(path),m[1])));}
const live=inputs.some(p=>JSON.parse(readFileSync(p)).fixture.liveWind);
for(const p of ['tests/lib/cloth-fluid-sail-motion.mjs',...(live?['tests/lib/cloth-live-wind-sail-motion.mjs']:[]),'sim/cloth/cloth-sparse-wasm.mjs','sim/cloth/cloth-material-wasm.mjs','tests/probes/cloth-material-wasm.c','sim/cloth/cloth-material-engine-check.mjs','tests/probes/cloth-assembly-wasm.mjs','tests/probes/cloth-assembly-wasm.c','tests/probes/cloth-assembly-engine-check.mjs',relative(root,fileURLToPath(import.meta.url))])copy(p);
const direction='tests/lib/cloth-fluid-schur-direction.mjs',original=readFileSync(resolve(root,direction),'utf8');
const instrumented=instrumentDirection(original);
writeFileSync(resolve(copies,direction+'.original'),original,{flag:'wx'});writeFileSync(resolve(copies,direction),instrumented);
const linearPath='sim/cloth/cloth-sparse-wasm.mjs',linearOriginal=readFileSync(resolve(root,linearPath),'utf8'),linearInstrumented=instrumentSparse(linearOriginal);
writeFileSync(resolve(copies,linearPath+'.original'),linearOriginal,{flag:'wx'});writeFileSync(resolve(copies,linearPath),linearInstrumented);
const fixtures=inputs.map(path=>{const b=readFileSync(path),r=JSON.parse(b),f=r.fixture;assert.equal(r.steps.length,180);assert.equal(r.shownStep,180);assert.equal(f.dirty,false);assert(f.materialWasm);
 for(const [p,h] of Object.entries(f.sourceSha256))assert.equal(hash(execFileSync('git',['show',f.revision+':'+p],{maxBuffer:16*1024*1024})),h);
 for(const part of [f.input,f.scene,f.wasm,f.materialWasm,f.sheetProof,...(f.assemblyWasm?[f.assemblyWasm]:[])])assert.equal(hash(readFileSync(part.path)),part.sha256);
 assert.equal(Boolean(f.liveWind),live);if(live)assert.equal(f.liveWind.bodyProfile,'sv20-rig-budget-point-v1');
 assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);return{path:resolve(path),sha256:hash(b),side:f.side};});
assert.equal(new Set(fixtures.map(f=>f.side)).size,2);
const runner=String.raw`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {cpus} from 'node:os';
const [source,input,out]=process.argv.slice(1),record=JSON.parse(readFileSync(input)),f=record.fixture;
const {fluidSailMotion}=await import(pathToFileURL(source)),{loadSparseFactor,sparseProfile}=await import(new URL('../../sim/cloth/cloth-sparse-wasm.mjs',pathToFileURL(source))),
{directionProfile}=await import(new URL('./cloth-fluid-schur-direction.mjs',pathToFileURL(source))),
{loadMaterialKernel}=await import(new URL('../../sim/cloth/cloth-material-wasm.mjs',pathToFileURL(source))),
{verifyMaterialKernel}=await import(new URL('../../sim/cloth/cloth-material-engine-check.mjs',pathToFileURL(source))),
{loadAssemblyKernel}=await import(new URL('../probes/cloth-assembly-wasm.mjs',pathToFileURL(source))),
{verifyAssemblyKernel}=await import(new URL('../probes/cloth-assembly-engine-check.mjs',pathToFileURL(source)));
const factor=await loadSparseFactor(readFileSync(f.wasm.path)),materialKernel=await loadMaterialKernel(readFileSync(f.materialWasm.path)),validation=verifyMaterialKernel(materialKernel,f.recipe);
assert.deepEqual(validation,record.preparation.material.validation);
const assemblyKernel=f.assemblyWasm?await loadAssemblyKernel(readFileSync(f.assemblyWasm.path)):undefined;
if(assemblyKernel)assert.deepEqual(verifyAssemblyKernel(assemblyKernel,f.recipe),record.preparation.assembly.validation);
else assert.equal(record.preparation.assembly,undefined);
const c=f.liveWind?(await import(new URL('./cloth-live-wind-sail-motion.mjs',pathToFileURL(source)))).liveWindSailMotion(f.recipe,f.bodyInput,factor,
  {pack:JSON.parse(readFileSync('out/export/physics.json')),wind:f.liveWind.wind,bodyProfile:f.liveWind.bodyProfile,sheet:f.sheet,materialKernel,assemblyKernel}):
  fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel,assemblyKernel}),rows=[];
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const json=v=>JSON.parse(JSON.stringify(serial(v)));assert.deepEqual(json({positions:c.motion.pos,body:c.motion.body}),record.initial);
for(const s of record.steps){const before=directionProfile(),linearBefore=sparseProfile(),start=performance.now();let audit;
 if(f.liveWind){const load=c.prepareLoad(s.controls);c.forceN.set(s.forceN);load.forceN=s.audit.water.totalForceN.slice();load.momentNm=s.audit.water.totalMomentNm.slice();audit=c.solve();}
 else audit=c.step(s.controls);
 const stepMs=performance.now()-start,after=directionProfile(),linearAfter=sparseProfile();
 const actual=json({positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit}),expected=structuredClone({positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});
 if(f.liveWind)for(const x of [actual,expected]){delete x.audit.air;delete x.audit.water;}
 assert.deepEqual(actual,expected);
 const phases=Object.fromEntries(Object.entries(after.phases).map(([kind,p])=>[kind,Object.fromEntries(Object.entries(p).map(([name,v])=>[name,{calls:v.calls-before.phases[kind][name].calls,ms:v.ms-before.phases[kind][name].ms}]))]));
 for(const p of Object.values(phases)){assert.equal(new Set(Object.values(p).map(v=>v.calls)).size,1);assert(Object.values(p).every(v=>Number.isFinite(v.ms)&&v.ms>=0));}
 assert(Object.values(phases).flatMap(Object.values).reduce((sum,v)=>sum+v.ms,0)<=stepMs+1e-6);
 const linear=Object.fromEntries(Object.entries(linearAfter).map(([k,v])=>[k,{calls:v.calls-linearBefore[k].calls,ms:v.ms-linearBefore[k].ms}]));
 assert(Object.values(linear).every(v=>Number.isFinite(v.ms)&&v.ms>=0));
 assert(Object.values(linear).reduce((sum,v)=>sum+v.ms,0)<=Object.values(phases).reduce((sum,p)=>sum+p.linear.ms,0)+1e-6);
 rows.push({index:s.index,iterations:audit.solver.iterations,stepMs,phases,linear});}
writeFileSync(out,JSON.stringify({runtime:process.version,v8:process.versions.v8,hardware:{cpu:cpus()[0]?.model,arch:process.arch,platform:process.platform},rows,work:directionProfile().work,assembly:assemblyKernel?{module:f.assemblyWasm,statistics:c.motion.compiledAssembly.statistics()}:null},null,2)+'\n',{flag:'wx'});`;
const result={schema:'cloth-fluid-direction-profile-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,
 instrumentedSha256:hash(instrumented),linearInstrumentedSha256:hash(linearInstrumented),inputs:fixtures,runs:[],...(live?{loadMode:'recorded-sv20-air-water-v1'}:{}),rule:'Материал/сборка выбираются из сохранённого входа. SV20 повторяет механику на записанных силах воздуха/воды; подготовка нагрузки выполняется, но полный воздух/вода между средами не принимаются. Границы направления, Node-копия: prepare — раскладки/план/буферы; clothMatrix — масса/материал; constraints — кромки/крепления; bodyCoupling — B/D/E; linear — перестановки/линейный модуль/копирование; finish — малое дополнение/ответ. linear содержит отдельные неперекрывающиеся интервалы подготовки/передачи/разложения/семи ответов оболочки; их нельзя прибавлять к linear ещё раз. Часы влияют на исполнение; это не CPU/FPS браузера.'};
process.once('uncaughtException',e=>{result.phase='failed';result.failure={message:e.message,stack:e.stack};writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.error('Профиль направления остановлен: '+e.message);process.exitCode=1;});
for(const f of fixtures){const path=resolve(copies,f.side+'-profile.json');execFileSync(process.execPath,['--input-type=module','-e',runner,resolve(copies,'tests/lib/cloth-fluid-sail-motion.mjs'),f.path,path],{cwd:root,maxBuffer:1024*1024});
 const b=readFileSync(path),r=JSON.parse(b);assert.equal(r.rows.length,180);result.runs.push({side:f.side,path:relative(root,path),sha256:hash(b),...r});console.log(`Направление, ${f.side==='plus'?'первая':'другая'} сторона: 180 точных шагов, все границы сохранены.`);}
result.phase='complete';writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
