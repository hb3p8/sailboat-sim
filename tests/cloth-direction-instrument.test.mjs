// Проверка сохранения прежних границ при выделении общего генератора таймеров.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import {instrumentDirection,instrumentSparse,instrumentMaterialHessian,instrumentReadSoft,instrumentMaterialValues} from './probes/cloth-direction-instrument.mjs';
const original=readFileSync('tests/lib/cloth-fluid-schur-direction.mjs','utf8'),linear=readFileSync('tests/lib/cloth-sparse-wasm.mjs','utf8'),saved={};
const old=execFileSync('git',['show','be1f260:scripts/cloth_fluid_direction_profile.mjs'],{encoding:'utf8'}),start=old.indexOf('let instrumented=original;'),end=old.indexOf('const fixtures=inputs.map',start);
assert(start>=0&&end>start);
runInNewContext(old.slice(start,end),{assert,original,direction:'tests/lib/cloth-fluid-schur-direction.mjs',root:'.',copies:'копия',resolve,
  readFileSync:()=>linear,writeFileSync:(path,value)=>{saved[path]=value;}});
assert.equal(instrumentDirection(original),saved[resolve('копия','tests/lib/cloth-fluid-schur-direction.mjs')]);
assert.equal(instrumentSparse(linear),saved[resolve('копия','tests/lib/cloth-sparse-wasm.mjs')]);
assert.throws(()=>instrumentDirection(original.replace('  const nc=m.pos.length','  const nc=this.pos.length')),/Граница/);
assert.throws(()=>instrumentSparse(linear.replace('    counts.numericFactorizations++;','    counts.numericFactorizations+=1;')),/Граница/);
// Подробные часы отказывают при изменённой либо повторённой границе:
// тихий перенос отметки мог бы приписать время чужому вычислению.
const material=readFileSync('tests/probes/cloth-material-wasm.mjs','utf8');
for(const marker of ['    const assemble=({g,plan})=>{',
  'matrix[plan.entries[entry++]]+=.5*(H[a*size+b]+H[b*size+a]);',
  '          group.hessianInto(s.q,block.map(t=>t.weight),block.map(t=>t.plan.hessian));']) {
  assert.throws(()=>instrumentDirection(original.replace(marker,''),{correction:true}),/Граница/);
  assert.throws(()=>instrumentDirection(original+'\n'+marker,{correction:true}),/Граница/);
}
for(const marker of ['      return {hessianInto(p,weights,targets) {',
  'targets.forEach(g=>separate(p,g));hessianOffset??=allocate(3*size*size);prepareInput(p);',
  '        new Float64Array(e.memory.buffer,weightsOffset,3).set(weights);calls++;',
  '        for(let j=0;j<3;j++)targets[j].set(hessianViews[j]);']) {
  assert.throws(()=>instrumentMaterialHessian(material.replace(marker,'')),/Граница/);
  assert.throws(()=>instrumentMaterialHessian(material+'\n'+marker),/Граница/);
}
console.log('Общий генератор: две прежние копии побайтно точны; 16 изменённых/повторённых границ отвергнуты.');
const body=readFileSync('tests/lib/cloth-fluid-body-motion.mjs','utf8');
for(const [code,generate,markers] of [[body,instrumentReadSoft,['  readSoft(q) {',
  '        const values=block.map(sample),C=group.valueInto(q,values.map(v=>v.values));',
  'values.forEach((v,k)=>{v.C=C[k];samples.push(v);});j+=block.length;',
  '        const v=sample(c);v.C=c.valueInto(q,v.values);samples.push(v);j++;',
  '      } else {samples.push(c.value(q));j++;}']],
  [material,instrumentMaterialValues,['      const execute=(p,requested)=>{','        prepareInput(p);\n        calls++;',
    "        if(failed)throw new Error('Вырожденная нормаль участка кривизны');",'      },valueInto(p,gradients) {',
    '        return [output[0],output[1],output[2]];','      },singleInto(p,j,g) {',
    '        separate(p,g);execute(p,j);g.set(gradientViews[j]);return output[j];']]]) {
  for(const marker of markers){assert.throws(()=>generate(code.replace(marker,'')),/Граница/);assert.throws(()=>generate(code+'\n'+marker),/Граница/);}
}
console.log('Чтение материала: ещё 24 изменённых/повторённых границы отвергнуты.');
