// Два сохранённых графа для сравнения кода или подробного разбора направления.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {instrumentDirection,instrumentSparse} from '../tests/probes/cloth-direction-instrument.mjs';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),baseline=args.find(a=>a.startsWith('--baseline='))?.slice(11),
  wasm=args.find(a=>a.startsWith('--wasm='))?.slice(7),out=args.find(a=>a.startsWith('--out='))?.slice(6),profile=args.includes('--profile-direction');
assert(args.length===(profile?5:4)&&input&&baseline&&wasm&&out&&args.every(a=>/^--(input|baseline|wasm|out)=.+$/.test(a)||a==='--profile-direction'));
assert(!existsSync(out)&&!existsSync(out+'.sources'),'Нужен новый путь');
const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),capture=JSON.parse(bytes),
  revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),baseRevision=execFileSync('git',['rev-parse',baseline],{encoding:'utf8'}).trim();
assert.equal(capture.schema,'cloth-sparse-capture-v1');assert.equal(capture.phase,'complete');assert.equal(capture.dirty,false);
const manifest={schema:'cloth-fluid-browser-pair-fixture-v1',phase:'preparing',revision,dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  baselineRevision:baseRevision,profile,source:{path:input,sha256:hash(bytes)},inputs:capture.inputs,modules:{...capture.modules,linear:{path:relative(root,resolve(wasm)),sha256:hash(readFileSync(wasm))}},
  graphs:{},sourceSha256:{},changedSources:[],
  rule:'Один линейный/материальный/сборочный модуль в обоих вариантах. Два независимых графа и модели; полные пары/прежние истории. Подробные таймеры только в сохранённых копиях, отдельно от обычного замера.'};
for(const part of [...manifest.inputs,...Object.values(manifest.modules)])assert.equal(hash(readFileSync(part.path)),part.sha256);
function save(path,b){const p=resolve(out+'.sources',path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,b,{flag:'wx'});return hash(b);}
function tool(url){const p=relative(root,fileURLToPath(url));if(manifest.sourceSha256[p])return;const b=readFileSync(url);manifest.sourceSha256[p]=save(p,b);
  for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))tool(new URL(m[1],url));}
tool(new URL(import.meta.url));tool(new URL('../tests/probes/cloth-fluid-browser-pair-worker.mjs',import.meta.url));tool(new URL('../tests/probes/cloth-fluid-browser-pair-review.html',import.meta.url));
tool(new URL('./cloth_fluid_browser_pair_report.mjs',import.meta.url));
const entries=['tests/lib/cloth-fluid-sail-motion.mjs','tests/lib/cloth-sparse-wasm.mjs','tests/lib/cloth-worker-timing.mjs','tests/lib/cloth-fluid-timing.mjs',
  'tests/probes/cloth-material-wasm.mjs','tests/probes/cloth-material-engine-check.mjs','tests/probes/cloth-assembly-wasm.mjs','tests/probes/cloth-assembly-engine-check.mjs'];
for(const variant of ['baseline','candidate']){
  const graph={revision:variant==='baseline'?baseRevision:revision,originalSha256:{},sourceSha256:{},instrumented:[]};manifest.graphs[variant]=graph;
  function copy(path){if(graph.sourceSha256[path])return;const original=variant==='baseline'?execFileSync('git',['show',baseRevision+':'+path],{maxBuffer:16*1024*1024}):readFileSync(path);graph.originalSha256[path]=hash(original);
    let b=original;if(profile&&['tests/lib/cloth-fluid-schur-direction.mjs','tests/lib/cloth-sparse-wasm.mjs'].includes(path)){
      save(variant+'/'+path+'.original',original);b=Buffer.from(path.includes('schur')?instrumentDirection(original.toString()):instrumentSparse(original.toString()));graph.instrumented.push(path);}
    graph.sourceSha256[path]=save(variant+'/'+path,b);
    for(const m of original.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))copy(relative(root,resolve(root,dirname(path),m[1])));}
  entries.forEach(copy);
}
assert.deepEqual(Object.keys(manifest.graphs.baseline.originalSha256).sort(),Object.keys(manifest.graphs.candidate.originalSha256).sort());
for(const [p,h] of Object.entries(manifest.graphs.baseline.originalSha256))if(manifest.graphs.candidate.originalSha256[p]!==h)manifest.changedSources.push(p);
manifest.phase='complete';writeFileSync(out,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(`Браузерная пара подготовлена: ${profile?'подробные стадии':'обычные шаги'}, различий исходников ${manifest.changedSources.length}; физические входы прежние.`);
