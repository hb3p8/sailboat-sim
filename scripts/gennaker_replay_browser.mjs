// Новую ткань повторяет тот же браузерный движок и обычный адаптер.
// Node не объявляет себя Safari/Chrome ради обхода проверки снимка.
import {createRequire} from 'node:module';
export async function replayGennakerBrowser(dump,{origin='http://127.0.0.1:8020',after=0}={}) {
  if(after)throw new Error('Для новой ткани --after не поддержан: будущие команды и вода не записаны');
  const require=createRequire(import.meta.url);
  let pw;try{pw=require(process.env.SV20_PLAYWRIGHT_MODULE??'playwright');}
  catch{throw new Error('Укажите SV20_PLAYWRIGHT_MODULE: путь к установленному playwright');}
  const engine=dump.gennakerSession?.engine??'';
  if(!engine.includes('Chrome/'))throw new Error('CLI-повтор требует Chrome; в исходном браузере используйте sv20replay(дамп)');
  const browser=await pw.chromium.launch({channel:'chrome',headless:engine.includes('HeadlessChrome/')});
  try {
    const mode=dump.gennakerSession?.environment.ui;
    const page=await browser.newPage({viewport:mode==='game'?{width:390,height:844}:{width:1280,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/sim/index.html?ui='+mode,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.sv20perf?.().gennakerMetrics,{timeout:30000});
    const result=await page.evaluate(d=>sv20replay(d),dump);
    if(errors.length)throw new Error('Ошибка страницы: '+errors.join('; '));
    return result;
  } finally {await browser.close();}
}
