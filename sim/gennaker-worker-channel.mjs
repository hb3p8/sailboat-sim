// Каждое поколение расчёта владеет своим ожиданием и таймером. Кандидат
// загрузки не может ответить на команду действующего Worker.
export function gennakerWorkerChannel(onProgress) {
  const worker=new Worker(new URL('./gennaker-energy-worker.mjs',import.meta.url),{type:'module'});
  let pending,timer;
  function finish(error,data){const p=pending;pending=undefined;clearTimeout(timer);if(error)p?.reject(error);else p?.resolve(data);}
  worker.onmessage=({data})=>{
    if(data.type==='progress'){onProgress?.();return;}
    if(data.type==='error')finish(Object.assign(new Error(data.message),{attempts:data.attempts,solverProfiles:data.solverProfiles}));else finish(null,data);
  };
  worker.onerror=e=>finish(new Error(e.message));
  return {request(message) {
    if(pending)throw new Error('Повторная команда нового генакера');
    return new Promise((resolve,reject)=>{pending={resolve,reject};timer=setTimeout(()=>{finish(new Error('Расчёт не ответил за 30 с'));worker.terminate();},30000);worker.postMessage(message);});
  },continue(){worker.postMessage({type:'continue'});},dispose(){worker.terminate();finish(new Error('Расчёт ткани освобождён'));}};
}
