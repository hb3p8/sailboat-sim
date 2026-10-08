// Подмена постановки или принятых нагрузок не должна выдавать успешный повтор.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===2&&input&&out&&!existsSync(out)&&!existsSync(out+'.cases'));
const bytes=readFileSync(input),original=JSON.parse(bytes);assert(original.fixture.liveWind&&original.steps.length>1);
mkdirSync(out+'.cases');
const accepted=out+'.cases/accepted.json';
execFileSync(process.execPath,['scripts/cloth_fluid_live_report.mjs',input,accepted],{stdio:['ignore','pipe','pipe']});
assert.equal(JSON.parse(readFileSync(accepted)).exactSteps,original.steps.length);
const cases=[
  ['неизвестный воздух',r=>{r.fixture.liveWind.model='unknown';}],
  ['подмена живого ветра замороженной нагрузкой',r=>{delete r.fixture.liveWind;}],
  ['команда вне окна ветра',r=>{r.steps[0].controls.windSpeedMPS=13;}],
  ['изменённая узловая сила',r=>{r.steps[0].forceN[0]+=1;}],
  ['изменённый интеграл воздуха',r=>{r.steps[0].audit.air.totalForceN[0]+=1;}],
  ['неверная фаза воздуха',r=>{r.steps[0].audit.air.loadPhase='after-step';}]
];
const results=[];
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
writeFileSync(out,JSON.stringify({schema:'cloth-live-wind-report-check-v1',phase:'complete',input,sha256:hash(bytes),
  toolSha256:hash(readFileSync('scripts/cloth_fluid_live_report.mjs')),accepted,rejected:results.length,results},null,2)+'\n',{flag:'wx'});
console.log(`Повтор живого ветра: ${original.steps.length} шагов приняты, ${results.length} подмен отклонены.`);
