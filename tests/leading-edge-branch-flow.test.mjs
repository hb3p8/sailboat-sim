// Проверка предпосылки (48)–(50) DeVoria–Mohseni на диагностическом LE:
// два ПРИХОДЯЩИХ к кромке пристенных потока нельзя предполагать заранее.
// Это невязкий плоский контроль, не модель настоящего генакера.
import assert from 'node:assert/strict';
import { fourierSheetWakeStep, fourierPlate, inducedSegment } from
  './lib/fourier-vortex.mjs';

const flow = [1, .1];
const samples = [];
for (const points of [2048, 4096]) {
  const birth = fourierSheetWakeStep({ flow, dt: .01,
    modes: 128, points, reynolds: 1e5, releaseHeight: 0,
    advection: 'induced', advectionSubsteps: 16,
    leadingFormation: 'tangent' });
  assert.ok(birth.ok);
  const plate = fourierPlate({ flow, sheets: birth.state.sheets,
    modes: 128, points });
  assert.ok(plate.ok && Math.abs(plate.A0) < 1e-10);
  const at = target => {
    let k = 0;
    while (k + 1 < plate.x.length &&
      Math.abs(plate.x[k + 1] - target) <
        Math.abs(plate.x[k] - target)) k++;
    const x = plate.x[k];
    const mean = flow[0] + birth.state.sheets.reduce((sum, sheet) =>
      sum + inducedSegment(sheet, x, 0, sheet.core2 ?? 0)[0], 0);
    return { x, towardEdgeMinus: -(mean - plate.gamma[k] / 2),
      towardEdgePlus: -(mean + plate.gamma[k] / 2) };
  };
  const near = at(1e-5), downstream = at(1e-4);
  // При x->0, A0=0 и gamma->0: оба потока направлены ОТ передней
  // кромки. Чуть ниже по хорде одна сторона обращается; это не два
  // готовых входящих в самый край слоя из формулы слияния.
  assert.ok(near.towardEdgeMinus < 0 && near.towardEdgePlus < 0);
  assert.ok(downstream.towardEdgeMinus > 0 &&
    downstream.towardEdgePlus < 0);
  samples.push({ points, A0: plate.A0, near, downstream });
}
console.log(JSON.stringify(samples, null, 2));
