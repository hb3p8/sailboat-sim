// Последовательный канал общего шага: команды не накапливаются в очереди.
export async function createFluidWorker(recipe, bodyInput, bytes, {
  makeWorker = url => new Worker(url,{type:'module'}),sheet,profile=false,probe=false } = {}) {
  if(typeof profile!=='boolean')throw new Error('Измерение стадий задаётся логическим значением');
  if(typeof probe!=='boolean')throw new Error('Независимая проба задаётся логическим значением');
  const worker = makeWorker(new URL('./cloth-fluid-worker.mjs',import.meta.url));
  let pending = null, sequence = 0, closed = false;
  const rejectPending = error => {
    if (!pending) return;
    clearTimeout(pending.timer); const { reject } = pending; pending = null; reject(error);
  };
  worker.addEventListener('error',event => {
    closed = true; rejectPending(new Error(event.message || 'Ошибка отдельного потока')); worker.terminate();
  });
  worker.addEventListener('message',({data}) => {
    if (!pending || data.id !== pending.id) {
      closed = true; rejectPending(new Error('Нарушен порядок ответов расчёта')); worker.terminate(); return;
    }
    if (data.type === 'error') { rejectPending(new Error(data.message)); return; }
    clearTimeout(pending.timer); const {resolve} = pending; pending = null; resolve(data);
  });
  const request = (type, fields = {}, transfer = []) => {
    if (closed) return Promise.reject(new Error('Отдельный поток остановлен'));
    if (pending) return Promise.reject(new Error('Предыдущий шаг ещё не завершён'));
    return new Promise((resolve,reject) => {
      const id = sequence++;
      const timer = setTimeout(() => { closed = true; rejectPending(new Error('Истекло время ожидания расчёта')); worker.terminate(); },30000);
      pending = {id,resolve,reject,timer};
      try { worker.postMessage({id,type,...fields},transfer); }
      catch(e) { rejectPending(e); }
    });
  };
  const terminate = () => { closed = true; rejectPending(new Error('Отдельный поток остановлен')); return worker.terminate(); };
  try {
    // Копия отделяет владение байтами от прочитанного/проверенного исходного модуля.
    const ownedBytes = bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const ready = await request('init',{recipe,bodyInput,bytes:ownedBytes,profile,...(probe?{probe:true}:{}),...(sheet?{sheet}:{})},[ownedBytes]);
    return {ready,step:controls=>request('step',{controls}),terminate,...(probe?{probe:()=>request('probe')}:{})};
  } catch(e) { terminate(); throw e; }
}
