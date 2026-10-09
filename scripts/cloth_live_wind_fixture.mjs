// Новая неизменяемая серия: прежний материал/пороги, воздух по живой форме.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {liveWindSailMotion} from '../tests/lib/cloth-live-wind-sail-motion.mjs';
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from '../tests/probes/cloth-material-wasm.mjs';
import {loadAssemblyKernel} from '../tests/probes/cloth-assembly-wasm.mjs';
import {liveWindCycleControls,sv20WindCycleControls} from '../tests/lib/cloth-live-wind-controls.mjs';
const args=process.argv.slice(2),cycle=args.includes('--cycle'),sv20=args.includes('--sv20'),steps=Number(args.find(a=>a.startsWith('--steps='))?.slice(8)??(cycle?180:60)),out=args.find(a=>a.startsWith('--out='))?.slice(6);
const baseMPS=Number(args.find(v=>v.startsWith('--wind-base='))?.slice(12)??6),peakMPS=Number(args.find(v=>v.startsWith('--wind-peak='))?.slice(12)??7);
assert(out&&args.every(v=>/^--(out|steps|wind-base|wind-peak)=.+$/.test(v)||['--cycle','--sv20'].includes(v))&&new Set(args.map(v=>v.split('=')[0])).size===args.length&&Number.isInteger(steps)&&steps>0&&steps<=300&&(!cycle||steps===180)&&!existsSync(out)&&!existsSync(out+'.sources'));
assert(sv20||(!args.some(v=>v.startsWith('--wind-base=')||v.startsWith('--wind-peak='))),'Отдельный ветер сценария поддерживается для SV20');
const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex'),sourceSha256={};
function source(url){const p=relative(root,fileURLToPath(url));if(sourceSha256[p])return;const bytes=readFileSync(url);sourceSha256[p]=hash(bytes);const copy=resolve(out+'.sources',p);mkdirSync(dirname(copy),{recursive:true});writeFileSync(copy,bytes,{flag:'wx'});
  for(const m of bytes.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))source(new URL(m[1],url));}
source(new URL(import.meta.url));const report={schema:'cloth-live-wind-motion-v1',phase:'running',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sourceSha256,stepsRequested:steps,...(sv20?{bodyProfile:'sv20-rig-budget-point-v1'}:{}),runs:[]};
report.cycleWind={baseMPS,peakMPS};
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Живой опыт остановлен: '+e.message);process.exitCode=1;});
const pack=JSON.parse(readFileSync('out/export/physics.json'));report.physicsSha256=hash(readFileSync('out/export/physics.json'));
for(const tack of [1,-1])for(const angle of cycle?[140]:[120,140,160]) {
  const path=`out/acceptance/fluid-live-snapshots-old-20261008-${tack===1?'plus':'minus'}.json`,f=JSON.parse(readFileSync(path));
  const factor=await loadSparseFactor(readFileSync(f.wasm.path)),materialKernel=await loadMaterialKernel(readFileSync(f.materialWasm.path)),assemblyKernel=await loadAssemblyKernel(readFileSync(f.assemblyWasm.path));
  const c=liveWindSailMotion(f.recipe,f.bodyInput,factor,{pack,sheet:f.sheet,materialKernel,assemblyKernel,wind:{speedMPS:baseMPS,fromDeg:tack*angle},...(sv20?{bodyProfile:report.bodyProfile}:{})});
  const run={tack,angle,input:{path,sha256:hash(readFileSync(path))},modules:{linear:f.wasm,material:f.materialWasm,assembly:f.assemblyWasm},...(sv20?{massBudget:c.massBudget}:{}),steps:[]};report.runs.push(run);
  for(let k=0;k<steps;k++){const controls=cycle?(sv20?sv20WindCycleControls(k,tack===1?'plus':'minus',{baseMPS,peakMPS}):liveWindCycleControls(k,tack===1?'plus':'minus')):{windSpeedMPS:k<steps/2?baseMPS:peakMPS,windFromDeg:tack*angle,sheetRateMPS:0,...(sv20?{rudderDeg:0}:{})},start=performance.now(),audit=c.step(controls);
    run.steps.push(serial({index:k+1,controls,stepMs:performance.now()-start,positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit}));}
  console.log(`Живой ветер ${tack>0?'первая':'другая'} сторона/${angle}°: ${steps} шагов, все прежние балансы выполнены.`);
}
report.phase='complete';writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
