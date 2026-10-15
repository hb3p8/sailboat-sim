// Собственная память состояния, непересекающиеся моды и прежние числа.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {FluidBodyEnergyMotion} from './lib/cloth-fluid-body-motion.mjs';
import {fluidSailMotion} from './lib/cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from '../sim/cloth/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from '../sim/cloth/cloth-material-wasm.mjs';
const args=process.argv.slice(2),fixture=args.find(a=>a.startsWith('--fixture='))?.slice(10),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===2&&fixture&&out&&!existsSync(out));
const hash=b=>createHash('sha256').update(b).digest('hex'),fb=readFileSync(fixture),f=JSON.parse(fb);
assert(f.phase==='complete'&&!f.dirty&&f.materialProfile&&f.changedSources.length===0);
const oldPath=resolve(fixture+'.sources/baseline/tests/lib/cloth-fluid-body-motion.mjs');
assert.equal(hash(readFileSync(oldPath)),f.graphs.baseline.sourceSha256['tests/lib/cloth-fluid-body-motion.mjs']);
const {FluidBodyEnergyMotion:OldMotion}=await import(pathToFileURL(oldPath));
const read=(soft,q)=>FluidBodyEnergyMotion.prototype.readSoft.call({soft},q),old=(soft,q)=>OldMotion.prototype.readSoft.call({soft},q);
let cases=0,elements=0,rejected=0;const native=[];
const compare=(a,b)=>{assert.deepEqual(a,b);for(let k=0;k<a.length;k++)if(a[k].values){assert(Object.is(a[k].C,b[k].C));for(let j=0;j<a[k].values.length;j++){assert(Object.is(a[k].values[j],b[k].values[j]));elements++;}}cases++;};
function modes(frozen) {
  const nodes=[0,0,1];if(frozen)Object.freeze(nodes);
  const group={size:3,valueInto(q,targets){return targets.map((g,k)=>{g.fill(0);g[k]=k===0?-0:q[0];if(q[0]===13)throw new Error('Отказ контрольной группы');return q[0]+k;});}};
  return [
    {value:q=>({C:q[0],grad:[[0,[1,-0,0]]]})},
    ...[0,1,2].map(k=>({gradientNodes:nodes,gradientGroup:group,gradientSlot:k,valueInto(){throw new Error('Ожидалось групповое чтение');}})),
    {gradientNodes:[],valueInto:()=>-0},
    {gradientNodes:[1],valueInto(q,g){g[0]=q[1];return q[0];}},
  ];
}
for(const frozen of [false,true]) {
  const soft=modes(frozen),q=Float64Array.of(0,-0,0,1,2,3),a=read(soft,q);compare(a,old(modes(frozen),q));
  const saved=structuredClone(a),b=read(soft,Float64Array.of(2,3,0,1,2,3));assert.deepEqual(a,saved);
  for(const x of a)for(const y of b)if(x.values&&y.values)assert.notEqual(x.values.buffer,y.values.buffer);
  const rest=structuredClone(a.slice(2));a[1].values[0]=45;assert.deepEqual(a.slice(2),rest);a[1].values[0]=-0;assert.deepEqual(a,saved);
  assert.throws(()=>read(soft,Float64Array.of(13,0,0,1,2,3)),/Отказ/);rejected++;assert.deepEqual(a,saved);
  compare(read(soft,q),old(modes(frozen),q));
  const replacement=[1];soft[1].gradientNodes=replacement;const next=read(soft,q),snapshot=structuredClone(next);replacement[0]=0;assert.deepEqual(next,snapshot);assert.deepEqual(a,saved);
}
function changing() {
  const later={gradientNodes:[0],valueInto(q,g){g.fill(-0);g[g.length-1]=q[0];return q[0];}};
  const first={gradientNodes:[0],valueInto(q,g){g[0]=1;later.gradientNodes=Array.from({length:20},(_,k)=>k%2);return q[0];}};
  return [first,later];
}
const enlarged=read(changing(),Float64Array.of(1,0,0,2,0,0));compare(enlarged,old(changing(),Float64Array.of(1,0,0,2,0,0)));
assert.notEqual(enlarged[0].values.buffer,enlarged[1].values.buffer,'Увеличившийся список требует своего нового блока');
compare(read([],new Float64Array(0)),old([],new Float64Array(0)));
for(const part of f.inputs) {
  assert.equal(hash(readFileSync(part.path)),part.sha256);const r=JSON.parse(readFileSync(part.path)),recipe=r.fixture;
  const factor=await loadSparseFactor(readFileSync(f.modules.linear.path)),kernel=await loadMaterialKernel(readFileSync(f.modules.material.path));
  const c=fluidSailMotion(recipe.recipe,recipe.bodyInput,factor,{sheet:recipe.sheet,materialKernel:kernel});
  for(const index of [1,45,120,121,122]) {
    const q=Float64Array.from(r.steps[index-1].positions),a=c.motion.readSoft(q),b=old(c.motion.soft,q);compare(a,b);
    const buffers=new Set(a.map(v=>v.values.buffer)),previousBuffers=new Set(b.map(v=>v.values.buffer));assert.equal(buffers.size,1);assert.equal(previousBuffers.size,777);
    let end=0;for(const v of a){assert.equal(v.values.byteOffset,end);end+=v.values.byteLength;}assert.equal(end,a[0].values.buffer.byteLength);
    native.push({side:part.side,step:index,gradients:a.length,bytes:end,oldBuffers:previousBuffers.size,newBuffers:buffers.size});
  }
}
writeFileSync(out,JSON.stringify({schema:'cloth-fluid-snapshot-blocks-check-v1',phase:'complete',cases,elements,rejected,native,
  fixture:{path:fixture,sha256:hash(fb)},sourceSha256:hash(readFileSync('tests/lib/cloth-fluid-body-motion.mjs')),testSha256:hash(readFileSync(new URL(import.meta.url))),
  rule:'Прежний замороженный метод и нынешний, Object.is до JSON. Новые состояния владеют разными блоками, моды не перекрываются; рост списка и отказ сохраняют снимки. Это проверка, не скорость.'},null,2)+'\n',{flag:'wx'});
console.log(`Блоки снимков: ${cases} сравнений/${elements} чисел строго, ${rejected} отказа; настоящий парус 777→1 буфер каждого состояния.`);
