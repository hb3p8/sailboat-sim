// Небольшой проверяемый вход живого лабораторного режима. Старые серии неизменны.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8));
const prefix=args.find(v=>v.startsWith('--out-prefix='))?.slice(13),wasm=args.find(v=>v.startsWith('--wasm='))?.slice(7);
assert(inputs.length===2&&prefix&&wasm&&args.length===4,'Нужны две --input, --out-prefix и --wasm');
const hash=b=>createHash('sha256').update(b).digest('hex');
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const dirty=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());
const root=fileURLToPath(new URL('../',import.meta.url)),sourceSha256={};
function addSource(url) {
  const p=relative(root,fileURLToPath(url));if(Object.hasOwn(sourceSha256,p))return;
  const bytes=readFileSync(url);sourceSha256[p]=hash(bytes);
  for(const x of bytes.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))addSource(new URL(x[1],url));
}
for(const p of ['../tests/lib/cloth-fluid-worker.mjs','../tests/lib/cloth-fluid-client.mjs','./cloth_fluid_live_scene.mjs'])addSource(new URL(p,import.meta.url));
const scene=readFileSync('sim/index.html'),physics=readFileSync('out/export/physics.json');
const records=inputs.map(path=>{
  const bytes=readFileSync(path),s=JSON.parse(bytes),side=s.config.tack===1?'plus':'minus';
  assert.equal(s.phase,'complete');assert.equal(s.dirty,false);
  for(const [p,sha] of Object.entries(s.sourceSha256))assert.equal(hash(execFileSync('git',['show',`${s.revision}:${p}`],{maxBuffer:16*1024*1024})),sha);
  assert.equal(s.physicsSha256,hash(physics));
  return {path:`${prefix}-${side}.json`,value:{schema:'cloth-fluid-live-v1',revision,dirty,sourceSha256,
    input:{path,sha256:hash(bytes),revision:s.revision},physicsSha256:s.physicsSha256,
    wasm:{path:wasm,sha256:hash(readFileSync(wasm))},scene:{path:`${prefix}-scene.html`,sha256:hash(scene)},
    recipe:s.recipe,bodyInput:s.config.bodyInput,side}};
});
assert.equal(new Set(records.map(r=>r.path)).size,2);
for(const r of records)assert(!existsSync(r.path),'Сохранённый вход нельзя перезаписывать');
assert(!existsSync(`${prefix}-scene.html`),'Снимок сцены нельзя перезаписывать');
writeFileSync(`${prefix}-scene.html`,scene,{flag:'wx'});
for(const r of records){writeFileSync(r.path,JSON.stringify(r.value,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({вход:r.path,ревизия:revision,изменено:dirty}));}
