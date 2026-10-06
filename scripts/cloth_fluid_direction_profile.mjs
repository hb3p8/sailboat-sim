// Границы обычного/точного направления измеряются только в сохранённой копии.
// Исходная модель и живой стенд не получают наблюдателя.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===2&&out&&args.length===3&&args.every(v=>/^--(input|out)=.+$/.test(v)));
const root=fileURLToPath(new URL('../',import.meta.url)),output=resolve(out),copies=output+'.sources',hash=b=>createHash('sha256').update(b).digest('hex');
assert(!existsSync(output)&&!existsSync(copies),'Нельзя перезаписывать запись/копии');const sourceSha256={};
function copy(path){if(sourceSha256[path])return;const b=readFileSync(resolve(root,path));sourceSha256[path]=hash(b);const target=resolve(copies,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,b,{flag:'wx'});
 for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))copy(relative(root,resolve(root,dirname(path),m[1])));}
for(const p of ['tests/lib/cloth-fluid-sail-motion.mjs','tests/lib/cloth-sparse-wasm.mjs','tests/probes/cloth-material-wasm.mjs','tests/probes/cloth-material-wasm.c','tests/probes/cloth-material-engine-check.mjs',relative(root,fileURLToPath(import.meta.url))])copy(p);
const direction='tests/lib/cloth-fluid-schur-direction.mjs',original=readFileSync(resolve(root,direction),'utf8');
let instrumented=original;
function insert(marker,text){assert.equal(instrumented.split(marker).length,2,'Граница направления должна быть единственной');instrumented=instrumented.replace(marker,text+marker);}
insert('  const nc=m.pos.length',`  const kind=exact?'correction':'ordinary';let mark=performance.now();
  const checkpoint=name=>{const now=performance.now(),row=directionPhases[kind][name];row.calls++;row.ms+=now-mark;mark=now;};
`);
insert('  for(let i=0;i<nc;i++)add(i,i',`  if(!directionWork[kind])directionWork[kind]={matrixEntries:matrix.length,softConstraints:soft.length,
    gradientValues:soft.reduce((sum,t)=>sum+t.g.length,0),pairAdds:soft.reduce((sum,t)=>sum+t.g.length*(t.g.length+1)/2,0)};
  checkpoint('prepare');
`);
insert('  const activeSet=new Set(active)',"  checkpoint('clothMatrix');\n");
insert('  // Шесть производных скоростей:',"  checkpoint('constraints');\n");
insert('  // Порядок координат задан',"  checkpoint('bodyCoupling');\n");
insert('  // Начальное +0 и последовательность',"  checkpoint('linear');\n");
insert('\n  return result;\n}',"\n  checkpoint('finish');");
instrumented=`const phaseNames=['prepare','clothMatrix','constraints','bodyCoupling','linear','finish'];
const directionPhases=Object.fromEntries(['ordinary','correction'].map(k=>[k,Object.fromEntries(phaseNames.map(p=>[p,{calls:0,ms:0}]))]));
const directionWork={};
export const directionProfile=()=>({work:structuredClone(directionWork),phases:structuredClone(directionPhases)});
`+instrumented;
// Сохраняются обе версии; изменение касается только копии, загружаемой опытом.
writeFileSync(resolve(copies,direction+'.original'),original,{flag:'wx'});writeFileSync(resolve(copies,direction),instrumented);
const fixtures=inputs.map(path=>{const b=readFileSync(path),r=JSON.parse(b),f=r.fixture;assert.equal(r.steps.length,180);assert.equal(r.shownStep,180);assert.equal(f.dirty,false);assert(f.materialWasm);
 for(const [p,h] of Object.entries(f.sourceSha256))assert.equal(hash(execFileSync('git',['show',f.revision+':'+p],{maxBuffer:16*1024*1024})),h);
 for(const part of [f.input,f.scene,f.wasm,f.materialWasm,f.sheetProof])assert.equal(hash(readFileSync(part.path)),part.sha256);
 assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);return{path:resolve(path),sha256:hash(b),side:f.side};});
