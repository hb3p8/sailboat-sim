// Подмена выбора/происхождения сборщика отвергается до повтора движения.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),nativePath=args.find(v=>v.startsWith('--wasm-record='))?.slice(14),jsPath=args.find(v=>v.startsWith('--js-record='))?.slice(12),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(nativePath&&jsPath&&out&&args.length===3&&!existsSync(out)&&!existsSync(out+'.cases'));
const hash=b=>createHash('sha256').update(b).digest('hex'),native=JSON.parse(readFileSync(nativePath)),js=JSON.parse(readFileSync(jsPath)),directory=out+'.cases';
assert(native.fixture.assemblyWasm&&native.preparation.assembly.backend==='wasm');assert.equal(js.fixture.assemblyWasm,undefined);
mkdirSync(directory,{recursive:true});const report={schema:'cloth-fluid-assembly-report-check-v1',inputs:[nativePath,jsPath].map(path=>({path,sha256:hash(readFileSync(path))})),tool:{path:'scripts/cloth_fluid_live_report.mjs',sha256:hash(readFileSync('scripts/cloth_fluid_live_report.mjs'))},testSha256:hash(readFileSync(import.meta.filename)),cases:[]};
const cases=[
  ['sha',native,r=>r.fixture.assemblyWasm.sha256='0'.repeat(64),/Изменился WASM сборки/],
  ['path',native,r=>delete r.fixture.assemblyWasm.path,/Некорректное происхождение сборки/],
  ['null',native,r=>r.fixture.assemblyWasm=null,/Некорректное происхождение сборки/],
  ['removed',native,r=>delete r.fixture.assemblyWasm,/Сборка результата отличается от входа/],
  ['module-abi',native,r=>r.fixture.assemblyWasm=r.fixture.materialWasm,/Несовместимая версия/],
  ['backend',native,r=>r.preparation.assembly.backend='js',/'js'.*'wasm'/s],
  ['abi',native,r=>r.preparation.assembly.validation.abi++,/abi/],
  ['matrix-count',native,r=>r.preparation.assembly.validation.matrices--,/matrices/],
  ['element-count',native,r=>r.preparation.assembly.validation.elements++,/elements/],
  ['negative-time',native,r=>r.preparation.assembly.checkMs=-1,/checkMs/],
  ['string-time',native,r=>r.preparation.assembly.checkMs='0',/checkMs/],
  ['missing-check',native,r=>delete r.preparation.assembly,/backend/],
  ['js-marker',js,r=>r.preparation.assembly=native.preparation.assembly,/Сборка результата отличается от входа/],
  ['js-module',js,r=>r.fixture.assemblyWasm=native.fixture.assemblyWasm,/backend/]
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
console.log(`Происхождение сборки: ${report.cases.length} подмен/перезаписей отклонены; исходные записи сохранены.`);
