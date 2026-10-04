// Замкнутые суммы целых чисел проверяют ответ независимо от циклов пробы.
import assert from 'node:assert/strict';
import {createExecutionProbe,validateExecutionProbe} from './lib/cloth-execution-probe.mjs';
let clock=0;const run=createExecutionProbe(()=>clock+=5),first=run(),second=run();
assert.equal(first.elapsedMs,65);assert.equal(second.elapsedMs,65);
assert.equal(first.samples.length,3);
for(const sample of first.samples) {
  assert.equal(sample.dotMs,5);assert.equal(sample.allocationMs,5);
  // Σ x(17−x)=816, Σ x²=1496 для x=1…16. Кольцо хранит 128 таких групп.
  assert.equal(sample.dotChecksum,816*128*1024);
  assert.equal(sample.allocationChecksum,14*1496*4096);
  assert.equal(sample.tailChecksum,14*1496*128);
}
assert.deepEqual(first,second);
const saved=structuredClone(second);first.samples[0].dotChecksum++;
assert.deepEqual(second,saved,'Ответ пробы изменил следующий независимый снимок');
assert.throws(()=>validateExecutionProbe(first),/Неверная запись/);
for(const edit of [r=>r.samples.pop(),r=>r.dotProducts++,r=>r.samples[0].dotMs=-1,
  r=>r.samples[1].allocationChecksum++,r=>r.elapsedMs=1]) {
  const r=structuredClone(second);edit(r);assert.throws(()=>validateExecutionProbe(r),/Неверная запись/);
}
console.log('ок: независимые замкнутые суммы, известные часы, повтор, владение ответом и шесть подмен пробы');
