// Известные/предельные матрицы и каждый настоящий LDL двух полных циклов.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sparsePattern} from '../sim/cloth/cloth-sparse-solve.mjs';
import {compareLDLFactors} from './probes/cloth-sparse-factor-audit.mjs';
import {loadSparseFactor} from '../sim/cloth/cloth-sparse-wasm.mjs';
import {fluidSailMotion} from './lib/cloth-fluid-sail-motion.mjs';
import {loadMaterialKernel} from '../sim/cloth/cloth-material-wasm.mjs';
import {verifyMaterialKernel} from '../sim/cloth/cloth-material-engine-check.mjs';
import {loadAssemblyKernel} from './probes/cloth-assembly-wasm.mjs';
import {verifyAssemblyKernel} from './probes/cloth-assembly-engine-check.mjs';
const args=process.argv.slice(2),inputs=args.filter(a=>a.startsWith('--input=')).map(a=>a.slice(8)),
  baseline=args.find(a=>a.startsWith('--baseline-wasm='))?.slice(16),wasm=args.find(a=>a.startsWith('--wasm='))?.slice(7),out=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(args.length===5&&inputs.length===2&&baseline&&wasm&&out&&args.every(a=>/^--(input|baseline-wasm|wasm|out)=.+$/.test(a)));
assert(!existsSync(out)&&!existsSync(out+'.sources'));
const hash=b=>createHash('sha256').update(b).digest('hex'),aBytes=readFileSync(baseline),bBytes=readFileSync(wasm),
  aModule=await WebAssembly.compile(aBytes),bModule=await WebAssembly.compile(bBytes),root=fileURLToPath(new URL('../',import.meta.url));
const report={schema:'cloth-sparse-stop-check-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,v8:process.versions.v8,
  baseline:{path:baseline,sha256:hash(aBytes)},candidate:{path:wasm,sha256:hash(bBytes)},sourceSha256:{},known:null,runs:[],exactSteps:0,
  rule:'Полные L/work/column по Object.is, включая знак нуля/NaN. Граница каждого плана против прежнего поиска. Таймеры nativeMs — дополнительный аудит с двумя экземплярами, не парный замер полного шага/браузера.'};
function source(url){const path=relative(root,fileURLToPath(url));if(report.sourceSha256[path])return;const b=readFileSync(url);report.sourceSha256[path]=hash(b);const p=resolve(out+'.sources',path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,b,{flag:'wx'});
 for(const m of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))source(new URL(m[1],url));}
source(new URL(import.meta.url));source(new URL('./lib/cloth-sparse-kernel.c',import.meta.url));
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Аудит границы LDL остановлен: '+e.message);process.exitCode=1;});
const known=compareLDLFactors(aModule,bModule);
for(const n of [0,1,13,201])for(const reversed of [false,true]) {
  const groups=Array.from({length:n},(_,i)=>Array.from(new Set([i,(i+1)%n,(i+7)%n]))),
    p=sparsePattern(n,groups,Int32Array.from({length:n},(_,i)=>reversed?n-i-1:i)),dense=Array.from({length:n},(_,i)=>Float64Array.from({length:n},(_,j)=>i===j?2:0));
  for(let k=0;k<groups.length;k++){const g=groups[k],v=g.map((_,i)=>Math.sin(k+i+.2));for(let a=0;a<g.length;a++)for(let b=0;b<g.length;b++)dense[g[a]][g[b]]+=v[a]*v[b];}
  for(const scale of [1,2]){const matrix=new Float64Array(p.cols.length);for(let i=0;i<n;i++)for(let a=p.rowPtr[i];a<p.rowPtr[i+1];a++)matrix[a]=scale*dense[p.order[i]][p.order[p.cols[a]]];assert.equal(known.compare(matrix,p,new Int32Array(n).fill(1)),0);}
}
const single=sparsePattern(1,[[0]]);
for(const value of [0,-0,-1,NaN,Infinity,-Infinity])assert.equal(known.compare(Float64Array.of(value),single,Int32Array.of(1)),1);
for(const value of [Number.MIN_VALUE,1,-1])assert.equal(known.compare(Float64Array.of(value),single,Int32Array.of(value>0?1:-1)),0);
const p=sparsePattern(3,[[0],[1]],Int32Array.of(0,1,2),[[0,2],[1,2]]),matrix=new Float64Array(p.cols.length);
for(const [i,j,v] of [[0,0,2],[1,1,3],[2,0,1],[2,1,2]])matrix[p.locations[i].get(j)]=v;
assert.equal(known.compare(matrix,p,Int32Array.of(1,1,-1)),0);assert.equal(known.compare(matrix,p,Int32Array.of(1,1,1)),3);
report.known=known.statistics();console.log(`Граница LDL: ${report.known.matrices} известных/предельных матриц, ${report.known.rejected} одинаковых отказов.`);
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
assert.equal(new Set(inputs.map(path=>JSON.parse(readFileSync(path)).fixture.side)).size,2);
for(const path of inputs){const bytes=readFileSync(path),record=JSON.parse(bytes),f=record.fixture;
  assert.equal(record.steps.length,180);assert.equal(record.shownStep,180);assert.equal(f.dirty,false);assert.equal(f.wasm.sha256,hash(aBytes));
  for(const [p,h] of Object.entries(f.sourceSha256)){assert.equal(hash(execFileSync('git',['show',f.revision+':'+p],{maxBuffer:16*1024*1024})),h);
    if(hash(readFileSync(p))!==h)assert.equal(p,'sim/cloth/cloth-sparse-wasm.mjs','Изолированный опыт может менять только оболочку');}
  for(const part of [f.input,f.scene,f.wasm,f.materialWasm,f.assemblyWasm,f.sheetProof])assert.equal(hash(readFileSync(part.path)),part.sha256);
  assert.equal(hash(readFileSync('out/export/physics.json')),f.physicsSha256);
  const factor=await loadSparseFactor(aBytes),audit=compareLDLFactors(aModule,bModule),original=factor.ldl;
  factor.ldl=(matrix,p,signs)=>{assert.equal(audit.compare(matrix,p,signs),0);return original(matrix,p,signs);};
  const materialKernel=await loadMaterialKernel(readFileSync(f.materialWasm.path)),assemblyKernel=await loadAssemblyKernel(readFileSync(f.assemblyWasm.path));
  assert.deepEqual(verifyMaterialKernel(materialKernel,f.recipe),record.preparation.material.validation);assert.deepEqual(verifyAssemblyKernel(assemblyKernel,f.recipe),record.preparation.assembly.validation);
  const c=fluidSailMotion(f.recipe,f.bodyInput,factor,{sheet:f.sheet,materialKernel,assemblyKernel});
  assert.deepEqual(JSON.parse(JSON.stringify(serial({positions:c.motion.pos,body:c.motion.body}))),record.initial);
  for(const s of record.steps){const a=c.step(s.controls);assert.deepEqual(JSON.parse(JSON.stringify(serial({positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit:a}))),{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit});report.exactSteps++;}
  const result=audit.statistics();report.runs.push({path,sha256:hash(bytes),side:f.side,...result});
  console.log(`Граница LDL, ${f.side==='plus'?'первая':'другая'} сторона: ${result.matrices} факторов/${result.factorElements} элементов строго, 180 прежних шагов.`);
}
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
