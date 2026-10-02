// Известная временная шкала и разные узлы одной функции; это не проверка физики.
import assert from 'node:assert/strict';
import {summarizeCpuProfile} from '../scripts/cloth_cpu_profile.mjs';
const frame=(functionName,lineNumber)=>({functionName,url:'file:///контроль.mjs',lineNumber});
const profile={nodes:[{id:1,callFrame:frame('решение',4)},{id:2,callFrame:frame('подготовка',9)},
  {id:3,callFrame:frame('решение',4)}],samples:[1,2,3,1],timeDeltas:[250000,500000,750000,500000]};
const summary=summarizeCpuProfile(profile);
assert.equal(summary.sampledSeconds,2);assert.equal(summary.sampleCount,4);
assert.equal(summary.negativeIntervals,0);assert.equal(summary.negativeIntervalSeconds,0);
assert.deepEqual(summary.functions,[
  {functionName:'решение',url:'file:///контроль.mjs',line:5,samples:3,selfSeconds:1.5,selfPercent:75},
  {functionName:'подготовка',url:'file:///контроль.mjs',line:10,samples:1,selfSeconds:.5,selfPercent:25}]);
const signed=summarizeCpuProfile({...profile,timeDeltas:[-1,500000,750001,750000]});
assert.deepEqual(signed.functions,summary.functions);assert.equal(signed.sampledSeconds,2);
assert.equal(signed.negativeIntervals,1);assert.equal(signed.negativeIntervalSeconds,.000001);
for(const broken of [
  {...profile,timeDeltas:[1]},
  {...profile,samples:[99,2,3,1]},
  {...profile,timeDeltas:[1,NaN,3,4]},
  {...profile,timeDeltas:[0,0,0,0]},
  {...profile,nodes:[...profile.nodes,profile.nodes[0]]}
])assert.throws(()=>summarizeCpuProfile(broken));
console.log('ок: известные интервалы, объединение одной функции и отказ неполных профилей');
