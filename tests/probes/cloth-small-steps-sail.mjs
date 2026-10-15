// Неприёмочная проба 99 узлов: одинаковые неподвижные крепления и нагрузка.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Boat} from '../../sim/physics.js';
import {energyCloth,prescribedGennaker,gennakerPose,gennakerBodyPack} from '../../sim/gennaker-energy.mjs';
import {createGennakerStep} from '../../sim/gennaker-step.mjs';
import {SmallStepsMotion} from '../../sim/cloth/cloth-small-steps.mjs';
import {loadSparseFactor} from '../../sim/cloth/cloth-sparse-wasm.mjs';
import {selectGennakerMaterial} from '../../sim/gennaker-material.mjs';
import {rotate3,cross3} from '../../sim/cloth/cloth-fluid-inertia.mjs';
import {IMPLICIT_TOLERANCES} from '../../sim/cloth/cloth-implicit-motion.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(v=>v.slice(2).split('='))),steps=Number(args.steps??60),out=args.out;
const referenceSubsteps=Number(args['reference-substeps']??2);
assert(out&&!existsSync(out),'Нужен новый --out=путь.json');assert(Number.isInteger(steps)&&steps>=20&&steps<=120);
assert([2,4,8].includes(referenceSubsteps),'Строгая опора допускает 2, 4 или 8 подшагов на кадр');
const read=p=>JSON.parse(readFileSync(p)),manifest=read('data/simulator/v1/manifest.json'),pack=read(manifest.physics.path);
const factor=await loadSparseFactor(readFileSync(manifest.wasm.path)),fixtures=['plus','minus'].map(s=>read(manifest.inputs[s].path));
const selected=process.argv.includes('--material-js')?{material:{backend:'js'},kernel:undefined}:
  await selectGennakerMaterial(readFileSync(manifest.materialWasm.path),fixtures[0].recipe);
const norm=a=>Math.hypot(...a),max=a=>Math.max(0,...a.map(Math.abs)),stats=a=>({mean:a.reduce((s,v)=>s+v,0)/a.length,max:Math.max(...a)});
const cpu=()=>{const t=process.threadCpuUsage();return t.user+t.system;};
const spec={schema:'small-steps-s1-spec-v2',dtS:1/30,substeps:[2,4,8,16,32],referenceSubsteps,steps,warmupFrames:10,
  windMPS:4,awaDeg:140,load:'однократный обычный Rig/Cloth.forcesAt; мировая нагрузка удерживается',
  supports:'неподвижные, шкот исходной длины',strictThresholds:IMPLICIT_TOLERANCES,
  acceptance:'разведочная проба, учебные допуски не назначены; ускорение и замена движка не принимаются'};
