// Контракт фаз: ожидание ткани, единственная публикация и остановка при отказе.
import assert from 'node:assert/strict';
import {createGennakerStep,GENNAKER_STEP_PHASES} from '../sim/gennaker-step.mjs';

function trial(fail) {
  const calls=[],command={type:'step'},result={positions:[1]},load={forceN:[2]},snapshot={positions:[3]};
  const invoke=name=>{calls.push(name);if(name===fail)throw new Error('Отказ фазы '+name);};
  const phases={
    prepareAir(){invoke('prepareAir');return {waterInput:{zM:4}};},
    clothLoads(){invoke('clothLoads');},
    clothCommand(){invoke('clothCommand');return command;},
    transferReactions(c){invoke('transferReactions');assert.equal(c.result,result);return {load,snapshot:result};},
    finishBoat(c){invoke('finishBoat');assert.equal(c.load,load);assert.equal(c.snapshot,result);}
  };
  const step=createGennakerStep({snapshot},phases);
  return {step,phases,calls,command,result,load,invoke,solve:c=>{assert.equal(c,command);invoke('solve');return result;}};
}
assert(Object.isFrozen(GENNAKER_STEP_PHASES));
const invalid=trial();delete invalid.phases.finishBoat;
assert.throws(()=>createGennakerStep({},invalid.phases),/Не задана фаза/);assert.deepEqual(invalid.calls,[]);

const t=trial(),s=t.step;
assert.throws(()=>s.finish(),/порядок фаз/);assert.throws(()=>s.publish(()=>t.invoke('publish')),/порядок фаз/);
const prepared=s.prepare();assert.equal(prepared.command,t.command);assert.deepEqual(prepared.waterInput,{zM:4});
assert.throws(()=>s.prepare(),/порядок фаз/);assert.throws(()=>s.transfer(),/порядок фаз/);
// Изменение таблицы фаз снаружи не меняет уже созданный шаг.
t.phases.finishBoat=()=>{throw new Error('Подмена выполняющегося плана');};
let answer;
const calculation=s.calculate(c=>{assert.equal(c,t.command);t.invoke('solve');return new Promise(resolve=>answer=resolve);});
assert.equal(s.phase,'calculating');
await assert.rejects(s.calculate(t.solve),/порядок фаз/);
assert.throws(()=>s.transfer(),/порядок фаз/);assert.throws(()=>s.finish(),/порядок фаз/);
assert.throws(()=>s.publish(()=>t.invoke('publish')),/порядок фаз/);
answer(t.result);assert.equal(await calculation,t.result);
assert.deepEqual(s.transfer(),{load:t.load,snapshot:t.result});assert.throws(()=>s.transfer(),/порядок фаз/);
s.finish();assert.throws(()=>s.finish(),/порядок фаз/);
const value=s.publish(c=>{t.invoke('publish');assert.equal(c.result,t.result);assert.equal(c.load,t.load);return 42;});
assert.equal(value,42);assert.equal(s.phase,'complete');
assert.throws(()=>s.publish(()=>t.invoke('publish')),/порядок фаз/);
assert.deepEqual(t.calls,['prepareAir','clothLoads','clothCommand','solve','transferReactions','finishBoat','publish']);

for(const fail of ['prepareAir','clothLoads','clothCommand','solve','transferReactions','finishBoat','publish']) {
  const t=trial(fail),s=t.step;
  await assert.rejects(async()=>{
    s.prepare();await s.calculate(t.solve);s.transfer();s.finish();s.publish(()=>t.invoke('publish'));
  },new RegExp('Отказ фазы '+fail));
  assert.equal(s.phase,'failed');assert.throws(()=>s.finish(),/порядок фаз/);
  assert.throws(()=>s.publish(()=>t.invoke('повтор')),/порядок фаз/);
  assert.equal(t.calls.at(-1),fail);
}
const rejected=trial();rejected.step.prepare();
await assert.rejects(rejected.step.calculate(async()=>{throw new Error('Асинхронный отказ ткани');}),/отказ ткани/);
assert.equal(rejected.step.phase,'failed');assert(!rejected.calls.includes('transferReactions'));

// Настоящая граница Boat также отклоняет отсутствие/повтор запроса ткани.
assert.throws(()=>GENNAKER_STEP_PHASES.prepareAir({boat:{waveZ:0,waveSE:0,waveSN:0,x:0,y:0,zc:0,psi:0,phi:0,th:0,
  *stepWithGennaker(){return;}},dt:1/30}),/не запросила/);
assert.throws(()=>GENNAKER_STEP_PHASES.finishBoat({work:{next:()=>({done:false})},load:{}}),/повторную нагрузку/);
console.log('Фазы: порядок, ожидание ответа, запрет повторной публикации и 8 отказов без продолжения проверены.');
