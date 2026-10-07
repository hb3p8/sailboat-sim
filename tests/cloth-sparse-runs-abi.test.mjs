// Неполный/чужой ABI плана должен отказать до чтения памяти/численного шага.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {sparsePattern} from './lib/cloth-sparse-solve.mjs';
const [arg]=process.argv.slice(2);assert(process.argv.length===3&&arg?.startsWith('--out='));const out=arg.slice(6);
assert(out&&!existsSync(out)&&!existsSync(out+'.cases'));mkdirSync(out+'.cases',{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex'),leb=n=>{const a=[];do{let b=n&127;n>>>=7;if(n)b|=128;a.push(b);}while(n);return a;},
  section=(id,b)=>[id,...leb(b.length),...b],name=s=>{const b=Array.from(new TextEncoder().encode(s));return [...leb(b.length),...b];};
function stub(abi,prepare) {
  const exports=[['sparse_ldl_factor_runs',0]],types=[0],bodies=[[0,0x41,0,0x0b]];
  if(abi!==undefined){exports.push(['sparse_ldl_runs_abi',types.length]);types.push(0);bodies.push([0,0x41,abi,0x0b]);}
  if(prepare){exports.push(['sparse_ldl_prepare_runs',types.length]);types.push(1);bodies.push([0,0x0b]);}
  return Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section(1,[2,0x60,0,1,0x7f,0x60,0,0]),...section(3,[types.length,...types]),
    ...section(7,[exports.length,...exports.flatMap(([s,index])=>[...name(s),0,...leb(index)])]),
    ...section(10,[bodies.length,...bodies.flatMap(b=>[...leb(b.length),...b])])]);
}
const p=sparsePattern(1,[[0]]),matrix=Float64Array.of(2),signs=Int32Array.of(1),cases=[];
for(const [label,abi,prepare] of [['нет-версии',undefined,true],['чужая-версия',2,true],['нет-подготовки',1,false]]) {
  const bytes=stub(abi,prepare),path=out+'.cases/'+label+'.wasm';writeFileSync(path,bytes,{flag:'wx'});
  const factor=await loadSparseFactor(bytes);
  assert.throws(()=>factor.ldl(matrix,p,signs),/Несовместимая подготовка участков LDL/);
  assert.deepEqual(matrix,Float64Array.of(2));assert.deepEqual(signs,Int32Array.of(1));
  cases.push({label,path,sha256:hash(bytes)});
}
writeFileSync(out,JSON.stringify({schema:'cloth-sparse-runs-abi-v1',test:{path:fileURLToPath(import.meta.url),sha256:hash(readFileSync(fileURLToPath(import.meta.url)))},
  loader:{path:'tests/lib/cloth-sparse-wasm.mjs',sha256:hash(readFileSync('tests/lib/cloth-sparse-wasm.mjs'))},cases,phase:'complete'},null,2)+'\n',{flag:'wx'});
console.log('ок: три несовместимых ABI участков LDL отклонены до чтения памяти; входы сохранены');
