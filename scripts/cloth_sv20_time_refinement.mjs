// Три механических шага при одних часах Rig 60 Гц; новый временной контроль.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {liveWindSailMotion} from '../tests/lib/cloth-live-wind-sail-motion.mjs';
import {sv20WindCycleControls} from '../tests/lib/cloth-live-wind-controls.mjs';
import {sv20BodyAngles} from '../tests/lib/cloth-sv20-water.mjs';
import {rotate3,transpose3} from '../tests/lib/cloth-fluid-inertia.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from '../tests/probes/cloth-material-wasm.mjs';
import {loadAssemblyKernel} from '../tests/probes/cloth-assembly-wasm.mjs';
const [out]=process.argv.slice(2);assert(out&&process.argv.length===3&&!existsSync(out)&&!existsSync(out+'.sources'));
const hash=b=>createHash('sha256').update(b).digest('hex'),root=fileURLToPath(new URL('../',import.meta.url));
const sourceSha256={};
function saveSource(url) {
  const path=relative(root,fileURLToPath(url));if(sourceSha256[path])return;
  const bytes=readFileSync(url);sourceSha256[path]=hash(bytes);const target=resolve(out+'.sources',path);
  mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});
  for(const m of bytes.toString().matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"]+)['"]/g))saveSource(new URL(m[1],url));
}
saveSource(new URL(import.meta.url));
const packBytes=readFileSync('out/export/physics.json'),pack=JSON.parse(packBytes);
const referencePath='out/acceptance/sv20-dry-cycle-20261009-draft-v2.json',referenceBytes=readFileSync(referencePath),reference=JSON.parse(referenceBytes);
assert.equal(reference.phase,'complete');assert.deepEqual(reference.cycleWind,{baseMPS:4,peakMPS:4.5});
assert.equal(reference.physicsSha256,hash(packBytes));
const report={schema:'cloth-sv20-time-refinement-v1',phase:'running',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,physicsSha256:hash(packBytes),
  reference:{path:referencePath,sha256:hash(referenceBytes)},parameters:{model:'sampled-air-60hz-v1',pressureFrequencyHz:60,
    mechanicalFrequenciesHz:[60,120,240],durationS:3,cycleWind:{baseMPS:4,peakMPS:4.5},bodyProfile:'sv20-rig-budget-point-v1'},runs:[],comparisons:[],
  scope:'Сходимость механики при удерживаемом давлении Rig 60 Гц. Вода/нормали/площадь/скоростное сопротивление ткани обновляются на каждом подшаге. Не полный временной предел воздуха, не CFD или приёмка G1–G4/C1.'};
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const json=v=>JSON.parse(JSON.stringify(serial(v)));
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Временной контроль остановлен: '+e.message.slice(0,1000));process.exitCode=1;});
for(const side of ['plus','minus'])for(const hz of [60,120,240]) {
  const path=`out/acceptance/fluid-live-sv20-dry-20261009-${side}.json`,bytes=readFileSync(path),f=JSON.parse(bytes),ratio=hz/60;
  assert.equal(f.recipe.hS,1/60);assert.equal(f.recipe.rows,11);assert.equal(f.recipe.cols,9);assert.equal(f.physicsSha256,hash(packBytes));
  for(const p of [f.input,f.wasm,f.materialWasm,f.assemblyWasm])assert.equal(hash(readFileSync(p.path)),p.sha256);
  const c=liveWindSailMotion(f.recipe,f.bodyInput,await loadSparseFactor(readFileSync(f.wasm.path)),
    {pack,wind:f.liveWind.wind,sheet:f.sheet,materialKernel:await loadMaterialKernel(readFileSync(f.materialWasm.path)),
      assemblyKernel:await loadAssemblyKernel(readFileSync(f.assemblyWasm.path)),bodyProfile:report.parameters.bodyProfile,
      hS:1/hz,timeRefinement:report.parameters.model});
  const old=reference.runs.find(r=>r.tack===(side==='plus'?1:-1)),run={side,hz,hS:1/hz,input:{path,sha256:hash(bytes)},
    modules:{linear:f.wasm,material:f.materialWasm,assembly:f.assemblyWasm},massBudget:c.massBudget,
    initial:json({positions:c.motion.pos,body:c.motion.body}),legacyExactSteps:0,pressureUpdates:0,drySteps:0,steps:[],frames:[]};report.runs.push(run);
  for(let k=0;k<180*ratio;k++) {
    const controls=sv20WindCycleControls(Math.floor(k/ratio),side,report.parameters.cycleWind),start=performance.now(),audit=c.step(controls);
    const state=json({index:k+1,timeS:(k+1)/hz,controls,stepMs:performance.now()-start,positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit});
    const a=state.audit,t=a.solver;
    assert(a.maxPhysicalResidualN<=t.forceToleranceN&&a.maxHardViolationM<=t.lengthToleranceM&&a.dualViolationN<=t.dualToleranceN&&a.complementarityJ<=t.complementarityToleranceJ);
    assert(Math.abs(a.discreteBalanceResidualJ)<=a.workLimitJ&&Math.abs(a.bodyWorkCancellationResidualJ)<=a.interfaceWorkLimitJ);
    for(const r of a.ropes)assert(Math.abs(r.controlResidualJ)<=r.controlLimitJ);
    assert.equal(a.air.pressureClock.updated,k%ratio===0);assert.equal(a.air.pressureClock.index,Math.floor(k/ratio));
    if(a.air.pressureClock.updated)run.pressureUpdates++;if(a.application.dryCloth)run.drySteps++;
    if(hz===60) {
      const clean=json(state.audit);delete clean.air.pressureClock;
      assert.deepEqual({positions:state.positions,body:state.body,forceN:state.forceN,audit:clean},
        {positions:old.steps[k].positions,body:old.steps[k].body,forceN:old.steps[k].forceN,audit:old.steps[k].audit});run.legacyExactSteps++;
    }
    run.steps.push(state);
    if((k+1)%(15*ratio)===0) {
      const R=state.body.orientation9,RT=transpose3(R),angles=sv20BodyAngles(R),V=rotate3(R,state.body.velocity6.slice(0,3));
      const local=state.positions.map((_,i)=>0);
      for(let j=0;j<state.positions.length;j+=3)rotate3(RT,state.positions.slice(j,j+3).map((v,d)=>v-state.body.originM[d])).forEach((v,d)=>local[j+d]=v);
      run.frames.push({timeS:state.timeS,positions:state.positions,body:state.body,localPositions:local,speedMPS:Math.hypot(V[0],V[1]),
        anglesRad:angles,softEnergyJ:a.softEnergyJ,kineticJ:a.kineticJ,sheetLengthM:a.ropes[0].lengthM,rudderDeg:a.water.rudderDeg});
    }
  }
  assert.equal(run.pressureUpdates,180);
  run.costMs=run.steps.reduce((s,v)=>s+v.stepMs,0);
  console.log(`Временной контроль ${side==='plus'?'первая':'другая'} сторона: ${hz} Гц, ${run.steps.length} шагов, ${run.pressureUpdates} обновлений давления, ${run.drySteps} сухих шагов.`);
}
const nodeError=(a,b)=>{
  let maxM=0,sum=0;for(let i=0;i<a.length;i+=3){const d=Math.hypot(...a.slice(i,i+3).map((v,k)=>v-b[i+k]));maxM=Math.max(maxM,d);sum+=d*d;}
  return {maxM,rmsM:Math.sqrt(sum/(a.length/3))};
};
for(const side of ['plus','minus'])for(const [low,high] of [[60,120],[120,240]]) {
  const a=report.runs.find(r=>r.side===side&&r.hz===low),b=report.runs.find(r=>r.side===side&&r.hz===high),frames=[];
  for(let i=0;i<a.frames.length;i++) {
    const x=a.frames[i],y=b.frames[i];assert.equal(x.timeS,y.timeS);
    frames.push({timeS:x.timeS,worldNodeError:nodeError(x.positions,y.positions),bodyLocalNodeError:nodeError(x.localPositions,y.localPositions),
      originErrorM:Math.hypot(...x.body.originM.map((v,d)=>v-y.body.originM[d])),speedDifferenceMPS:x.speedMPS-y.speedMPS,
      heelDifferenceDeg:(x.anglesRad.phi-y.anglesRad.phi)*180/Math.PI,headingDifferenceDeg:(x.anglesRad.psi-y.anglesRad.psi)*180/Math.PI,
      pitchDifferenceDeg:(x.anglesRad.th-y.anglesRad.th)*180/Math.PI,softEnergyDifferenceJ:x.softEnergyJ-y.softEnergyJ,
      kineticDifferenceJ:x.kineticJ-y.kineticJ,sheetLengthDifferenceM:x.sheetLengthM-y.sheetLengthM,rudderDifferenceDeg:x.rudderDeg-y.rudderDeg});
  }
  report.comparisons.push({side,lowHz:low,highHz:high,frames});
}
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log('Временной контроль сохранён. Размеры различий — измерение, порог принятия по форме не назначен.');
