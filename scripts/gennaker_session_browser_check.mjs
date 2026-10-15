// Проверка публичного снимка на собранной странице; отдельный настольный Chrome.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),args=Object.fromEntries(process.argv.slice(2).map(s=>{const i=s.indexOf('=');return [s.slice(2,i),s.slice(i+1)];}));
if(!args.out||existsSync(args.out))throw new Error('Нужен новый --out=путь.json');
const origin=args.origin??'http://127.0.0.1:8020';
let pw;try{pw=require(process.env.SV20_PLAYWRIGHT_MODULE??'playwright');}catch{throw new Error('Укажите SV20_PLAYWRIGHT_MODULE: путь к установленному playwright');}
const browser=await pw.chromium.launch({channel:'chrome',headless:true}),results=[];
const report={schema:'gennaker-session-browser-check-v1',scope:'desktop-chromium-webgpu-not-mobile-budget',results,
  runnerSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')};
try {
  for(const [mode,side,wake,mid] of [['debug','plus',1,false],['debug','minus',3,true],['game','plus',3,false]]) {
    const context=await browser.newContext({viewport:mode==='game'?{width:390,height:844}:{width:1280,height:900},hasTouch:mode==='game'}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    try {
      await page.goto(`${origin}/sim/index.html?ui=${mode}&physics-run=controls-v1&physics-side=${side}&physics-wake=${wake}`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(mid=>{const s=window.sv20perf?.().gennakerMetrics?.scenario;return s&&(mid?s.elapsedS>=1:s.done);},mid,{timeout:25000});
      const saved=await page.evaluate(()=>sv20snapshot());
      if(args['dump-out']&&mode==='debug'&&side==='plus')writeFileSync(args['dump-out'],JSON.stringify(saved),{flag:'wx'});
      if(mid)await page.waitForFunction(()=>sv20perf().gennakerMetrics.scenario.done,{timeout:20000});
      const roundtrip=await page.evaluate(async saved=>{await sv20load(saved);const after=await sv20snapshot();return {same:JSON.stringify(after.gennakerSession)===JSON.stringify(saved.gennakerSession),input:JSON.stringify(after.inputState)===JSON.stringify(saved.inputState)};},saved);
      assert(roundtrip.same&&roundtrip.input,'Снимок/управление должны точно совпасть после загрузки');
      const replay=args.replay==='1'?await page.evaluate(saved=>sv20replay(saved),saved):undefined;
      if(replay)assert(replay.exact&&replay.steps>0);
      let rejected=0,dumpId;
      if(!mid&&mode==='debug') {
        rejected=await page.evaluate(async saved=>{
          const bad=[d=>d.gennakerSession.runtimeSha256['sim/physics.js']='x',d=>d.gennakerSession.model.local.body.u=null,
            d=>d.gennakerSession.solver.motion.lambda.pop(),d=>d.inputState.panel.wind='999',
            d=>d.inputState.game.at.main=2,d=>d.inputState.held.ArrowLeft=1];
          for(const mutate of bad){const d=structuredClone(saved);mutate(d);let rejected=false;try{await sv20load(d);}catch{rejected=true;}
            if(!rejected||JSON.stringify((await sv20snapshot()).gennakerSession)!==JSON.stringify(saved.gennakerSession))throw Error('Ошибочный снимок изменил сессию');}
          return bad.length;
        },saved);
        const response=page.waitForResponse(r=>r.url()===origin+'/api/dump'&&r.request().method()==='POST');
        await page.locator('#dump').click();const receipt=await (await response).json();assert(receipt.id);dumpId=receipt.id;
        await page.evaluate(id=>sv20load(id),dumpId);
        // Событие drop с настоящими File/DataTransfer использует обычный обработчик страницы.
        await page.evaluate(saved=>{const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(saved)],'проверка-сессии.json',{type:'application/json'}));window.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,cancelable:true}));},saved);
        await page.waitForFunction(()=>document.getElementById('dump').textContent.startsWith('загружено:'),{timeout:10000});
        const afterDrop=await page.evaluate(()=>sv20snapshot());assert.deepEqual(afterDrop.gennakerSession,saved.gennakerSession);
      }
      await page.waitForFunction(()=>sv20perf().gennakerMetrics.scenario.done,{timeout:20000});
      const final=await page.evaluate(()=>sv20snapshot());assert.equal(final.gennakerSession.adapter.steps,80);assert.equal(errors.length,0);
      results.push({mode,side,wake,mid,roundtrip,replay,rejected,dumpId,restoredAtS:saved.gennakerSession.model.local.body.t,
        finishedAtS:final.gennakerSession.model.local.body.t,build:final.build,physicalSteps:final.gennakerSession.adapter.steps,
        runtimeSha256:final.gennakerSession.runtimeSha256,errors});
      console.log(`Браузер: ${mode}, ${side}, wake=${wake}, ${mid?'середина манёвра':'конец манёвра'} — снимок и продолжение приняты.`);
    } finally {await context.close();}
  }
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto(origin+'/sim/index.html',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.sv20perf?.().gennakerMetrics,{timeout:20000});
    await page.keyboard.press('n');await page.waitForFunction(n=>sv20dump().gennakerEnergy?.steps>=n,args.ring==='1'?365:15,{timeout:40000});
    const saved=await page.evaluate(()=>sv20snapshot());
    let ringDumpId;
    if(args.ring==='1') {
      assert(saved.gennakerReplay.inputs.length>=300&&saved.gennakerReplay.inputs.length<=329);
      const response=page.waitForResponse(r=>r.url()===origin+'/api/dump'&&r.request().method()==='POST');
      await page.locator('#dump').click();const receipt=await (await response).json();assert(receipt.id);ringDumpId=receipt.id;
    }
    await page.locator('#gensheet').evaluate(el=>{el.value=String(Number(el.min)+.2);el.dispatchEvent(new Event('input'));});
    await page.waitForFunction(n=>sv20dump().gennakerEnergy.steps>=n,saved.gennakerSession.adapter.steps+10,{timeout:10000});
    const exact=await page.evaluate(async saved=>{await sv20load(saved);const actual=await sv20snapshot();return JSON.stringify(actual.gennakerSession)===JSON.stringify(saved.gennakerSession)&&JSON.stringify(actual.inputState)===JSON.stringify(saved.inputState);},saved);
    assert(exact);await page.waitForFunction(n=>sv20dump().gennakerEnergy.steps>=n,saved.gennakerSession.adapter.steps+10,{timeout:10000});assert.equal(errors.length,0);
    const replay=args.replay==='1'?await page.evaluate(saved=>sv20replay(saved),saved):undefined;
    if(replay)assert(replay.exact&&replay.steps>0);
    results.push({mode:'debug',manualOrdinaryURL:true,scenario:null,exact,replay,ringDumpId,
      savedBytes:Buffer.byteLength(JSON.stringify(saved)),continuedSteps:10,errors});
    console.log('Браузер: обычный URL, клавиша подъёма и ползунок шкота — сохранение/загрузка и живое продолжение пройдены.');
  } finally {await context.close();}
  report.complete=true;
} catch(error){report.complete=false;report.error={message:error.message,stack:error.stack};throw error;}
finally {writeFileSync(args.out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});await browser.close();}
