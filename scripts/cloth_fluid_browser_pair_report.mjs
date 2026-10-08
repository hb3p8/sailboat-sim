// Проверка происхождения двух графов, полной физики и вложенных интервалов.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {instrumentDirection,instrumentSparse,instrumentMaterialHessian,instrumentReadSoft,instrumentMaterialValues} from '../tests/probes/cloth-direction-instrument.mjs';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),fixture=args.find(a=>a.startsWith('--fixture='))?.slice(10),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===3&&input&&fixture&&out&&!existsSync(out));
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),r=JSON.parse(bytes),fb=readFileSync(fixture),f=JSON.parse(fb),copies=fixture+'.sources';
assert.equal(f.schema,'cloth-fluid-browser-pair-fixture-v1');assert.equal(r.schema,'cloth-fluid-browser-pair-v1');assert.equal(f.phase,'complete');assert.equal(r.phase,'complete');assert.equal(f.dirty,false);
assert.equal(r.input.path,'/'+fixture);assert.equal(r.input.sha256,hash(fb));assert.equal(r.fixtureRevision,f.revision);assert.equal(r.fixtureDirty,false);assert.equal(r.profile,f.profile);assert([1,2,3].includes(r.pair));
assert.deepEqual(r.graphs,f.graphs);assert.deepEqual(r.modules,f.modules);
assert.equal(typeof f.profile,'boolean');
assert.deepEqual(Object.keys(f.graphs.baseline.originalSha256).sort(),Object.keys(f.graphs.candidate.originalSha256).sort());
assert.deepEqual(f.changedSources,Object.entries(f.graphs.baseline.originalSha256).filter(([p,h])=>f.graphs.candidate.originalSha256[p]!==h).map(([p])=>p));
const correctionProfile=f.correctionProfile??false;assert.equal(typeof correctionProfile,'boolean');assert.equal(Boolean(r.correctionProfile),correctionProfile);assert(!correctionProfile||f.profile);
const materialProfile=f.materialProfile??false;assert.equal(typeof materialProfile,'boolean');assert.equal(Boolean(r.materialProfile),materialProfile);assert(!materialProfile||f.profile&&!correctionProfile);
for(const g of Object.values(f.graphs))assert.deepEqual(g.instrumented,f.profile?[...(materialProfile?['tests/lib/cloth-fluid-body-motion.mjs']:[]),'tests/lib/cloth-fluid-schur-direction.mjs','tests/lib/cloth-sparse-wasm.mjs',...(correctionProfile||materialProfile?['tests/probes/cloth-material-wasm.mjs']:[])]:[]);
for(const [p,h] of Object.entries(f.sourceSha256)){assert.equal(hash(readFileSync(resolve(copies,p))),h);assert.equal(hash(execFileSync('git',['show',f.revision+':'+p],{maxBuffer:16*1024*1024})),h);}
for(const [v,g] of Object.entries(f.graphs))for(const [p,h] of Object.entries(g.originalSha256)){
  const original=execFileSync('git',['show',g.revision+':'+p],{maxBuffer:16*1024*1024});assert.equal(hash(original),h);let expected=original;
  if(g.instrumented.includes(p)){assert.equal(f.profile,true);assert.equal(hash(readFileSync(resolve(copies,v,p+'.original'))),h);expected=Buffer.from(p.includes('schur')?instrumentDirection(original.toString(),{correction:correctionProfile}):p.includes('body-motion')?instrumentReadSoft(original.toString()):p.includes('material')?(materialProfile?instrumentMaterialValues(original.toString()):instrumentMaterialHessian(original.toString())):instrumentSparse(original.toString()));}
  assert.equal(hash(expected),g.sourceSha256[p]);assert.equal(hash(readFileSync(resolve(copies,v,p))),g.sourceSha256[p]);}
