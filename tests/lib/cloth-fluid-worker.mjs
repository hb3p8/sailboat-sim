// Браузер и проверка Node используют тот же обработчик общего шага.
import {fluidSailMotion} from './cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from './cloth-sparse-wasm.mjs';

export function fluidWorkerHandler(post) {
  let calculation,index=0,busy=false,failed=false;
  return async ({id,type,recipe,bodyInput,bytes,controls,sheet})=>{
    if(busy){post({id,type:'error',message:'Предыдущая команда ещё выполняется',index});return;}
    busy=true;
    try {
      if(failed)throw new Error('После отказа требуется новая постановка');
      if(type==='init') {
        if(calculation)throw new Error('Расчёт уже подготовлен');
        const start=performance.now(),factor=await loadSparseFactor(bytes);
        calculation=fluidSailMotion(recipe,bodyInput,factor,{sheet});
        post({id,type:'ready',positions:calculation.motion.pos.slice(),body:structuredClone(calculation.motion.body),
          setupMs:performance.now()-start,hS:calculation.hS,
          ...(calculation.sheetControl?{sheetControl:calculation.sheetControl}:{})});
      } else if(type==='step') {
        if(!calculation)throw new Error('Расчёт не подготовлен');
        const start=performance.now(),audit=calculation.step(controls),stepMs=performance.now()-start;
        const positions=calculation.motion.pos.slice();
        post({id,type:'step',index:++index,hS:calculation.hS,stepMs,positions,
          body:structuredClone(calculation.motion.body),forceN:calculation.forceN.slice(),audit,controls:controls??{}},[positions.buffer]);
      } else throw new Error('Неизвестная команда общего шага');
    } catch(e) {failed=true;post({id,type:'error',message:e.message,index});}
    finally {busy=false;}
  };
}
if(typeof self!=='undefined') {
  const handle=fluidWorkerHandler((data,transfer=[])=>self.postMessage(data,transfer));
  self.addEventListener('message',event=>{void handle(event.data);});
}
