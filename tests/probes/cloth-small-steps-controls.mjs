// S2: заданное управление, разложение реакций и повтор пика из общей истории.
// Это диагностический опыт; допуски учебной версии здесь не назначаются.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Boat} from '../../sim/physics.js';
import {boatBodyRotation} from '../../sim/axes.js';
import {energyCloth,prescribedGennaker,gennakerPose,gennakerBodyPack,worldPoint} from '../../sim/gennaker-energy.mjs';
import {createGennakerStep} from '../../sim/gennaker-step.mjs';
import {SmallStepsMotion} from '../../sim/cloth/cloth-small-steps.mjs';
import {JointSmallStepsMotion,JOINT_HARD_LIMITS} from '../../sim/cloth/cloth-small-steps-joint.mjs';
import {ImplicitEnergyMotion,IMPLICIT_TOLERANCES} from '../../sim/cloth/cloth-implicit-motion.mjs';
import {distance} from '../../sim/cloth/cloth-compliance.mjs';
import {loadSparseFactor} from '../../sim/cloth/cloth-sparse-wasm.mjs';
import {selectGennakerMaterial} from '../../sim/gennaker-material.mjs';
import {cross3} from '../../sim/cloth/cloth-fluid-inertia.mjs';

const args=Object.fromEntries(process.argv.slice(2).map(v=>v.slice(2).split('='))),out=args.out;
const jointHard=Object.hasOwn(args,'joint-hard');
const visual=Object.hasOwn(args,'visual');
assert(out&&!existsSync(out)&&!existsSync(out+'.probe.mjs'),'Нужен новый --out=путь.json и свободное имя снимка исходника');
const substeps=Number(args.substeps??8);assert([2,4,8].includes(substeps),'Допускаются 2, 4 или 8 подшагов');
const spec={schema:'small-steps-s2-spec-v4',dtS:1/30,substeps,hS:1/(30*substeps),substepStudy:[2,4,8],
  candidate:jointHard?'block-hard-xpbd-v1':'small-steps-impulse-v1',jointLimits:jointHard?JOINT_HARD_LIMITS:undefined,
  cases:args.case?[args.case]:args.cases?args.cases.split(','):['hold','sheet','takeup','supports'],
  sides:args.sides?args.sides.split(','):['plus','minus'],capturePositions:visual,windMPS:4,awaDeg:140,
  sheet:{startS:.5,easeEndS:1,returnStartS:1.5,returnEndS:2,deltaM:.25,rateMPS:.5,seconds:4},
  takeup:{startS:0,easeEndS:.04,returnStartS:.08,returnEndS:.12,deltaM:.02,rateMPS:.5,seconds:2},
  supports:{startS:.5,endS:2.5,heaveM:.05,rollRad:Math.PI/180,seconds:3},holdSeconds:2,
  load:'однократный Rig/Cloth, затем удержанная мировая нагрузка и прежний вес',
  peakReplay:'повтор кадра максимального отличия реакции; строгий шаг из обеих исходных историй',
  strictThresholds:IMPLICIT_TOLERANCES,acceptance:'диагностика; не приёмка метода, скорости или мобильного бюджета'};
