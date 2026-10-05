// Подмены происхождения/выбора материала отвергаются до физического повтора.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),nativePath=args.find(v=>v.startsWith('--wasm-record='))?.slice(14),jsPath=args.find(v=>v.startsWith('--js-record='))?.slice(12),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(nativePath&&jsPath&&out&&args.length===3&&!existsSync(out)&&!existsSync(out+'.cases'));
const hash=b=>createHash('sha256').update(b).digest('hex'),native=JSON.parse(readFileSync(nativePath)),js=JSON.parse(readFileSync(jsPath)),directory=out+'.cases';
assert(native.fixture.materialWasm&&native.preparation.material.backend==='wasm');assert.equal(js.fixture.materialWasm,undefined);
mkdirSync(directory,{recursive:true});const report={schema:'cloth-fluid-material-report-check-v1',inputs:[nativePath,jsPath].map(path=>({path,sha256:hash(readFileSync(path))})),tool:{path:'scripts/cloth_fluid_live_report.mjs',sha256:hash(readFileSync('scripts/cloth_fluid_live_report.mjs'))},testSha256:hash(readFileSync(import.meta.filename)),cases:[]};
const cases=[
 ['sha',native,r=>r.fixture.materialWasm.sha256='0'.repeat(64),/Изменился WASM материала/],
 ['path',native,r=>delete r.fixture.materialWasm.path,/Некорректное происхождение материала/],
 ['null',native,r=>r.fixture.materialWasm=null,/Некорректное происхождение материала/],
 ['removed',native,r=>delete r.fixture.materialWasm,/Материал результата отличается от входа/],
 ['abi',native,r=>r.fixture.materialWasm=r.fixture.wasm,/Несовместимая версия/],
 ['backend',native,r=>r.preparation.material.backend='js',/'js'.*'wasm'/s],
 ['value-count',native,r=>r.preparation.material.validation.values++,/values/],
 ['matrix-count',native,r=>r.preparation.material.validation.hessianComponents--,/hessianComponents/],
 ['negative-time',native,r=>r.preparation.material.checkMs=-1,/checkMs/],
 ['string-time',native,r=>r.preparation.material.checkMs='0',/checkMs/],
 ['missing-check',native,r=>delete r.preparation.material,/backend/],
 ['js-marker',js,r=>r.preparation.material=native.preparation.material,/Материал результата отличается от входа/],
 ['js-module',js,r=>r.fixture.materialWasm=native.fixture.materialWasm,/backend/]
];
for(const [name,base,mutate,reason] of cases) {
 const r=structuredClone(base);mutate(r);const input=directory+'/'+name+'.json',output=directory+'/'+name+'-report.json';writeFileSync(input,JSON.stringify(r,null,2)+'\n',{flag:'wx'});
 const p=spawnSync(process.execPath,['scripts/cloth_fluid_live_report.mjs',input,output],{encoding:'utf8',maxBuffer:1024*1024});
 assert.equal(p.status,1,name);assert.match(p.stderr,reason,name);assert.equal(existsSync(output),false,name);
 report.cases.push({name,input,sha256:hash(readFileSync(input)),status:p.status,stderr:p.stderr});
}
const untouched=directory+'/existing.json';writeFileSync(untouched,'{"сохранено":true}\n',{flag:'wx'});const before=readFileSync(untouched),p=spawnSync(process.execPath,['scripts/cloth_fluid_live_report.mjs',nativePath,untouched],{encoding:'utf8'});
assert.equal(p.status,1);assert.deepEqual(readFileSync(untouched),before);report.cases.push({name:'existing-output',status:p.status,sha256:hash(before),stderr:p.stderr});
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Происхождение материала: ${report.cases.length} подмен/перезаписей отклонены; исходные записи сохранены.`);