const report={schema:'small-steps-s1-probe-v2',spec,material:selected.material,results:[],node:process.version};
try {
  for(const f of fixtures) {
    const b=new Boat(pack,null,{gennakerUp:true,mainUp:true,jibUp:false,localPressure:false}),r=f.recipe;
    b.o.windSpeed=4;b.o.windDir=(f.side==='plus'?140:-140)*Math.PI/180;b.o.twist=8*Math.PI/180;b.o.crewMass=220;
    const body=gennakerBodyPack(pack,r);b.p=body.pack;b.mass=body.pack.mass.total_kg;b.rig.p=b.p;b.rig.cloth=energyCloth(r,pack);
    const pose=gennakerPose(b),calc=prescribedGennaker(f,pack,pose,factor,selected.kernel);
    const work=createGennakerStep({boat:b,cloth:b.rig.cloth,snapshot:{targetPose:pose},dt:spec.dtS});
    const {command}=work.prepare(),forceN=command.forceN,initial=calc.motion.pos.slice(),mass=calc.motion.mass.slice();
    // Эта проба после подготовки не завершает Boat и не пересчитывает воздух.
    const fullForce=new Float64Array(initial.length);fullForce.set(forceN);
    for(let i=0;i<99;i++)fullForce[3*i+2]-=calc.budget.dryNodalKg[i]*pack.environment.g;
    const reference=[],referenceMs=[],referenceCpu=[];
    for(let j=0;j<steps;j++) {
      const start=performance.now(),c0=cpu();
      const parts=Array.from({length:referenceSubsteps},()=>calc.step({forceN,targetPose:pose,sheetLengthM:f.sheet.lengthM,hS:spec.dtS/referenceSubsteps}));
      referenceCpu.push((cpu()-c0)/1000);referenceMs.push(performance.now()-start);
      reference.push({positions:Array.from(calc.motion.pos.slice(0,297)),
        forceN:[0,1,2].map(d=>parts.reduce((s,p)=>s+p.forceN[d],0)/referenceSubsteps),
        momentNm:[0,1,2].map(d=>parts.reduce((s,p)=>s+p.momentNm[d],0)/referenceSubsteps)});
    }
    const side={side:f.side,reference:{wallMs:stats(referenceMs.slice(10)),cpuMs:stats(referenceCpu.slice(10)),
      maxForceN:Math.max(...reference.map(f=>norm(f.forceN))),maxMomentNm:Math.max(...reference.map(f=>norm(f.momentNm))),frames:reference},candidates:[]};report.results.push(side);
    const cg=rotate3(pose.orientation9,calc.budget.cgM);
    for(const n of spec.substeps) {
      const initialMass=Array.from(mass,v=>v===0?1:v),m=new SmallStepsMotion({positions:initial,mass:initialMass,
        fixed:Array.from(calc.motion.fixed),board:r.board,constraints:calc.motion.constraints});m.mass.set(mass);
      const result={substeps:n,frames:[],wallMs:[],cpuMs:[],maxForceResidualN:0,maxHardViolationM:0,maxFreeImpulseResidualNs:0,
        maxLinearMomentumResidualNs:0,maxAngularMomentumResidualNms:0,maxImpulseWorkResidualJ:0,
        maxPositionErrorM:0,rmsPositionErrorM:0,maxReactionErrorN:0,maxMomentErrorNm:0,energyDefectJ:0,
        impulseErrorNs:[0,0,0],angularImpulseErrorNms:[0,0,0]};
      let square=0,count=0;
      try {
        for(let j=0;j<steps;j++) {
          const start=performance.now(),c0=cpu(),a=m.advance(fullForce,spec.dtS,{substeps:n});
          result.cpuMs.push((cpu()-c0)/1000);result.wallMs.push(performance.now()-start);
          const reaction=[0,0,0];for(const node of m.fixed)for(let d=0;d<3;d++)reaction[d]-=a.supportImpulseNs[3*node+d]/spec.dtS;
          const shift=cross3(cg,reaction),moment=a.supportMomentImpulseNms.map((v,d)=>-v/spec.dtS-shift[d]);
          for(let i=0;i<99;i++) {
            const e=norm([0,1,2].map(d=>m.pos[3*i+d]-reference[j].positions[3*i+d]));square+=e*e;count++;result.maxPositionErrorM=Math.max(result.maxPositionErrorM,e);
          }
          result.maxReactionErrorN=Math.max(result.maxReactionErrorN,norm(reaction.map((v,d)=>v-reference[j].forceN[d])));
          result.maxMomentErrorNm=Math.max(result.maxMomentErrorNm,norm(moment.map((v,d)=>v-reference[j].momentNm[d])));
          for(let d=0;d<3;d++) {
            result.impulseErrorNs[d]+=spec.dtS*(reaction[d]-reference[j].forceN[d]);
            result.angularImpulseErrorNms[d]+=spec.dtS*(moment[d]-reference[j].momentNm[d]);
          }
          result.maxForceResidualN=Math.max(result.maxForceResidualN,a.maxForceResidualN);result.maxHardViolationM=Math.max(result.maxHardViolationM,a.maxHardViolationM);
          for(const s of a.audits) {
            result.maxFreeImpulseResidualNs=Math.max(result.maxFreeImpulseResidualNs,s.maxFreeImpulseResidualNs);
            result.maxLinearMomentumResidualNs=Math.max(result.maxLinearMomentumResidualNs,max(s.linearMomentumResidualNs));
            result.maxAngularMomentumResidualNms=Math.max(result.maxAngularMomentumResidualNms,max(s.angularMomentumResidualNms));
            result.maxImpulseWorkResidualJ=Math.max(result.maxImpulseWorkResidualJ,Math.abs(s.impulseWorkResidualJ));
          }
          result.energyDefectJ+=a.energyDefectJ;
          result.frames.push({step:j+1,forceN:reaction,momentNm:moment,positions:j%10===0||j===steps-1?Array.from(m.pos.slice(0,297)):undefined});
        }
        result.complete=true;
      } catch(error){result.complete=false;result.error=error.message;}
      result.rmsPositionErrorM=Math.sqrt(square/count);result.wall=stats(result.wallMs.slice(10));result.cpu=stats(result.cpuMs.slice(10));
      result.meetsStrictResiduals=result.maxForceResidualN<=spec.strictThresholds.forceToleranceN&&result.maxHardViolationM<=spec.strictThresholds.lengthToleranceM;
      side.candidates.push(result);
      console.log(`Борт ${f.side}, ${n} подшагов: ${result.frames.length}/${steps}, отклонение ${result.maxPositionErrorM.toFixed(4)} м, реакция ${result.maxReactionErrorN.toFixed(3)} Н, кромки ${(1000*result.maxHardViolationM).toFixed(3)} мм, CPU ${result.cpu.mean.toFixed(3)} мс/кадр.`);
    }
  }
  report.complete=true;
} catch(error){report.complete=false;report.error=error.message;throw error;}
finally {
  report.revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  report.sources=Object.fromEntries(['sim/cloth/cloth-small-steps.mjs','sim/cloth/cloth-energy-motion.mjs','sim/gennaker-energy.mjs','tests/probes/cloth-small-steps-sail.mjs',
    manifest.physics.path,manifest.inputs.plus.path,manifest.inputs.minus.path,manifest.wasm.path,manifest.materialWasm.path].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
  writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