assert.equal(new Set(fixtures.map(f=>f.side)).size,2);
const runner=String.raw`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {cpus} from 'node:os';
const [source,input,out]=process.argv.slice(1),record=JSON.parse(readFileSync(input)),f=record.fixture;
const {fluidSailMotion}=await import(pathToFileURL(source)),{loadSparseFactor}=await import(new URL('./cloth-sparse-wasm.mjs',pathToFileURL(source))),
{directionProfile}=await import(new URL('./cloth-fluid-schur-direction.mjs',pathToFileURL(source))),
{loadMaterialKernel}=await import(new URL('../probes/cloth-material-wasm.mjs',pathToFileURL(source))),
{verifyMaterialKernel}=await import(new URL('../probes/cloth-material-engine-check.mjs',pathToFileURL(source)));
const factor=await loadSparseFactor(readFileSync(f.wasm.path)),materialKernel=await loadMaterialKernel(readFileSync(f.materialWasm.path)),validation=verifyMaterialKernel(materialKernel,f.recipe);
assert.deepEqual(validation,record.preparation.material.validation);
const c=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel}),rows=[];
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const json=v=>JSON.parse(JSON.stringify(serial(v)));assert.deepEqual(json({positions:c.motion.pos,body:c.motion.body}),record.initial);
for(const s of record.steps){const before=directionProfile(),start=performance.now(),audit=c.step(s.controls),stepMs=performance.now()-start,after=directionProfile();
 assert.deepEqual(json({positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit}),{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});
 const phases=Object.fromEntries(Object.entries(after.phases).map(([kind,p])=>[kind,Object.fromEntries(Object.entries(p).map(([name,v])=>[name,{calls:v.calls-before.phases[kind][name].calls,ms:v.ms-before.phases[kind][name].ms}]))]));
 for(const p of Object.values(phases)){assert.equal(new Set(Object.values(p).map(v=>v.calls)).size,1);assert(Object.values(p).every(v=>Number.isFinite(v.ms)&&v.ms>=0));}
 assert(Object.values(phases).flatMap(Object.values).reduce((sum,v)=>sum+v.ms,0)<=stepMs+1e-6);
 rows.push({index:s.index,iterations:audit.solver.iterations,stepMs,phases});}
writeFileSync(out,JSON.stringify({runtime:process.version,v8:process.versions.v8,hardware:{cpu:cpus()[0]?.model,arch:process.arch,platform:process.platform},rows,work:directionProfile().work},null,2)+'\n',{flag:'wx'});`;
const result={schema:'cloth-fluid-direction-profile-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,
 instrumentedSha256:hash(instrumented),inputs:fixtures,runs:[],rule:'Границы направления, Node-копия: prepare — раскладки/план/буферы; clothMatrix — масса/материал; constraints — кромки/крепления; bodyCoupling — B/D/E; linear — перестановки/линейный модуль/копирование; finish — малое дополнение/ответ. Без пересечений внутри направления; часы влияют на исполнение. Это не CPU/FPS браузера.'};
process.once('uncaughtException',e=>{result.phase='failed';result.failure={message:e.message,stack:e.stack};writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.error('Профиль направления остановлен: '+e.message);process.exitCode=1;});
for(const f of fixtures){const path=resolve(copies,f.side+'-profile.json');execFileSync(process.execPath,['--input-type=module','-e',runner,resolve(copies,'tests/lib/cloth-fluid-sail-motion.mjs'),f.path,path],{cwd:root,maxBuffer:1024*1024});
 const b=readFileSync(path),r=JSON.parse(b);assert.equal(r.rows.length,180);result.runs.push({side:f.side,path:relative(root,path),sha256:hash(b),...r});console.log(`Направление, ${f.side==='plus'?'первая':'другая'} сторона: 180 точных шагов, все границы сохранены.`);}
result.phase='complete';writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
