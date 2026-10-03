// Стенд стоимости настоящего браузерного Worker и точного повторения.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [plus,minus,output]=process.argv.slice(2);
assert(process.argv.length===5&&!existsSync(output),'Нужны две полные серии и новый HTML');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=[plus,minus].map(path=> {
  assert(/^out\/acceptance\/[\p{L}\p{N}_.-]+\.json$/u.test(path));
  const bytes=readFileSync(path),r=JSON.parse(bytes);assert.equal(r.phase,'complete');
  return {path,sha256:hash(bytes)};
});
const ownPaths=['scripts/cloth_rigid_sail_review.mjs','tests/lib/cloth-browser-client.mjs','tests/lib/cloth-browser-worker.mjs','tests/lib/cloth-worker-timing.mjs'];
const provenance={manifest,sourceSha256:Object.fromEntries(ownPaths.map(p=>[p,hash(readFileSync(p))]))};
writeFileSync(output,`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Полный парус и свободная опора</title>
<style>body{font:16px system-ui;background:#f4f8fa;color:#183b50;margin:24px;max-width:1100px}button{font:inherit;padding:8px 16px;margin-right:8px}canvas{background:white;display:block;margin:16px 0;width:800px;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace}</style>
<h1>Полный парус и свободная опора</h1><p>Сетка 11×9, один общий расчёт. Опора 1000 кг с заданной инерцией; нагрузка ветра сохранена в неподвижных осях. Это лабораторный опыт без воды, руления и нового расчёта воздуха.</p>
<p>Проверяются все шаги против сохранённой серии. Время ниже относится к расчёту и обмену с отдельным потоком; плавность полной сцены здесь не измеряется.</p>
<button id="plus">Сторона +</button><button id="minus">Сторона −</button><p id="state">Выберите сторону для проверки.</p>
<canvas id="view" width="800" height="620"></canvas><pre id="summary"></pre><details><summary>Полная измеренная запись</summary><pre id="report"></pre></details>
<script type="module">
import {createMotionWorker} from '/tests/lib/cloth-browser-client.mjs';
const provenance=${JSON.stringify(provenance)},state=document.querySelector('#state'),report=document.querySelector('#report'),summary=document.querySelector('#summary');
const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d');
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const same=(a,b)=> {if(JSON.stringify(serial(a))!==JSON.stringify(b))throw Error('Нарушено точное совпадение физического результата');};
const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).map(x=>x.toString(16).padStart(2,'0')).join('');
async function read(path,expected) {const response=await fetch('/'+path);if(!response.ok)throw Error('Не прочитан '+path);const bytes=await response.arrayBuffer();if(await sha(bytes)!==expected)throw Error('Изменилось происхождение '+path);return bytes;}
function draw(p,recipe) {
  ctx.clearRect(0,0,800,620);const n=recipe.rows*recipe.cols;
  const proj=i=>[160+55*(p[3*i]+.4*p[3*i+1]),550-50*p[3*i+2]+12*p[3*i+1]];
  for(let r=0;r<recipe.rows-1;r++)for(let c=0;c<recipe.cols-1;c++) {
    const a=r*recipe.cols+c;for(const t of [[a,a+1,a+recipe.cols],[a+1,a+recipe.cols+1,a+recipe.cols]]) {
      ctx.beginPath();t.forEach((i,j)=>{const q=proj(i);j?ctx.lineTo(...q):ctx.moveTo(...q);});ctx.closePath();ctx.fillStyle='#cfdee780';ctx.fill();ctx.strokeStyle='#688c9e';ctx.lineWidth=.6;ctx.stroke();
    }
  }
  for(const i of recipe.rigidBody.attachments) {const q=proj(i);ctx.fillStyle='#d9761d';ctx.beginPath();ctx.arc(...q,5,0,2*Math.PI);ctx.fill();}
  ctx.strokeStyle='#446477';ctx.setLineDash([4,4]);for(let a=0;a<4;a++)for(let b=0;b<a;b++){ctx.beginPath();ctx.moveTo(...proj(n+a));ctx.lineTo(...proj(n+b));ctx.stroke();}ctx.setLineDash([]);
  ctx.fillStyle='#183b50';ctx.fillText('Оранжевые точки — крепления; пунктир — четыре массы опоры',16,24);
}
async function run(side) {
  const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);state.textContent='Подготовка…';report.textContent='';summary.textContent='';
  let client;const record={schema:1,createdAt:new Date().toISOString(),side,provenance,runtime:{userAgent:navigator.userAgent},steps:[]};
  try {
    const inputStart=performance.now(),entry=provenance.manifest[side===1?0:1];
    const raw=await read(entry.path,entry.sha256),r=JSON.parse(new TextDecoder().decode(raw));
    for(const [p,h] of Object.entries({...r.sourceSha256,...provenance.sourceSha256}))await read(p,h);
    const wasm=await read(r.wasm.path,r.wasm.sha256);record.inputMs=performance.now()-inputStart;record.input={...entry,revision:r.revision,dirty:r.dirty};
    const setupStart=performance.now();client=await createMotionWorker(r.recipe,wasm,{profile:true});record.setupMs=performance.now()-setupStart;record.ready=serial(client.ready);same(client.ready.positions,r.recipe.positions);
    for(let i=0;i<r.steps.length;i++) {
      const begin=performance.now(),a=await client.step(),requestMs=performance.now()-begin,expected=r.steps[i];
      if(a.index!==i)throw Error('Нарушен порядок шагов');same(a.positions,expected.positionsM);
      const {supportForceN,...audit}=expected.audit;same(a.audit,audit);same(a.supportForceN,supportForceN);same(a.dualViolationN,expected.dualViolationN);
      record.steps.push({index:i,requestMs,timeMs:a.timeMs,timing:a.timing,wasmMemory:a.wasmMemory});draw(a.positions,r.recipe);state.textContent='Проверено '+(i+1)+' / '+r.steps.length;
    }
    const s=record.steps,average=k=>s.reduce((v,x)=>v+x[k],0)/s.length;record.phase='complete';record.summary={exactSteps:s.length,meanStepMs:average('timeMs'),meanRequestMs:average('requestMs'),maxStepMs:Math.max(...s.map(x=>x.timeMs)),
      meanFactorMs:s.reduce((v,x)=>v+x.timing.factorMs,0)/s.length,meanSolveMs:s.reduce((v,x)=>v+x.timing.solveMs,0)/s.length,meanOtherMs:s.reduce((v,x)=>v+x.timing.otherStepMs,0)/s.length};
    const skip=Math.round(1/r.config.hS),working=s.slice(skip);
    if(working.length) {
      const durations=working.map(x=>x.timeMs).sort((a,b)=>a-b),mean=k=>working.reduce((v,x)=>v+x[k],0)/working.length;
      record.workingWindow={startS:1,endS:r.config.durationS,firstIndex:skip,steps:working.length,meanStepMs:mean('timeMs'),meanRequestMs:mean('requestMs'),
        p95StepMs:durations[Math.ceil(.95*durations.length)-1],maxStepMs:durations.at(-1),overBudgetSteps:working.filter(x=>x.requestMs>1000*r.config.hS).length,
        meanFactorMs:working.reduce((v,x)=>v+x.timing.factorMs,0)/working.length,meanSolveMs:working.reduce((v,x)=>v+x.timing.solveMs,0)/working.length,
        meanOtherMs:working.reduce((v,x)=>v+x.timing.otherStepMs,0)/working.length};
    }
    state.textContent='Проверка завершена: все физические поля совпали точно.';summary.textContent='Сторона '+side+'; '+s.length+' шагов. Средний расчёт '+record.summary.meanStepMs.toFixed(2)+' мс; запрос/ответ '+record.summary.meanRequestMs.toFixed(2)+' мс. Максимальный расчёт '+record.summary.maxStepMs.toFixed(2)+' мс.';
  }catch(e){record.phase='failed';record.failure=e.message;state.textContent='Отказ: '+e.message;}
  finally{await client?.terminate();report.textContent=JSON.stringify(record,null,2);buttons.forEach(b=>b.disabled=false);}
}
document.querySelector('#plus').onclick=()=>run(1);document.querySelector('#minus').onclick=()=>run(-1);
</script></html>\n`,{flag:'wx'});
console.log('Создан стенд полного паруса: '+output);
