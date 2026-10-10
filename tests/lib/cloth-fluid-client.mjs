// Последовательный канал общего шага: команды не накапливаются в очереди.
export async function createFluidWorker(recipe, bodyInput, bytes, {
  makeWorker = url => new Worker(url,{type:'module'}),sheet,liveWind,profile=false,probe=false,frameSliced=false,materialBytes,assemblyBytes } = {}) {
  if(typeof profile!=='boolean')throw new Error('Измерение стадий задаётся логическим значением');
  if(typeof probe!=='boolean')throw new Error('Независимая проба задаётся логическим значением');
  if(typeof frameSliced!=='boolean'||frameSliced&&profile)throw new Error('Разделение по кадрам требует обычного режима без профильных часов');
  if(materialBytes!==undefined&&!(materialBytes instanceof ArrayBuffer||ArrayBuffer.isView(materialBytes)))
    throw new Error('Нужны отдельные байты модуля материала');
  if(assemblyBytes!==undefined&&!(assemblyBytes instanceof ArrayBuffer||ArrayBuffer.isView(assemblyBytes)))
    throw new Error('Нужны отдельные байты модуля сборки');
  const worker = makeWorker(new URL('./cloth-fluid-worker.mjs',import.meta.url));
  let pending = null, sequence = 0, closed = false;
  const rejectPending = error => {
    if (!pending) return;
    clearTimeout(pending.timer); const { reject } = pending; pending = null; reject(error);
  };
  const timeout = () => setTimeout(() => {closed=true;rejectPending(new Error('Истекло время ожидания расчёта'));worker.terminate();},30000);
  worker.addEventListener('error',event => {
    closed = true; rejectPending(new Error(event.message || 'Ошибка отдельного потока')); worker.terminate();
  });
  worker.addEventListener('message',({data}) => {
    if (!pending || data.id !== pending.id) {
      closed = true; rejectPending(new Error('Нарушен порядок ответов расчёта')); worker.terminate(); return;
    }
    if (data.type === 'error') { rejectPending(new Error(data.message)); return; }
    if(data.type==='progress') {
      if(!frameSliced||pending.type!=='step'||pending.waitingFrame||data.part!==pending.part+1||data.part>2) {
        closed=true;rejectPending(new Error('Нарушен порядок частей шага'));worker.terminate();return;
      }
      clearTimeout(pending.timer);pending.part=data.part;pending.waitingFrame=true;return;
    }
    clearTimeout(pending.timer); const {resolve} = pending; pending = null; resolve(data);
  });
  const request = (type, fields = {}, transfer = []) => {
    if (closed) return Promise.reject(new Error('Отдельный поток остановлен'));
    if (pending) return Promise.reject(new Error('Предыдущий шаг ещё не завершён'));
    return new Promise((resolve,reject) => {
      const id = sequence++;
      const timer = timeout();
      pending = {id,type,resolve,reject,timer,part:0,waitingFrame:false};
      try { worker.postMessage({id,type,...fields},transfer); }
      catch(e) { rejectPending(e); }
    });
  };
  const terminate = () => { closed = true; rejectPending(new Error('Отдельный поток остановлен')); return worker.terminate(); };
  // Вызывается после показанного кадра; за кадр продолжается только одна часть.
  const resume = () => {
    if(closed||!pending?.waitingFrame)return false;
    pending.waitingFrame=false;
    pending.timer=timeout();
    try {worker.postMessage({id:pending.id,type:'continue'});} catch(error){rejectPending(error);}
    return true;
  };
  try {
    // Копия отделяет владение байтами от прочитанного/проверенного исходного модуля.
    const ownedBytes = bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const ownedMaterial=materialBytes===undefined?undefined:materialBytes instanceof ArrayBuffer?materialBytes.slice(0):
      materialBytes.buffer.slice(materialBytes.byteOffset,materialBytes.byteOffset+materialBytes.byteLength);
    const ownedAssembly=assemblyBytes===undefined?undefined:assemblyBytes instanceof ArrayBuffer?assemblyBytes.slice(0):
      assemblyBytes.buffer.slice(assemblyBytes.byteOffset,assemblyBytes.byteOffset+assemblyBytes.byteLength);
    const ready = await request('init',{recipe,bodyInput,bytes:ownedBytes,profile,...(frameSliced?{frameSliced:true}:{}),...(liveWind!==undefined?{liveWind}:{}),...(probe?{probe:true}:{}),...(sheet?{sheet}:{}),
      ...(ownedMaterial?{materialBytes:ownedMaterial}:{}),...(ownedAssembly?{assemblyBytes:ownedAssembly}:{})},
      [ownedBytes,...(ownedMaterial?[ownedMaterial]:[]),...(ownedAssembly?[ownedAssembly]:[])]);
    return {ready,step:controls=>request('step',{controls}),resume,terminate,...(probe?{probe:()=>request('probe')}:{})};
  } catch(e) { terminate(); throw e; }
}
