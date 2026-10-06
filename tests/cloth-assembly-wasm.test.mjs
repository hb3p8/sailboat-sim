// Известная сумма жёсткостей и строгий перенос прежнего порядка прибавлений.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadAssemblyKernel} from './probes/cloth-assembly-wasm.mjs';
const args=process.argv.slice(2),wasm=args.find(v=>v.startsWith('--wasm='))?.slice(7),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(wasm&&args.length===(out?2:1)&&args.every(v=>/^--(wasm|out)=.+$/.test(v))&&(!out||!existsSync(out)));
const bytes=readFileSync(wasm),kernel=await loadAssemblyKernel(bytes),hash=b=>createHash('sha256').update(b).digest('hex'),report={schema:'cloth-assembly-wasm-check-v1',wasm:{path:wasm,sha256:hash(bytes)},runtime:process.version,v8:process.versions.v8,matrices:0,elements:0,rejected:0};
const plans=[{coordinates:[0,1],entries:Int32Array.from([0,1,2])},{coordinates:[2],entries:Int32Array.from([2])}],compiled=kernel.compile(3,plans),matrix=Float64Array.from([10,-0,0]),soft=[{g:[[0,2],[1,-3]],c:{alpha:2}},{g:[[2,4]],c:{alpha:4}}];
compiled.assemble(matrix,soft);assert.deepEqual(Array.from(matrix),[12,-3,8.5]);report.matrices++;report.elements+=3;
// В разных группах места могут совпадать; в одной SIMD-группе они различны.
let seed=7127;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
for(let trial=0;trial<128;trial++) {
 const count=1+trial%17,length=1700,descriptors=[],groups=[];
 for(let k=0;k<count;k++) {
  const size=(trial+k)%19,entries=[];
  while(entries.length<size*(size+1)/2){const v=Math.floor(random()*length);if(!entries.includes(v))entries.push(v);}
  descriptors.push({coordinates:Array.from({length:size},(_,i)=>i),entries:Int32Array.from(entries)});
  groups.push({g:Array.from({length:size},(_,i)=>[i,(random()-.5)*10**((trial+k)%9-4)]),c:{alpha:10**(trial%11-5)}});
 }
 const native=kernel.compile(length,descriptors),expected=Float64Array.from({length},(_,i)=>i%7===0?-0:(random()-.5)*3),actual=expected.slice();
 for(let k=0;k<count;k++){const g=groups[k].g,alpha=groups[k].c.alpha;let at=0;for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++)expected[descriptors[k].entries[at++]]+=g[a][1]*g[b][1]/alpha;}
 native.assemble(actual,groups);for(let i=0;i<length;i++)assert(Object.is(actual[i],expected[i]),`Матрица ${trial}, элемент ${i}`);report.matrices++;report.elements+=length;
}
for(const g of [[-0,0],[1e-200,-1e-200],[1e200,-1e200],[Number.MIN_VALUE,-Number.MIN_VALUE]]) {
 const plan=[{coordinates:[0,1],entries:Int32Array.from([0,1,2])}],C=kernel.compile(3,plan),soft=[{g:g.map((v,i)=>[i,v]),c:{alpha:1e-200}}],a=new Float64Array(3),b=a.slice();let k=0;
 for(let i=0;i<2;i++)for(let j=0;j<=i;j++)a[k++]+=g[i]*g[j]/soft[0].c.alpha;
 C.assemble(b,soft);b.forEach((v,i)=>assert(Object.is(v,a[i])));report.matrices++;report.elements+=3;
}
const empty=kernel.compile(0,[]);empty.assemble(new Float64Array(),[]);report.matrices++;
const wide=kernel.compile(4656,[{coordinates:new Array(96),entries:Int32Array.from({length:4656},(_,i)=>i)}]),wideMatrix=new Float64Array(4656);
wide.assemble(wideMatrix,[{c:{alpha:1},g:Array.from({length:96},(_,i)=>[i,1])}]);assert(wideMatrix.every(v=>v===1));report.matrices++;report.elements+=wideMatrix.length;
const before=compiled.statistics();for(const bad of [[{coordinates:[0,1],entries:Int32Array.from([0,0,2])}],[{coordinates:[0],entries:Int32Array.from([3])}]]){assert.throws(()=>kernel.compile(3,bad));report.rejected++;}
const guard=new Float64Array(3).fill(71),snapshot=guard.slice();
for(const bad of [[],[{g:[[0,2]],c:{alpha:1}},{g:[[0,3]],c:{alpha:1}}],[{g:[[0,NaN],[1,3]],c:{alpha:1}},soft[1]],[{g:soft[0].g,c:{alpha:0}},soft[1]]]){assert.throws(()=>compiled.assemble(guard,bad));assert.deepEqual(guard,snapshot);report.rejected++;}
assert.deepEqual(compiled.statistics(),before);assert.throws(()=>compiled.assemble(new Float64Array(2),soft));report.rejected++;
const copied=kernel.compile(3,plans);plans[0].entries[0]=2;const copyResult=Float64Array.from([10,0,0]);copied.assemble(copyResult,soft);assert.deepEqual(Array.from(copyResult),[12,-3,8.5]);
const other=kernel.compile(3,[{coordinates:[0],entries:Int32Array.from([0])}]);other.assemble(new Float64Array(3),[{g:[[0,19]],c:{alpha:2}}]);copyResult.set([10,0,0]);copied.assemble(copyResult,soft);assert.deepEqual(Array.from(copyResult),[12,-3,8.5]);
await assert.rejects(loadAssemblyKernel(Uint8Array.from([0,97,115,109,1,0,0,0])),/Несовместимая/);report.rejected++;
report.sourceSha256=Object.fromEntries(['tests/cloth-assembly-wasm.test.mjs','tests/probes/cloth-assembly-wasm.c','tests/probes/cloth-assembly-wasm.mjs'].map(p=>[p,hash(readFileSync(p))]));report.phase='complete';if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Сборка WASM: ${report.matrices} матриц, ${report.elements} элементов совпали строго; ${report.rejected} отказов, копии плана и отдельные экземпляры — пройдены.`);
