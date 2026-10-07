// Настоящие коэффициенты LDL из неизменного движения, без JSON-округления чисел.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {fluidSailMotion} from '../tests/lib/cloth-fluid-sail-motion.mjs';
import {loadMaterialKernel} from '../tests/probes/cloth-material-wasm.mjs';
import {verifyMaterialKernel} from '../tests/probes/cloth-material-engine-check.mjs';
import {loadAssemblyKernel} from '../tests/probes/cloth-assembly-wasm.mjs';
import {verifyAssemblyKernel} from '../tests/probes/cloth-assembly-engine-check.mjs';
const args=process.argv.slice(2),inputs=args.filter(a=>a.startsWith('--input=')).map(a=>a.slice(8)),
  candidate=args.find(a=>a.startsWith('--candidate-wasm='))?.slice(17),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===4&&inputs.length===2&&candidate&&out&&args.every(a=>/^--(input|candidate-wasm|out)=.+$/.test(a)));
for(const suffix of ['', '.bin','.sources'])assert(!existsSync(out+suffix),'Нельзя перезаписывать прежний захват');
const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(new Uint8Array(Uint32Array.of(1).buffer)[0],1,'Захват требует little-endian');
const selectedSteps=[1,45,120,121,122],parts=[],patterns=[],ids=new WeakMap();let offset=0;
const report={schema:'cloth-sparse-capture-v1',phase:'preparing',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,v8:process.versions.v8,
  selectedSteps,inputs:[],modules:{},sourceSha256:{},patterns,samples:[],exactSteps:0,
  rule:'Все вызовы LDL шагов 1/45/120/121/122 обоих бортов. little-endian Float64 и Int32 сохраняют знак нуля. Все 360 шагов повторяют исходную запись; захват не является замером скорости.'};
function source(url){const path=relative(root,fileURLToPath(url));if(report.sourceSha256[path])return;
  const b=readFileSync(url);report.sourceSha256[path]=hash(b);const p=resolve(out+'.sources',path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,b,{flag:'wx'});
  for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))source(new URL(m[1],url));}
source(new URL(import.meta.url));source(new URL('../tests/probes/cloth-sparse-browser-review.html',import.meta.url));
source(new URL('../tests/probes/cloth-sparse-browser-worker.mjs',import.meta.url));
source(new URL('./cloth_sparse_browser_report.mjs',import.meta.url));
source(new URL('../tests/cloth-sparse-browser-probe.test.mjs',import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
function modulePart(name,path){const b=readFileSync(path),part={path:relative(root,resolve(path)),sha256:hash(b)};
  if(report.modules[name])assert.deepEqual(report.modules[name],part);else report.modules[name]=part;return b;}
function append(array){const start=offset,bytes=Buffer.from(array.buffer,array.byteOffset,array.byteLength);parts.push(Buffer.from(bytes));offset+=bytes.length;return {offset:start,length:array.length,byteLength:bytes.length};}
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Захват LDL остановлен: '+e.message);process.exitCode=1;});
assert.equal(new Set(inputs.map(p=>JSON.parse(readFileSync(p)).fixture.side)).size,2);
for(const path of inputs){const b=readFileSync(path),record=JSON.parse(b),f=record.fixture;
  assert.equal(f.dirty,false);assert.equal(record.steps.length,180);assert.equal(record.shownStep,180);
  for(const [p,h] of Object.entries(f.sourceSha256)){
    assert.equal(hash(execFileSync('git',['show',f.revision+':'+p],{maxBuffer:16*1024*1024})),h);assert.equal(hash(readFileSync(p)),h);}
  for(const part of [f.input,f.scene,f.wasm,f.materialWasm,f.assemblyWasm,f.sheetProof])assert.equal(hash(readFileSync(part.path)),part.sha256);
  assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);
  report.inputs.push({path:relative(root,resolve(path)),sha256:hash(b),side:f.side});
  const factor=await loadSparseFactor(modulePart('baseline',f.wasm.path)),old=factor.ldl;modulePart('candidate',candidate);
  let step=0,call=0;factor.ldl=(matrix,p,signs)=>{
    call++;if(selectedSteps.includes(step)){
      let id=ids.get(p);if(id===undefined){id=patterns.length;ids.set(p,id);patterns.push({n:p.n,...Object.fromEntries(['rowPtr','cols','colPtr','colRows','colEntries','rowToCol'].map(k=>[k,append(p[k])]))});}
      // Float64 после Int32 снова выравнивается по 8 байтам.
      if(offset%8){parts.push(Buffer.alloc(4));offset+=4;}
      const item={side:f.side,step,call,pattern:id,matrix:append(matrix),signs:append(signs)};
      report.samples.push(item);
    }
    return old(matrix,p,signs);
  };
  const materialKernel=await loadMaterialKernel(modulePart('material',f.materialWasm.path)),assemblyKernel=await loadAssemblyKernel(modulePart('assembly',f.assemblyWasm.path));
  assert.deepEqual(verifyMaterialKernel(materialKernel,f.recipe),record.preparation.material.validation);assert.deepEqual(verifyAssemblyKernel(assemblyKernel,f.recipe),record.preparation.assembly.validation);
  const c=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel,assemblyKernel});
  assert.deepEqual(JSON.parse(JSON.stringify(serial({positions:c.motion.pos,body:c.motion.body}))),record.initial);
  for(const s of record.steps){step=s.index;call=0;const a=c.step(s.controls);
    assert.deepEqual(JSON.parse(JSON.stringify(serial({positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit:a}))),{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});report.exactSteps++;}
  console.log(`Захват LDL, ${f.side==='plus'?'первая':'другая'} сторона: 180 прежних шагов, коэффициенты пяти выбранных шагов сохранены.`);
}
const blob=Buffer.concat(parts);assert.equal(blob.length,offset);
writeFileSync(out+'.bin',blob,{flag:'wx'});report.binary={path:relative(root,resolve(out+'.bin')),sha256:hash(blob),byteLength:blob.length,endian:'little'};
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Захват готов: ${report.samples.length} факторов, ${patterns.length} структур, ${(blob.length/1048576).toFixed(2)} МиБ.`);
