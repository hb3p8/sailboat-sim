// Обычный контроллер/Worker: точность и цена диагностических часов, без сцены.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Boat} from '../sim/physics.js';
import {startGennakerSimulator} from '../sim/gennaker-live.mjs';
import {liveHarness,settled} from './lib/gennaker-live-harness.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(v=>v.slice(2).split('='))),pairs=Number(args.pairs??3),out=args.out;
assert(out&&!existsSync(out),'Нужен новый --out=путь.json');assert(Number.isInteger(pairs)&&pairs>=1&&pairs<=5);
let cpuParts=[];
const h=liveHarness({js:process.argv.includes('--material-js'),measureCpu:true,onReply:data=>{
  if(['progress','step'].includes(data.type)){assert(Number.isFinite(data.benchmarkCpuUs));cpuParts.push(data.benchmarkCpuUs/1000);}
}}),pack=JSON.parse(readFileSync('data/simulator/v1/physics.json'));
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),runs=[];
function checkProfile(profile) {
  assert.equal(profile.schema,'cloth-solver-profile-v1');const stages=profile.stages;
  assert.equal(stages.cloth.calls,1);assert.equal(stages.cloth.failed,0);
  const sum=Object.values(stages).reduce((s,r)=>{assert(r.calls>0&&r.failed>=0&&r.failed<=r.calls);assert(r.selfMs>=-1e-7);return s+r.selfMs;},0);
  assert(Math.abs(sum-stages.cloth.inclusiveMs)<1e-6);
  for(const key of ['materialBending','materialMembrane','matrixAssembly','activeAssembly','factor','linearSolve','lineSearch'])assert(stages[key]?.calls>0,key);
  assert.equal(stages.factor.calls,stages.linearSolve.calls);return stages;
}
async function run(side,profile,pair) {
  cpuParts=[];
  globalThis.location={search:`?physics-run=controls-v1&physics-side=${side}&physics-wake=3&physics-profile=${Number(profile)}`};
  const boat=new Boat(pack),sim=await startGennakerSimulator({boat,ui:h.ui(),manifestPath:'data/simulator/v1/manifest.json'});
  const start=performance.now();
  for(let i=0;i<90;i++){sim.advance(1/30,()=>boat.setWater(.0002*Math.sin(i),.0001,-.0001),()=>{});await settled(sim);}
  const wallMs=performance.now()-start,metrics=sim.performance(),end=await sim.capture();
  assert.equal(metrics.steps,90);assert(metrics.scenario.done);
  const worker=boat.gennakerEnergy.history.slice(10).map(r=>r.partsMs.reduce((a,b)=>a+b,0));assert.equal(worker.length,70);
  assert.equal(cpuParts.length,160);const cpuMs=Array.from({length:70},(_,i)=>cpuParts[20+2*i]+cpuParts[21+2*i]);
  const records=metrics.records.filter(r=>r.gennakerUp).slice(10);
  if(profile){assert.equal(records.length,70);for(const r of records){assert.equal(r.solverProfiles.length,2);r.solverProfiles.forEach(checkProfile);}}
  else assert.equal(records.length,0);
  const result={pair,side,profile,wallMs,workerMs:worker,cpuMs,records,
    physicalSha256:sha({model:end.model,solver:end.solver,adapter:end.adapter}),runtimeSha256:end.runtimeSha256,
    material:end.material};runs.push(result);sim.restart();return result;
}
const report={schema:'gennaker-solver-profile-check-v1',scope:'node-controller-real-worker-not-browser-or-mobile',
  node:process.version,platform:process.platform,arch:process.arch,pairs,warmupClothSteps:10,runs};
try {
  for(const side of ['plus','minus'])for(let pair=1;pair<=pairs;pair++) {
    const order=pair%2?[false,true]:[true,false],a=await run(side,order[0],pair),b=await run(side,order[1],pair);
    assert.equal(a.physicalSha256,b.physicalSha256);
    const on=a.profile?a:b,off=a.profile?b:a;
    const sum=a=>a.reduce((s,v)=>s+v,0),overhead=sum(on.cpuMs)/sum(off.cpuMs)-1;
    console.log(`Борт ${side}, пара ${pair}: полный снимок точный; цена часов по CPU потока на 70 шагах ткани ${(100*overhead).toFixed(2)}%.`);
  }
  report.complete=true;
} catch(error){report.complete=false;report.error=error.message;throw error;}
finally {
  report.revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  report.sources=Object.fromEntries(['sim/cloth/cloth-solver-profile.mjs','sim/cloth/cloth-kkt-direction.mjs','sim/cloth/cloth-implicit-motion.mjs',
    'sim/gennaker-energy.mjs','sim/gennaker-energy-worker.mjs','sim/gennaker-live.mjs','sim/gennaker-worker-channel.mjs','tests/gennaker-solver-profile.test.mjs','tests/lib/gennaker-live-harness.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
  writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});await h.close();
}
