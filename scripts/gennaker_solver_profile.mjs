// Разбор собственного времени решателя; --browser получает обычную WebGPU-сцену.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {cpus,release} from 'node:os';
const args=Object.fromEntries(process.argv.slice(2).map(v=>v.slice(2).split('=')));
assert(args.out&&!existsSync(args.out),'Нужен новый --out=отчёт.json');
assert(Boolean(args.input)!==process.argv.includes('--browser'),'Выберите --input=запись.json либо --browser');
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const stats=a=>{const s=a.slice().sort((a,b)=>a-b);return {count:s.length,meanMs:s.reduce((a,b)=>a+b,0)/s.length,p95Ms:s[Math.ceil(.95*s.length)-1]};};
function summarize(run) {
  const records=run.records.filter(r=>r.gennakerUp),stages={};let totalMs=0;
  for(const r of records)for(const profile of r.solverProfiles) {
    assert.equal(profile.schema,'cloth-solver-profile-v1');const rows=Object.entries(profile.stages);
    const root=profile.stages.cloth;assert(root.calls===1&&root.failed===0);
    assert(Math.abs(rows.reduce((s,[,v])=>s+v.selfMs,0)-root.inclusiveMs)<1e-6);
    totalMs+=root.inclusiveMs;
    for(const [key,v] of rows) {
      const sum=stages[key]??={calls:0,failed:0,inclusiveMs:0,selfMs:0};
      for(const field of Object.keys(sum))sum[field]+=v[field];
    }
  }
  for(const row of Object.values(stages))row.selfPercent=100*row.selfMs/totalMs;
  return {side:run.side,profile:run.profile,pair:run.pair,ui:run.ui,wake:run.wake??3,steps:records.length,totalMs,
    worker:stats(run.workerMs),cpu:run.cpuMs?stats(run.cpuMs):undefined,
    stages:Object.fromEntries(Object.entries(stages).sort((a,b)=>b[1].selfMs-a[1].selfMs))};
}
const report={schema:'gennaker-solver-profile-report-v1',toolSha256:digest(new URL(import.meta.url)),
  limits:'Собственные времена не пересекаются; вложенные inclusiveMs нельзя складывать. Часы включают накладные расходы. Это не мобильный бюджет.',runs:[]};
if(args.input) {
  const raw=JSON.parse(readFileSync(args.input));assert(raw.complete);assert.equal(raw.schema,'gennaker-solver-profile-check-v1');
  report.input={path:args.input,sha256:digest(args.input)};report.scope=raw.scope;
  report.runs=raw.runs.filter(r=>r.profile).map(summarize);report.overhead=[];
  for(const on of raw.runs.filter(r=>r.profile)) {
    const off=raw.runs.find(r=>r.side===on.side&&r.pair===on.pair&&!r.profile);
    assert.equal(on.physicalSha256,off.physicalSha256);assert(on.cpuMs&&off.cpuMs,'Для цены часов нужен CPU потока');
    const sum=a=>a.reduce((s,v)=>s+v,0);
    report.overhead.push({side:on.side,pair:on.pair,cpuPercent:100*(sum(on.cpuMs)/sum(off.cpuMs)-1),
      wallPercent:100*(sum(on.workerMs)/sum(off.workerMs)-1)});
  }
} else {
  const require=createRequire(import.meta.url),pw=require(process.env.SV20_PLAYWRIGHT_MODULE??'playwright');
  const browser=await pw.chromium.launch({channel:'chrome',headless:true}),origin=args.origin??'http://127.0.0.1:8020';
  report.scope='desktop-chrome-full-webgpu-scene';report.browser=browser.version();
  report.host={cpu:cpus()[0].model,system:process.platform,release:release()};
  try {
    for(const [ui,side,wake] of [['debug','plus',1],['debug','minus',3],['game','plus',3]]) {
      const context=await browser.newContext({viewport:ui==='game'?{width:390,height:844}:{width:1280,height:900}}),page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      try {
        const url=origin+'/sim/index.html?'+new URLSearchParams({ui,'physics-profile':'1','physics-run':'controls-v1','physics-side':side,'physics-wake':wake});
        await page.goto(url);await page.waitForFunction(()=>['complete','failed'].includes(window.sv20perf?.().gennakerMetrics?.phase),null,{timeout:30000});
        const {dump,metrics:m}=await page.evaluate(async()=>{const dump=await sv20snapshot();return {dump,metrics:sv20perf().gennakerMetrics};});
        assert.equal(m.phase,'complete');assert.equal(m.steps,90);assert.deepEqual(errors,[]);
        for(const [path,sha] of Object.entries(dump.gennakerSession.runtimeSha256))assert.equal(digest(path),sha,path);
        const records=m.records.filter(r=>r.gennakerUp).slice(10);assert.equal(records.length,70);
        const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return {vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description};});
        const rawPath=args.out.replace(/\.json$/,'')+`-${ui}-${side}-${wake}.json`;
        writeFileSync(rawPath,JSON.stringify({url,browser:report.browser,host:report.host,adapter,errors,dump,metrics:m},null,2)+'\n',{flag:'wx'});
        const run={ui,side,wake,profile:true,records,workerMs:records.map(r=>r.timings.workerComputeMs)};
        report.runs.push({...summarize(run),raw:{path:rawPath,sha256:digest(rawPath)},tempo:m.tempo,activeS:m.activeS,
          frameIntervals:stats(m.frameIntervalsMs),adapter});
        console.log(`Браузер ${ui}/${side}/wake=${wake}: 70 шагов ткани после 10 шагов прогрева, темп ${m.tempo.toFixed(3)}.`);
      } finally {await context.close();}
    }
    report.complete=true;
  } catch(error) {
    report.complete=false;report.error=error.message;writeFileSync(args.out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});throw error;
  } finally {await browser.close();}
}
writeFileSync(args.out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
for(const r of report.runs)console.log(`Борт ${r.side}: `+Object.entries(r.stages).slice(0,5).map(([k,v])=>`${k} ${v.selfPercent.toFixed(1)}%`).join(', '));
