// Изолированный контроль стоимости линейной арифметики, не физическая приёмка.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {bandFactor} from './lib/cloth-linear-solve.mjs';
import {loadBandFactor} from './probes/cloth-linear-wasm.mjs';

const args=process.argv.slice(2);
assert.ok(args.length===3 && ['baseline','wasm','out'].every(name=>args.filter(a=>a.startsWith(`--${name}=`)).length===1)
  && args.every(a=>/^--(baseline|wasm|out)=.+$/.test(a)),
  'Нужны --baseline=ревизия --wasm=модуль.wasm --out=отчёт.json');
const arg=name=>args.find(a=>a.startsWith(`--${name}=`)).slice(name.length+3);
const revision=execFileSync('git',['rev-parse','--verify',`${arg('baseline')}^{commit}`],{encoding:'utf8'}).trim();
const baseline=execFileSync('git',['show',`${revision}:tests/lib/cloth-linear-solve.mjs`]);
const before=(await import(`data:text/javascript;base64,${baseline.toString('base64')}`)).bandFactor;
const wasmPath=resolve(arg('wasm')),wasmBytes=readFileSync(wasmPath),wasm=await loadBandFactor(wasmBytes);
const output=resolve(arg('out'));
assert.ok(output!==wasmPath && output.endsWith('.json') && output!==resolve('out/export/physics.json'),
  'Отчёт не должен заменять модуль или исходники');
const variants=[['исходный JS',before],['ускоренный JS',bandFactor],['изолированный WASM',wasm]];
const packed=(n,band)=>{
  const A=new Float64Array(n*(band+1));
  // Симметричная положительная матрица: диагональ 10 превосходит сумму модулей.
  for(let i=0;i<n;i++)for(let j=Math.max(0,i-band);j<=i;j++)
    A[i*(band+1)+i-j]=i===j?10:.03*Math.sin(i+j)/(i-j);
  return A;
};
for(const [n,band] of [[0,2],[9,0],[9,3],[9,12],[257,161]]) {
  const A=packed(n,band),old=before(A,n,band),current=bandFactor(A,n,band),candidate=wasm(A,n,band);
  for(const rhs of [new Float64Array(n).fill(1),Float64Array.from({length:n},(_,i)=>Math.sin(i))]) {
    const expected=old(rhs);assert.deepEqual(current(rhs),expected);assert.deepEqual(candidate(rhs),expected);
  }
}
for(const diagonal of [0,-1,NaN,Infinity])for(const [,factor] of variants)
  assert.throws(()=>factor(Float64Array.of(diagonal),1,0),/не положительна/);
const n=4000,band=305,A=packed(n,band),rhs=Array.from({length:80},(_,k)=>
  Float64Array.from({length:n},(_,i)=>Math.sin(i+k))),stats=[];
let reference;
for(let pass=0;pass<6;pass++)for(const [name,factor] of variants) {
  const begin=performance.now(),solve=factor(A,n,band),factored=performance.now();
  const answers=rhs.map(solve),finish=performance.now();reference??=answers;
  answers.forEach((x,i)=>assert.deepEqual(x,reference[i]));
  stats.push({pass,phase:pass?'прогретый большой случай':'первый большой случай после малых контролей',name,
    factorMs:factored-begin,solveMs:finish-factored,exact:true});
}
const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
const warmed=variants.map(([name])=>({name,medianMs:median(stats.filter(s=>s.pass && s.name===name).map(s=>s.factorMs+s.solveMs))}));
const sha=b=>createHash('sha256').update(b).digest('hex');
const sources=['tests/probes/cloth-linear-wasm.c','tests/probes/cloth-linear-wasm.mjs',
  'tests/cloth-linear-wasm-probe.mjs','tests/lib/cloth-linear-solve.mjs'];
const result={schema:1,createdAt:new Date().toISOString(),
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
  baselineRevision:revision,baselineSha256:sha(baseline),wasmSha256:sha(wasmBytes),
  sourceSha256:Object.fromEntries(sources.map(p=>[p,sha(readFileSync(p))])),
  n,band,rhs:80,rule:'синтетическая положительная матрица; малые контроли до замера, затем первый большой случай и пять повторов; загрузка/компиляция модуля не измерены; не полный парус',
  stats,warmed,physicalAcceptance:false};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log('Ответы совпали точно; вырожденные/нечисловые матрицы отклонены.');
for(const s of warmed)console.log(`${s.name}: медиана пяти прогретых разложений и 80 решений ${s.medianMs.toFixed(3)} мс`);
