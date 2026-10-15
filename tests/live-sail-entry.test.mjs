// Основной вход не требует флагов; исследовательские режимы и прежний Boat явные.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {liveSailEntry} from '../sim/live-entry.js';
import {publishLiveSailDefault} from '../scripts/live_sail_default.mjs';
const args=process.argv.slice(2),inputs=args.filter(x=>x.startsWith('--input=')).map(x=>x.slice(8)),out=args.find(x=>x.startsWith('--out='))?.slice(6);
assert(args.length===3&&inputs.length===2&&out&&!existsSync(out));
let routes=0,rejected=0;const hash=b=>createHash('sha256').update(b).digest('hex');
for(const search of ['', '?ui=game','?ui=debug','?noaa']){assert.deepEqual(liveSailEntry(search),{kind:'simulator',play:false,manifestPath:'data/simulator/v1/manifest.json'});routes++;}
assert.deepEqual(liveSailEntry('?sail-live=copy'),{kind:'explicit',play:true,prefix:'copy'});routes++;
assert.deepEqual(liveSailEntry('?bench=0&fluid-live=copy'),{kind:'review',play:false,prefix:'copy'});routes++;
for(const search of ['?bench=0','?bench=2','?cloth-review&series=copy','?legacy=1','?legacy=1&ui=game']){assert.equal(liveSailEntry(search),undefined);routes++;}
const directory=mkdtempSync(join(tmpdir(),'sv20-live-entry-'));
try {
 const path=join(directory,'default.json'),records=inputs.map(path=>({path})),original=inputs.map(path=>readFileSync(path));
 const first=publishLiveSailDefault(records,path),saved=readFileSync(path);
 assert.equal(first.schema,'sv20-live-entry-v1');assert.deepEqual(JSON.parse(saved),first);
 for(const input of inputs){const f=JSON.parse(readFileSync(input));assert.deepEqual(first.inputs[f.side],{path:input,sha256:hash(readFileSync(input))});}
 for(const [name,change] of [
  ['грязный',f=>f.dirty=true],['профиль',f=>f.profileWorker=true],['лаборатория',f=>f.liveWind.bodyProfile='laboratory-v1'],
  ['другая-сборка',f=>f.revision='other'],['другая-сцена',f=>f.scene.sha256='0'.repeat(64)],
  ['другой-пакет',f=>f.physicsSha256='0'.repeat(64)],['другие-исходники',f=>f.sourceSha256={}],
  ['без-верёвки',f=>delete f.sheet],['без-материала',f=>delete f.materialWasm],['без-сборки',f=>delete f.assemblyWasm],
  ['повтор-борта',f=>f.side=JSON.parse(original[0]).side]
 ]) {
  const mutated=JSON.parse(original[1]);change(mutated);const input=join(directory,name+'.json');writeFileSync(input,JSON.stringify(mutated));
  assert.throws(()=>publishLiveSailDefault([records[0],{path:input}],path));assert.deepEqual(readFileSync(path),saved);rejected++;
 }
 assert.throws(()=>publishLiveSailDefault(records.slice(0,1),path));rejected++;
 for(let i=0;i<inputs.length;i++)assert.deepEqual(readFileSync(inputs[i]),original[i]);
 assert.deepEqual(publishLiveSailDefault(records,path),first);assert.deepEqual(readFileSync(path),saved);
}finally{rmSync(directory,{recursive:true,force:true});}
writeFileSync(out,JSON.stringify({schema:'live-sail-entry-check-v1',phase:'complete',routes,rejected,
 inputs:inputs.map(path=>({path,sha256:hash(readFileSync(path))})),
 sources:Object.fromEntries(['sim/live-entry.js','scripts/live_sail_default.mjs'].map(path=>[path,hash(readFileSync(path))]))},null,2)+'\n',{flag:'wx'});
console.log(`Основной вход: ${routes} маршрутов, ${rejected} отказов, исходные постановки не изменены.`);
