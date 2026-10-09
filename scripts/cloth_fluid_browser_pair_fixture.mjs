// Два сохранённых графа для сравнения кода или подробного разбора направления.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {instrumentDirection,instrumentSparse,instrumentMaterialHessian,instrumentReadSoft,instrumentMaterialValues} from '../tests/probes/cloth-direction-instrument.mjs';
const args=process.argv.slice(2),inputs=args.filter(a=>a.startsWith('--input=')).map(a=>a.slice(8)),input=inputs[0],baseline=args.find(a=>a.startsWith('--baseline='))?.slice(11),
  wasm=args.find(a=>a.startsWith('--wasm='))?.slice(7),out=args.find(a=>a.startsWith('--out='))?.slice(6),correctionProfile=args.includes('--profile-correction'),materialProfile=args.includes('--profile-material'),profile=args.includes('--profile-direction')||correctionProfile||materialProfile;
assert(args.filter(a=>['--profile-direction','--profile-correction','--profile-material'].includes(a)).length<=1&&[1,2].includes(inputs.length)&&args.length===inputs.length+3+Number(profile)&&input&&baseline&&wasm&&out&&args.every(a=>/^--(input|baseline|wasm|out)=.+$/.test(a)||['--profile-direction','--profile-correction','--profile-material'].includes(a)));
assert(!existsSync(out)&&!existsSync(out+'.sources'),'Нужен новый путь');
const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),source=JSON.parse(bytes),
  revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),baseRevision=execFileSync('git',['rev-parse',baseline],{encoding:'utf8'}).trim();
const live=source.schema==='cloth-fluid-live-result-v1';let capture=source;
if(live) {
 assert.equal(inputs.length,2);const parts=[],modules={};
 for(const path of inputs) {
  const b=readFileSync(path),r=JSON.parse(b),f=r.fixture;
  assert.equal(r.schema,'cloth-fluid-live-result-v1');assert.equal(f.dirty,false);assert.equal(f.liveWind?.bodyProfile,'sv20-rig-budget-point-v1');
  assert.equal(r.steps.length,180);assert.equal(r.shownStep,180);
  for(const [p,h] of Object.entries(f.sourceSha256))assert.equal(hash(execFileSync('git',['show',f.revision+':'+p],{maxBuffer:16*1024*1024})),h);
  for(const part of [f.input,f.scene,f.wasm,f.materialWasm,f.assemblyWasm,f.sheetProof])assert.equal(hash(readFileSync(part.path)),part.sha256);
  assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);
  for(const [name,part] of [['linear',f.wasm],['material',f.materialWasm],['assembly',f.assemblyWasm]]) {
   if(modules[name])assert.deepEqual(modules[name],part);else modules[name]=part;
  }
  parts.push({path,sha256:hash(b),side:f.side});
 }
 assert.equal(new Set(parts.map(p=>p.side)).size,2);
 capture={inputs:parts,modules};
} else {assert.equal(inputs.length,1);assert.equal(capture.schema,'cloth-sparse-capture-v1');assert.equal(capture.phase,'complete');assert.equal(capture.dirty,false);}
const manifest={schema:'cloth-fluid-browser-pair-fixture-v1',phase:'preparing',revision,dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  baselineRevision:baseRevision,profile,correctionProfile,materialProfile,source:{path:input,sha256:hash(bytes)},inputs:capture.inputs,modules:{...capture.modules,linear:{path:relative(root,resolve(wasm)),sha256:hash(readFileSync(wasm))}},
  graphs:{},sourceSha256:{},changedSources:[],
  rule:'Один линейный/материальный/сборочный модуль в обоих вариантах. Два независимых графа и модели; полные пары/прежние истории. Подробные таймеры только в сохранённых копиях, отдельно от обычного замера.'};
if(live)manifest.liveWind={mode:'recorded-sv20-air-water-v1',physics:{path:'out/export/physics.json',sha256:hash(readFileSync('out/export/physics.json'))},
 scope:'Механика на записанных силах воздуха/воды. Подготовка воздуха/воды выполняется; их межсредовые числа с прежней записью не принимаются. Это не свободный живой бюджет сцены.'};
for(const part of [...manifest.inputs,...Object.values(manifest.modules)])assert.equal(hash(readFileSync(part.path)),part.sha256);
function save(path,b){const p=resolve(out+'.sources',path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,b,{flag:'wx'});return hash(b);}
function tool(url){const p=relative(root,fileURLToPath(url));if(manifest.sourceSha256[p])return;const b=readFileSync(url);manifest.sourceSha256[p]=save(p,b);
  for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))tool(new URL(m[1],url));}
tool(new URL(import.meta.url));tool(new URL('../tests/probes/cloth-fluid-browser-pair-worker.mjs',import.meta.url));tool(new URL('../tests/probes/cloth-fluid-browser-pair-review.html',import.meta.url));
tool(new URL('./cloth_fluid_browser_pair_report.mjs',import.meta.url));
const entries=['tests/lib/cloth-fluid-sail-motion.mjs',...(live?['tests/lib/cloth-live-wind-sail-motion.mjs']:[]),'tests/lib/cloth-sparse-wasm.mjs','tests/lib/cloth-worker-timing.mjs','tests/lib/cloth-fluid-timing.mjs',
  'tests/probes/cloth-material-wasm.mjs','tests/probes/cloth-material-engine-check.mjs','tests/probes/cloth-assembly-wasm.mjs','tests/probes/cloth-assembly-engine-check.mjs'];
for(const variant of ['baseline','candidate']){
  const graph={revision:variant==='baseline'?baseRevision:revision,originalSha256:{},sourceSha256:{},instrumented:[]};manifest.graphs[variant]=graph;
  function copy(path){if(graph.sourceSha256[path])return;const original=variant==='baseline'?execFileSync('git',['show',baseRevision+':'+path],{maxBuffer:16*1024*1024}):readFileSync(path);graph.originalSha256[path]=hash(original);
    let b=original;if(profile&&(['tests/lib/cloth-fluid-schur-direction.mjs','tests/lib/cloth-sparse-wasm.mjs'].includes(path)||(correctionProfile||materialProfile)&&path==='tests/probes/cloth-material-wasm.mjs'||materialProfile&&path==='tests/lib/cloth-fluid-body-motion.mjs')){
      save(variant+'/'+path+'.original',original);b=Buffer.from(path.includes('schur')?instrumentDirection(original.toString(),{correction:correctionProfile}):path.includes('body-motion')?instrumentReadSoft(original.toString()):path.includes('material')?(materialProfile?instrumentMaterialValues(original.toString()):instrumentMaterialHessian(original.toString())):instrumentSparse(original.toString()));graph.instrumented.push(path);}
    graph.sourceSha256[path]=save(variant+'/'+path,b);
    for(const m of original.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))copy(relative(root,resolve(root,dirname(path),m[1])));}
  entries.forEach(copy);
}
assert.deepEqual(Object.keys(manifest.graphs.baseline.originalSha256).sort(),Object.keys(manifest.graphs.candidate.originalSha256).sort());
for(const [p,h] of Object.entries(manifest.graphs.baseline.originalSha256))if(manifest.graphs.candidate.originalSha256[p]!==h)manifest.changedSources.push(p);
manifest.phase='complete';writeFileSync(out,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(`Браузерная пара подготовлена: ${profile?'подробные стадии':'обычные шаги'}, различий исходников ${manifest.changedSources.length}; физические входы прежние.`);
