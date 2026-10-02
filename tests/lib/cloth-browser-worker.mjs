// Один последовательный шаг ткани за сообщение. Воздух/лодка не добавляются.
import { browserMotion } from './cloth-browser-motion.mjs';
import { loadSparseFactor } from './cloth-sparse-wasm.mjs';
import { observeSparseFactor } from './cloth-worker-timing.mjs';

// Та же обработка используется настоящим Worker и независимой проверкой Node.
export function motionWorkerHandler(post) {
  let calculation, factor, observer, index = 0, preparing = false;
  return async ({ id, type, recipe, bytes, reuse, profile = false, supportTargets }) => {
    try {
      if (type === 'init') {
        if (calculation || preparing) throw new Error('Расчёт уже подготовлен');
        if(typeof profile!=='boolean')throw new Error('Измерение стадий задаётся логическим значением');
        preparing = true;
        const start = performance.now(); factor = await loadSparseFactor(bytes,{reuse});
        const compiled = performance.now();
        if(profile)observer=observeSparseFactor(factor);
        calculation = browserMotion(recipe,observer?.factor ?? factor);
        post({ id, type: 'ready', compileMs: compiled-start, setupMs: performance.now()-compiled,
          positions: calculation.motion.pos.slice(),wasmMemory:factor.statistics() });
      } else if (type === 'step') {
        if (!calculation) throw new Error('Расчёт не подготовлен');
        const before=observer?.snapshot();
        const start = performance.now(), result = calculation.step(supportTargets), solvedAt=performance.now(), timeMs = solvedAt-start;
        const { constraintForce, hardForce, prediction, supportForceN, ...audit } = result;
        let dualViolationN = 0;
        for (const c of calculation.motion.hard) if (c.unilateral)
          dualViolationN = Math.max(dualViolationN,c.lambda/(result.hS**2));
        const positions = calculation.motion.pos.slice();
        const transfer=[positions.buffer]; if (supportForceN) transfer.push(supportForceN.buffer);
        const wasmMemory=factor.statistics();
        let timing;
        if(observer) {
          const after=observer.snapshot();
          const delta=Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-before[k]]));
          const snapshotMs=performance.now()-solvedAt;
          timing={...delta,otherStepMs:timeMs-delta.factorMs-delta.solveMs,snapshotMs,handlerMs:timeMs+snapshotMs};
        }
        post({ id, type: 'step', index: index++, timeMs, positions, audit, dualViolationN,
          ...(supportForceN?{supportForceN}:{}),wasmMemory,...(timing?{timing}:{}) },transfer);
      } else throw new Error('Неизвестная команда расчёта');
    } catch (e) { post({id,type:'error',message:e.message,index}); }
  };
}

if (typeof self !== 'undefined') {
  const handle = motionWorkerHandler((data,transfer=[]) => self.postMessage(data,transfer));
  self.addEventListener('message',event => { void handle(event.data); });
}
