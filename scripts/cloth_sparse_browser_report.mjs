// Независимая сверка загруженного браузерного результата с захватом и Git.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),capturePath=args.find(a=>a.startsWith('--capture='))?.slice(10),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===3&&input&&capturePath&&out&&args.every(a=>/^--(input|capture|out)=.+$/.test(a))&&!existsSync(out));
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),r=JSON.parse(bytes),cb=readFileSync(capturePath),c=JSON.parse(cb);
assert.equal(r.schema,'cloth-sparse-browser-probe-v1');assert.equal(r.phase,'complete');assert.equal(c.phase,'complete');assert.equal(c.dirty,false);
assert.equal(r.input.path,'/'+capturePath);assert.equal(r.input.sha256,hash(cb));assert.equal(r.captureRevision,c.revision);assert.equal(r.captureDirty,false);
assert.deepEqual(r.modules,c.modules);assert.deepEqual(r.sourceSha256,c.sourceSha256);assert([1,2,3].includes(r.pair)&&['native','plain','profile'].includes(r.mode));
for(const [p,h] of Object.entries(c.sourceSha256)){
  assert.equal(hash(readFileSync(resolve(capturePath+'.sources',p))),h);
  assert.equal(hash(execFileSync('git',['show',c.revision+':'+p],{maxBuffer:16*1024*1024})),h);}
for(const part of [...Object.values(c.modules),c.binary,...c.inputs])assert.equal(hash(readFileSync(part.path)),part.sha256);
assert.equal(r.page.sha256,c.sourceSha256['tests/probes/cloth-sparse-browser-review.html']);assert.equal(r.page.endedVisibility,'visible');
assert(r.page.visibility.length>=1&&r.page.visibility.every(v=>v.state==='visible'&&Number.isFinite(v.at)));
assert(r.page.url.endsWith('/tests/probes/cloth-sparse-browser-review.html?input=/'+capturePath));
const report={schema:'cloth-sparse-browser-report-v1',input:{path:input,sha256:hash(bytes)},capture:{path:capturePath,sha256:hash(cb)},mode:r.mode,pair:r.pair,
  exactPairs:0,rows:[],rule:'Независимая проверка источников/байтов/порядка/всех записей. Браузерные пары до JSON сравниваются по Object.is; JSON не сохраняет знак нуля. Время по часам, без вывода о CPU/кадрах.'};
const times=new Map(),add=(key,v)=>{if(!times.has(key))times.set(key,{baseline:[],candidate:[]});for(const name of ['baseline','candidate'])times.get(key)[name].push(v[name]);};
if(r.mode==='native'){
  assert.equal(r.records.length,c.samples.length*6);
  for(let k=0;k<r.records.length;k++){const x=r.records[k],s=c.samples[k%c.samples.length],repeat=Math.floor(k/c.samples.length);
    for(const key of ['side','step','call','pattern'])assert.equal(x[key],s[key]);assert.equal(x.repeat,repeat);
    assert.deepEqual(x.order,(k%c.samples.length+repeat+r.pair)%2?['baseline','candidate']:['candidate','baseline']);
    for(const v of ['baseline','candidate']){const t=x.times[v];assert.equal(t.failure,0);assert(Object.values(t).every(y=>Number.isFinite(y)&&y>=0));assert(Math.abs(t.elapsedMs-t.copyMs-t.nativeMs)<1e-6);}
    add(`${x.side}/${x.step}/${repeat===0?'initial':'repeated'}`,Object.fromEntries(['baseline','candidate'].map(v=>[v,x.times[v].nativeMs])));report.exactPairs++;
  }
  const factors=c.samples.reduce((sum,s)=>sum+s.matrix.length,0)*6,scratch=c.samples.reduce((sum,s)=>sum+c.patterns[s.pattern].n+c.patterns[s.pattern].colRows.length,0)*6;
  assert.equal(r.factorElements,factors);assert.equal(r.scratchElements,scratch);
  for(const v of ['baseline','candidate']){assert(Number.isFinite(r.preparation[v].compileMs));assert.equal(r.preparation[v].patterns.length,c.patterns.length);
    for(const p of r.preparation[v].patterns){assert.equal(p.planned,v==='candidate');assert.equal(p.finalBytes-p.initialBytes,p.grownPages*65536);
      assert(Math.abs(p.instanceMs+p.allocationMs+p.growMs+p.uploadMs+p.planMs-p.setupMs)<1e-6);}}
}else {
  assert.equal(r.records.length,360);
  let k=0;for(const part of c.inputs){const old=JSON.parse(readFileSync(part.path));
    for(const s of old.steps){const x=r.records[k++];assert.equal(x.side,part.side);assert.equal(x.step,s.index);
      assert.deepEqual(x.order,(s.index+r.pair)%2?['baseline','candidate']:['candidate','baseline']);assert.deepEqual(x.states.baseline,x.states.candidate);
      for(const v of ['baseline','candidate']){assert.deepEqual(x.states[v],{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});const t=x.times[v];assert(Number.isFinite(t.stepMs)&&t.stepMs>=0);
        assert.equal(Boolean(t.profile),r.mode==='profile');if(t.profile){const p=t.profile;assert(Math.abs(p.loadMs+p.physicsMs-t.stepMs)<1e-6);
          assert.equal(p.linear.factorCalls,t.wasm.numericFactorizations);assert(Object.values(p.stages).every(y=>y.selfMs>=-1e-6&&y.selfMs<=y.inclusiveMs+1e-6));
          assert(Object.values(p.stages).reduce((sum,y)=>sum+y.selfMs,0)<=p.physicsMs+1e-6);}}
      if(s.index>1)add(part.side+'/working',Object.fromEntries(['baseline','candidate'].map(v=>[v,x.times[v].stepMs])));
      if([1,45,120,121,122].includes(s.index))add(part.side+'/'+s.index,Object.fromEntries(['baseline','candidate'].map(v=>[v,x.times[v].stepMs])));
      report.exactPairs++;
    }
  }
}
assert.equal(r.exactPairs,report.exactPairs);
for(const [key,t] of times){const row={key,count:t.baseline.length};for(const v of ['baseline','candidate']){const a=t[v].slice().sort((a,b)=>a-b);row[v]={sumMs:a.reduce((s,x)=>s+x,0),meanMs:a.reduce((s,x)=>s+x,0)/a.length,p95Ms:a[Math.ceil(.95*a.length)-1],maxMs:a.at(-1)};}
  row.changePercent=100*(row.candidate.meanMs/row.baseline.meanMs-1);report.rows.push(row);}
report.preparation=r.preparation;report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Изолированный браузерный опыт ${r.mode}/${r.pair}: ${report.exactPairs} пар, источники/порядок/все числа — пройдены.`);
