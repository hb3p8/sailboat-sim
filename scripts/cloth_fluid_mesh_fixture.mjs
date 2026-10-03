// Проверить излом полного паруса при истинном уточнении сетки в двух направлениях.
// Воздух заморожен; это сравнение лабораторной ткани, не CFD и не приёмка SV20.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import {Boat} from '../sim/physics.js';
import {Cloth} from '../sim/cloth.js';
import {installSharedInput,integrateDensity} from '../tests/lib/cloth-shared-input.mjs';
import {constraintFamily} from '../tests/lib/cloth-mechanics.mjs';
import {browserMotion} from '../tests/lib/cloth-browser-motion.mjs';
import {fluidSailMotion} from '../tests/lib/cloth-fluid-sail-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {surfaceTurns} from '../tests/lib/cloth-surface-turns.mjs';
import {commonNodeDistances} from '../tests/cloth-motion-refinement.mjs';

const [input,output,gridText,scaleText,countText,...extra]=process.argv.slice(2);
const grid=gridText?.match(/^(11x9|21x17|41x33)$/),pressureScale=Number(scaleText),count=Number(countText);
assert(input&&output&&grid&&[1,1.5].includes(pressureScale)&&Number.isInteger(count)&&count>=1&&count<=300&&
  extra.length===1&&extra[0].startsWith('--wasm='),'Нужны вход, новый JSON, 11x9/21x17/41x33, давление 1/1.5, 1–300 шагов и --wasm=модуль');
assert(!existsSync(output),'Сохранённый опыт нельзя перезаписывать');
const [rows,cols]=gridText.split('x').map(Number),hash=b=>createHash('sha256').update(b).digest('hex');
const sourceBytes=readFileSync(input),source=JSON.parse(sourceBytes),wasmPath=extra[0].slice(7),wasmBytes=readFileSync(wasmPath);
assert.equal(source.dirty,false);assert.equal(source.phase,'complete');
assert.deepEqual([source.recipe.rows,source.recipe.cols],[11,9]);
for(const [path,sha] of Object.entries(source.sourceSha256))
  assert.equal(hash(execFileSync('git',['show',`${source.revision}:${path}`],{maxBuffer:16*1024*1024})),sha);
const packBytes=readFileSync('out/export/physics.json');assert.equal(hash(packBytes),source.physicsSha256);
const factor=await loadSparseFactor(wasmBytes),baseline=source.recipe,n=rows*cols;
const record={schema:'cloth-fluid-mesh-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,
  hardware:{cpu:cpus()[0]?.model,platform:process.platform,arch:process.arch},
  input:{path:input,sha256:hash(sourceBytes),revision:source.revision},physicsSha256:source.physicsSha256,
  wasm:{path:wasmPath,sha256:hash(wasmBytes)},sourceSha256:{},
  config:{rows,cols,tack:source.config.tack,pressureScale,yawMomentNm:0,hS:1/60,requestedSteps:count,warmupSteps:40,
    scope:'Тот же аналитический крой и интегрируемое поле 16 компонент; посадка 40 шагов при закреплённых углах и давлении 100%, затем свободная лабораторная опора с обобщённой водой. Нагрузка 100/150% постоянна с первого общего шага. Руль, верёвка, живой воздух и CFD отсутствуют.'},steps:[]};
const root=fileURLToPath(new URL('../',import.meta.url));
function addSource(url) {
  const p=relative(root,fileURLToPath(url));if(Object.hasOwn(record.sourceSha256,p))return;
  const bytes=readFileSync(url);record.sourceSha256[p]=hash(bytes);
  for(const m of bytes.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
    addSource(new URL(m[1],url));
}
addSource(new URL(import.meta.url));
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):
  v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const start=performance.now();let attempt=0,calculation;
