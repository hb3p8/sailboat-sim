// Проверка сохранения прежних границ при выделении общего генератора таймеров.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import {instrumentDirection,instrumentSparse} from './probes/cloth-direction-instrument.mjs';
const original=readFileSync('tests/lib/cloth-fluid-schur-direction.mjs','utf8'),linear=readFileSync('tests/lib/cloth-sparse-wasm.mjs','utf8'),saved={};
const old=execFileSync('git',['show','be1f260:scripts/cloth_fluid_direction_profile.mjs'],{encoding:'utf8'}),start=old.indexOf('let instrumented=original;'),end=old.indexOf('const fixtures=inputs.map',start);
assert(start>=0&&end>start);
runInNewContext(old.slice(start,end),{assert,original,direction:'tests/lib/cloth-fluid-schur-direction.mjs',root:'.',copies:'копия',resolve,
  readFileSync:()=>linear,writeFileSync:(path,value)=>{saved[path]=value;}});
assert.equal(instrumentDirection(original),saved[resolve('копия','tests/lib/cloth-fluid-schur-direction.mjs')]);
assert.equal(instrumentSparse(linear),saved[resolve('копия','tests/lib/cloth-sparse-wasm.mjs')]);
assert.throws(()=>instrumentDirection(original.replace('  const nc=m.pos.length','  const nc=this.pos.length')),/Граница/);
assert.throws(()=>instrumentSparse(linear.replace('    counts.numericFactorizations++;','    counts.numericFactorizations+=1;')),/Граница/);
console.log('Общий генератор таймеров: обе прежние копии совпали побайтно; изменённые границы отвергнуты.');
