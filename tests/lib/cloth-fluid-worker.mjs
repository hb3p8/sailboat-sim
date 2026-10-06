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
  let calculation,factor,linearObserver,stageObserver,executionProbe,index=0,busy=false,failed=false;
  return async ({id,type,recipe,bodyInput,bytes,materialBytes,assemblyBytes,controls,sheet,profile=false,probe=false})=>{
    if(busy){post({id,type:'error',message:'Предыдущая команда ещё выполняется',index});return;}
    busy=true;
    try {
      if(failed)throw new Error('После отказа требуется новая постановка');
      if(type==='init') {
        if(calculation)throw new Error('Расчёт уже подготовлен');
        if(typeof profile!=='boolean')throw new Error('Измерение стадий задаётся логическим значением');
        if(typeof probe!=='boolean')throw new Error('Независимая проба задаётся логическим значением');
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
        calculation=fluidSailMotion(recipe,bodyInput,linearObserver?.factor??factor,{sheet,materialKernel,assemblyKernel});
        if(profile)stageObserver=observeFluidStages(calculation.motion);
        if(probe)executionProbe=createExecutionProbe();
        const positions=calculation.motion.pos.slice(),body=structuredClone(calculation.motion.body),readyAt=performance.now();
        post({id,type:'ready',positions,body,setupMs:readyAt-start,hS:calculation.hS,
          ...(profile?{profile:true,compileMs:compiledAt-start,modelMs:readyAt-compiledAt}:{}),
          ...(probe?{probe:true}:{}),
          ...(material?{material}:{}),
          ...(assembly?{assembly}:{}),
          ...(calculation.sheetControl?{sheetControl:calculation.sheetControl}:{})});
      } else if(type==='step') {
        if(!calculation)throw new Error('Расчёт не подготовлен');
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
      } else if(type==='probe') {
        if(!calculation||!executionProbe)throw new Error('Независимая проба не подготовлена');
        // Проба не меняет индекс, состояние, команды или наблюдатели модели.
        post({id,type:'probe',index,probe:executionProbe()});
      } else throw new Error('Неизвестная команда общего шага');
    } catch(e) {failed=true;post({id,type:'error',message:e.message,index});}
    finally {busy=false;}
  };
}
if(typeof self!=='undefined') {
  const handle=fluidWorkerHandler((data,transfer=[])=>self.postMessage(data,transfer));
  self.addEventListener('message',event=>{void handle(event.data);});
}
