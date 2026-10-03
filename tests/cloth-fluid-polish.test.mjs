// Уже решённый шаг сжатой пружины не требует положительной полной Hessian.
// Неудачная вспомогательная коррекция не отменяет физические проверки.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FluidBodyEnergyMotion} from './lib/cloth-fluid-body-motion.mjs';
import {fluidInertia} from './lib/cloth-fluid-inertia.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
import {distance} from './cloth-compliance.mjs';

const args=process.argv.slice(2),wasmPath=args.find(a=>a.startsWith('--wasm='))?.slice(7),
  output=args.find(a=>a.startsWith('--out='))?.slice(6);
assert(wasmPath&&args.every(v=>/^--(wasm|out)=.+$/.test(v))&&new Set(args.map(v=>v.split('=')[0])).size===args.length);
const bytes=readFileSync(wasmPath),factor=await loadSparseFactor(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
const near=(a,b,t=1e-8)=>assert(Math.abs(a-b)<=t*Math.max(1,Math.abs(b)),`${a} ≠ ${b}`);
const inertia=fluidInertia({dryMassKg:10,dryPrincipalInertiaKgM2:[2,3,4],addedMass6:new Array(36).fill(0)});
const make=(side,backend='schur-wasm')=>new FluidBodyEnergyMotion({
  positions:[0,0,0,.6*side,0,0],mass:[2,2],constraints:[distance(0,1,1,1/1000,false)],dampingHz:0,
  linearBackend:backend,wasmSparseFactor:factor,
  body:{inertia,originM:[0,0,0],orientation9:[1,0,0,0,1,0,0,0,1],velocity6:[0,0,0,0,0,0],attachments:[0],frame:'body-cg'}});
const load=(side,h)=>({frame:'inertial-cartesian-cg',clothForceN:[500*side,0,0,(-500-2*.1/(h*h))*side,0,0],forceN:[0,0,0],momentNm:[0,0,0]});
const snapshot=m=>({positions:Array.from(m.pos),velocity:Array.from(m.vel),body:structuredClone(m.body),
  reactions:Array.from(m.lastMu),lambdas:m.constraints.map(c=>c.lambda)});
const cases=[];
for(const side of [1,-1])for(const h of [.1,.05,.025]) {
  const m=make(side),a=m.step(load(side,h),h),reference=make(side,'reference-dense');
  reference.step(load(side,h),h);
  // Итог задан независимо: опора остаётся на месте, свободная масса идёт .6→.5 м.
  const expected=[0,0,0,.5*side,0,0];m.pos.forEach((v,i)=>near(v,expected[i]));
  m.pos.forEach((v,i)=>near(v,reference.pos[i]));m.body.originM.forEach(v=>near(v,0));
  near(m.vel[3],-.1*side/h);near(a.softEnergyJ,125);near(a.kineticJ,.01/(h*h));
  near(a.workJ,50+.02/(h*h));near(a.materialIncrementJ,5);
  assert(a.maxPhysicalResidualN<=m.tolerances.forceToleranceN&&a.maxHardViolationM<=m.tolerances.lengthToleranceM);
  assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ&&Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
  // Поперечная диагональ полной Hessian: m/h² + k(1−L/d).
  // Положительная энергия не означает положительность её второй производной.
  const transverseDiagonal=2/(h*h)+1000*(1-1/.5);
  const failures=a.solver.polishFactorizationFailures??[];
  assert.equal(failures.length,transverseDiagonal<0?1:0);
  if(failures.length){assert.equal(a.solver.polishStalls,1);assert.equal(a.solver.polishIterations,0);}
  cases.push({side,h,transverseDiagonal,failures,audit:{forceN:a.maxPhysicalResidualN,workJ:a.discreteBalanceResidualJ,
    workLimitJ:a.workLimitJ,interfaceJ:a.bodyWorkCancellationResidualJ,interfaceLimitJ:a.interfaceWorkLimitJ}});
}
// Любой отказ основного решения остаётся отказом, с полным возвратом состояния.
{
  const m=make(1),before=snapshot(m);m.direction=()=>{const e=new Error('Отказ основного направления');e.code='CLOTH_SPARSE_FACTOR_REJECTED';throw e;};
  assert.throws(()=>m.step(load(1,.1),.1),/основного направления/);assert.deepEqual(snapshot(m),before);
}
// Ошибка программы в дополнительной коррекции не маскируется её необязательностью.
{
  const m=make(1),before=snapshot(m),direction=m.direction;
  m.direction=function(...a){if(a[6]?.exact)throw new Error('Ошибка дополнительного направления');return direction.apply(this,a);};
  assert.throws(()=>m.step(load(1,.1),.1),/дополнительного направления/);assert.deepEqual(snapshot(m),before);
}
// При плохом балансе работы даже выполненные силовые допуски не разрешают приёмку.
for(const kind of ['discreteBalanceResidualJ','bodyWorkCancellationResidualJ']) {
  const m=make(1),before=snapshot(m),audit=m.audit;
  m.audit=function(...args){const a=audit.apply(this,args);a[kind]=2*a[kind==='discreteBalanceResidualJ'?'workLimitJ':'interfaceWorkLimitJ'];return a;};
  assert.throws(()=>m.step(load(1,.1),.1),e=>e.code==='CLOTH_SPARSE_FACTOR_REJECTED');
  assert.deepEqual(snapshot(m),before);
}
const sourceSha256={},root=fileURLToPath(new URL('../',import.meta.url));
function addSource(url){const p=relative(root,fileURLToPath(url));if(Object.hasOwn(sourceSha256,p))return;
  const b=readFileSync(url);sourceSha256[p]=hash(b);
  for(const x of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))addSource(new URL(x[1],url));}
addSource(new URL(import.meta.url));
if(output)writeFileSync(output,JSON.stringify({schema:'cloth-fluid-polish-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,
  wasm:{path:wasmPath,sha256:hash(bytes)},cases,rejectedControls:4,phase:'complete'},null,2)+'\n',{flag:'wx'});
console.log('Дополнительная коррекция: 6 известных сжатий в обоих зеркалах, плотный контроль и 4 отказа с возвратом состояния — пройдены.');
