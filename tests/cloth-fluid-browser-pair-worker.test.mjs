// Настоящий диагностический обработчик в Node Worker: HTTP заменён чтением файлов.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),out=args.find(a=>a.startsWith('--out='))?.slice(6);assert(args.length===2&&input&&out&&!existsSync(out));
const fixture=JSON.parse(readFileSync(input)),url=pathToFileURL(resolve(input+'.sources/tests/probes/cloth-fluid-browser-pair-worker.mjs')),
  code=`import {parentPort} from 'node:worker_threads';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
const root=${JSON.stringify(process.cwd())};globalThis.self={crossOriginIsolated:false,postMessage:data=>parentPort.postMessage(data),addEventListener:(name,fn)=>parentPort.on('message',data=>{void fn({data});})};
globalThis.fetch=async path=>{const p=path instanceof URL?fileURLToPath(path):root+path;const b=await readFile(p);return {ok:true,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};};await import(${JSON.stringify(url.href)});parentPort.postMessage({type:'initialized'});`;
const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code))),messages=[];
try{
  const result=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',data=>{
    if(data.type==='initialized'){worker.postMessage({input:'/'+input,pair:1});return;}messages.push(data);
    if(data.type==='error')reject(new Error(data.message));if(data.type==='result')resolve(data.result);
  });});
  assert.equal(result.phase,'complete',JSON.stringify(result.failure));assert.equal(result.exactPairs,360);assert.equal(result.records.length,360);
  assert.equal(result.profile,fixture.profile);let k=0;
  for(const part of fixture.inputs){const old=JSON.parse(readFileSync(part.path));for(const step of old.steps){const x=result.records[k++];assert.equal(x.step,step.index);assert.equal(x.side,part.side);
    assert.deepEqual(x.states.baseline,x.states.candidate);assert.deepEqual(JSON.parse(JSON.stringify(x.states.baseline)),{positions:step.positions,body:step.body,forceN:step.forceN,audit:step.audit});
    if(fixture.profile)for(const v of ['baseline','candidate']){const p=x.times[v].profile;assert.equal(p.directions.ordinary.linear.calls+p.directions.correction.linear.calls,x.times[v].wasm.numericFactorizations);assert.equal(p.sparse.factorNative.calls,p.linear.factorCalls);
      if(fixture.correctionProfile){assert.equal(p.correction.local.calls,p.materialHessian.native.calls);assert.equal(new Set(Object.values(p.materialHessian).map(a=>a.calls)).size,1);
        assert(p.correction.local.ms+p.correction.scatter.ms<=p.directions.correction.clothMatrix.ms+1e-6);assert(Object.values(p.materialHessian).reduce((s,a)=>s+a.ms,0)<=p.correction.local.ms+1e-6);}}}}
  const hash=b=>createHash('sha256').update(b).digest('hex');writeFileSync(out,JSON.stringify({schema:'cloth-fluid-browser-pair-worker-check-v1',phase:'complete',runtime:process.version,
    fixture:{path:input,sha256:hash(readFileSync(input))},testSha256:hash(readFileSync(new URL(import.meta.url))),progressMessages:messages.filter(x=>x.type==='progress').length,result},null,2)+'\n',{flag:'wx'});
  console.log(`Диагностический настоящий Worker: 360 строгих пар и прежних шагов${fixture.profile?', отдельные обычные/точные направления':''} — пройдены.`);
}finally{await worker.terminate();}
