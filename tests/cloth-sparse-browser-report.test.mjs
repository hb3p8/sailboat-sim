// Отказы независимой проверки на намеренно повреждённых доказательствах.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),inputs=args.filter(a=>a.startsWith('--input=')).map(a=>a.slice(8)),capture=args.find(a=>a.startsWith('--capture='))?.slice(10),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===5&&inputs.length===3&&capture&&out&&!existsSync(out)&&!existsSync(out+'.cases'));
const hash=b=>createHash('sha256').update(b).digest('hex'),tool='scripts/cloth_sparse_browser_report.mjs',cases=out+'.cases';mkdirSync(cases);
const records=inputs.map(p=>JSON.parse(readFileSync(p)));assert.deepEqual(records.map(r=>r.mode).sort(),['native','plain','profile']);
const report={schema:'cloth-sparse-browser-report-negatives-v1',toolSha256:hash(readFileSync(tool)),testSha256:hash(readFileSync(fileURLToPath(import.meta.url))),
  inputs:inputs.map(path=>({path,sha256:hash(readFileSync(path))})),capture:{path:capture,sha256:hash(readFileSync(capture))},accepted:[],rejected:[]};
for(let k=0;k<inputs.length;k++){
  const path=cases+`/accepted-${records[k].mode}.json`;execFileSync(process.execPath,[tool,'--input='+inputs[k],'--capture='+capture,'--out='+path],{stdio:'pipe'});report.accepted.push({path,sha256:hash(readFileSync(path))});
}
const native=records.find(r=>r.mode==='native'),plain=records.find(r=>r.mode==='plain'),profile=records.find(r=>r.mode==='profile');
const mutants=[
  ['sha-входа',plain,r=>{r.input.sha256='0'.repeat(64);}],
  ['sha-модуля',plain,r=>{r.modules.candidate.sha256='0'.repeat(64);}],
  ['видимость',plain,r=>{r.page.visibility.push({at:1,state:'hidden'});}],
  ['sha-страницы',plain,r=>{r.page.sha256='0'.repeat(64);}],
  ['порядок',plain,r=>{r.records[0].order.reverse();}],
  ['прежняя-физика',plain,r=>{r.records[0].states.baseline.positions[0]+=.1;r.records[0].states.candidate.positions[0]+=.1;}],
  ['парная-физика',plain,r=>{r.records[0].states.candidate.positions[0]+=.1;}],
  ['число-пар',plain,r=>{r.exactPairs--;}],
  ['число-разложений',profile,r=>{r.records[0].times.baseline.profile.linear.factorCalls++;}],
  ['вложенные-часы',profile,r=>{r.records[0].times.baseline.profile.stages.direction.selfMs=1e9;}],
  ['рост-памяти',native,r=>{r.preparation.candidate.patterns[0].grownPages++;}],
  ['пропуск-матрицы',native,r=>{r.records.pop();}],
  ['число-элементов',native,r=>{r.factorElements--; }],
];
for(const [name,original,mutate] of mutants){const r=structuredClone(original);mutate(r);const input=cases+'/'+name+'.json',output=cases+'/'+name+'-report.json';writeFileSync(input,JSON.stringify(r)+'\n',{flag:'wx'});
  let error;try{execFileSync(process.execPath,[tool,'--input='+input,'--capture='+capture,'--out='+output],{stdio:'pipe'});}catch(e){error=e;}
  assert(error?.status===1&&String(error.stderr).includes('AssertionError'),name+' должен быть отвергнут самой проверкой');assert(!existsSync(output));
  report.rejected.push({name,input,sha256:hash(readFileSync(input)),message:String(error.stderr)});
}
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
writeFileSync(cases+'/report-tool.mjs',readFileSync(tool),{flag:'wx'});writeFileSync(cases+'/test-tool.mjs',readFileSync(fileURLToPath(import.meta.url)),{flag:'wx'});
console.log(`Доказательства браузерного опыта: 3 правильных результата приняты, ${report.rejected.length} подмен отвергнуты.`);
