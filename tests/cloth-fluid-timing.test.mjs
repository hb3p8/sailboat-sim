// Известные часы: вложенность, повтор, сохранение владельца/ответа и отказ.
import assert from 'node:assert/strict';
import {observeFluidStages,stageDifference} from './lib/cloth-fluid-timing.mjs';
let clock=0;
const answer=new Float64Array([3,5]);
const motion={
  validateState(){assert.equal(this,motion);clock+=2;},
  bodyState(arg){assert.equal(this,motion);assert.equal(arg,answer);clock+=3;return arg;},
  readSoft(arg){clock+=7;return arg;},
  state(arg){clock+=5;this.bodyState(arg);this.readSoft(arg);clock+=11;return arg;},
  direction(arg){clock+=13;this.state(arg);clock+=17;return arg;},
  audit(){clock+=19;throw Error('известный отказ аудита');}
};
const observed=observeFluidStages(motion,()=>clock),before=observed.snapshot();
motion.validateState();assert.equal(motion.direction(answer),answer);
assert.throws(()=>motion.audit(),/известный отказ аудита/);
const first=stageDifference(observed.snapshot(),before);
assert.deepEqual(first,{
  validateState:{calls:1,inclusiveMs:2,selfMs:2},
  bodyState:{calls:1,inclusiveMs:3,selfMs:3},readSoft:{calls:1,inclusiveMs:7,selfMs:7},
  state:{calls:1,inclusiveMs:26,selfMs:16},direction:{calls:1,inclusiveMs:56,selfMs:30},
  audit:{calls:1,inclusiveMs:19,selfMs:19}
});
assert.equal(Object.values(first).reduce((sum,row)=>sum+row.selfMs,0),clock);
const saved=observed.snapshot();saved.state.calls=999;
assert.equal(observed.snapshot().state.calls,1);
const last=observed.snapshot();assert.equal(motion.state(answer),answer);
assert.equal(stageDifference(observed.snapshot(),last).state.calls,1);
assert.equal(stageDifference(observed.snapshot(),last).direction.calls,0);
console.log('ок: известные часы стадий, вложенное время, повтор, владение ответом/снимком и отказ');
