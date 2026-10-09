// Известные неподвижные состояния: часы давления не ускоряются с механикой.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createClothLiveWind} from './lib/cloth-live-wind.mjs';
import {liveWindSailMotion} from './lib/cloth-live-wind-sail-motion.mjs';
const [out]=process.argv.slice(2);assert(out&&process.argv.length===3&&!existsSync(out));
const pack=JSON.parse(readFileSync('out/export/physics.json'));
let exactSamples=0,heldSamples=0;
for(const side of ['plus','minus']) {
  const f=JSON.parse(readFileSync(`out/acceptance/fluid-live-sv20-dry-20261009-${side}.json`)),r=f.recipe;
  const motion={pos:Float64Array.from(r.positions.slice(0,3*r.rows*r.cols)),vel:new Float64Array(3*r.rows*r.cols),
    body:{originM:[0,0,0],orientation9:[1,0,0,0,1,0,0,0,1],velocity6:[0,0,0,0,0,0]},ropeLengthsM:[f.sheet.lengthM]};
  const legacy=createClothLiveWind(pack,r),samples=[];
  for(let k=0;k<30;k++)samples.push(legacy.evaluate(motion,{windSpeedMPS:k<15?4:4.5,windFromDeg:side==='plus'?140:-140},k/60));
  for(const ratio of [1,2,4]) {
    const air=createClothLiveWind(pack,r,{hS:1/(60*ratio),pressureClock:'sampled-60hz-v1'});
    for(let k=0;k<30*ratio;k++) {
      const coarse=Math.floor(k/ratio),a=air.evaluate(motion,{windSpeedMPS:coarse<15?4:4.5,windFromDeg:side==='plus'?140:-140},k/(60*ratio));
      assert.deepEqual(Array.from(a.forceN),Array.from(samples[coarse].forceN));
      assert.deepEqual(a.audit.totalForceN,samples[coarse].audit.totalForceN);
      assert.equal(a.audit.pressureClock.index,coarse);assert.equal(a.audit.pressureClock.updated,k%ratio===0);
      if(k%ratio===0)exactSamples++;else heldSamples++;
    }
  }
}
let rejected=0;
const r=JSON.parse(readFileSync('out/acceptance/fluid-live-sv20-dry-20261009-plus.json')).recipe;
for(const options of [{hS:0},{hS:NaN},{pressureClock:'unknown'},{hS:1/80,pressureClock:'sampled-60hz-v1'}]) {
  assert.throws(()=>createClothLiveWind(pack,r,options));rejected++;
}
for(const options of [{hS:1/120},{timeRefinement:'unknown'},{hS:1/80,timeRefinement:'sampled-air-60hz-v1',bodyProfile:'sv20-rig-budget-point-v1'},
  {hS:1/120,timeRefinement:'sampled-air-60hz-v1'}]) {
  assert.throws(()=>liveWindSailMotion(r,{},undefined,{pack,...options}));rejected++;
}
const hash=b=>createHash('sha256').update(b).digest('hex');
writeFileSync(out,JSON.stringify({schema:'cloth-live-wind-time-check-v1',phase:'complete',exactSamples,heldSamples,rejected,
  sources:Object.fromEntries(['tests/cloth-live-wind-time.test.mjs','tests/lib/cloth-live-wind.mjs','tests/lib/cloth-live-wind-sail-motion.mjs','out/export/physics.json'].map(p=>[p,hash(readFileSync(p))])),
  scope:'Неподвижная форма, обе стороны: прежние 60 Гц давления точно сохранены при 60/120/240 Гц механики. Не проверка движения или временной сходимости воздуха.'},null,2)+'\n',{flag:'wx'});
console.log(`Часы давления: ${exactSamples} точных отсчётов, ${heldSamples} удержанных подшагов, ${rejected} отказов — пройдены.`);
