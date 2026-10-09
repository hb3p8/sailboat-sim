// Отказы смешанной ревизии, ложных чисел/модулей и вложенных интервалов.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),fixture=args.find(a=>a.startsWith('--fixture='))?.slice(10),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===3&&input&&fixture&&out&&!existsSync(out)&&!existsSync(out+'.cases'));const r=JSON.parse(readFileSync(input));assert.equal(r.profile,true);
const hash=b=>createHash('sha256').update(b).digest('hex'),tool='scripts/cloth_fluid_browser_pair_report.mjs',cases=out+'.cases';mkdirSync(cases);
execFileSync(process.execPath,[tool,'--input='+input,'--fixture='+fixture,'--out='+cases+'/accepted.json'],{stdio:'pipe'});
const report={schema:'cloth-fluid-browser-pair-report-check-v1',phase:'checking',input:{path:input,sha256:hash(readFileSync(input))},fixture:{path:fixture,sha256:hash(readFileSync(fixture))},
  toolSha256:hash(readFileSync(tool)),rejected:[]};
for(const [name,mutate] of [
  ['вход',x=>{x.input.sha256='0'.repeat(64);} ],['ревизия',x=>{x.fixtureRevision='0'.repeat(40);} ],['модуль',x=>{x.modules.linear.sha256='0'.repeat(64);} ],
  ['порядок',x=>{x.records[0].order.reverse();}],['парные-числа',x=>{x.records[0].states.candidate.positions[0]+=.1;}],
  ['прежние-числа',x=>{x.records[0].states.candidate.positions[0]+=.1;x.records[0].states.baseline.positions[0]+=.1;}],
  ['число-пар',x=>{x.exactPairs--;}],['видимость',x=>{x.page.visibility.push({state:'hidden'});} ],['страница',x=>{x.page.sha256='0'.repeat(64);} ],
  ['счётчики-границ',x=>{x.records[0].times.candidate.profile.directions.ordinary.linear.calls++;}],
  ['вложенное-время',x=>{x.records[0].times.candidate.profile.directions.ordinary.linear.ms=1e9;}],
  ['счётчики-wasm',x=>{x.records[0].times.candidate.profile.sparse.factorNative.calls++;}],
  ['время-wasm',x=>{x.records[0].times.candidate.profile.sparse.factorNative.ms=1e9;}],
  ...(r.liveWind?[
    ['режим-нагрузки-sv20',x=>{x.liveWind.mode='free-live';}],
    ['пакет-sv20',x=>{x.liveWind.physics.sha256='0'.repeat(64);}],
  ]:[]),
  ...(r.correctionProfile?[
    ['режим-корректора',x=>{x.correctionProfile=false;}],
    ['счётчик-местных-матриц',x=>{x.records[0].times.candidate.profile.correction.local.calls++;}],
    ['время-общей-сборки',x=>{x.records[0].times.candidate.profile.correction.scatter.ms=1e9;}],
    ['отрицательное-местное-время',x=>{x.records[0].times.candidate.profile.correction.local.ms=-1;}],
    ['счётчик-передачи-материала',x=>{x.records[0].times.candidate.profile.materialHessian.upload.calls++;}],
    ['время-чтения-материала',x=>{x.records[0].times.candidate.profile.materialHessian.read.ms=1e9;}],
    ['отрицательное-время-материала',x=>{x.records[0].times.candidate.profile.materialHessian.native.ms=-1;}],
  ]:[]),
  ...(r.materialProfile?[
    ['режим-материала',x=>{x.materialProfile=false;}],
    ['время-подготовки-снимков',x=>{x.records[0].times.candidate.profile.readSoft.prepare.ms=1e9;}],
    ['счётчик-снимков',x=>{x.records[0].times.candidate.profile.readSoft.evaluate.calls++;}],
    ['время-вызова-группы',x=>{x.records[0].times.candidate.profile.materialValues.group.native.ms=1e9;}],
    ['счётчик-одиночного-материала',x=>{x.records[0].times.candidate.profile.materialValues.single.read.calls++;}],
    ['отрицательное-чтение-материала',x=>{x.records[0].times.candidate.profile.materialValues.group.read.ms=-1;}],
  ]:[]),
]){const x=structuredClone(r);mutate(x);const path=cases+'/'+name+'.json',target=cases+'/'+name+'-report.json';writeFileSync(path,JSON.stringify(x)+'\n',{flag:'wx'});
  let error;try{execFileSync(process.execPath,[tool,'--input='+path,'--fixture='+fixture,'--out='+target],{stdio:'pipe'});}catch(e){error=e;}
  assert(error?.status===1&&String(error.stderr).includes('AssertionError'),name);assert(!existsSync(target));report.rejected.push({name,path,sha256:hash(readFileSync(path)),message:String(error.stderr)});}
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});writeFileSync(cases+'/report-tool.mjs',readFileSync(tool),{flag:'wx'});writeFileSync(cases+'/test-tool.mjs',readFileSync(new URL(import.meta.url)),{flag:'wx'});
console.log(`Подробные доказательства: правильная пара принята, ${report.rejected.length} подмен отвергнуты.`);
