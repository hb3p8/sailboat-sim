// Известные операции и прежние байты: знаки нуля, крайние числа, разные контейнеры.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as current from './lib/cloth-fluid-inertia.mjs';
const args=process.argv.slice(2),out=args.find(a=>a.startsWith('--out='))?.slice(6);assert(args.length===1&&out&&!existsSync(out));
const oldSource=execFileSync('git',['show','63f0225:tests/lib/cloth-fluid-inertia.mjs'],{encoding:'utf8'}),old=await import('data:text/javascript,'+encodeURIComponent(oldSource)),
  hash=b=>createHash('sha256').update(b).digest('hex');let cases=0,elements=0;
function exact(a,b){assert.deepEqual(a,b);for(let i=0;i<a.length;i++)assert(Object.is(a[i],b[i]));cases++;elements+=a.length;}
exact(current.matrixVector([2,1,3,4],[5,6]),[16,39]);exact(current.product3([1,0,0,0,1,0,0,0,1],[1,2,3,4,5,6,7,8,9]),[1,2,3,4,5,6,7,8,9]);
for(const n of [0,1,3,6,13])for(const Type of [Array,Float64Array])for(const scale of [1,1e-200,1e200]){
  const m=Type.from({length:n*n},(_,i)=>Math.sin(i+.2)*scale),v=Type.from({length:n},(_,i)=>Math.cos(i+.7)),copyM=m.slice(),copyV=v.slice();
  exact(current.matrixVector(m,v),old.matrixVector(m,v));assert.deepEqual(m,copyM);assert.deepEqual(v,copyV);
}
for(const x of [0,-0,NaN,Infinity,-Infinity,Number.MIN_VALUE,Number.MAX_VALUE]){
  const a=[x,-0,1,0,x,-1,1,0,x],b=[1,x,-0,-0,0,x,0,1,x];
  for(const Type of [Array,Float64Array]){exact(current.product3(Type.from(a),Type.from(b)),old.product3(Type.from(a),Type.from(b)));exact(current.matrixVector(Type.from(a),Type.from([x,-0,1])),old.matrixVector(Type.from(a),Type.from([x,-0,1])));}
}
for(const length of [0,1,2,5,8,9,12]){const a=Array.from({length},(_,i)=>i-.2);if(length>2)delete a[1];exact(current.matrixVector(a,[1,2,3]),old.matrixVector(a,[1,2,3]));}
const a=current.matrixVector([1,0,0,1],[2,3]),b=current.matrixVector([1,0,0,1],[4,5]);assert.deepEqual(a,[2,3]);b[0]=7;assert.deepEqual(a,[2,3]);
const state={origin:[1,-2,3],rotation:[0,-1,0,1,0,0,0,0,1],velocity:[.2,-.3,.4,.7,-.8,.9]};
for(const h of [1/60,1/120,1/240])for(const sign of [1,-1]){const v=state.velocity.map(x=>x*sign);const p=current.cayleyBodyPose(state.origin,state.rotation,v,h),q=old.cayleyBodyPose(state.origin,state.rotation,v,h);assert.deepEqual(p,q);cases++;elements+=27;}
const report={schema:'cloth-fluid-matrix-loops-check-v1',phase:'complete',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  baselineRevision:'63f0225',baselineSha256:hash(oldSource),candidateSha256:hash(readFileSync('tests/lib/cloth-fluid-inertia.mjs')),cases,elements,
  rule:'Все элементы Object.is, включая знак нуля/NaN. Известные числа/неизменность/самостоятельные ответы, Array/Float64Array, пустые/неполные/с пропусками, конечные позы Кэли обоих знаков.'};
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});writeFileSync(out+'.baseline.mjs',oldSource,{flag:'wx'});writeFileSync(out+'.candidate.mjs',readFileSync('tests/lib/cloth-fluid-inertia.mjs'),{flag:'wx'});
console.log(`Малые матричные операции: ${cases} случаев/${elements} элементов и известные движения совпали строго.`);
