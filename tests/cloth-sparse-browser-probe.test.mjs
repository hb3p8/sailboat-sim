// Реальные двоичные коэффициенты и независимые известные системы перед браузером.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {sparsePattern} from '../sim/cloth/cloth-sparse-solve.mjs';
import {captureViews,prepareProbeLDL,compareProbeLDL,equalProbe} from './probes/cloth-sparse-browser-probe.mjs';
const args=process.argv.slice(2);assert(args.length===1&&args[0].startsWith('--input='));
const capture=JSON.parse(readFileSync(args[0].slice(8))),b=readFileSync(capture.binary.path),hash=x=>createHash('sha256').update(x).digest('hex');
assert.equal(hash(b),capture.binary.sha256);const buffer=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),{patterns,samples}=captureViews(capture,buffer);
const modules={};for(const [v,p] of Object.entries(capture.modules)){const bytes=readFileSync(p.path);assert.equal(hash(bytes),p.sha256);if(['baseline','candidate'].includes(v))modules[v]=await WebAssembly.compile(bytes);}
const workspaces=Object.fromEntries(Object.entries(modules).map(([v,m])=>[v,patterns.map(p=>prepareProbeLDL(m,p))]));
let elements=0;
for(const s of samples){const a=workspaces.baseline[s.pattern],c=workspaces.candidate[s.pattern],saved=s.matrix.slice();
  assert.equal(a.run(s.matrix,s.signs).failure,0);assert.equal(c.run(s.matrix,s.signs).failure,0);compareProbeLDL(a,c);assert.deepEqual(s.matrix,saved);elements+=a.L.length;}
for(const n of [0,1,13,201]){
  const p=sparsePattern(n,Array.from({length:n},(_,i)=>[i])),matrix=new Float64Array(p.cols.length).fill(2),signs=new Int32Array(n).fill(1),
    a=prepareProbeLDL(modules.baseline,p),c=prepareProbeLDL(modules.candidate,p);
  assert.equal(a.run(matrix,signs).failure,0);assert.equal(c.run(matrix,signs).failure,0);compareProbeLDL(a,c);
}
const p=sparsePattern(1,[[0]]),a=prepareProbeLDL(modules.baseline,p),c=prepareProbeLDL(modules.candidate,p);
for(const x of [0,-0,-1,NaN,Infinity,-Infinity]){const matrix=Float64Array.of(x),signs=Int32Array.of(1);assert.equal(a.run(matrix,signs).failure,1);assert.equal(c.run(matrix,signs).failure,1);compareProbeLDL(a,c);}
assert.throws(()=>equalProbe({a:-0},{a:0}),/Различие/);equalProbe({a:NaN},{a:NaN});
const bad=structuredClone(capture);bad.samples[0].matrix.offset++;assert.throws(()=>captureViews(bad,buffer),/граница/);
assert.throws(()=>captureViews(capture,buffer.slice(0,-1)),/длина/);
console.log(`Браузерный аудит LDL: ${samples.length} настоящих факторов/${elements} элементов, 10 известных систем/отказов, знак нуля и плохие границы — пройдены.`);
