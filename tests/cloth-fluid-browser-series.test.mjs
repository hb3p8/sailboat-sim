// Неполная серия и отрицательные хвосты не должны исчезать в среднем времени.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {summarizeBrowserPairs} from '../scripts/cloth_fluid_browser_series.mjs';

const args=process.argv.slice(2),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===1&&out&&!existsSync(out));
const records=[],reports=[];
for(let pair=1;pair<=3;pair++) {
  const baseline=pair===3?100:1,candidate=[1.5,.5,90][pair-1];
  const r={schema:'cloth-fluid-browser-pair-v1',phase:'complete',pair,profile:false,exactPairs:360,
    input:{path:'/условия.json',sha256:'1'.repeat(64)},fixtureRevision:'2'.repeat(40),fixtureDirty:false,
    graphs:{baseline:{revision:'3'.repeat(40)},candidate:{revision:'2'.repeat(40)}},modules:{},
    liveWind:{mode:'recorded-sv20-air-water-v1'},environment:{userAgent:'Проверочный браузер',hardwareConcurrency:10,crossOriginIsolated:false},
    page:{url:'http://localhost/условия',sha256:'4'.repeat(64),width:1280,height:720,dpr:2,
      visibility:[{at:pair,state:'visible'}],endedVisibility:'visible'},records:[]};
  const report={schema:'cloth-fluid-browser-pair-report-v1',phase:'complete',pair,profile:false,exactPairs:360,
    fixture:{path:'условия.json',sha256:'1'.repeat(64)},liveWind:r.liveWind,rows:[]};
  for(const side of ['plus','minus']) {
    for(let step=1;step<=180;step++)r.records.push({side,step,times:{baseline:{stepMs:step===1?999:baseline},candidate:{stepMs:step===1?1000:candidate}}});
    report.rows.push({side,variants:{
      baseline:{firstMs:999,meanMs:baseline,p95Ms:baseline,maxMs:baseline,overBudget:pair===3?179:0,stopMs:baseline,iterations:2},
      candidate:{firstMs:1000,meanMs:candidate,p95Ms:candidate,maxMs:candidate,overBudget:pair===3?179:0,stopMs:candidate,iterations:2},
    },changePercent:100*(candidate/baseline-1)});
  }
  records.push(r);reports.push(report);
}

const partial=summarizeBrowserPairs([records[0]],[reports[0]]);
assert.equal(partial.phase,'partial');assert.equal(partial.completeSeries,false);assert.deepEqual(partial.missingPairs,[2,3]);
assert.equal(partial.exactPairs,360);assert.equal(partial.workingStepsPerVariant,358);
assert.equal(partial.pooled.baseline.meanMs,1);assert.equal(partial.pooled.candidate.meanMs,1.5);
assert.equal(partial.sceneBudgetAccepted,false);assert.equal(partial.allWorkingMeansLower,false);

const complete=summarizeBrowserPairs([...records].reverse(),[...reports].reverse());
assert.equal(complete.phase,'complete');assert.deepEqual(complete.completedPairs,[1,2,3]);assert.deepEqual(complete.missingPairs,[]);
assert.equal(complete.exactPairs,1080);assert.equal(complete.workingStepsPerVariant,1074);
assert.equal(complete.pooled.baseline.meanMs,34);assert.equal(complete.pooled.candidate.meanMs,92/3);
// У среднего трёх P95 было бы 34 мс; настоящий P95 полной выборки — 100 мс.
assert.equal(complete.pooled.baseline.p95Ms,100);assert.equal(complete.pooled.candidate.p95Ms,90);
assert.equal(complete.pooled.baseline.overBudget,358);assert.equal(complete.pooled.candidate.overBudget,358);
assert.equal(complete.allWorkingMeansLower,false);assert.equal(complete.sceneBudgetAccepted,false);
assert.deepEqual(complete.rows.map(r=>r.pair),[1,1,2,2,3,3]);
assert(complete.rows[0].regressions.includes('meanMs')&&complete.rows[0].regressions.includes('firstMs'));
assert.deepEqual(complete.rows[4].regressions,['firstMs']);

const rejected=[];
for(const [name,mutate] of [
  ['повтор-пары',(rs,ps)=>{rs[1].pair=1;ps[1].pair=1;}],
  ['наблюдаемые-часы',rs=>{rs[1].profile=true;}],
  ['разный-браузер',rs=>{rs[1].environment.userAgent='Другой браузер';}],
  ['разный-масштаб',rs=>{rs[1].page.dpr=1;}],
  ['разные-условия',rs=>{rs[1].input.sha256='0'.repeat(64);}],
  ['разный-режим-сил',rs=>{rs[1].liveWind.mode='free-live';}],
  ['скрытая-страница',rs=>{rs[1].page.visibility.push({at:100,state:'hidden'});}],
  ['пропущенный-шаг',rs=>{rs[1].records.splice(50,1);}],
  ['перепутанный-борт',rs=>{rs[1].records[180].side='plus';}],
  ['несовпадающая-сводка',(rs,ps)=>{ps[1].rows[0].variants.candidate.meanMs=1;}],
  ['непроверенная-пара',(rs,ps)=>{ps[1].phase='checking';}],
]) {
  const rs=structuredClone(records),ps=structuredClone(reports);mutate(rs,ps);
  assert.throws(()=>summarizeBrowserPairs(rs,ps),{name:'AssertionError'},name);rejected.push(name);
}
const hash=b=>createHash('sha256').update(b).digest('hex');
writeFileSync(out,JSON.stringify({schema:'cloth-fluid-browser-series-check-v1',phase:'complete',
  scope:'Известные часы и подмены состава сводки; это не физический или браузерный эксперимент.',
  toolSha256:hash(readFileSync(new URL('../scripts/cloth_fluid_browser_series.mjs',import.meta.url))),
  testSha256:hash(readFileSync(new URL(import.meta.url))),partial:{pairs:partial.exactPairs,missingPairs:partial.missingPairs},
  complete:{pairs:complete.exactPairs,working:complete.workingStepsPerVariant,p95Ms:complete.pooled.baseline.p95Ms},rejected},null,2)+'\n',{flag:'wx'});
console.log(`Сводка часов: неполная серия и известная общая выборка проверены; ${rejected.length} подмен отвергнуты.`);
