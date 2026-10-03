// Чередующиеся полные прогоны материала против кода из Git.
// Изолированные копии импортов сохраняют исходники опыта без изменения checkout.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const args=process.argv.slice(2);
assert(args.length===2&&args.every(v=>/^--(baseline|out)=.+$/.test(v))&&new Set(args.map(v=>v.split('=')[0])).size===2,
  'Нужны --baseline=ревизия и --out=новая-запись.json');
const baseline=execFileSync('git',['rev-parse',args.find(v=>v.startsWith('--baseline=')).slice(11)],{encoding:'utf8'}).trim();
const output=resolve(args.find(v=>v.startsWith('--out=')).slice(6)),copies=output+'.sources';
assert(!existsSync(output)&&!existsSync(copies),'Запись и копии опыта нельзя перезаписывать');
const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
const sourceSha256={},baselineSha256={},changed=[];
function copyModule(path) {
  if(Object.hasOwn(sourceSha256,path))return;
  const current=readFileSync(resolve(root,path)),prior=execFileSync('git',['show',`${baseline}:${path}`],{maxBuffer:16*1024*1024});
  sourceSha256[path]=hash(current);baselineSha256[path]=hash(prior);
  if(sourceSha256[path]!==baselineSha256[path])changed.push(path);
  for(const [version,bytes] of [['candidate',current],['baseline',prior]]) {
    const target=resolve(copies,version,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});
  }
  const imports=bytes=>[...bytes.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map(x=>
    relative(root,resolve(root,dirname(path),x[1])));
  assert.deepEqual(imports(current),imports(prior),'Опыт сравнивает тот же граф импортов');
  imports(current).forEach(copyModule);
}
copyModule('scripts/cloth_fluid_sail_fixture.mjs');
assert.deepEqual(changed.sort(),['tests/lib/cloth-fluid-schur-direction.mjs','tests/lib/cloth-material.mjs'],
  'Сравнение ограничено интерфейсом материала и его использованием в корректоре');
const input='out/acceptance/rigid-sail-60321b9-plus-five.json',wasm='out/acceptance/cloth-sparse-20261002-simd.wasm';
const record={schema:'cloth-fluid-material-benchmark-v1',baselineRevision:baseline,
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  toolSha256:hash(readFileSync(fileURLToPath(import.meta.url))),sourceSha256,baselineSha256,
  input:{path:input,sha256:hash(readFileSync(input))},wasm:{path:wasm,sha256:hash(readFileSync(wasm))},
  rule:'Три пары отдельных процессов, порядок чередуется; первые 60 шагов +/11×9/60 Гц. Время Node, не браузера.',runs:[],checkedSteps:0};
for(let pair=0;pair<3;pair++) {
  const records={};
  for(const version of pair%2?['candidate','baseline']:['baseline','candidate']) {
    const result=resolve(copies,`${pair+1}-${version}.json`);
    execFileSync(process.execPath,[resolve(copies,version,'scripts/cloth_fluid_sail_fixture.mjs'),input,result,'60',
      '--hz=60','--linear-backend=schur-wasm',`--wasm=${wasm}`],{cwd:root,maxBuffer:1024*1024});
    const bytes=readFileSync(result),r=JSON.parse(bytes);records[version]=r;
    assert.equal(r.phase,'complete');assert.deepEqual(r.sourceSha256,version==='candidate'?sourceSha256:baselineSha256);
    const times=r.steps.slice(1).map(s=>s.stepMs),sorted=times.slice().sort((a,b)=>a-b);
    const row={pair:pair+1,version,path:relative(root,result),sha256:hash(bytes),runtime:r.runtime,hardware:r.hardware,
      firstMs:r.steps[0].stepMs,followingMeanMs:times.reduce((s,v)=>s+v,0)/times.length,
      followingP90Ms:sorted[Math.ceil(.9*sorted.length)-1],followingMaxMs:Math.max(...times),totalMs:r.totalMs};
    record.runs.push(row);console.log(`Пара ${pair+1}, ${version==='candidate'?'новый код':'код из Git'}: `+
      `первый ${row.firstMs.toFixed(2)} мс, следующие в среднем ${row.followingMeanMs.toFixed(2)} мс; запись ${row.path}`);
  }
  const physical=s=>({step:s.step,positionsM:s.positionsM,body:s.body,forceN:s.forceN,audit:s.audit});
  assert.deepEqual(records.candidate.steps.map(physical),records.baseline.steps.map(physical));record.checkedSteps+=60;
}
record.phase='complete';writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(`ок: ${record.checkedSteps} полных шагов точно против Git; запись ${output}`);
