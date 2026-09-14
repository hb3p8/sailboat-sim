import { readFileSync } from 'node:fs';
import { RUNS } from './tests/lib/runs.mjs';
import { gennakerSetOf } from './sim/aero.js';
const PACK=JSON.parse(readFileSync('out/export/physics.json','utf8'));
const G=PACK.rig.gennaker, D=Math.PI/180;
const A=PACK.rig.gennaker.area_m2 + PACK.rig.main_area_m2;
console.log('TWA 140°, шкот грота 80°: шкот  вынос   C_x');
for(const L of [5.5,6.0,6.4,6.6,7.0,7.4,7.7,8.0]){
  if(L>G.sheet_max_m) continue;
  const r=RUNS.sailForce(PACK,{twa:140,len:L,mainSheet:80,secs:25});
  console.log(`  ${L.toFixed(1)}   ${(gennakerSetOf({genSheetLen:L},G)/D).toFixed(1)}°   ${(r.drive/(r.q*A)).toFixed(3)}`);
}
