// Сводка обычных браузерных пар после независимой проверки каждой записи.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const budgetMs=1000/60;
const variants=['baseline','candidate'];

// Эта функция проверяет состав и считает часы; физику проверяет pair-report.
export function summarizeBrowserPairs(records,reports) {
  assert(records.length>=1&&records.length<=3&&records.length===reports.length);
  const first=records[0],pairs=new Set(),rows=[],working={baseline:[],candidate:[]};
  const viewport=r=>({width:r.page.width,height:r.page.height,dpr:r.page.dpr});
  assert(Object.values(viewport(first)).every(x=>Number.isFinite(x)&&x>0));
  for(let i=0;i<records.length;i++) {
    const r=records[i],report=reports[i];
    assert.equal(r.schema,'cloth-fluid-browser-pair-v1');assert.equal(r.phase,'complete');
    assert.equal(r.profile,false,'Скорость обычного шага нельзя смешивать с подробным профилем');
    assert([1,2,3].includes(r.pair)&&!pairs.has(r.pair),'Нужны разные пары 1–3');pairs.add(r.pair);
    for(const name of ['input','fixtureRevision','fixtureDirty','graphs','modules','environment','liveWind'])assert.deepEqual(r[name],first[name],name);
    assert.deepEqual(viewport(r),viewport(first),'Размер страницы или масштаб изменился');
    assert.equal(r.page.url,first.page.url);assert.equal(r.page.sha256,first.page.sha256);
    assert.equal(r.page.endedVisibility,'visible');assert(r.page.visibility.length&&r.page.visibility.every(x=>x.state==='visible'));
    assert.equal(r.records.length,360);assert.equal(r.exactPairs,360);
    assert.equal(report.schema,'cloth-fluid-browser-pair-report-v1');assert.equal(report.phase,'complete');
    assert.equal(report.profile,false);assert.equal(report.pair,r.pair);assert.equal(report.exactPairs,360);
    assert.deepEqual(report.liveWind,r.liveWind);assert.deepEqual(report.fixture,{path:r.input.path.slice(1),sha256:r.input.sha256});
    assert.equal(report.rows.length,2);
    for(const [sideIndex,side] of ['plus','minus'].entries()) {
      const steps=r.records.slice(sideIndex*180,(sideIndex+1)*180);
      assert(steps.every((s,j)=>s.side===side&&s.step===j+1),'Неверная сторона или последовательность шагов');
      const row=report.rows[sideIndex];assert.equal(row.side,side);
      for(const v of variants) {
        const times=steps.slice(1).map(s=>s.times[v].stepMs);
        assert(times.every(x=>Number.isFinite(x)&&x>=0));
        const stats=distribution(times);
        for(const name of ['meanMs','p95Ms','maxMs','overBudget'])assert.equal(stats[name],row.variants[v][name],name);
        working[v].push(...times);
      }
      const regressions=['firstMs','meanMs','p95Ms','maxMs','overBudget','stopMs'].filter(name=>row.variants.candidate[name]>row.variants.baseline[name]);
      rows.push({pair:r.pair,...row,regressions});
    }
  }
  const missingPairs=[1,2,3].filter(p=>!pairs.has(p)),completeSeries=missingPairs.length===0;
  const pooled=Object.fromEntries(variants.map(v=>[v,distribution(working[v])]));
  return {
    phase:completeSeries?'complete':'partial',completeSeries,completedPairs:[...pairs].sort(),missingPairs,
    exactPairs:360*records.length,workingStepsPerVariant:358*records.length,budgetMs,
    environment:first.environment,viewport:viewport(first),loadMode:first.liveWind?.mode??'frozen-load',
    pooled,changePercent:100*(pooled.candidate.meanMs/pooled.baseline.meanMs-1),
    allWorkingMeansLower:rows.every(row=>row.variants.candidate.meanMs<row.variants.baseline.meanMs),
    rows:rows.sort((a,b)=>a.pair-b.pair||['plus','minus'].indexOf(a.side)-['plus','minus'].indexOf(b.side)),
    sceneBudgetAccepted:false,
    scope:'Окно 2–180 каждого борта; первые шаги и остановка 121 сохранены отдельно. P95 общей выборки считается по всем временам, не усредняется по парам. Неполная серия не подтверждает повторяемость; даже полная серия не принимает время свободной сцены или устойчивые 60 Гц.',
  };
}

function distribution(times) {
  const sorted=[...times].sort((a,b)=>a-b);
  return {meanMs:sorted.reduce((s,x)=>s+x,0)/sorted.length,p95Ms:sorted[Math.ceil(.95*sorted.length)-1],
    maxMs:sorted.at(-1),overBudget:sorted.filter(x=>x>budgetMs).length};
}

function main() {
  const args=process.argv.slice(2),inputs=args.filter(a=>a.startsWith('--input=')).map(a=>a.slice(8)),
    fixtures=args.filter(a=>a.startsWith('--fixture=')).map(a=>a.slice(10)),outputs=args.filter(a=>a.startsWith('--out=')).map(a=>a.slice(6));
  assert(args.length===inputs.length+2&&inputs.length>=1&&inputs.length<=3&&fixtures.length===1&&outputs.length===1);
  const [fixture]=fixtures,[out]=outputs;assert(inputs.every(Boolean)&&fixture&&out&&!existsSync(out)&&!existsSync(out+'.sources'));
  const records=inputs.map(p=>JSON.parse(readFileSync(p))),seen=new Set();
  for(const r of records) {assert.equal(r.profile,false);assert(!seen.has(r.pair),'Повтор пары');seen.add(r.pair);}
  const copies=out+'.sources',tool='scripts/cloth_fluid_browser_pair_report.mjs';mkdirSync(copies,{recursive:true});
  writeFileSync(copies+'/series-tool.mjs',readFileSync(fileURLToPath(import.meta.url)),{flag:'wx'});
  writeFileSync(copies+'/pair-report-tool.mjs',readFileSync(tool),{flag:'wx'});
  const reports=[],evidence=[];
  // Только чтение прежних результатов; новые физические расчёты не выполняются.
  for(let i=0;i<inputs.length;i++) {
    const path=copies+'/pair-'+records[i].pair+'-report.json';
    execFileSync(process.execPath,[tool,'--input='+inputs[i],'--fixture='+fixture,'--out='+path],{stdio:'pipe'});
    const bytes=readFileSync(path),report=JSON.parse(bytes);
    assert.deepEqual(report.input,{path:inputs[i],sha256:hash(readFileSync(inputs[i]))});
    reports.push(report);evidence.push({input:report.input,report:{path,sha256:hash(bytes)}});
  }
  const summary=summarizeBrowserPairs(records,reports);
  writeFileSync(out,JSON.stringify({schema:'cloth-fluid-browser-series-v1',...summary,
    fixture:{path:fixture,sha256:hash(readFileSync(fixture))},evidence,
    toolSha256:hash(readFileSync(fileURLToPath(import.meta.url))),pairReportSha256:hash(readFileSync(tool))},null,2)+'\n',{flag:'wx'});
  console.log(`Браузерная серия: ${summary.exactPairs} проверенных пар; ${summary.completeSeries?'три сравнения завершены':'остались пары '+summary.missingPairs.join(', ')}. Бюджет свободной сцены не принят.`);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
