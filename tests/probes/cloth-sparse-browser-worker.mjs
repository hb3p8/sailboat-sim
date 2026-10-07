// Отдельный диагностический Worker; не выбирается интерактивным симулятором.
import {requireProbe as check,equalProbe,serialProbe,shaProbe,fetchProbe,captureViews,prepareProbeLDL,compareProbeLDL} from './cloth-sparse-browser-probe.mjs';
import {loadSparseFactor} from '../lib/cloth-sparse-wasm.mjs';
import {fluidSailMotion} from '../lib/cloth-fluid-sail-motion.mjs';
import {observeSparseFactor} from '../lib/cloth-worker-timing.mjs';
import {observeFluidStages,stageDifference} from '../lib/cloth-fluid-timing.mjs';
import {loadMaterialKernel} from './cloth-material-wasm.mjs';
import {verifyMaterialKernel} from './cloth-material-engine-check.mjs';
import {loadAssemblyKernel} from './cloth-assembly-wasm.mjs';
import {verifyAssemblyKernel} from './cloth-assembly-engine-check.mjs';
let used=false;
export async function runSparseBrowserProbe(input,{pair=1,mode='native',progress=()=>{}}={}){
  check(Number.isInteger(pair)&&pair>=1&&pair<=3&&['native','plain','profile'].includes(mode),'Неверный выбор опыта');
  const started=performance.now(),captureBytes=await fetch(input,{cache:'no-store'}).then(r=>{check(r.ok,'Не прочитан вход');return r.arrayBuffer();}),capture=JSON.parse(new TextDecoder().decode(captureBytes));
  const result={schema:'cloth-sparse-browser-probe-v1',phase:'preparing',pair,mode,input:{path:input,sha256:await shaProbe(captureBytes)},
    captureRevision:capture.revision,captureDirty:capture.dirty,sourceSha256:capture.sourceSha256,modules:capture.modules,
    preparation:{},records:[],exactPairs:0,factorElements:0,scratchElements:0,
    environment:{userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,crossOriginIsolated:self.crossOriginIsolated},
    rule:'Один новый Worker, две независимые памяти/модели. Порядок чередуется на каждой матрице/шаге; первый старый→новый в 1/3, наоборот в 2. Время по часам не CPU/FPS. Проверки и снимки вне таймеров шага; подготовка/первые вызовы сохранены. Наблюдение стадий — отдельный режим.'};
  try {
    // Импорт уже выполнен; проверяются именно его сохранённые файлы, а не текущая копия.
    const graphRoot=new URL('../../',import.meta.url);
    for(const [path,expected] of Object.entries(capture.sourceSha256)){
      const b=await fetch(new URL(path,graphRoot),{cache:'no-store'}).then(r=>{check(r.ok,'Не прочитан исходник '+path);return r.arrayBuffer();});
      check(await shaProbe(b)===expected,'Изменился сохранённый исходник '+path);}
    const bytes={};for(const [name,part] of Object.entries(capture.modules))bytes[name]=await fetchProbe(part);
    if(mode==='native'){
      const buffer=await fetchProbe(capture.binary),{patterns,samples}=captureViews(capture,buffer),modules={},workspaces={baseline:[],candidate:[]};
      for(const v of pair%2?['baseline','candidate']:['candidate','baseline']){
        const t=performance.now();modules[v]=await WebAssembly.compile(bytes[v]);result.preparation[v]={compileMs:performance.now()-t,patterns:[]};
        for(const p of patterns){const w=prepareProbeLDL(modules[v],p);workspaces[v].push(w);result.preparation[v].patterns.push(w.preparation);}}
      // Нулевой проход сохраняет холодные вызовы. Пять последующих проходов все сохранены.
      for(let repeat=0;repeat<=5;repeat++)for(let k=0;k<samples.length;k++){
        const s=samples[k],times={},order=(k+repeat+pair)%2?['baseline','candidate']:['candidate','baseline'];
        for(const v of order)times[v]=workspaces[v][s.pattern].run(s.matrix,s.signs);
        equalProbe(times.baseline.failure,times.candidate.failure,'отказ');check(times.baseline.failure===0,'Настоящий фактор отказал');
        const a=workspaces.baseline[s.pattern],b=workspaces.candidate[s.pattern];compareProbeLDL(a,b);
        result.exactPairs++;result.factorElements+=a.L.length;result.scratchElements+=a.work.length+a.column.length;
        result.records.push({side:s.side,step:s.step,call:s.call,pattern:s.pattern,repeat,order,times});
        if(k===samples.length-1)progress(`Разложения: проход ${repeat+1}/6, ${result.exactPairs} точных пар.`);
      }
    } else {
      for(const part of capture.inputs){const record=JSON.parse(new TextDecoder().decode(await fetchProbe(part))),f=record.fixture,contexts={};
        for(const v of pair%2?['baseline','candidate']:['candidate','baseline']){
          const t=performance.now(),factor=await loadSparseFactor(bytes[v]),materialKernel=await loadMaterialKernel(bytes.material),assemblyKernel=await loadAssemblyKernel(bytes.assembly),compiled=performance.now();
          equalProbe(verifyMaterialKernel(materialKernel,f.recipe),record.preparation.material.validation);equalProbe(verifyAssemblyKernel(assemblyKernel,f.recipe),record.preparation.assembly.validation);
          const verified=performance.now(),linear=mode==='profile'?observeSparseFactor(factor):undefined,c=fluidSailMotion(f.recipe,f.bodyInput,linear?.factor??factor,{sheet:f.sheet,materialKernel,assemblyKernel}),stages=mode==='profile'?observeFluidStages(c.motion):undefined;
          contexts[v]={c,factor,linear,stages};result.preparation[part.side+'-'+v]={compileMs:compiled-t,checkMs:verified-compiled,modelMs:performance.now()-verified,setupMs:performance.now()-t};
          equalProbe(JSON.parse(JSON.stringify(serialProbe({positions:c.motion.pos,body:c.motion.body}))),record.initial,'начальное состояние');}
        for(const s of record.steps){const times={},states={},order=(s.index+pair)%2?['baseline','candidate']:['candidate','baseline'];
          for(const v of order){const {c,factor,linear,stages}=contexts[v],before=stages?.snapshot(),linearBefore=linear?.snapshot(),wasmBefore=factor.statistics();
            const t=performance.now();let audit,loaded;
            if(stages){c.prepareLoad(s.controls);loaded=performance.now();audit=c.solve();}else audit=c.step(s.controls);
            const ended=performance.now();times[v]={stepMs:ended-t};
            if(stages){const after=linear.snapshot();times[v].profile={loadMs:loaded-t,physicsMs:ended-loaded,stages:stageDifference(stages.snapshot(),before),
              linear:Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-linearBefore[k]]))};}
            times[v].wasm=Object.fromEntries(Object.entries(factor.statistics()).map(([k,x])=>[k,x-wasmBefore[k]]));
            states[v]=serialProbe({positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit});
            equalProbe(JSON.parse(JSON.stringify(states[v])),{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit},'прежний шаг '+s.index);}
          equalProbe(states.baseline,states.candidate,'строгая пара '+s.index);result.exactPairs++;
          result.records.push({side:part.side,step:s.index,order,times,states});
          if(s.index%30===0)progress(`Полные шаги, ${part.side==='plus'?'первая':'другая'} сторона: ${s.index}/180, ${result.exactPairs} точных пар.`);
        }
      }
    }
    result.phase='complete';result.wallMs=performance.now()-started;return result;
  }catch(e){result.phase='failed';result.failure={message:e.message,stack:e.stack};result.wallMs=performance.now()-started;return result;}
}
if(typeof self!=='undefined'&&typeof document==='undefined'&&typeof self.postMessage==='function')self.addEventListener('message',async event=>{
  if(used){self.postMessage({type:'error',message:'Для каждого опыта нужен новый Worker'});return;}used=true;
  try{const result=await runSparseBrowserProbe(event.data.input,{pair:event.data.pair,mode:event.data.mode,progress:message=>self.postMessage({type:'progress',message})});self.postMessage({type:'result',result});}
  catch(e){self.postMessage({type:'error',message:e.message});}
});
