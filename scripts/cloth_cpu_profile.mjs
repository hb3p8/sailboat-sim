// Сводка выборок V8: собственное время функций, без приписывания FPS браузеру.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export function summarizeCpuProfile(profile) {
  assert.ok(Array.isArray(profile.nodes) && Array.isArray(profile.samples) &&
    Array.isArray(profile.timeDeltas) && profile.samples.length===profile.timeDeltas.length,
    'Нужны узлы, выборки и совпадающее число интервалов профиля V8');
  const nodes=new Map(profile.nodes.map(n=>[n.id,n.callFrame])),totals=new Map();
  assert.equal(nodes.size,profile.nodes.length,'Повторный идентификатор узла');
  let totalUs=0,negativeIntervals=0,negativeUs=0;
  for(let i=0;i<profile.samples.length;i++) {
    const f=nodes.get(profile.samples[i]),us=profile.timeDeltas[i];
    assert.ok(f && Number.isFinite(us),'Неизвестный узел или неверный интервал');
    // В сохранённых V8-профилях встречается -1 мкс. Не исправляем данные
    // молча: суммируем исходные знаки, отдельно показываем размер аномалии.
    if(us<0){negativeIntervals++;negativeUs-=us;}
    assert.ok(typeof f.functionName==='string' && typeof f.url==='string' &&
      Number.isInteger(f.lineNumber),'Нужны имя, источник и строка функции');
    const key=JSON.stringify([f.functionName,f.url,f.lineNumber]);
    if(!totals.has(key))totals.set(key,{functionName:f.functionName,url:f.url,line:f.lineNumber+1,selfUs:0,samples:0});
    const row=totals.get(key);row.selfUs+=us;row.samples++;totalUs+=us;
  }
  assert.ok(totalUs>0,'Нужен непустой профиль с положительной длительностью');
  return {sampledSeconds:totalUs/1e6,sampleCount:profile.samples.length,
    negativeIntervals,negativeIntervalSeconds:negativeUs/1e6,
    rule:'собственное время по интервалам выборок V8; дочернее время не включено; весь процесс, не FPS браузера',
    functions:[...totals.values()].sort((a,b)=>b.selfUs-a.selfUs).map(({selfUs,...row})=>
      ({...row,selfSeconds:selfUs/1e6,selfPercent:100*selfUs/totalUs}))};
}

function main() {
  const args=process.argv.slice(2);
  assert.ok(args.length===2 && args.every(a=>/^--(input|out)=.+$/.test(a)) && args.filter(a=>a.startsWith('--input=')).length===1 &&
    args.filter(a=>a.startsWith('--out=')).length===1,'Нужны --input=профиль.cpuprofile и --out=сводка.json');
  const input=resolve(args.find(a=>a.startsWith('--input=')).slice(8));
  const output=resolve(args.find(a=>a.startsWith('--out=')).slice(6));
  assert.ok(input!==output && output!==fileURLToPath(import.meta.url),'Результат не должен заменять вход или инструмент');
  const bytes=readFileSync(input),summary=summarizeCpuProfile(JSON.parse(bytes));
  const sha=b=>createHash('sha256').update(b).digest('hex');
  const report={schema:1,createdAt:new Date().toISOString(),input,inputSha256:sha(bytes),
    toolSha256:sha(readFileSync(fileURLToPath(import.meta.url))),...summary};
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(`Выборки всего процесса: ${summary.sampledSeconds.toFixed(6)} с; ${summary.sampleCount} интервалов.`);
  if(summary.negativeIntervals)console.log(`Отрицательных интервалов: ${summary.negativeIntervals}, сумма модулей `+
    `${summary.negativeIntervalSeconds.toFixed(6)} с; исходные знаки сохранены, время выборок приблизительное.`);
  for(const f of summary.functions.slice(0,12))console.log(`${(f.functionName||'(без имени)')} ${f.url}:${f.line}: `+
    `${f.selfSeconds.toFixed(6)} с, ${f.selfPercent.toFixed(2)}%`);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
