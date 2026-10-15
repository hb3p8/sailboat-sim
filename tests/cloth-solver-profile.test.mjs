// Известные интервалы и исключения: собственные времена не пересекаются.
import assert from 'node:assert/strict';
import {ClothSolverProfile,observeClothSolver} from '../sim/cloth/cloth-solver-profile.mjs';
import {readFileSync} from 'node:fs';
import {Boat} from '../sim/physics.js';
import {prescribedGennaker,gennakerPose} from '../sim/gennaker-energy.mjs';
import {loadSparseFactor} from '../sim/cloth/cloth-sparse-wasm.mjs';
let time=0;const p=new ClothSolverProfile(()=>time);
const root=p.begin('cloth');time=2;const state=p.begin('state');time=3;
const material=p.begin('material');time=8;p.end(material);time=10;p.end(state);time=15;p.end(root);
assert.deepEqual(p.snapshot().stages,{cloth:{calls:1,failed:0,inclusiveMs:15,selfMs:7},
  state:{calls:1,failed:0,inclusiveMs:8,selfMs:3},material:{calls:1,failed:0,inclusiveMs:5,selfMs:5}});
const detached=p.snapshot();detached.stages.cloth.selfMs=0;assert.equal(p.snapshot().stages.cloth.selfMs,7);
p.reset();
assert.throws(()=>p.measure('cloth',()=>{time=17;p.begin('assembly');time=20;throw new Error('Пробный отказ');}),/Пробный/);
assert.deepEqual(p.snapshot().stages,{cloth:{calls:1,failed:1,inclusiveMs:5,selfMs:2},assembly:{calls:1,failed:1,inclusiveMs:3,selfMs:3}});
p.reset();const a=p.begin('a'),b=p.begin('b');assert.throws(()=>p.end(a),/порядок/);
assert.throws(()=>p.reset(),/незавершённое/);assert.throws(()=>p.snapshot(),/не завершено/);
p.end(b);p.end(a);assert.throws(()=>p.end(a),/порядок/);p.reset();
const answer={},motion={linearBackend:'kkt-wasm',soft:[{family:'bending',value(){return answer;}}],
  step(){return this.soft[0].value();},solve(){},state(){},direction(){},kktFactor:()=>()=>answer};
observeClothSolver(motion,p);assert.equal(motion.step(),answer);
const solve=motion.kktFactor();assert.equal(solve(),answer);assert.equal(solve.release,undefined);
assert.throws(()=>observeClothSolver(motion,p),/отдельный расчёт/);
assert(p.snapshot().stages.materialBending.calls===1);
// Отказ линейного направления вызывает прежнее дробление; часы сохраняют
// цену неудачного родителя и не меняют результат дочерних подшагов.
const pack=JSON.parse(readFileSync('data/simulator/v1/physics.json')),
  fixture=JSON.parse(readFileSync('data/simulator/v1/gennaker-plus.json')),
  factor=await loadSparseFactor(readFileSync('data/simulator/v1/cloth-sparse.wasm'));
function refined(profile) {
  let first=true;const source=(...args)=>factor(...args);
  source.ldl=(...args)=>{if(first){first=false;throw new Error('Матрица направления не положительна: пробный отказ');}return factor.ldl(...args);};
  const attempts=[],pose=gennakerPose(new Boat(pack)),calc=prescribedGennaker(fixture,pack,pose,source,undefined,
    {solverProfile:profile,observeAttempt:a=>attempts.push({...a,ms:0})});
  const command={forceN:new Float64Array(297),targetPose:pose,sheetLengthM:fixture.sheet.lengthM};
  const result=profile?profile.measure('cloth',calc.step,calc,[command]):calc.step(command);
  return {result,state:calc.snapshot(),attempts};
}
const observer=new ClothSolverProfile(),plain=refined(),observed=refined(observer);
assert.deepEqual(observed,plain);const rows=observer.snapshot().stages;
assert.equal(rows.cloth.calls,1);assert.equal(rows.cloth.failed,0);assert.equal(rows.factor.failed,1);
assert.equal(rows.motionStep.failed,1);assert.equal(rows.motionStep.calls,3);
assert.deepEqual(observed.attempts.map(a=>a.accepted),[false,true,true]);
assert(Math.abs(Object.values(rows).reduce((s,r)=>s+r.selfMs,0)-rows.cloth.inclusiveMs)<1e-6);
console.log('Часы решателя: известные вложенные интервалы, собственное время, отказы и сохранение результата/необязательного освобождения проверены.');
