// Проверка поставки в отдельном каталоге: без out/, tests/ и истории Git.
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,copyFileSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
assert(out&&!existsSync(out),'Нужен новый --out=отчёт.json');
const require=createRequire(import.meta.url),pw=require(process.env.SV20_PLAYWRIGHT_MODULE??'playwright');
const root=mkdtempSync(join(tmpdir(),'sv20-release-')),report={schema:'gennaker-clean-build-check-v1',results:[]};
let server,browser;
const copy=p=>{mkdirSync(dirname(join(root,p)),{recursive:true});copyFileSync(p,join(root,p));};
try {
  cpSync('sim',join(root,'sim'),{recursive:true,filter:p=>!p.endsWith('/index.html')});
  cpSync('data/simulator',join(root,'data/simulator'),{recursive:true});
  for(const p of execFileSync('git',['ls-files','assets','viewer/vendor'],{encoding:'utf8'}).trim().split('\n'))copy(p);
  for(const p of ['Makefile','scripts/build_sim.py','scripts/sim_runtime.py','data/marks.json'])copy(p);
  assert(!existsSync(join(root,'out'))&&!existsSync(join(root,'tests')));
  report.build=execFileSync('make',['sim'],{cwd:root,encoding:'utf8'}).trim();
  assert(!existsSync(join(root,'out')));
  // Даже случайно забытый fetch старого каталога должен дать явный отказ.
  const code=`from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  if self.path.startswith(('/out/', '/tests/')): self.send_error(404)
  else: super().do_GET()
 def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
print(server.server_port,flush=True)
server.serve_forever()
`;
  server=spawn('python3',['-u','-c',code],{cwd:root,stdio:['ignore','pipe','pipe']});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Сервер не запустился')),10000);
    server.stdout.once('data',v=>{clearTimeout(timer);resolve(Number(v.toString().trim()));});
    server.once('error',reject);
  });
  assert(port>0);browser=await pw.chromium.launch({channel:'chrome',headless:true});
  for(const side of ['plus','minus']) {
    const page=await browser.newPage(),errors=[],forbidden=[],failed=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(/^\/(out|tests)\//.test(new URL(r.url()).pathname))forbidden.push(r.url());});
    page.on('requestfailed',r=>failed.push(r.url()));
    try {
      await page.goto(`http://127.0.0.1:${port}/sim/index.html?noperf&physics-run=controls-v1&physics-side=${side}&physics-wake=3`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>window.sv20perf?.().gennakerMetrics?.scenario?.done,{timeout:30000});
      const saved=await page.evaluate(()=>sv20snapshot());assert.equal(saved.build.runtime.version,1);
      const replay=await page.evaluate(d=>sv20replay(d),saved);assert(replay.exact&&replay.steps===89);
      assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);assert.deepEqual(failed,[]);
      report.results.push({side,replay,errors,forbidden,failed,build:saved.build});
    } finally {await page.close();}
  }
  assert(!existsSync(join(root,'out'))&&!existsSync(join(root,'tests')));
  report.complete=true;
} catch(error){report.complete=false;report.error=error.message;throw error;}
finally {
  await browser?.close();if(server){server.kill();await once(server,'close');}
  report.manifestSha256=createHash('sha256').update(readFileSync('data/simulator/v1/manifest.json')).digest('hex');
  report.toolSha256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});rmSync(root,{recursive:true,force:true});
}
console.log('Чистая сборка и оба браузерных повтора прошли без out/ и tests/.');
