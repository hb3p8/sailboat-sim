// Тот же контроль обычной лодки в локальном JavaScriptCore без браузерного UI.
// Меняется только оболочка Node (файлы/утверждения/отчёт), физика импортируется.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),jsc=args.find(v=>v.startsWith('--jsc='))?.slice(6),out=args.find(v=>v.startsWith('--out='))?.slice(6);
if(!jsc||!out||args.length!==2)throw new Error('Нужны --jsc=путь-к-движку и --out=новый-отчёт.json');
const hash=b=>createHash('sha256').update(b).digest('hex'),test='tests/gennaker-simulator.test.mjs',source=readFileSync(test,'utf8');
let imports='';
let body=source.replace(/^import .+ from 'node:.+';\n/gm,'').replace(/^import (.+) from '(.+)';\n/gm,(_,names,path)=>{
  imports+=`import ${names} from ${JSON.stringify(resolve(dirname(test),path))};\n`;return '';
});
// Отчётом владеет запускатель; исходная проверка продолжает все свои утверждения.
const reportStart=body.indexOf("if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-simulator-check-v1',phase:'complete'");
if(reportStart<0)throw new Error('Изменился формат исходной проверки; обновите оболочку явно');
body=body.slice(0,reportStart);
const runner=imports+`
const readFileSync=path=>path.endsWith('.wasm')?readFile(path,'binary'):readFile(path);
const process={argv:[],env:{SV20_COUPLING_STEPS:'60'}};
const console={log:print};
const structuredClone=value=>JSON.parse(JSON.stringify(value));
const assert=(ok,message)=>{if(!ok)throw new Error(message??'Не выполнено утверждение');};
assert.equal=(a,b)=>assert(Object.is(a,b),'Не совпали ожидаемые значения');
assert.throws=fn=>{let caught=false;try{fn();}catch(error){caught=true;}assert(caught,'Не получен ожидаемый отказ');};
try {
${body}
print('SV20_ENGINE_REPORT='+JSON.stringify({phase:'complete',material:selected.material,results}));
} catch(error) {
print('SV20_ENGINE_REPORT='+JSON.stringify({phase:'failed',failure:{message:error.message,stack:error.stack}}));
throw error;
}
`;
const folder=out+'.sources';mkdirSync(folder);
const runnerPath=resolve(folder,'gennaker-simulator-engine.mjs');writeFileSync(runnerPath,runner,{flag:'wx'});
let output,executionFailure;
try {output=execFileSync(jsc,[runnerPath],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});}
catch(error){output=error.stdout??'';executionFailure=error.message;}
writeFileSync(resolve(folder,'stdout.txt'),output,{flag:'wx'});
const line=output.split('\n').find(v=>v.startsWith('SV20_ENGINE_REPORT='));
const result=line?JSON.parse(line.slice('SV20_ENGINE_REPORT='.length)):{phase:'failed',failure:{message:executionFailure??'Нет отчёта движка'}};
const paths=[test,'scripts/gennaker_engine_check.mjs','sim/gennaker-energy.mjs','sim/gennaker-material.mjs',
  'tests/probes/cloth-material-wasm.mjs','tests/probes/cloth-material-engine-check.mjs','sim/physics.js',
  'out/export/physics.json','out/acceptance/cloth-sparse-20261002-simd.wasm','out/acceptance/cloth-material-20261005-probe-v3.wasm',
  ...['plus','minus'].map(side=>`out/acceptance/fluid-live-main-20261010-${side}.json`)];
const report={schema:'gennaker-engine-check-v1',model:'boat-prescribed-energy-v1',
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  engine:{path:resolve(jsc),sha256:hash(readFileSync(jsc))},runner:{path:runnerPath,sha256:hash(runner)},
  sourceSha256:Object.fromEntries(paths.map(path=>[path,hash(readFileSync(path))])),...result};
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
if(executionFailure||report.phase!=='complete')throw new Error('Контроль JavaScriptCore остановлен: '+(report.failure?.message??executionFailure));
console.log(`JavaScriptCore: материал ${report.material.backend}, ${report.results.length} режима / ${report.results.reduce((s,r)=>s+r.steps,0)} шагов; прежние силовые и геометрические критерии выполнены. Это проверка движка, не браузерного экрана.`);