for(const part of [...f.inputs,...Object.values(f.modules)])assert.equal(hash(readFileSync(part.path)),part.sha256);
assert.equal(hash(readFileSync(f.source.path)),f.source.sha256);assert.equal(r.page.sha256,f.sourceSha256['tests/probes/cloth-fluid-browser-pair-review.html']);
assert.equal(r.page.endedVisibility,'visible');assert(r.page.visibility.length&&r.page.visibility.every(x=>x.state==='visible'));
assert(r.page.url.endsWith('/tests/probes/cloth-fluid-browser-pair-review.html?input=/'+fixture));assert.equal(r.records.length,360);
const report={schema:'cloth-fluid-browser-pair-report-v1',phase:'checking',input:{path:input,sha256:hash(bytes)},fixture:{path:fixture,sha256:hash(fb)},pair:r.pair,profile:r.profile,changedSources:f.changedSources,exactPairs:0,rows:[]};
let k=0;for(const part of f.inputs){const old=JSON.parse(readFileSync(part.path)),rows=[];
  for(const s of old.steps){const x=r.records[k++];assert.equal(x.side,part.side);assert.equal(x.step,s.index);assert.deepEqual(x.order,(s.index+r.pair)%2?['baseline','candidate']:['candidate','baseline']);
    assert.deepEqual(x.states.baseline,x.states.candidate);
    for(const v of ['baseline','candidate']){assert.deepEqual(x.states[v],{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});const t=x.times[v];assert(Number.isFinite(t.stepMs)&&t.stepMs>=0);assert.equal(Boolean(t.profile),f.profile);
      if(f.profile){const p=t.profile;assert(Math.abs(p.loadMs+p.physicsMs-t.stepMs)<1e-6);assert.equal(p.linear.factorCalls,t.wasm.numericFactorizations);
        for(const group of Object.values(p.directions)){assert.equal(new Set(Object.values(group).map(y=>y.calls)).size,1);assert(Object.values(group).every(y=>y.ms>=-1e-6&&Number.isFinite(y.ms)));}
        const directionMs=Object.values(p.directions).flatMap(Object.values).reduce((sum,y)=>sum+y.ms,0);
        assert(directionMs<=p.stages.direction.inclusiveMs+1e-6);assert.equal(p.directions.ordinary.linear.calls+p.directions.correction.linear.calls,p.linear.factorCalls);
        assert(Object.values(p.sparse).every(y=>y.ms>=-1e-6&&Number.isFinite(y.ms)));assert.equal(p.sparse.factorNative.calls,p.linear.factorCalls);
        assert(Object.values(p.sparse).reduce((sum,y)=>sum+y.ms,0)<=p.directions.ordinary.linear.ms+p.directions.correction.linear.ms+1e-6);
        if(correctionProfile){const c=p.correction,m=p.materialHessian;assert(c&&m);assert(Object.values(c).every(y=>y.ms>=-1e-6&&Number.isFinite(y.ms)));
          assert(c.local.ms+c.scatter.ms<=p.directions.correction.clothMatrix.ms+1e-6);assert.equal(new Set(Object.values(m).map(y=>y.calls)).size,1);assert.equal(m.native.calls,c.local.calls);
          assert(Object.values(m).every(y=>y.ms>=-1e-6&&Number.isFinite(y.ms)));assert(Object.values(m).reduce((sum,y)=>sum+y.ms,0)<=c.local.ms+1e-6);}
        if(materialProfile){const a=p.readSoft,b=p.materialValues;assert(a&&b);const sum=g=>Object.values(g).reduce((s,y)=>s+y.ms,0);
          for(const g of [a,...Object.values(b)]){assert.equal(new Set(Object.values(g).map(y=>y.calls)).size,1);assert(Object.values(g).every(y=>y.ms>=-1e-6&&Number.isFinite(y.ms)));}
          assert(sum(a)<=p.stages.readSoft.inclusiveMs+1e-6);assert(sum(b.group)<=a.evaluate.ms+1e-6);assert.equal(b.group.native.calls,a.evaluate.calls);
          assert(sum(b.group)+sum(b.single)<=p.physicsMs+1e-6);}
      }}rows.push(x);report.exactPairs++;}
  const row={side:part.side,variants:{}};for(const v of ['baseline','candidate']){const a=rows.slice(1).map(x=>x.times[v].stepMs).sort((a,b)=>a-b),event=rows[120];
    row.variants[v]={firstMs:rows[0].times[v].stepMs,meanMs:a.reduce((s,x)=>s+x,0)/179,p95Ms:a[170],maxMs:a.at(-1),overBudget:a.filter(x=>x>1000/60).length,
      stopMs:event.times[v].stepMs,iterations:event.states[v].audit.solver.iterations};
    if(f.profile){const stages={},sparse={},group=rows.slice(1),total=group.reduce((sum,x)=>sum+x.times[v].stepMs,0);
      for(const kind of ['ordinary','correction']){stages[kind]={};for(const name of Object.keys(group[0].times[v].profile.directions[kind])){const ms=group.reduce((sum,x)=>sum+x.times[v].profile.directions[kind][name].ms,0),calls=group.reduce((sum,x)=>sum+x.times[v].profile.directions[kind][name].calls,0);stages[kind][name]={ms,calls,percent:100*ms/total};}}
      for(const name of Object.keys(group[0].times[v].profile.sparse)){const ms=group.reduce((sum,x)=>sum+x.times[v].profile.sparse[name].ms,0);sparse[name]={ms,percent:100*ms/total};}
      row.variants[v].directions=stages;row.variants[v].sparse=sparse;row.variants[v].stopProfile=event.times[v].profile;
      if(correctionProfile)for(const name of ['correction','materialHessian'])row.variants[v][name]=Object.fromEntries(Object.keys(group[0].times[v].profile[name]).map(k=>{
        const ms=group.reduce((sum,x)=>sum+x.times[v].profile[name][k].ms,0),calls=group.reduce((sum,x)=>sum+x.times[v].profile[name][k].calls,0);return[k,{ms,calls,percent:100*ms/total}];}));
      if(materialProfile){const aggregate=g=>Object.fromEntries(Object.keys(g(group[0])).map(k=>{
        const ms=group.reduce((s,x)=>s+g(x)[k].ms,0),calls=group.reduce((s,x)=>s+g(x)[k].calls,0);return[k,{ms,calls,percent:100*ms/total}];}));
        row.variants[v].readSoft=aggregate(x=>x.times[v].profile.readSoft);
        row.variants[v].materialValues=Object.fromEntries(['group','single'].map(kind=>[kind,aggregate(x=>x.times[v].profile.materialValues[kind])]));}
    }}row.changePercent=100*(row.variants.candidate.meanMs/row.variants.baseline.meanMs-1);report.rows.push(row);
}
assert.equal(r.exactPairs,360);report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Браузерная пара ${r.pair}: 360 полных пар, источники/числа${f.profile?'/вложенные стадии':''} — пройдены.`);
