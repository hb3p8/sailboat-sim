// Один короткий общий опыт полного сохранённого паруса с лабораторной водой.
// Сохраняет первый отказ/стоимость, старые серии не перезаписывает.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import {FluidBodyEnergyMotion} from '../tests/lib/cloth-fluid-body-motion.mjs';
import {fluidInertia} from '../tests/lib/cloth-fluid-inertia.mjs';
import {materialSurface,gridTriangles,MODEL_MATERIAL} from '../tests/lib/cloth-material.mjs';
import {installSharedInput} from '../tests/lib/cloth-shared-input.mjs';
import {distance} from '../tests/cloth-compliance.mjs';

const [input,output,countText='1',...extra]=process.argv.slice(2),count=Number(countText);
assert(input&&output&&!extra.length&&Number.isInteger(count)&&count>=1&&count<=3,'Нужны исходная полная серия, новый JSON и 1–3 шага');
assert(!existsSync(output),'Сохранённую постановку нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=readFileSync(input),source=JSON.parse(bytes);
assert.equal(source.dirty,false);assert.equal(source.phase,'complete');
for(const [path,sha] of Object.entries(source.sourceSha256))
  assert.equal(hash(execFileSync('git',['show',`${source.revision}:${path}`],{maxBuffer:16*1024*1024})),sha);
assert.equal(hash(readFileSync('out/export/physics.json')),source.physicsSha256);
const r=source.recipe,n=r.rows*r.cols;
assert.deepEqual([r.rows,r.cols],[11,9]);assert.equal(r.loadFrame,'inertial-cartesian-frozen');
assert.equal(r.mass.length,n+4);assert.equal(r.fixed.length,0);
const bodyInput=source.config.bodyInput;
assert.deepEqual(bodyInput,{massKg:1000,principalInertiaKgM2:[1000,5000,5000],originM:[0,0,0]});
const addedDiagonal=[60,1000,1200,250,4500,3500];
// Назначенный лабораторный контроль, не массы/обмер воды около SV20.
const addedMass6=Array.from({length:36},(_,i)=>i%7===0?addedDiagonal[i/7]:0);
const inertia=fluidInertia({dryMassKg:bodyInput.massKg,dryPrincipalInertiaKgM2:bodyInput.principalInertiaKgM2,addedMass6});
const surface=materialSurface(r.reference,gridTriangles(r.rows,r.cols),MODEL_MATERIAL,
  {bendingModel:'curvature',rows:r.rows,cols:r.cols});
const constraints=[...surface.constraints,...r.hard.map(c=>Object.assign(distance(c.a,c.b,c.rest,0,c.unilateral),{family:c.family}))];
const {head,end,nodes,fractions}=r.board;
nodes.forEach((node,j)=>{if(node!==head&&node!==end)for(let d=0;d<3;d++)constraints.push({
  alpha:0,unilateral:false,family:'аффинная верхняя планка',unit:'м',value(p) {
    const t=fractions[j],e=[0,0,0];e[d]=1;
    return {C:p[3*node+d]-(1-t)*p[3*head+d]-t*p[3*end+d],
      grad:[[node,e],[head,e.map(v=>-(1-t)*v)],[end,e.map(v=>-t*v)]]};
  }});});
const positions=r.positions.slice(0,3*n),previous=r.previous.slice(0,3*n);
const velocity=positions.map((v,k)=>(v-previous[k])/r.prevDt);
const m=new FluidBodyEnergyMotion({positions,mass:r.mass.slice(0,n),constraints,velocityMS:velocity,dampingHz:6,
  body:{inertia,originM:bodyInput.originM,orientation9:[1,0,0,0,1,0,0,0,1],velocity6:[0,0,0,0,0,0],
    attachments:r.rigidBody.attachments,frame:'body-cg'}});
const forceN=new Float64Array(3*n),cloth={rows:r.rows,cols:r.cols,n,rigidBoard:true,freeClew:false,
  pos:m.pos,prev:Float64Array.from(previous),frc:forceN,nrm:new Float64Array(3*n),pattern(){},velocityDt(){return r.hS;}};
installSharedInput(cloth,r.field);
const record={schema:'cloth-fluid-sail-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,
  hardware:{cpu:cpus()[0]?.model,platform:process.platform,arch:process.arch},
  input:{path:input,sha256:hash(bytes),revision:source.revision},physicsSha256:source.physicsSha256,
  sourceSha256:{},parameters:{bodyInput,addedMass6,material:MODEL_MATERIAL,hS:r.hS,tack:source.config.tack,requestedSteps:count,
    scope:'Лабораторный ЦТ и оси, заданная постоянная инерция воды; прежний замороженный воздух/вес/сопротивление ткани. Сил воды, собственного веса тела, живого Boat и CFD нет.'},
  initial:{positionsM:positions,velocityMS:velocity},steps:[]};
const root=fileURLToPath(new URL('../',import.meta.url));
function addSource(url) {
  const p=relative(root,fileURLToPath(url));if(Object.hasOwn(record.sourceSha256,p))return;
  const b=readFileSync(url);record.sourceSha256[p]=hash(b);
  for(const x of b.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))addSource(new URL(x[1],url));
}
addSource(new URL(import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):
  v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const start=performance.now();let attempt=0;
try {
  for(attempt=1;attempt<=count;attempt++) {
    cloth.prev.set(m.pos.map((v,k)=>v-r.hS*m.vel[k]));cloth.forcesAt(r.boat,r.hS);
    const old=m.pos.slice(),before=performance.now();
    const a=m.step({frame:'inertial-cartesian-cg',clothForceN:forceN,forceN:[0,0,0],momentNm:[0,0,0]},r.hS,r.iterations);
    const entry={step:attempt,stepMs:performance.now()-before,positionsM:Array.from(m.pos),body:structuredClone(m.body),forceN:Array.from(forceN),audit:serial(a)};
    record.steps.push(entry);
    assert(a.maxPhysicalResidualN<=m.tolerances.forceToleranceN&&a.maxHardViolationM<=m.tolerances.lengthToleranceM);
    assert(a.dualViolationN<=m.tolerances.dualToleranceN&&a.complementarityJ<=m.tolerances.complementarityToleranceJ);
    assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ);assert(Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
    assert(m.pos.every(Number.isFinite));assert(old.every(Number.isFinite));
  }
  record.phase='complete';
} catch(error) {
  record.phase='failed';record.failure={step:attempt,message:error.message,positionsM:Array.from(m.pos),body:structuredClone(m.body),forceN:Array.from(forceN)};
  process.exitCode=1;
}
record.totalMs=performance.now()-start;writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({запись:output,состояние:record.phase,принято_шагов:record.steps.length,время_мс:record.totalMs,отказ:record.failure?.message}));
