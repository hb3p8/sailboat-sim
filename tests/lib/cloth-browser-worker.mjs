// Один последовательный шаг ткани за сообщение. Воздух/лодка не добавляются.
import { browserMotion } from './cloth-browser-motion.mjs';
import { loadSparseFactor } from './cloth-sparse-wasm.mjs';

// Та же обработка используется настоящим Worker и независимой проверкой Node.
export function motionWorkerHandler(post) {
  let calculation, factor, index = 0, preparing = false;
  return async ({ id, type, recipe, bytes, reuse, supportTargets }) => {
    try {
      if (type === 'init') {
        if (calculation || preparing) throw new Error('Расчёт уже подготовлен');
        preparing = true;
        const start = performance.now(); factor = await loadSparseFactor(bytes,{reuse});
        const compiled = performance.now(); calculation = browserMotion(recipe,factor);
        post({ id, type: 'ready', compileMs: compiled-start, setupMs: performance.now()-compiled,
          positions: calculation.motion.pos.slice() });
      } else if (type === 'step') {
        if (!calculation) throw new Error('Расчёт не подготовлен');
        const start = performance.now(), result = calculation.step(supportTargets), timeMs = performance.now()-start;
        const { constraintForce, hardForce, prediction, supportForceN, ...audit } = result;
        let dualViolationN = 0;
        for (const c of calculation.motion.hard) if (c.unilateral)
          dualViolationN = Math.max(dualViolationN,c.lambda/(result.hS**2));
        const positions = calculation.motion.pos.slice();
        const transfer=[positions.buffer]; if (supportForceN) transfer.push(supportForceN.buffer);
        post({ id, type: 'step', index: index++, timeMs, positions, audit, dualViolationN,
          ...(supportForceN?{supportForceN}:{}),wasmMemory: factor.statistics() },transfer);
      } else throw new Error('Неизвестная команда расчёта');
    } catch (e) { post({id,type:'error',message:e.message,index}); }
  };
}

if (typeof self !== 'undefined') {
  const handle = motionWorkerHandler((data,transfer=[]) => self.postMessage(data,transfer));
  self.addEventListener('message',event => { void handle(event.data); });
}
