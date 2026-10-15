// Исследовательский указатель прежнего входа. Версия обычной сцены хранится в data/.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
export function publishLiveSailDefault(records,path='out/export/live-sail-default.json') {
  assert.equal(records.length,2,'Нужны оба борта');
  const inputs={},hash=b=>createHash('sha256').update(b).digest('hex');let reference;
  for(const record of records) {
    const bytes=readFileSync(record.path),f=JSON.parse(bytes);
    assert.equal(f.schema,'cloth-fluid-live-v1');assert.equal(f.dirty,false);
    assert(f.profileWorker===undefined||f.profileWorker===false,'Указателю нужен режим без подробного профиля');
    assert.equal(f.liveWind?.bodyProfile,'sv20-rig-budget-point-v1');assert(f.sheet&&f.materialWasm&&f.assemblyWasm);
    assert(['plus','minus'].includes(f.side)&&!inputs[f.side],'Нужны разные борта');
    const shared={revision:f.revision,sceneSha:f.scene.sha256,physicsSha:f.physicsSha256,sources:f.sourceSha256};
    if(reference)assert.deepEqual(shared,reference,'Постановки принадлежат разным сборкам');else reference=shared;
    inputs[f.side]={path:record.path,sha256:hash(bytes)};
  }
  const manifest={schema:'sv20-live-entry-v1',revision:reference.revision,inputs};
  mkdirSync(dirname(path),{recursive:true});const temporary=path+'.'+process.pid+'.tmp';
  writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});renameSync(temporary,path);
  return manifest;
}