assert(spec.cases.every(c=>['hold','sheet','takeup','supports'].includes(c)),'Неизвестный сценарий S2');
assert(spec.sides.length&&spec.sides.every(s=>['plus','minus'].includes(s)),'Неизвестная сторона ветра');
const read=p=>JSON.parse(readFileSync(p)),manifest=read('data/simulator/v1/manifest.json'),pack=read(manifest.physics.path);
const factor=await loadSparseFactor(readFileSync(manifest.wasm.path));
const fixtures=['plus','minus'].map(s=>read(manifest.inputs[s].path));
const selected=await selectGennakerMaterial(readFileSync(manifest.materialWasm.path),fixtures[0].recipe);
const norm=a=>Math.hypot(...a),difference=(a,b)=>norm(a.map((v,d)=>v-b[d]));
const maxAbs=a=>Math.max(0,...a.map(Math.abs));
const cpu=()=>{const t=process.threadCpuUsage();return t.user+t.system;};
const family=(m,j)=>j===m.constraints.length-1?'sheet':m.constraints[j].family??'hard';
function supportWeight(m,i) {
  const j=m.board?.nodes.indexOf(i)??-1;
  return j>=0?1-m.board.fractions[j]:m.fixed.has(i)?1:0;
}
function contribution(m,grad,scale) {
  const force=[0,0,0];
  for(const [i,g] of grad)for(let d=0;d<3;d++)force[d]+=supportWeight(m,i)*g[d]*scale;
  return force;
}
function families(m,h,gradients) {
  if(m.usedFamilyForces)return m.usedFamilyForces;
  const result={};
  for(let j=0;j<m.constraints.length;j++) {
    const c=m.constraints[j],name=family(m,j),grad=gradients?gradients[j]:c.value(m.pos).grad;
    const f=contribution(m,grad,c.lambda/(h*h));
    const sum=result[name]??=[0,0,0];for(let d=0;d<3;d++)sum[d]+=f[d];
  }
  return result;
}
// Копия только градиентов наблюдателя: сам проход исполняется исходным кодом.
class ObservedSmallSteps extends SmallStepsMotion {
  reduce(grad) {this.usedGradients.push(grad.map(([i,g])=>[i,g.slice()]));return super.reduce(grad);}
  advanceStep(...args) {
    this.usedGradients=[];
    const a=super.advanceStep(...args);
    assert.equal(this.usedGradients.length,this.constraints.length,'Число наблюдений прохода изменилось');
    return a;
  }
}
class ObservedJointSteps extends JointSmallStepsMotion {
  observeProjection(c,grad,delta,h) {
    const j=this.constraintIds.get(c),name=family(this,j),f=contribution(this,grad,delta/(h*h)),sum=this.usedFamilyForces[name]??=[0,0,0];
    for(let d=0;d<3;d++)sum[d]+=f[d];
  }
  advanceStep(...args) {
    this.constraintIds??=new Map(this.constraints.map((c,j)=>[c,j]));this.usedFamilyForces={};
    return super.advanceStep(...args);
  }
}
const CandidateMotion=jointHard?ObservedJointSteps:ObservedSmallSteps;
function state(m) {
  return {pos:Array.from(m.pos),prev:Array.from(m.prev),prevDt:m.prevDt,lambda:m.constraints.map(c=>c.lambda),
    lastMu:m.lastMu?Array.from(m.lastMu):null,supportMotionActive:m.supportMotionActive,
    fixedPositions:Array.from(m.fixedPositions,([i,p])=>[i,p.slice()])};
}
function copyState(m,s) {
  m.pos.set(s.pos);m.prev.set(s.prev);m.prevDt=s.prevDt;
  m.constraints.forEach((c,j)=>c.lambda=s.lambda[j]);
  if(s.lastMu)m.lastMu=Float64Array.from(s.lastMu);else delete m.lastMu;
  m.supportMotionActive=s.supportMotionActive;m.fixedPositions=new Map(s.fixedPositions);
}
function makeMotion(type,base,s) {
  const m=new type({positions:s.pos,mass:Array.from(base.mass,v=>v||1),constraints:base.constraints,
    fixed:Array.from(base.fixed),board:base.board,dampingHz:0,linearBackend:'kkt-wasm',wasmSparseFactor:factor});
  m.mass.set(base.mass);copyState(m,s);return m;
}
function sheetLength(t,base,s) {
  return base+s.deltaM*(t<=s.startS?0:t<s.easeEndS?(t-s.startS)/(s.easeEndS-s.startS):
    t<=s.returnStartS?1:t<s.returnEndS?1-(t-s.returnStartS)/(s.returnEndS-s.returnStartS):0);
}
function targetPose(t,pose) {
  const s=spec.supports,u=(t-s.startS)/(s.endS-s.startS),bump=u<=0||u>=1?0:(1-Math.cos(2*Math.PI*u))/2;
  const angles=pose.angles.map((v,d)=>v+(d===1?s.rollRad*bump:0));
  return {originM:pose.originM.map((v,d)=>v+(d===2?s.heaveM*bump:0)),angles,orientation9:boatBodyRotation(...angles)};
}
function hardViolation(m) {return Math.max(0,...m.constraints.filter(c=>c.alpha===0).map(c=>{
  const {C}=c.value(m.pos);return c.unilateral?Math.max(0,C):Math.abs(C);
}));}
function reaction(m,a,pose,cgLocal,frameOrigin) {
  const forceN=[0,0,0],momentNm=[0,0,0],cg=worldPoint(pose,cgLocal).map((v,d)=>v-frameOrigin[d]);
  for(const i of m.fixed) {
    const f=[0,1,2].map(d=>a.supportImpulseNs?-a.supportImpulseNs[3*i+d]/spec.hS:-a.supportForceN[3*i+d]);
    const lever=[0,1,2].map(d=>m.pos[3*i+d]-cg[d]),torque=cross3(lever,f);
    for(let d=0;d<3;d++){forceN[d]+=f[d];momentNm[d]+=torque[d];}
  }
  return {forceN,momentNm};
}
function observation(m,a,old,length,previousLength,pose,cg,frameOrigin,gradients) {
  const h=spec.hS,parts=families(m,h,gradients),base=[0,0,0];
  for(let i=0;i<m.mass.length;i++)for(let d=0;d<3;d++) {
    const k=3*i+d,v=(m.pos[k]-old.pos[k])/h,v0=old.prevDt?(old.pos[k]-old.prev[k])/old.prevDt:0;
    base[d]+=supportWeight(m,i)*(fullLoad[k]-m.mass[i]*(v-v0)/h);
  }
  const r=reaction(m,a,pose,cg,frameOrigin),sum=base.slice();
  for(const f of Object.values(parts))for(let d=0;d<3;d++)sum[d]+=f[d];
  const sheet=m.constraints.at(-1),tensionN=Math.max(0,-sheet.lambda/(h*h));
  return {...r,familyForceN:parts,externalAndInertiaN:base,decompositionResidualN:difference(sum,r.forceN),
    tensionN,sheetImpulseForceN:norm(parts.sheet??[0,0,0]),sheetGapM:sheet.value(m.pos).C,nominalSheetWorkJ:-tensionN*(length-previousLength),
    hardLambda:m.constraints.filter(c=>c.alpha===0).map(c=>c.lambda),
    hardViolationM:a.maxHardViolationM,forceResidualN:a.maxForceResidualN??a.solver.maxForceResidualN,
    supportWorkJ:a.supportWorkJ,
    energyDefectJ:a.kineticJ-a.initialKineticJ+a.softEnergyJ-a.initialSoftEnergyJ-a.appliedWorkJ-a.supportWorkJ,
    workResidualJ:a.impulseWorkResidualJ??a.discreteBalanceResidualJ,
    angularMomentumResidualNms:a.angularMomentumResidualNms,freeImpulseResidualNs:a.maxFreeImpulseResidualNs,
    linearMomentumResidualNs:a.linearMomentumResidualNs,projection:a.projection,hardGradientResidualN:a.maxHardGradientResidualN,
    materialForceResidualN:a.materialForceResidualN,cpuMs:a.observedCpuMs};
}
function aggregate(parts) {
  const result={forceN:[0,0,0],momentNm:[0,0,0],sheetWorkJ:0,supportWorkJ:0,energyDefectJ:0,
    maxTensionN:0,maxHardViolationM:0,maxForceResidualN:0,maxWorkResidualJ:0,maxDecompositionResidualN:0,cpuMs:0};
  for(const p of parts) {
    for(const k of ['forceN','momentNm'])for(let d=0;d<3;d++)result[k][d]+=p[k][d]/parts.length;
    result.sheetWorkJ+=p.nominalSheetWorkJ;result.supportWorkJ+=p.supportWorkJ;result.energyDefectJ+=p.energyDefectJ;
    result.cpuMs+=p.cpuMs??0;
    for(const [to,from] of [['maxTensionN','tensionN'],['maxHardViolationM','hardViolationM'],['maxForceResidualN','forceResidualN'],
      ['maxWorkResidualJ','workResidualJ'],['maxDecompositionResidualN','decompositionResidualN']])result[to]=Math.max(result[to],Math.abs(p[from]));
  }
  return result;
}
const report={schema:'small-steps-s2-probe-v4',spec,material:selected.material,node:process.version,results:[]};
let fullLoad;
try {
  console.log('Выбранный кандидат: '+spec.candidate);
  for(const f of fixtures.filter(f=>spec.sides.includes(f.side)))for(const scenario of spec.cases) {
    const result={side:f.side,scenario,frames:[]};report.results.push(result);
    try {
    const b=new Boat(pack,null,{gennakerUp:true,mainUp:true,jibUp:false,localPressure:false}),r=f.recipe;
    b.o.windSpeed=spec.windMPS;b.o.windDir=(f.side==='plus'?1:-1)*spec.awaDeg*Math.PI/180;b.o.twist=8*Math.PI/180;b.o.crewMass=220;
    const body=gennakerBodyPack(pack,r);b.p=body.pack;b.mass=body.pack.mass.total_kg;b.rig.p=b.p;b.rig.cloth=energyCloth(r,pack);
    const pose=gennakerPose(b),calc=prescribedGennaker(f,pack,pose,factor,selected.kernel);
    const originalStep=calc.motion.step;let strictAudit;
    calc.motion.step=function(...values){const a=originalStep.apply(this,values);strictAudit=a;return a;};
    const prepared=createGennakerStep({boat:b,cloth:b.rig.cloth,snapshot:{targetPose:pose},dt:spec.dtS}).prepare();
    const forceN=prepared.command.forceN,initial=state(calc.motion),m=makeMotion(CandidateMotion,calc.motion,initial);
    fullLoad=new Float64Array(m.pos.length);fullLoad.set(forceN);
    for(let i=0;i<99;i++)fullLoad[3*i+2]-=calc.budget.dryNodalKg[i]*pack.environment.g;
    const supportLocal=new Map(Array.from(m.fixed,i=>[i,i===99?f.sheet.localM:r.positions.slice(3*i,3*i+3)]));
    Object.assign(result,{maxPositionErrorM:0,maxReactionErrorN:0,maxMomentErrorNm:0,maxTensionErrorN:0,
      impulseErrorNs:[0,0,0],angularImpulseErrorNms:[0,0,0]});
    const seconds=scenario==='hold'?spec.holdSeconds:spec[scenario].seconds;
    let length=f.sheet.lengthM,peak;
    function commands(j,part) {
      const t=(j+(part+1)/spec.substeps)*spec.dtS,p=scenario==='supports'?targetPose(t,pose):pose;
      const localPose={...p,originM:p.originM.map((v,d)=>v-pose.originM[d])};
      return {timeS:t,pose:p,requestedLengthM:['sheet','takeup'].includes(scenario)?sheetLength(t,f.sheet.lengthM,spec[scenario]):f.sheet.lengthM,
        targets:Array.from(supportLocal,([node,point])=>({node,positionM:worldPoint(localPose,point)}))};
    }
    for(let j=0;j<Math.round(seconds/spec.dtS);j++) {
      const before={strict:state(calc.motion),small:state(m),lengthM:length},strict=[],small=[],inputs=[];
      for(let k=0;k<spec.substeps;k++) {
        const c=commands(j,k),oldStrict=state(calc.motion),oldSmall=state(m);
        result.lastAttempt={frame:j+1,part:k+1,command:c,initialSmall:oldSmall};
        const strictCPU=cpu();
        const s=calc.step({forceN,targetPose:c.pose,sheetLengthM:c.requestedLengthM,hS:spec.hS});
        strictAudit.observedCpuMs=(cpu()-strictCPU)/1000;
        // Обе ветви получают одну фактически применённую длину, включая
        // действующий ограничитель 0.5 м/с. Второго закона лебёдки здесь нет.
        m.constraints.at(-1).value=distance(f.sheet.node,99,s.lengthM,0,true).value;
        const smallCPU=cpu(),a=m.step(fullLoad,spec.hS,1,c.targets);a.observedCpuMs=(cpu()-smallCPU)/1000;
        if(jointHard)assert.equal(a.projection?.method,'block-hard-xpbd-v1','Запрошенный совместный метод не выполнялся');
        // Наблюдатель захватил полный аудит; обычный фасад выдаёт сводку.
        strict.push({...s.audit,...observation(calc.motion,strictAudit,oldStrict,s.lengthM,length,c.pose,calc.budget.cgM,pose.originM)});
        small.push(observation(m,a,oldSmall,s.lengthM,length,c.pose,calc.budget.cgM,pose.originM,m.usedGradients));
        result.maxTensionErrorN=Math.max(result.maxTensionErrorN,Math.abs(strict.at(-1).tensionN-small.at(-1).tensionN));
        length=s.lengthM;inputs.push({...c,lengthM:length});
      }
      const reference=aggregate(strict),candidate=aggregate(small),error=difference(reference.forceN,candidate.forceN);
      let shape=0;for(let i=0;i<99;i++)shape=Math.max(shape,difference(Array.from(m.pos.slice(3*i,3*i+3)),Array.from(calc.motion.pos.slice(3*i,3*i+3))));
      result.maxPositionErrorM=Math.max(result.maxPositionErrorM,shape);result.maxReactionErrorN=Math.max(result.maxReactionErrorN,error);
      result.maxMomentErrorNm=Math.max(result.maxMomentErrorNm,difference(reference.momentNm,candidate.momentNm));
      for(let d=0;d<3;d++){result.impulseErrorNs[d]+=spec.dtS*(candidate.forceN[d]-reference.forceN[d]);
        result.angularImpulseErrorNms[d]+=spec.dtS*(candidate.momentNm[d]-reference.momentNm[d]);}
      const frame={frame:j+1,timeS:(j+1)*spec.dtS,lengthM:length,positionErrorM:shape,reactionErrorN:error,reference,candidate,strictParts:strict,smallParts:small};
      if(visual)frame.visual={referenceM:Array.from(calc.motion.pos.slice(0,297)),candidateM:Array.from(m.pos.slice(0,297)),
        targets:inputs.at(-1).targets.map(t=>({node:t.node,positionM:t.positionM.slice()}))};
      result.frames.push(frame);
      if(!peak||error>peak.reactionErrorN)peak={frame:j+1,reactionErrorN:error,before,inputs,
        after:{small:Array.from(m.pos),strict:Array.from(calc.motion.pos)}};
    }
    // Непринятая приближённая форма не загружается обычным restore().
    // Создаётся отдельная численная задача с явно сохранённой начальной
    // невязкой; переход из неё — диагностическое исправление истории.
    const sameSmall=makeMotion(CandidateMotion,calc.motion,peak.before.small);
    const strictFromSmall=makeMotion(ImplicitEnergyMotion,calc.motion,peak.before.small);
    const strictFromStrict=makeMotion(ImplicitEnergyMotion,calc.motion,peak.before.strict);
    for(const solver of [sameSmall,strictFromSmall,strictFromStrict])solver.constraints.at(-1).value=distance(f.sheet.node,99,peak.before.lengthM,0,true).value;
    const replay={frame:peak.frame,before:peak.before,inputs:peak.inputs,initialSmallHardViolationM:hardViolation(sameSmall),series:[]};result.peakReplay=replay;
    for(const [name,solver] of [['smallFromSmall',sameSmall],['strictFromSmall',strictFromSmall],['strictFromStrict',strictFromStrict]]) {
      const parts=[];let priorLength=peak.before.lengthM;
      try {
        for(const c of peak.inputs) {
          const old=state(solver);solver.constraints.at(-1).value=distance(f.sheet.node,99,c.lengthM,0,true).value;
          const a=solver.step(fullLoad,spec.hS,solver instanceof SmallStepsMotion?1:r.iterations,c.targets);
          parts.push(observation(solver,a,old,c.lengthM,priorLength,c.pose,calc.budget.cgM,pose.originM,solver.usedGradients));priorLength=c.lengthM;
        }
        replay.series.push({name,complete:true,...aggregate(parts),parts,positions:Array.from(solver.pos)});
      } catch(error){replay.series.push({name,complete:false,error:error.message,parts});}
    }
    const original=result.frames[peak.frame-1],repeatSmall=replay.series.find(s=>s.name==='smallFromSmall'),repeatStrict=replay.series.find(s=>s.name==='strictFromStrict');
    assert(repeatSmall.complete&&repeatStrict.complete,'Повтор исходной ветви не завершён');
    assert.deepEqual(repeatSmall.forceN,original.candidate.forceN,'Наблюдатель изменил повтор Small Steps');
    assert.deepEqual(repeatStrict.forceN,original.reference.forceN,'Прямой строгий повтор изменил реакцию фасада');
    assert.deepEqual(repeatSmall.positions,peak.after.small,'Повтор Small Steps изменил координаты');
    assert.deepEqual(repeatStrict.positions,peak.after.strict,'Прямой строгий повтор изменил координаты');
    replay.exactOriginalForces=true;replay.exactOriginalPositions=true;
    if(['sheet','takeup'].includes(scenario)) {
      result.sheetCoverage={};const s=spec[scenario];
      for(const key of ['strictParts','smallParts']) {
        const parts=result.frames.flatMap(f=>f[key]);
        const slackBeforeReturn=parts.some((p,i)=>(i+1)*spec.hS<=s.returnStartS&&p.tensionN===0&&p.sheetGapM<0);
        const catchPart=parts.findIndex((p,i)=>(i+1)*spec.hS>s.returnStartS&&(i+1)*spec.hS<=s.returnEndS&&p.tensionN>0);
        result.sheetCoverage[key]={slackBeforeReturn,caughtDuringReturn:catchPart>=0,catchTimeS:catchPart<0?null:(catchPart+1)*spec.hS};
        if(scenario==='takeup')assert(slackBeforeReturn&&catchPart>=0,'Короткий цикл не проверил выбор провиса');
      }
    }
    result.complete=true;delete result.lastAttempt;
    console.log(`${f.side}, ${scenario}: форма ${(result.maxPositionErrorM*1000).toFixed(3)} мм, реакция ${result.maxReactionErrorN.toFixed(3)} Н, пик на кадре ${peak.frame}; повтор реакций точный.`);
    } catch(error) {
      result.complete=false;result.error=error.message;result.jointProjection=error.jointProjection;
      if(!jointHard)throw error;
      console.log(`${f.side}, ${scenario}: остановлен — ${error.message}`);
    }
  }
  report.complete=true;report.allCasesComplete=report.results.every(r=>r.complete);
} catch(error){report.complete=false;report.error=error.message;throw error;}
finally {
  report.revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  report.sources=Object.fromEntries(['tests/probes/cloth-small-steps-controls.mjs','sim/cloth/cloth-small-steps.mjs','sim/cloth/cloth-small-steps-joint.mjs','sim/gennaker-energy.mjs',
    manifest.physics.path,manifest.inputs.plus.path,manifest.inputs.minus.path,manifest.wasm.path,manifest.materialWasm.path]
    .map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
  report.probeSource=out+'.probe.mjs';writeFileSync(report.probeSource,readFileSync('tests/probes/cloth-small-steps-controls.mjs'),{flag:'wx'});
  writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
