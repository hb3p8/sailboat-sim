// Обычная WebGPU-сцена в отдельном Chrome; сохранение обеих сторон сравнения.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),args=Object.fromEntries(process.argv.slice(2).map(s=>{const i=s.indexOf('=');return [s.slice(2,i),s.slice(i+1)];}));
if(!args.out||!args.baseline)throw new Error('Нужны --out=новый-префикс и --baseline=каталог-исходного-графа');
const prefix=resolve(args.out),baseline=resolve(args.baseline),origin=args.origin??'http://127.0.0.1:8020';
if(existsSync(prefix+'.json'))throw new Error('Серия уже существует');mkdirSync(dirname(prefix),{recursive:true});
let playwright;try{playwright=require(process.env.SV20_PLAYWRIGHT_MODULE??'playwright');}catch{throw new Error('Укажите SV20_PLAYWRIGHT_MODULE: путь к установленному playwright');}
const browser=await playwright.chromium.launch({channel:'chrome',headless:true});
const results=[],errors=[];let graph='baseline';
const runnerSha256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const context=await browser.newContext({viewport:{width:1280,height:900}});
if(args['half-raf']==='1')await context.addInitScript(()=>{
  // Только цикл основной сцены: один показ на два настоящих rAF. Это
  // диагностическое ограничение, а не эмуляция процессора/дисплея телефона.
  const native=requestAnimationFrame.bind(window);
  window.requestAnimationFrame=callback=>callback.name==='frame'?native(()=>native(callback)):native(callback);
});
await context.route(origin+'/sim/**',async route=>{
  if(graph!=='baseline'){await route.continue();return;}
  const pathname=decodeURIComponent(new URL(route.request().url()).pathname),path=resolve(baseline,'.'+pathname);
  if(relative(baseline,path).startsWith('..')||!existsSync(path))throw new Error('Нет исходного файла '+pathname);
  await route.fulfill({path});
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
function stats(a){if(!a.length)return null;const s=a.slice().sort((a,b)=>a-b),q=p=>s[Math.ceil(p*s.length)-1];
  return {count:s.length,mean:s.reduce((a,b)=>a+b,0)/s.length,p95:q(.95),p99:q(.99),max:s.at(-1)};}
async function run(label,variant,{side='plus',wake=1,profile=1,warmup=false,download=false}={}) {
  graph=variant;errors.length=0;
  const query=new URLSearchParams({ui:'debug','physics-profile':String(profile),'physics-run':'controls-v1',
    'physics-side':side,'physics-wake':String(wake),'physics-speed':'0','physics-schedule':variant==='baseline'?'frame':'message'});
  const url=origin+'/sim/index.html?'+query;
  await page.goto(url);
  await page.waitForFunction(()=>['complete','failed'].includes(window.sv20perf?.().gennakerMetrics?.phase),{},{timeout:30000});
  const dump=await page.evaluate(()=>({dump:window.sv20dump(),perf:window.sv20perf()})),m=dump.dump.gennakerMetrics;
  for(const [source,sha] of Object.entries(dump.dump.gennakerEnergy?.runtimeSha256??{})) {
    const path=variant==='baseline'&&existsSync(resolve(baseline,source))?resolve(baseline,source):resolve(source);
    if(createHash('sha256').update(readFileSync(path)).digest('hex')!==sha)throw new Error('Не совпал загруженный исходник '+source);
  }
  const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return {vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description};});
  let downloadSha256,interactionError;
  if(download&&m.phase==='complete') {
    try {const [download]=await Promise.all([page.waitForEvent('download',{timeout:5000}),page.getByRole('button',{name:'Скачать замер физики'}).click()]);
    const file=await download.path(),bytes=readFileSync(file),parsed=JSON.parse(bytes);
    if(parsed.gennakerMetrics.steps!==90)throw new Error('Неполная скачанная запись');
    downloadSha256=createHash('sha256').update(bytes).digest('hex');writeFileSync(prefix+'-'+label+'-download.json',bytes,{flag:'wx'});
    } catch(error){interactionError=String(error);}
    await page.screenshot({path:prefix+'-'+label+'.png'});
  }
  const payload={scope:'chrome-headless-full-scene',label,variant,warmup,url,runnerSha256,browser:browser.version(),
    halfRAF:args['half-raf']==='1',adapter,errors:[...errors],downloadSha256,interactionError,...dump.dump,perf:dump.perf};
  const path=prefix+'-'+label+'.json',bytes=Buffer.from(JSON.stringify(payload,null,2)+'\n');writeFileSync(path,bytes,{flag:'wx'});
  const records=m.records.filter(r=>r.gennakerUp),result={label,variant,warmup,path,sha256:createHash('sha256').update(bytes).digest('hex'),
    phase:m.phase,side,wake,profile,interactionError,activeS:m.activeS,tempo:m.tempo,lagS:m.lagS,steps:m.steps,errors:[...errors],
    frameMs:stats(m.frameIntervalsMs),workerMs:stats(records.map(r=>r.timings.workerComputeMs)),
    waitMs:stats(records.map(r=>r.timings.frameWaitMs)),physicsWallMs:stats(records.map(r=>r.timings.physicsWallMs))};
  results.push(result);console.log(`${label}: ${m.steps} шагов, ${m.activeS.toFixed(3)} с, темп ${m.tempo.toFixed(3)}, фаза ${m.phase}`);await page.goto('about:blank');
  if(m.phase!=='complete'||m.steps!==90||errors.length||interactionError)throw new Error('Браузерный сценарий не принят: '+label);
}
try {
  await run('warm-base','baseline',{warmup:true});await run('warm-message','message',{warmup:true});
  for(let pair=1;pair<=3;pair++)for(const variant of (pair===2?['message','baseline']:['baseline','message']))await run('pair'+pair+'-'+variant,variant,{download:pair===3&&variant==='message'});
  if(args.extra==='1') {
    await run('plain-base','baseline',{profile:0});await run('plain-message','message',{profile:0});
    await run('minus-base','baseline',{side:'minus',wake:3});await run('minus-message','message',{side:'minus',wake:3});
  }
} finally {
  writeFileSync(prefix+'.json',JSON.stringify({schema:'gennaker-browser-series-v1',baseline,runnerSha256,browser:browser.version(),
    halfRAF:args['half-raf']==='1',results},null,2)+'\n',{flag:'wx'});await browser.close();
}
