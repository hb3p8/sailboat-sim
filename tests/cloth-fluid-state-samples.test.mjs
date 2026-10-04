// Известные три пружины: один снимок остатка/направления и владение данными.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FluidBodyEnergyMotion} from './lib/cloth-fluid-body-motion.mjs';
import {fluidInertia} from './lib/cloth-fluid-inertia.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
const args=process.argv.slice(2);assert(args.length===1&&args[0].startsWith('--wasm='),'Нужен --wasm=модуль');
const wasmSparseFactor=await loadSparseFactor(readFileSync(args[0].slice(7)));
const positions=[0,0,0,1,2,3],h=.1,alphas=[2,3,4];
const inertia=fluidInertia({dryMassKg:10,dryPrincipalInertiaKgM2:[2,3,4],addedMass6:new Array(36).fill(0)});
const load={frame:'inertial-cartesian-cg',clothForceN:new Float64Array(6),forceN:[0,0,0],momentNm:[0,0,0]};
for(const repeated of [false,true]) {
  function make(buffered) {
    const counters={ordinary:0,group:0},nodes=repeated?[0,0,1]:[0,1];
    const fill=(d,values)=>{
      for(let k=0;k<nodes.length;k++)for(let axis=0;axis<3;axis++)
        values[3*k+axis]=axis===d?(nodes[k]===0?(repeated?-.5:-1):1):(nodes[k]===0?-0:0);
    };
    const group={size:3,valueInto(q,gradients) {
      counters.group++;return gradients.map((g,d)=>{fill(d,g);return q[3+d]-q[d];});
    }};
    const constraints=alphas.map((alpha,d)=>({alpha,unilateral:false,value(q) {
      counters.ordinary++;const values=new Float64Array(3*nodes.length);fill(d,values);
      return {C:q[3+d]-q[d],grad:nodes.map((node,k)=>[node,Array.from(values.slice(3*k,3*k+3))])};
    },...(buffered?{gradientNodes:nodes,gradientGroup:group,gradientSlot:d,valueInto(q,g){fill(d,g);return q[3+d]-q[d];}}:{})}));
    const m=new FluidBodyEnergyMotion({positions,mass:[1,1],constraints,dampingHz:0,
      linearBackend:'schur-wasm',wasmSparseFactor,body:{inertia,originM:[0,0,0],orientation9:[1,0,0,0,1,0,0,0,1],
        velocity6:[0,0,0,0,0,0],attachments:[],frame:'body-cg'}});
    return {m,counters,nodes};
  }
  const direct=make(true),legacy=make(false);
  const old=m=>({pos:m.pos.slice(),vel:m.vel.slice(),body:structuredClone(m.body)});
  const z=Float64Array.from([...positions,0,0,0,0,0,0]);
  const a=direct.m.state(z,old(direct.m),load,h,[]),b=legacy.m.state(z,old(legacy.m),load,h,[]);
  for(const key of ['residual','clothResidual','materialGradient','softEnergyJ'])assert.deepEqual(a[key],b[key]);
  assert.deepEqual(Array.from(a.materialGradient),[-.5,-2/3,-.75,.5,2/3,.75]);
  const expected=Float64Array.from([...alphas.map((alpha,d)=>(d+1)/alpha/(1/(h*h)+2/alpha)),
    ...alphas.map((alpha,d)=>-(d+1)/alpha/(1/(h*h)+2/alpha)),0,0,0,0,0,0]);
  for(let attempt=0;attempt<2;attempt++) {
    const da=direct.m.direction(z,a,old(direct.m),load,h,[]),db=legacy.m.direction(z,b,old(legacy.m),load,h,[]);
    assert.deepEqual(da,db);da.forEach((v,k)=>assert(Math.abs(v-expected[k])<1e-14));
  }
  assert.equal(direct.counters.group,1);assert.equal(direct.counters.ordinary,0);
  assert.equal(legacy.counters.ordinary,3,'Направление повторно прочитало материал того же состояния');
  const snapshot=structuredClone(a),trial=z.slice();trial[3]=2;trial[4]=4;
  const next=direct.m.state(trial,old(direct.m),load,h,[]);assert.deepEqual(a,snapshot,'Пробное состояние изменило принятый снимок');
  direct.m.direction(trial,next,old(direct.m),load,h,[]);
  const again=direct.m.direction(z,a,old(direct.m),load,h,[]);
  again.forEach((v,k)=>assert(Math.abs(v-expected[k])<1e-14,'Повтор старого состояния использовал градиенты пробного состояния'));
  assert.deepEqual(a,snapshot,'Рабочая раскладка изменила снимок материала');
  const otherModes=structuredClone(a.softValues.slice(1)),first=a.softValues[0].values[0];
  a.softValues[0].values[0]=first+1;
  assert.deepEqual(a.softValues.slice(1),otherModes,'Градиенты разных мод перекрываются в памяти');
  a.softValues[0].values[0]=first;assert.deepEqual(a,snapshot);
  direct.nodes[0]=1;assert.deepEqual(a,snapshot,'Снимок сохранил чужой изменяемый список узлов');
}
console.log('ок: известные три пружины, обычный/численный интерфейсы, группа, повторные узлы и -0; холодное/повторное направление, одно чтение и независимость состояний');
