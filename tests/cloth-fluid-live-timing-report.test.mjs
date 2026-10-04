// Подмены диагностических чисел должны отклоняться, даже если физика прежняя.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===2&&input&&out&&!existsSync(out)&&!existsSync(out+'.cases'));
const bytes=readFileSync(input),original=JSON.parse(bytes);assert.equal(original.fixture.profileWorker,true);assert(original.steps.length>0);
const cases=[
  ['пропущено наблюдение',r=>{delete r.steps[0].timing;}],
  ['неверный режим',r=>{r.fixture.profileWorker=false;}],
  ['отрицательное время',r=>{r.steps[0].timing.loadMs=-1;}],
  ['двойной учёт стадий',r=>{r.steps[0].timing.stages.direction.selfMs+=1e6;}],
  ['неверное число разложений',r=>{r.steps[0].timing.linear.factorCalls++;}]
];
mkdirSync(out+'.cases');const results=[];
for(let i=0;i<cases.length;i++) {
  const [name,change]=cases[i],r=structuredClone(original);change(r);
  const path=`${out}.cases/${i}-input.json`,reportPath=`${out}.cases/${i}-report.json`;
  writeFileSync(path,JSON.stringify(r)+'\n',{flag:'wx'});
  let failure;
  try{execFileSync(process.execPath,['scripts/cloth_fluid_live_report.mjs',path,reportPath],{stdio:['ignore','pipe','pipe']});}
  catch(e){failure={status:e.status,stderr:e.stderr.toString()};}
  assert(failure?.status!==0&&failure?.status!=null&&!existsSync(reportPath),name);
  results.push({name,path,...failure});
}
const hash=b=>createHash('sha256').update(b).digest('hex');
writeFileSync(out,JSON.stringify({schema:'cloth-fluid-live-timing-negative-v1',input,sha256:hash(bytes),
  toolSha256:hash(readFileSync('scripts/cloth_fluid_live_report.mjs')),rejected:results.length,results,phase:'complete'},null,2)+'\n',{flag:'wx'});
console.log(`Подмены наблюдения живого шага: ${results.length} отклонены без успешного отчёта.`);
