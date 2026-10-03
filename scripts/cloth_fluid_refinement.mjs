// Полная история ткани/тела с водой на общих временах и интегралы реакций.
// Ни ошибка остатка, ни один последний кадр не заменяют уточнение времени.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [output,...paths]=process.argv.slice(2);
assert(output&&paths.length===3&&!existsSync(output),'Нужны новый JSON и три полные серии 60/120/240 Гц');
const hash=b=>createHash('sha256').update(b).digest('hex');
const records=paths.map(p=>JSON.parse(readFileSync(p)));
for(const [i,r] of records.entries()) {
  assert.equal(r.schema,'cloth-fluid-sail-v1');assert.equal(r.phase,'complete');
  assert.equal(r.parameters.hS,1/[60,120,240][i]);
  assert.equal(r.steps.length,r.parameters.requestedSteps);
  assert.equal(r.steps.length*r.parameters.hS,records[0].steps.length*records[0].parameters.hS);
  for(const key of ['bodyInput','addedMass6','material','tack','scope'])assert.deepEqual(r.parameters[key],records[0].parameters[key]);
  for(const key of ['sourceSha256','physicsSha256','wasm','input','backend','initial','revision','dirty'])assert.deepEqual(r[key],records[0][key]);
  r.steps.forEach((s,j)=>{
    assert.equal(s.step,j+1);assert.equal(s.positionsM.length,r.initial.positionsM.length);
    const a=s.audit,t=a.solver;
    assert(t.converged&&a.maxPhysicalResidualN<=t.forceToleranceN&&a.maxHardViolationM<=t.lengthToleranceM);
    assert(a.dualViolationN<=t.dualToleranceN&&a.complementarityJ<=t.complementarityToleranceJ);
    assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ&&Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
    assert(s.positionsM.every(Number.isFinite));
  });
}
const norm=v=>Math.hypot(...v),difference=(a,b)=>a.map((x,i)=>x-b[i]);
function inBodyFrame(s) {
  const {originM:c,orientation9:R}=s.body;
  return s.positionsM.map((_,k)=>[0,1,2].reduce((v,d)=>v+R[3*d+k%3]*(s.positionsM[3*Math.floor(k/3)+d]-c[d]),0));
}
const pairs=[];
for(let p=0;p<2;p++) {
  const a=records[p],b=records[p+1],n=a.initial.positionsM.length/3,metrics=[];
  for(let i=0;i<a.steps.length;i++) {
    const x=a.steps[i],y=b.steps[2*i+1];assert.equal(y.step,2*x.step);
    const rms=(u,v)=>Math.sqrt(difference(u,v).reduce((s,d)=>s+d*d,0)/n);
    metrics.push({timeS:x.step*a.parameters.hS,worldShapeRmsM:rms(x.positionsM,y.positionsM),
      bodyShapeRmsM:rms(inBodyFrame(x),inBodyFrame(y)),
      originDifferenceM:norm(difference(x.body.originM,y.body.originM)),
      rotationMatrixDifference:norm(difference(x.body.orientation9,y.body.orientation9)),
      bodyLinearVelocityDifferenceMS:norm(difference(x.body.velocity6.slice(0,3),y.body.velocity6.slice(0,3))),
      bodyAngularVelocityDifferenceRadS:norm(difference(x.body.velocity6.slice(3),y.body.velocity6.slice(3)))});
  }
  const integral=(r,key)=>[0,1,2].map(d=>r.steps.reduce((s,x)=>s+r.parameters.hS*x.audit[key][d],0));
  pairs.push({hz:[[60,120],[120,240]][p],metrics,
    maximum:Object.fromEntries(Object.keys(metrics[0]).filter(k=>k!=='timeS').map(k=>[k,Math.max(...metrics.map(x=>x[k]))])),
    final:metrics.at(-1),bodyImpulseDifferenceNs:norm(difference(integral(a,'bodyForceN'),integral(b,'bodyForceN'))),
    bodyAngularImpulseDifferenceNms:norm(difference(integral(a,'bodyMomentNm'),integral(b,'bodyMomentNm')))});
}
const quantities=['worldShapeRmsM','bodyShapeRmsM','originDifferenceM','rotationMatrixDifference',
  'bodyLinearVelocityDifferenceMS','bodyAngularVelocityDifferenceRadS'];
const decreases=quantities.every(k=>pairs[1].maximum[k]<pairs[0].maximum[k])&&
  pairs[1].bodyImpulseDifferenceNs<pairs[0].bodyImpulseDifferenceNs&&
  pairs[1].bodyAngularImpulseDifferenceNms<pairs[0].bodyAngularImpulseDifferenceNms;
const record={schema:'cloth-fluid-refinement-v1',createdAt:new Date().toISOString(),
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  inputs:paths.map(p=>({path:p,sha256:hash(readFileSync(p))})),
  sourceSha256:{'scripts/cloth_fluid_refinement.mjs':hash(readFileSync('scripts/cloth_fluid_refinement.mjs'))},
  bodyFrame:'Измеренный поворот транспонируется, координаты/ортогональность не исправляются',pairs,decreases};
writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({запись:output,уменьшаются:decreases,пары:pairs.map(({metrics,...r})=>r)}));
assert(decreases,'Уточнение не уменьшило все заранее выбранные различия');
