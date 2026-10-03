// Уточнение времени на одном полном парусе и одной известной опоре.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [output,...paths]=process.argv.slice(2);
assert(paths.length===3&&!existsSync(output),'Нужны новый JSON и три полные серии 60/120/240 Гц');
const hash=b=>createHash('sha256').update(b).digest('hex');
const records=paths.map(p=>JSON.parse(readFileSync(p)));
for(const [i,r] of records.entries()) {
  assert.equal(r.phase,'complete');assert.equal(r.config.hS,1/[60,120,240][i]);
  for(const key of ['bodyInput','durationS','tack','tolerances'])assert.deepEqual(r.config[key],records[0].config[key]);
  for(const key of ['sourceSha256','physicsSha256','wasm','input'])assert.deepEqual(r[key],records[0][key]);
}
const norm=v=>Math.hypot(...v),difference=(a,b)=>a.map((x,i)=>x-b[i]);
function inBodyFrame(s,n) {
  const {bodyOriginM:c,bodyRotationFromReference:R}=s.audit;
  return s.positionsM.slice(0,3*n).map((_,k)=>[0,1,2].reduce((v,d)=>v+R[3*d+k%3]*(s.positionsM[3*Math.floor(k/3)+d]-c[d]),0));
}
const pairs=[];
for(let p=0;p<2;p++) {
  const a=records[p],b=records[p+1],n=a.recipe.rows*a.recipe.cols,metrics=[];
  for(let i=0;i<a.steps.length;i++) {
    const x=a.steps[i],y=b.steps[2*i+1];assert.equal(x.timeS,y.timeS);
    const rms=(u,v)=>Math.sqrt(difference(u,v).reduce((s,d)=>s+d*d,0)/n);
    metrics.push({timeS:x.timeS,worldShapeRmsM:rms(x.positionsM.slice(0,3*n),y.positionsM.slice(0,3*n)),
      bodyShapeRmsM:rms(inBodyFrame(x,n),inBodyFrame(y,n)),
      originDifferenceM:norm(difference(x.audit.bodyOriginM,y.audit.bodyOriginM)),
      rotationMatrixDifference:norm(difference(x.audit.bodyRotationFromReference,y.audit.bodyRotationFromReference))});
  }
  const impulse=r=>[0,1,2].map(d=>r.steps.reduce((s,x)=>s+r.config.hS*x.audit.bodyForceN[d],0));
  const moment=r=>[0,1,2].map(d=>r.steps.reduce((s,x)=>s+r.config.hS*x.audit.bodyMomentNm[d],0));
  pairs.push({hz:[[60,120],[120,240]][p],metrics,
    maximum:Object.fromEntries(Object.keys(metrics[0]).filter(k=>k!=='timeS').map(k=>[k,Math.max(...metrics.map(x=>x[k]))])),
    final:metrics.at(-1),bodyImpulseDifferenceNs:norm(difference(impulse(a),impulse(b))),
    bodyAngularImpulseDifferenceNms:norm(difference(moment(a),moment(b)))});
}
const quantities=['worldShapeRmsM','bodyShapeRmsM','originDifferenceM','rotationMatrixDifference'];
const decreases=quantities.every(k=>pairs[1].maximum[k]<pairs[0].maximum[k])&&
  pairs[1].bodyImpulseDifferenceNs<pairs[0].bodyImpulseDifferenceNs&&
  pairs[1].bodyAngularImpulseDifferenceNms<pairs[0].bodyAngularImpulseDifferenceNms;
const record={schema:1,createdAt:new Date().toISOString(),inputs:paths.map(p=>({path:p,sha256:hash(readFileSync(p))})),
  sourceSha256:{'scripts/cloth_rigid_sail_refinement.mjs':hash(readFileSync('scripts/cloth_rigid_sail_refinement.mjs'))},
  bodyFrame:'Собственный вид через транспонированный измеренный поворот; исправления ортогональности нет',pairs,decreases};
writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,decreases,pairs:pairs.map(({hz,maximum,final,bodyImpulseDifferenceNs,bodyAngularImpulseDifferenceNms})=>
  ({hz,maximum,final,bodyImpulseDifferenceNs,bodyAngularImpulseDifferenceNms}))},null,2));
assert(decreases,'Уточнение не уменьшило все заранее выбранные интегральные различия');
