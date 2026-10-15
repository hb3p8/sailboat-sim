// Архитектурная граница: выпуск не должен загружать раннеры/Node или tests.
import assert from 'node:assert/strict';
import {gennakerRuntimeGraph} from '../scripts/gennaker_runtime_graph.mjs';
const graph=gennakerRuntimeGraph();
assert(Object.keys(graph).length>20);
for(const path of Object.keys(graph))assert(path.startsWith('sim/'));
const names=['implicit-motion','energy-motion','linear-solve','sparse-solve','kkt-direction','sparse-wasm','material','sv20-mass','fluid-inertia','shared-input'];
for(const name of names) {
  const canonical=await import('../sim/cloth/cloth-'+name+'.mjs'),compatibility=await import('./lib/cloth-'+name+'.mjs');
  for(const key of Object.keys(canonical))assert.equal(compatibility[key],canonical[key]);
  assert(graph['sim/cloth/cloth-'+name+'.mjs']);
}
for(const name of ['wasm','engine-check']) {
  const canonical=await import('../sim/cloth/cloth-material-'+name+'.mjs'),compatibility=await import('./probes/cloth-material-'+name+'.mjs');
  for(const key of Object.keys(canonical))assert.equal(compatibility[key],canonical[key]);
}
const core=await import('../sim/cloth/cloth-compliance.mjs'),examples=await import('./cloth-compliance.mjs');
for(const key of Object.keys(core))assert.equal(examples[key],core[key]);
console.log('Граф выпуска замкнут в sim; совместимые входы используют те же функции библиотеки.');
