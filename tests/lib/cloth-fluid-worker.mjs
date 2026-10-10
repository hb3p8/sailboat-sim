// Браузер и проверка Node используют тот же обработчик общего шага.
import {fluidSailMotion} from './cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from './cloth-sparse-wasm.mjs';
import {observeSparseFactor} from './cloth-worker-timing.mjs';
import {observeFluidStages,stageDifference} from './cloth-fluid-timing.mjs';
import {createExecutionProbe} from './cloth-execution-probe.mjs';
import {loadMaterialKernel} from '../probes/cloth-material-wasm.mjs';
import {verifyMaterialKernel} from '../probes/cloth-material-engine-check.mjs';
import {loadAssemblyKernel} from '../probes/cloth-assembly-wasm.mjs';
import {verifyAssemblyKernel} from '../probes/cloth-assembly-engine-check.mjs';

export function fluidWorkerHandler(post) {
  let calculation,factor,linearObserver,stageObserver,executionProbe,index=0,busy=false,failed=false,frameSliced=false,job;
  function runPart() {
    const start=performance.now(),part=job.parts.length+1;let next;
    do {next=job.work.next();} while(!next.done&&(part===3||performance.now()-start+job.loadMs<8));
    job.parts.push({computeMs:performance.now()-start+job.loadMs});job.loadMs=0;
    if(!next.done){post({id:job.id,type:'progress',part,index:index+1});return;}
    const audit=next.value,positions=calculation.motion.pos.slice(),body=structuredClone(calculation.motion.body),forceN=calculation.forceN.slice();
    const frameWork={mode:'three-frame-parts-v1',parts:job.parts,wallMs:performance.now()-job.start};
    const stepMs=job.parts.reduce((sum,p)=>sum+p.computeMs,0),finished=job;job=undefined;
    post({id:finished.id,type:'step',index:++index,hS:calculation.hS,stepMs,positions,body,forceN,audit,
      controls:finished.controls??{},frameWork},[positions.buffer]);
  }
  return async ({id,type,recipe,bodyInput,bytes,materialBytes,assemblyBytes,controls,sheet,liveWind,profile=false,probe=false,frameSliced:split=false})=>{
    if(busy){post({id,type:'error',message:'Предыдущая команда ещё выполняется',index});return;}
    busy=true;
    try {
      if(failed)throw new Error('После отказа требуется новая постановка');
      if(job&&(type!=='continue'||id!==job.id))throw new Error('Ожидается продолжение текущего шага после кадра');
      if(type==='init') {
        if(calculation)throw new Error('Расчёт уже подготовлен');
        if(typeof profile!=='boolean')throw new Error('Измерение стадий задаётся логическим значением');
        if(typeof probe!=='boolean')throw new Error('Независимая проба задаётся логическим значением');
        if(typeof split!=='boolean'||split&&profile)throw new Error('Разделение по кадрам требует обычного режима без профильных часов');
        frameSliced=split;
        if(materialBytes!==undefined&&!(materialBytes instanceof ArrayBuffer||ArrayBuffer.isView(materialBytes)))
          throw new Error('Нужны отдельные байты модуля материала');
        if(assemblyBytes!==undefined&&!(assemblyBytes instanceof ArrayBuffer||ArrayBuffer.isView(assemblyBytes)))
          throw new Error('Нужны отдельные байты модуля сборки');
        const start=performance.now();factor=await loadSparseFactor(bytes);
        const materialKernel=materialBytes===undefined?undefined:await loadMaterialKernel(materialBytes),
          assemblyKernel=assemblyBytes===undefined?undefined:await loadAssemblyKernel(assemblyBytes),compiledAt=performance.now();
        let material,assembly;
        if(materialKernel) {
          const checkStart=performance.now(),validation=verifyMaterialKernel(materialKernel,recipe);
          material={backend:'wasm',validation,checkMs:performance.now()-checkStart};
        }
        if(assemblyKernel) {
          const checkStart=performance.now(),validation=verifyAssemblyKernel(assemblyKernel,recipe);
          assembly={backend:'wasm',validation,checkMs:performance.now()-checkStart};
        }
        if(profile)linearObserver=observeSparseFactor(factor);
        if(liveWind!==undefined&&(!liveWind||typeof liveWind!=='object'||!liveWind.pack))throw new Error('Живому ветру нужен отдельный физический пакет');
        // Воздух импортирует kernel с верхнеуровневым await. Загружаем его
        // после установки обработчика: ранняя init не должна теряться.
        const factory=liveWind===undefined?fluidSailMotion:(await import('./cloth-live-wind-sail-motion.mjs')).liveWindSailMotion;
        calculation=factory(recipe,bodyInput,linearObserver?.factor??factor,{...liveWind,sheet,materialKernel,assemblyKernel});
        if(profile)stageObserver=observeFluidStages(calculation.motion);
        if(probe)executionProbe=createExecutionProbe();
        const positions=calculation.motion.pos.slice(),body=structuredClone(calculation.motion.body),readyAt=performance.now();
        post({id,type:'ready',positions,body,setupMs:readyAt-start,hS:calculation.hS,
          ...(profile?{profile:true,compileMs:compiledAt-start,modelMs:readyAt-compiledAt}:{}),
          ...(probe?{probe:true}:{}),
          ...(frameSliced?{frameSliced:true}:{}),
          ...(material?{material}:{}),
          ...(assembly?{assembly}:{}),
          ...(calculation.liveWind?{liveWind:calculation.liveWind}:{}),
          ...(calculation.massBudget?{massBudget:calculation.massBudget,geometryCGM:calculation.geometryCGM}:{}),
          ...(calculation.sheetControl?{sheetControl:calculation.sheetControl}:{})});
      } else if(type==='step') {
        if(!calculation)throw new Error('Расчёт не подготовлен');
        if(frameSliced) {
          const start=performance.now();calculation.prepareLoad(controls);
          job={id,controls,start,loadMs:performance.now()-start,parts:[],work:calculation.solveIterations()};
          runPart();return;
        }
        const before=stageObserver?.snapshot(),linearBefore=linearObserver?.snapshot(),wasmBefore=stageObserver&&factor.statistics();
        const start=performance.now();let audit,loadedAt;
        if(stageObserver){calculation.prepareLoad(controls);loadedAt=performance.now();audit=calculation.solve();}
        else audit=calculation.step(controls);
        const solvedAt=performance.now(),stepMs=solvedAt-start;
        const positions=calculation.motion.pos.slice(),body=structuredClone(calculation.motion.body),forceN=calculation.forceN.slice();
        let timing;
        if(stageObserver) {
          const after=linearObserver.snapshot(),wasmAfter=factor.statistics();
          timing={loadMs:loadedAt-start,physicsMs:solvedAt-loadedAt,
            stages:stageDifference(stageObserver.snapshot(),before),
            linear:Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-linearBefore[k]])),
            wasm:Object.fromEntries(Object.keys(wasmAfter).map(k=>[k,wasmAfter[k]-wasmBefore[k]]))};
          timing.snapshotMs=performance.now()-solvedAt;timing.handlerMs=stepMs+timing.snapshotMs;
        }
        post({id,type:'step',index:++index,hS:calculation.hS,stepMs,positions,body,forceN,audit,controls:controls??{},
          ...(timing?{timing}:{})},[positions.buffer]);
      } else if(type==='continue') {
        if(!job)throw new Error('Нет приостановленного шага');
        runPart();
      } else if(type==='probe') {
        if(!calculation||!executionProbe)throw new Error('Независимая проба не подготовлена');
        // Проба не меняет индекс, состояние, команды или наблюдатели модели.
        post({id,type:'probe',index,probe:executionProbe()});
      } else throw new Error('Неизвестная команда общего шага');
    } catch(e) {job?.work.return();job=undefined;failed=true;post({id,type:'error',message:e.message,index});}
    finally {busy=false;}
  };
}
if(typeof self!=='undefined') {
  const handle=fluidWorkerHandler((data,transfer=[])=>self.postMessage(data,transfer));
  self.addEventListener('message',event=>{void handle(event.data);});
}
