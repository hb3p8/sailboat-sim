// Сводка активных часов и последнего окна обычного генакера из JSON-дампа.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const args=Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith('--')).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
if(!args.input)throw new Error('Укажите --input=дамп.json [--out=новая-сводка.json]');
const bytes=readFileSync(args.input),dump=JSON.parse(bytes);
const finite=(x,name)=>{if(!Number.isFinite(x)||x<0)throw new Error('Неверное измерение: '+name);return x;};
function stats(values){if(!values.length)return null;const a=values.map(v=>finite(v,'время')).sort((a,b)=>a-b);
  const q=p=>a[Math.max(0,Math.ceil(p*a.length)-1)];return {count:a.length,mean:a.reduce((s,v)=>s+v,0)/a.length,p50:q(.5),p95:q(.95),p99:q(.99),max:a.at(-1)};}
function summarize(m) {
  if(m?.schema!=='gennaker-metrics-v1')throw new Error('Нет измерений обычной физики gennaker-metrics-v1');
  for(const k of ['modelS','activeModelS','excludedModelS','activeS','lagS','steps'])finite(m[k],k);
  if(Math.abs(m.modelS-m.activeModelS-m.excludedModelS)>1e-9)throw new Error('Не сходится учёт принятого времени');
  if(Math.abs(m.lagS-Math.max(0,m.activeS-m.activeModelS))>1e-9)throw new Error('Неверное отставание');
  if(m.activeS>0&&Math.abs(m.tempo-m.activeModelS/m.activeS)>1e-9)throw new Error('Неверный темп модели');
  if(!Array.isArray(m.records)||m.records.length>300||!Array.isArray(m.frameIntervalsMs))throw new Error('Неверное окно записи');
  const cloth=m.records.filter(r=>r.gennakerUp),keys=['rigMs','boatPrepareMs','clothLoadsMs','toWorldMs',
    'workerRoundTripMs','workerComputeMs','waitAndTransferMs','frameWaitMs','applySnapshotMs','boatFinishMs','physicsWallMs'];
  const totals=[];let maxDepth=0,failedAttempts=0;
  for(const r of cloth) {
    if(!Array.isArray(r.attempts)||r.attempts.length!==2)throw new Error('Не сохранены оба набора попыток шага');
    let attempts=0;
    for(const part of r.attempts)for(const a of part){
      if(!Number.isInteger(a.depth)||a.depth<0||a.depth>2||typeof a.accepted!=='boolean'||a.hS!==1/(60*2**a.depth))throw new Error('Неверное дробление');
      finite(a.ms,'попытка');maxDepth=Math.max(maxDepth,a.depth);if(!a.accepted)failedAttempts++;attempts++;
    }
    if(attempts<2)throw new Error('Потеряны попытки');totals.push(attempts);
  }
  return {context:m.context,phase:m.phase,scenario:m.scenario,driverFPS:m.driverFPS,
    wholeSession:{steps:m.steps,modelS:m.modelS,activeS:m.activeS,tempo:m.tempo,lagS:m.lagS,
      excludedModelS:m.excludedModelS,phaseMs:m.phaseMs,failure:m.failure},
    lastWindow:{count:m.records.length,clothSteps:cloth.length,fromModelS:m.records[0]?.modelTimeS,
      toModelS:m.records.at(-1)?.modelTimeS,timingsMs:Object.fromEntries(keys.map(k=>[k,stats(cloth.map(r=>r.timings[k]))])),
      attemptsPerStep:stats(totals),failedAttempts,maxDepth,frameIntervalsMs:stats(m.frameIntervalsMs)}};
}
const report={schema:'gennaker-metrics-report-v1',input:args.input,sha256:createHash('sha256').update(bytes).digest('hex'),
  scope:dump.scope??'browser-dump',build:dump.build,runtimeSha256:dump.gennakerEnergy?.runtimeSha256,
  runs:(dump.runs??[dump.gennakerMetrics]).map(summarize),
  notes:['Часы относятся ко всей сессии; тайминги — к последним 300 шагам и 600 интервалам кадров.',
    'rigMs входит в boatPrepareMs; workerComputeMs и frameWaitMs входят в workerRoundTripMs. Вложенные интервалы не складывать.',
    'Измерения не принимают физику, браузерную сцену или мобильный бюджет автоматически.']};
if(args.out)writeFileSync(args.out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
for(const r of report.runs)console.log(`Физика: ${r.wholeSession.steps} шагов; ${r.wholeSession.modelS.toFixed(3)} с модели / ${r.wholeSession.activeS.toFixed(3)} с активных часов; темп ${r.wholeSession.tempo?.toFixed(3)??'нет'}, отставание ${r.wholeSession.lagS.toFixed(3)} с; попыток с отказом ${r.lastWindow.failedAttempts}.`);
