// Полный рабочий граф обычного генакера. Исследовательские маршруты main.js
// не являются корнями выпуска; энергия Worker также достижима из live.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export function gennakerRuntimeGraph(root=fileURLToPath(new URL('../',import.meta.url))) {
  const seen=new Map(),queue=['sim/gennaker-live.mjs','sim/gennaker-energy-worker.mjs'];
  while(queue.length) {
    const path=queue.shift();if(seen.has(path))continue;
    if(!path.startsWith('sim/'))throw new Error('Рабочий граф вышел из sim: '+path);
    const bytes=readFileSync(resolve(root,path)),code=bytes.toString(),imports=[];
    for(const m of code.matchAll(/\b(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      if(!m[1].startsWith('.'))throw new Error('В рабочем графе внешний импорт: '+m[1]);
      const next=relative(root,resolve(root,dirname(path),m[1]));imports.push(next);queue.push(next);
    }
    seen.set(path,{sha256:createHash('sha256').update(bytes).digest('hex'),imports});
  }
  return Object.fromEntries([...seen].sort(([a],[b])=>a.localeCompare(b)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6),modules=gennakerRuntimeGraph();
  if(out)writeFileSync(out,JSON.stringify({schema:'gennaker-runtime-graph-v1',modules},null,2)+'\n',{flag:'wx'});
  console.log('Рабочий граф генакера: '+Object.keys(modules).length+' модулей, все внутри sim.');
}
