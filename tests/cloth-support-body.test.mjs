// Передача полного пакета известному телу, независимо от решения ткани.
import assert from 'node:assert/strict';
import { SupportImpulseLedger } from './lib/cloth-support-impulse.mjs';
import { supportBodyResponse } from './lib/cloth-support-body.mjs';
const close = (a,b) => assert(Math.abs(a-b) <= 1e-12*Math.max(1,Math.abs(b)), `${a} != ${b}`);
const vector = (a,b) => a.forEach((v,d) => close(v,b[d]));
const body = () => ({ massKg:10, inertiaKgM2:[20,30,40], originM:[0,0,0],
  frame:'body-horizontal', velocityMS:[0,0,0], angularVelocityRadS:[0,0,0] });

// Известный импульс 2 Н·с на высоте 3 м: все фазы и два окна лодки.
for (const boatHz of [30,60]) for (const hz of [60,120,240]) for (const phase of [.25,.5,.75]) {
  const h = 1/hz, width = hz/boatHz, event = Math.ceil(phase*width)-1;
  const ledger = new SupportImpulseLedger({clothHS:h,boatHS:1/boatHz,originM:[0,0,0]});
  let packet;
  for (let i=0;i<width;i++) packet = ledger.push({index:i,positionsM:[0,0,3],
    supportForceN:[i===event?-2/h:0,0,0]});
  const result = supportBodyResponse(body(),packet);
  vector(result.velocityMS,[.2,0,0]); vector(result.angularVelocityRadS,[0,.2,0]);
  close(result.beforeJ,0); close(result.afterJ,.8); close(result.impulseWorkJ,.8);
  // Нос кверху в Boat — отрицательный My: ответ на этот импульс опускает нос.
  close(-result.angularVelocityRadS[1],-.2);
}

// Нулевой суммарный вектор не отменяет вращения вокруг каждой из трёх осей.
for (const [points,forces,expected] of [
  [[0,-1,0,0,1,0],[0,0,3,0,0,-3],[6,0,0]],
  [[0,0,-1,0,0,1],[3,0,0,-3,0,0],[0,6,0]],
  [[-1,0,0,1,0,0],[0,3,0,0,-3,0],[0,0,6]],
]) {
  const ledger = new SupportImpulseLedger({clothHS:1/60,boatHS:1/30,originM:[0,0,0]});
  ledger.push({index:0,positionsM:points,supportForceN:forces});
  const packet = ledger.push({index:1,positionsM:points,supportForceN:forces});
  const result = supportBodyResponse(body(),packet);
  vector(result.velocityMS,[0,0,0]);
  vector(result.angularVelocityRadS,expected.map((v,d)=>v/30/body().inertiaKgM2[d]));
  close(result.afterJ,result.impulseWorkJ);
  assert(result.afterJ>0,'Пара сил потеряна из-за нулевой результирующей');
}

// Обратный импульс тормозит: работа отрицательна, энергия уменьшилась.
const moving = body(); moving.velocityMS=[.2,0,0]; moving.angularVelocityRadS=[0,.2,0];
const packet = {frame:'body-horizontal',originM:[0,0,0],durationS:1/30,
  impulseNs:[-2,0,0],angularImpulseNms:[0,-6,0]};
const original = structuredClone({moving,packet});
const stopped = supportBodyResponse(moving,packet);
vector(stopped.velocityMS,[0,0,0]); vector(stopped.angularVelocityRadS,[0,0,0]);
close(stopped.impulseWorkJ,-.8); close(stopped.afterJ-stopped.beforeJ,-.8);
assert.deepEqual({moving,packet},original,'Расчёт ответа изменил вход');
stopped.velocityMS[0]=99; assert.deepEqual({moving,packet},original,'Ответ разделяет память с входом');

// Смена начала действительно меняет ответ, если плечо задано относительно нового ЦТ.
const shifted = body(); shifted.originM=[2,0,0];
const ledger = new SupportImpulseLedger({clothHS:1/60,boatHS:1/30,originM:shifted.originM});
ledger.push({index:0,positionsM:[2,0,3],supportForceN:[-60,0,0]});
const shiftedPacket = ledger.push({index:1,positionsM:[2,0,3],supportForceN:[-60,0,0]});
vector(supportBodyResponse(shifted,shiftedPacket).angularVelocityRadS,[0,.2,0]);
assert.throws(()=>supportBodyResponse(body(),shiftedPacket),/начало моментов/);
for (const invalid of [{massKg:0},{massKg:NaN},{inertiaKgM2:[1,0,1]},
  {velocityMS:[0,NaN,0]},{angularVelocityRadS:[0,Infinity,0]},{frame:'world'}])
  assert.throws(()=>supportBodyResponse({...moving,...invalid},packet));
for (const invalid of [{durationS:0},{impulseNs:[NaN,0,0]},
  {angularImpulseNms:[0,0,Infinity]},{originM:[0,1,0]},{frame:'world'}])
  assert.throws(()=>supportBodyResponse(moving,{...packet,...invalid}));
assert.throws(()=>supportBodyResponse({...moving,massKg:Number.MIN_VALUE},
  {...packet,impulseNs:[Number.MAX_VALUE,0,0]}),/Переполнение/);
assert.deepEqual({moving,packet},original,'Отказ изменил вход');
console.log('ок: известный ответ тела, три момента пары сил, фазы/частоты, работа ускорения и торможения, начала/оси и отказ');
