// Проверка сохранённого отчёта и намеренных подмен; новые расчёты ткани не нужны.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const args=Object.fromEntries(process.argv.slice(2).map(a=>{
  assert(a.startsWith('--') && a.includes('='),'Нужны --input=отчёт и необязательный --out=новый-манифест');
  const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];
}));
assert(args.input && Object.keys(args).every(k=>['input','out'].includes(k)),'Нужен --input=отчёт экранной команды');
const bytes=readFileSync(args.input), original=JSON.parse(bytes);
const warmup=original.measurement.warmupSteps;
assert(original.command && original.allSteps[warmup].supportTargets?.length,'Нужен полный отчёт движения угла');
const dir=mkdtempSync(join(tmpdir(),'sv20-команды-'));
const results=[];
const escape=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const difference=(actual,expected)=>new RegExp(`actual: ${escape(actual)},[\\s\\S]*expected: ${escape(expected)},[\\s\\S]*operator: 'strictEqual'`);
function run(name,report,diagnostic) {
  const input=join(dir,`${results.length}.json`),output=join(dir,`${results.length}-сводка.json`);
  writeFileSync(input,report);
  const r=spawnSync(process.execPath,['scripts/cloth_browser_report.mjs',output,input],{encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(r.error,undefined);assert.equal(r.signal,null);
  if(diagnostic) {
    assert.notEqual(r.status,0,`Принята подмена: ${name}`);
    assert.match(r.stderr,diagnostic,`Подмена ${name} отвергнута по другой причине`);
  } else assert.equal(r.status,0,r.stderr);
  results.push({name,accepted:r.status===0});
}
const cases=[
  ['чужой узел',r=>r.allSteps[warmup].supportTargets[0].node++,/Команда не соответствует проверенной траектории/],
  ['подменённое положение',r=>r.allSteps[warmup].supportTargets[0].positionM[0]+=.001,/Команда не соответствует проверенной траектории/],
  ['пропущенная команда шага',r=>delete r.allSteps[warmup].supportTargets,/Команда не соответствует проверенной траектории/],
  ['нет метки нажатия',r=>delete r.command,/Нет метки экранной команды/],
  ['ответ раньше запроса',r=>r.allSteps[warmup+1].receivedAtMs=r.allSteps[warmup+1].requestAtMs-1,/s.receivedAtMs>=s.requestAtMs/],
  ['два ожидающих запроса',r=>r.allSteps[warmup+1].requestAtMs=r.allSteps[warmup].receivedAtMs-1,/Запросы накопились/],
  ['не тот первый показанный шаг',r=>r.command.firstShownStep++,difference(original.command.firstShownStep+1,original.command.firstShownStep)],
  ['подменённая задержка показа',r=>r.command.frameDelayMs--,difference(original.command.frameDelayMs-1,original.command.frameDelayMs)],
  ['показ до получения снимка',r=>{
    const f=r.scene.frames.find(f=>f.shownStep>r.command.firstShownStep);
    assert(f,'Нет второго показанного результата');
    f.presentedAtMs=r.allSteps[f.shownStep-1].receivedAtMs-1;
    f.timestamp=Math.min(f.timestamp,f.presentedAtMs-1);
  },/frame.presentedAtMs>=r.allSteps/]
];
if(original.workerProfile!==undefined)cases.push(
  ['подменённый режим наблюдения',r=>r.workerProfile=!r.workerProfile,difference(!original.workerProfile,original.workerProfile)],
  ['нет стадий подготовки',r=>delete r.preparation.timeline,/Неполные стадии подготовки/],
  ['обратный порядок подготовки',r=>r.preparation.timeline[2].atMs=r.preparation.timeline[1].atMs-1,/Нарушен порядок подготовки/]
);
if(original.workerProfile)cases.push(
  ['нет стадий шага',r=>delete r.allSteps[warmup].timing,/Нет стадий рабочего шага/],
  ['отрицательное время разложения',r=>r.allSteps[warmup].timing.factorMs=-1,/Неверная стадия factorMs/],
  ['подменённый остаток стоимости',r=>r.allSteps[warmup].timing.otherStepMs++,/Неверный остаток стоимости шага/],
  ['подменённая длительность обработчика',r=>r.allSteps[warmup].timing.handlerMs++,/Неверная длительность обработчика/],
  ['подменённое число разложений',r=>r.allSteps[warmup].timing.factorCalls++,/Число наблюдаемых разложений не совпадает/]
);
try {
  run('исходный отчёт',bytes);
  for(const [name,mutate,diagnostic] of cases) {
    const r=structuredClone(original);mutate(r);run(name,JSON.stringify(r),diagnostic);
  }
  if(args.out)writeFileSync(args.out,JSON.stringify({schema:1,input:{path:args.input,
    sha256:createHash('sha256').update(bytes).digest('hex')},results},null,2)+'\n',{flag:'wx'});
  console.log(`ок: исходный отчёт принят; ${cases.length} подмен команд и времени отвергнуты по ожидаемой причине`);
} finally {rmSync(dir,{recursive:true,force:true});}