try {
  // Воспроизводим параметры исходного кроя; новая сетка не интерполирует старые грани.
  const b=new Boat(JSON.parse(packBytes)),D=Math.PI/180,tack=source.config.tack;
  const wrap=x=>((x+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
  b.o.freeWake=true;b.o.wakeForces=true;b.o.crewHike=-tack;b.o.crewMass=219.9;
  b.wind.o.gust=0;b.wind.o.shift=0;b.setGennaker(true);b.o.sheet=70*D;b.o.twist=8*D;b.o.genSheetLen=9;
  b.reset();b.o.windSpeed=6;b.o.windDir=100*D;b.u=3;b.psi=(100-tack*140)*D;
  for(let i=0;i<900;i++) {
    b.o.rudderTarget=Math.max(-25*D,Math.min(25*D,-(2.2*wrap((100-tack*140)*D-b.psi)-.9*b.r)));
    b.step(1/30);
  }
  const cloth=new Cloth(b.rig.sails[2],2,{rows,cols,iter:80,rigidBoard:true,continuousCut:true,joinedCutProfile:true});
  const {integrated}=installSharedInput(cloth,baseline.field);let fixedRecipe;
  cloth.advance=function() {
    if(fixedRecipe)return;
    const hard=[];
    for(let k=0;k<this.ci.length;k++) {
      const family=constraintFamily(this,k);
      if(['foot','luff','leech'].includes(family))hard.push({a:this.ci[k],b:this.cj[k],rest:this.rest[k],unilateral:true,family});
    }
    hard.push({a:this.head,b:this.boardEnd,rest:this.boardRest,unilateral:false,family:'board'});
    const nodes=Array.from({length:cols},(_,c)=>this.head+c);
    fixedRecipe={rows,cols,hS:1/60,iterations:80,
      reference:Array.from({length:3*n},(_,k)=>[this.dx,this.dy,this.dz][k%3][Math.floor(k/3)]),
      positions:Array.from(this.pos),previous:Array.from(this.prev),prevDt:this.prevDt,mass:Array.from(this.mass),
      fixed:[this.tack,this.head,this.clew],hard,
      board:{head:this.head,end:this.boardEnd,nodes,fractions:nodes.map(i=>this.boardFraction[i])},
      field:baseline.field,boat:{phi:b.phi,p:{mass:{cg_m:b.p.mass.cg_m}}}};
  };
  assert(cloth.step(b,1/30));assert(fixedRecipe);
  assert.deepEqual(fixedRecipe.boat,baseline.boat);
  record.referenceComparison=commonNodeDistances(baseline,fixedRecipe,baseline.reference,fixedRecipe.reference);
  assert.equal(record.referenceComparison.maximumM,0,'Изменился аналитический крой в общих узлах');
  const totals=p=>Array.from({length:16},(_,d)=>Array.from({length:p.length/16},(_,i)=>p[16*i+d]).reduce((a,b)=>a+b,0));
  const oldTotals=totals(integrateDensity(baseline.field,11,9)),newTotals=totals(integrated);
  record.fieldTotals={old:oldTotals,refined:newTotals,maximumRelativeDifference:Math.max(...oldTotals.map((v,d)=>Math.abs(v-newTotals[d])/Math.max(1,Math.abs(v))))};
  assert(record.fieldTotals.maximumRelativeDifference<1e-12,'Изменился интеграл общего входа');
  const warm=browserMotion(fixedRecipe,factor),warmStart=performance.now();
  for(let i=0;i<40;i++)warm.step();
  record.warmupMs=performance.now()-warmStart;
  const recipe={...fixedRecipe,fixed:[],positions:[...warm.motion.pos,...baseline.positions.slice(3*99)],
    previous:[...warm.motion.prev,...baseline.previous.slice(3*99)],prevDt:warm.motion.prevDt,
    mass:[...fixedRecipe.mass,...baseline.mass.slice(99)],loadFrame:baseline.loadFrame,
    rigidBody:{...baseline.rigidBody,nodes:[n,n+1,n+2,n+3],attachments:fixedRecipe.fixed}};
  if(rows===11&&cols===9)assert.deepEqual(recipe,baseline,'Перестроение изменило исходную лабораторную постановку');
  record.recipe=recipe;
  calculation=fluidSailMotion(recipe,source.config.bodyInput,factor,{allowRefinementGrid:true});
  const {motion:m}=calculation;
  record.parameters={bodyInput:source.config.bodyInput,addedMass6:calculation.addedMass6,material:calculation.material,tolerances:m.tolerances};
  record.initial={positionsM:Array.from(m.pos),velocityMS:Array.from(m.vel),body:structuredClone(m.body),turns:surfaceTurns(recipe,m.pos)};
  record.referenceTurns=surfaceTurns(recipe,recipe.reference);
  for(attempt=1;attempt<=count;attempt++) {
    calculation.prepareLoad({pressureScale,yawMomentNm:0});const before=performance.now();
    const audit=calculation.solve(),stepMs=performance.now()-before;
    assert(audit.maxPhysicalResidualN<=m.tolerances.forceToleranceN&&audit.maxHardViolationM<=m.tolerances.lengthToleranceM);
    assert(audit.dualViolationN<=m.tolerances.dualToleranceN&&audit.complementarityJ<=m.tolerances.complementarityToleranceJ);
    record.steps.push({step:attempt,timeS:attempt/60,stepMs,positionsM:Array.from(m.pos),body:structuredClone(m.body),
      forceN:Array.from(calculation.forceN),audit:serial(audit),turns:surfaceTurns(recipe,m.pos)});
  }
  record.phase='complete';
} catch(error) {
  record.phase='failed';record.failure={stage:calculation?'движение':'подготовка',step:attempt,message:error.message,stack:error.stack};
  process.exitCode=1;
}
record.totalMs=performance.now()-start;
writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({запись:output,сетка:gridText,давление:pressureScale,состояние:record.phase,
  принято_шагов:record.steps.length,время_мс:record.totalMs,отказ:record.failure?.message}));
