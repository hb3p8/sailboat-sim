// Квитанция не должна направлять к чужому пути или подтверждать другие байты.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {saveBrowserRecord} from './probes/browser-record-save.mjs';
const args=process.argv.slice(2),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===1&&out&&!existsSync(out));
const text='{"проверка":1.0000000000000002}\n',bytes=new TextEncoder().encode(text),
  hash=b=>createHash('sha256').update(b).digest('hex'),receipt={file:'out/acceptance/browser-record-20261010-123456abcdef.json',bytes:bytes.length,sha256:hash(bytes)},rejected=[];
const originalFetch=globalThis.fetch;
try {
  globalThis.fetch=async(path,options)=>{assert.equal(path,'/api/browser-record');assert.equal(options.method,'POST');
    assert.equal(options.headers['Content-Type'],'application/json');assert.deepEqual(options.body,bytes);return {ok:true,json:async()=>receipt};};
  assert.deepEqual(await saveBrowserRecord(text),receipt);
  for(const [name,mutate] of [
    ['путь',r=>{r.file='../../data/marks.json';}],['sha',r=>{r.sha256='0'.repeat(64);} ],
    ['размер',r=>{r.bytes--;}],['имя',r=>{r.file='out/acceptance/произвольный.json';}],
  ]) {
    const r=structuredClone(receipt);mutate(r);globalThis.fetch=async()=>({ok:true,json:async()=>r});
    await assert.rejects(saveBrowserRecord(text),/Квитанция/);rejected.push(name);
  }
  globalThis.fetch=async()=>({ok:false,json:async()=>({error:'Сервер отказал'})});
  await assert.rejects(saveBrowserRecord(text),/Сервер отказал/);rejected.push('отказ-сервера');
} finally {globalThis.fetch=originalFetch;}
writeFileSync(out,JSON.stringify({schema:'browser-record-save-check-v1',phase:'complete',accepted:1,rejected,
  sourceSha256:hash(readFileSync(new URL('./probes/browser-record-save.mjs',import.meta.url))),testSha256:hash(readFileSync(new URL(import.meta.url)))},null,2)+'\n',{flag:'wx'});
console.log(`Квитанция записи: правильный путь/байты/SHA проверены; ${rejected.length} подмен отвергнуты.`);
