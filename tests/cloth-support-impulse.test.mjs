// Независимые известные импульс/момент, изменение начала/осей и отказ без потери шага.
import assert from 'node:assert/strict';
import {SupportImpulseLedger} from './lib/cloth-support-impulse.mjs';
const close=(a,b)=>assert(Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const vector=(a,b)=>a.forEach((v,d)=>close(v,b[d]));
const make=(clothHS=1/60,boatHS=1/30,originM=[0,0,0],phi=0)=>new SupportImpulseLedger({clothHS,boatHS,originM,phi});

// На ткань действует нулевой суммарный вектор и ненулевой момент пары сил.
const couple=make();
const sample={positionsM:[-1,0,0,1,0,0],supportForceN:[0,3,0,0,-3,0]};
assert.equal(couple.push({index:0,...sample}),null);
const pair=couple.push({index:1,...sample});
vector(pair.impulseNs,[0,0,0]);vector(pair.angularImpulseNms,[0,0,.2]);
vector(pair.averageForceN,[0,0,0]);vector(pair.averageMomentNm,[0,0,6]);
vector(couple.finish().angularImpulseNms,[0,0,.2]);

// В течение окна точка и сила коррелируют: произведение средних потеряло бы момент.
const varying=make();
varying.push({index:0,positionsM:[1,0,0],supportForceN:[0,-2,0]});
const change=varying.push({index:1,positionsM:[3,0,0],supportForceN:[0,-4,0]});
vector(change.impulseNs,[0,.1,0]);vector(change.angularImpulseNms,[0,0,14/60]);
assert(Math.abs(change.averageMomentNm[2]-2*3)>0.9,'Средняя точка не заменяет полный момент');

// Одно воздействие нити: импульс на ткань −2 Н·с, на лодку +2.
// Разные шаги/положения события меняют пик, но не интеграл одного окна.
for(const hz of [60,120,240])for(const phase of [.25,.5,.75]) {
  const h=1/hz,ledger=make(h),width=hz/30,event=Math.ceil(phase*width)-1;
  let packet;
  for(let i=0;i<width;i++)packet=ledger.push({index:i,positionsM:[0,0,3],supportForceN:[i===event?-2/h:0,0,0]});
  vector(packet.impulseNs,[2,0,0]);vector(packet.angularImpulseNms,[0,6,0]);
  vector(packet.averageForceN,[60,0,0]);vector(packet.averageMomentNm,[0,180,0]);
  close(packet.impulseNs[0]/10,.2);close(packet.angularImpulseNms[1]/20,.3); // массы/инерция тестового тела
}

const shifted=make(1/60,1/30,[1,0,0],Math.PI/2);
for(let i=0;i<2;i++)var turned=shifted.push({index:i,positionsM:[3,2,0],supportForceN:[0,-4,0]});
vector(turned.impulseNs,[0,0,4/30]);vector(turned.angularImpulseNms,[0,-8/30,0]);
const mirrored=make();
for(let i=0;i<2;i++)var mirror=mirrored.push({index:i,positionsM:[3,-2,1],supportForceN:[-2,4,-6]});
vector(mirror.impulseNs,[2/30,-4/30,6/30]);vector(mirror.angularImpulseNms,[-8/30,-16/30,-8/30]);

const ledger=make();
assert.throws(()=>ledger.push({index:1,...sample}),/Пропущен/);
assert.equal(ledger.push({index:0,...sample}),null);
assert.throws(()=>ledger.push({index:0,...sample}),/повторён/);
assert.throws(()=>ledger.push({index:1,positionsM:[0,0,NaN],supportForceN:[1,0,0]}),/полного снимка/);
assert.throws(()=>ledger.push({index:1,positionsM:sample.positionsM}),/полного снимка/);
assert.throws(()=>ledger.push({index:1,positionsM:sample.positionsM.map(()=>NaN),supportForceN:sample.supportForceN}),/Нечисловая/);
assert.throws(()=>ledger.push({index:1,positionsM:sample.positionsM,supportForceN:sample.supportForceN.map(()=>NaN)}),/Нечисловая/);
assert.throws(()=>ledger.finish(),/Неполный/);
const accepted=ledger.push({index:1,...sample});
sample.positionsM[0]=99;sample.supportForceN[1]=99;
vector(accepted.angularImpulseNms,[0,0,.2]);
accepted.angularImpulseNms[2]=99;vector(ledger.finish().angularImpulseNms,[0,0,.2]);
assert.throws(()=>{ledger.originM[0]=99;},TypeError);assert.throws(()=>{ledger.clothHS=1;},TypeError);
assert.throws(()=>make(1/60,1/40),/целое число/);
assert.throws(()=>make(0),/положительные/);
console.log('ок: известные импульсы/три момента, пара сил, движущаяся точка, фаза короткого события, оси и отказ без потери шага');
