// Сопоставление полной истории паруса с верёвкой на трёх шагах времени.
// Измеряет различия; успешный отчёт не принимает учебное поведение генакера.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rotate3,transpose3} from '../tests/lib/cloth-fluid-inertia.mjs';
const args=process.argv.slice(2),inputs=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),output=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(inputs.length===6&&output&&args.length===7,'Нужны шесть --input и новый --out');
assert(!existsSync(output),'Отчёт нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'),records=inputs.map(path=>{
  const bytes=readFileSync(path),r=JSON.parse(bytes);assert.equal(r.schema,'cloth-fluid-rope-sail-v1');
  assert.equal(r.phase,'complete');assert.equal(r.dirty,false);
  for(const [p,sha] of Object.entries(r.sourceSha256))assert.equal(hash(execFileSync('git',['show',`${r.revision}:${p}`],{maxBuffer:16*1024*1024})),sha);
  assert.equal(r.physicsSha256,hash(readFileSync('out/export/physics.json')));
  for(const {audit:a} of r.steps) {
    assert(a.maxPhysicalResidualN<=a.solver.forceToleranceN&&a.maxHardViolationM<=a.solver.lengthToleranceM);
    assert(a.dualViolationN<=a.solver.dualToleranceN&&a.complementarityJ<=a.solver.complementarityToleranceJ);
    assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ&&Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
    for(const rope of a.ropes)assert(Math.abs(rope.controlResidualJ)<=rope.controlLimitJ);
  }
  return {path,sha256:hash(bytes),r};
});
const first=records[0].r;
const helper='tests/lib/cloth-fluid-inertia.mjs';assert.equal(hash(readFileSync(helper)),first.sourceSha256[helper]);
for(const {r} of records) {
  assert.deepEqual(r.sourceSha256,first.sourceSha256);assert.deepEqual(r.parameters.material,first.parameters.material);
  assert.deepEqual(r.parameters.bodyInput,first.parameters.bodyInput);assert.deepEqual(r.parameters.addedMass6,first.parameters.addedMass6);
  assert.equal(r.parameters.rateMPS,first.parameters.rateMPS);assert.equal(r.parameters.rows,11);assert.equal(r.parameters.cols,9);
}
const distances=(a,b)=>{
  assert.equal(a.length,b.length);let sum=0,maxM=0;
  for(let k=0;k<a.length;k+=3){const d=Math.hypot(a[k]-b[k],a[k+1]-b[k+1],a[k+2]-b[k+2]);sum+=d*d;maxM=Math.max(maxM,d);}
  return {maxM,rmsM:Math.sqrt(sum/(a.length/3))};
};
const local=s=>{
  const R=transpose3(s.body.orientation9),o=s.body.originM,q=s.positionsM,out=[];
  for(let k=0;k<q.length;k+=3)out.push(...rotate3(R,q.slice(k,k+3).map((v,d)=>v-o[d])));return out;
};
const comparison=[];
for(const tack of [1,-1]) {
  const group=records.filter(x=>x.r.parameters.tack===tack).sort((a,b)=>b.r.parameters.hS-a.r.parameters.hS);
  assert.equal(group.length,3);assert.deepEqual(group.map(x=>Math.round(1/x.r.parameters.hS)),[60,120,240]);
  group.slice(1).forEach(({r})=>{
    assert.deepEqual(r.initial,group[0].r.initial);assert.deepEqual(r.parameters.sheet,group[0].r.parameters.sheet);
    assert.equal(r.input.sha256,group[0].r.input.sha256);
  });
  for(let j=0;j<2;j++) {
    const a=group[j].r,b=group[j+1].r;
    const ratio=Math.round(a.parameters.hS/b.parameters.hS);assert.equal(ratio,2);assert.equal(b.steps.length,a.steps.length*ratio);
    const samples=a.steps.map((s,i)=>{
      const t=b.steps[ratio*(i+1)-1];assert(Math.abs(s.timeS-t.timeS)<1e-12);assert.deepEqual(s.controls,t.controls);
      return {timeS:s.timeS,world:distances(s.positionsM,t.positionsM),bodyRelative:distances(local(s),local(t)),
        originM:Math.hypot(...s.body.originM.map((v,d)=>v-t.body.originM[d])),
        tensionDifferenceN:Math.abs(s.audit.ropes[0].tensionN-t.audit.ropes[0].tensionN)};
    });
    const maximum=fn=>Math.max(...samples.map(fn));
    comparison.push({tack,hz:[1/a.parameters.hS,1/b.parameters.hS],commonSamples:samples.length,
      maximum:{worldM:maximum(s=>s.world.maxM),bodyRelativeM:maximum(s=>s.bodyRelative.maxM),originM:maximum(s=>s.originM),tensionN:maximum(s=>s.tensionDifferenceN)},
      final:samples.at(-1),samples});
  }
}
const integrals=records.map(({path,r})=>({path,tack:r.parameters.tack,hz:1/r.parameters.hS,steps:r.steps.length,
  bodyImpulseNs:[0,1,2].map(d=>r.steps.reduce((sum,s)=>sum+s.audit.bodyForceN[d]*r.parameters.hS,0)),
  bodyMomentIntegralNms:[0,1,2].map(d=>r.steps.reduce((sum,s)=>sum+s.audit.bodyMomentNm[d]*r.parameters.hS,0)),
  controlWorkJ:r.steps.reduce((sum,s)=>sum+s.audit.ropes[0].controlWorkJ,0),
  engagementLossJ:r.steps.reduce((sum,s)=>sum+s.audit.ropes[0].engagementLossJ,0),
  turnLossJ:r.steps.reduce((sum,s)=>sum+s.audit.ropes[0].turnLossJ,0),...r.summary}));
const result={schema:'cloth-fluid-rope-refinement-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  inputs:records.map(({path,sha256})=>({path,sha256})),sourceSha256:{
    [relative(process.cwd(),fileURLToPath(import.meta.url))]:hash(readFileSync(new URL(import.meta.url))),[helper]:hash(readFileSync(helper))},
  physicalAcceptance:false,scope:'Один крой 11×9, лабораторное тело/вода и замороженный воздух, вся история на общих моментах; нет приёмки сетки ткани или живого обучения.',
  integrals,comparison};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({отчёт:output,принято_шагов:integrals.reduce((sum,r)=>sum+r.steps,0),сравнение:comparison.map(({tack,hz,maximum,final})=>({сторона:tack,частота_Гц:hz,максимум:maximum,конец:final}))}));
