// Аналитическая передача натяжения всей цепочкой, планка и ограниченный отказ.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {JointSmallStepsMotion,JOINT_HARD_LIMITS} from '../sim/cloth/cloth-small-steps-joint.mjs';
import {distance} from '../sim/cloth/cloth-compliance.mjs';
import {IMPLICIT_TOLERANCES} from '../sim/cloth/cloth-implicit-motion.mjs';
const spec={schema:'small-steps-joint-s0-v1',hS:1/30,relativeRoundoff:2e-11,
  limits:JOINT_HARD_LIMITS,hardTolerances:IMPLICIT_TOLERANCES,
  acceptance:'известные дискретные координаты, реакции и работа; ограниченный отказ с полным откатом'};
const out=process.argv.find(v=>v.startsWith('--out='))?.slice(6);if(out)assert(!existsSync(out),'Нужен новый путь отчёта');
const report={spec,results:[]},close=(a,b)=>assert(Math.abs(a-b)<=spec.relativeRoundoff*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const capture=m=>({pos:Array.from(m.pos),prev:Array.from(m.prev),prevDt:m.prevDt,lambda:m.constraints.map(c=>c.lambda),
  fixed:Array.from(m.fixedPositions),active:m.supportMotionActive});
function audit(a) {close(a.maxFreeImpulseResidualNs,0);close(a.impulseWorkResidualJ,0);for(const v of a.linearMomentumResidualNs)close(v,0);}
try {
  const h=spec.hS,F=12,p=[0,0,0,1,0,0,2,0,0,3,0,0],mass=[4,1,2,3],load=[0,0,0,0,0,0,0,0,0,F,0,0];
  for(const unilateral of [false,true])for(const reverse of [false,true]) {
    const constraints=[distance(0,1,1,0,unilateral),distance(1,2,1,0,unilateral),distance(2,3,1,0,unilateral)];
    const m=new JointSmallStepsMotion({positions:p,mass,fixed:[0],constraints:reverse?constraints.reverse():constraints});
    const a=m.step(load,h);audit(a);for(let i=0;i<4;i++)close(m.pos[3*i],i);
    close(a.supportImpulseNs[0],-F*h);close(a.maxForceResidualN,0);assert.equal(a.projection.corrections,1);
    report.results.push({case:'неподвижная цепочка',unilateral,reverse,reactionN:a.supportImpulseNs[0]/h,corrections:a.projection.corrections});
  }
  const H=-.01,chain=new JointSmallStepsMotion({positions:p,mass,fixed:[0],constraints:[0,1,2].map(i=>distance(i,i+1,1,0,true))});
  const r=chain.advance(load,h,{substeps:1,supportTargets:[{node:0,positionM:[H,0,0]}]}),a=r.audits[0];audit(a);
  for(let i=0;i<4;i++)close(chain.pos[3*i],i+H);
  const impulse=mass.reduce((s,m)=>s+m,0)*H/h-F*h;
  close(r.supportImpulseNs[0],impulse);close(r.supportWorkJ,impulse*H/h);
  report.results.push({case:'движущееся крепление всей цепочки',impulseNs:r.supportImpulseNs[0],workJ:r.supportWorkJ});
  const slack=new JointSmallStepsMotion({positions:p,mass,fixed:[0],constraints:[0,1,2].map(i=>distance(i,i+1,1,0,true))});
  const inward=load.map(v=>-v),sa=slack.step(inward,h);audit(sa);close(sa.supportImpulseNs[0],0);assert(slack.pos[9]<3);
  assert(slack.constraints.every(c=>c.lambda===0));

  const board={head:0,end:4,nodes:[0,1,2,3,4],fractions:[0,.25,.5,.75,1]},bm=[1,2,3,4,5];
  const bp=[0,0,0,.5,0,0,1,0,0,1.5,0,0,2,0,0],force=new Float64Array(15);force[7]=8;
  const rod=new JointSmallStepsMotion({positions:bp,mass:bm,fixed:[0],board,constraints:[distance(0,4,2,0)]});
  const B=bm.reduce((s,m,i)=>s+m*board.fractions[i]**2,0),C=bm.reduce((s,m,i)=>s+m*board.fractions[i]*(1-board.fractions[i]),0),A=bm.reduce((s,m,i)=>s+m*(1-board.fractions[i])**2,0);
  const headY=.1,predY=-C/B*headY+h*h*4/B,relativeY=predY-headY,len=Math.hypot(2,relativeY),unit=[2/len,relativeY/len,0];
  const end=[2*unit[0],headY+2*unit[1],0],lambda=-(len-2)*B;
  const ba=rod.step(force,h,1,[{node:0,positionM:[0,headY,0]}]);audit(ba);
  for(let d=0;d<3;d++)close(rod.pos[12+d],end[d]);
  const expected=[C*(end[0]-2)/h+lambda*unit[0]/h,A*headY/h+C*end[1]/h-4*h+lambda*unit[1]/h,0];
  for(let d=0;d<3;d++)close(ba.supportImpulseNs[d],expected[d]);close(ba.supportWorkJ,expected[1]*headY/h);
  report.results.push({case:'планка со смешанной массой',endM:end,supportImpulseNs:expected,workJ:ba.supportWorkJ});

  // Лимит одного исправления заведомо недостаточен изогнутой цепочке.
  const fail=new JointSmallStepsMotion({positions:p,mass,fixed:[0],jointCorrections:1,constraints:[0,1,2].map(i=>distance(i,i+1,1,0))});
  const old=capture(fail),bent=new Float64Array(12);bent[10]=1000;
  assert.throws(()=>fail.advance(bent,h,{substeps:1}),/не доведена/);assert.deepEqual(capture(fail),old);
  const dependent=new JointSmallStepsMotion({positions:[0,0,0,1,0,0],mass:[1,1],fixed:[0],constraints:[distance(0,1,1,0),distance(0,1,1,0)]});
  const prior=capture(dependent);assert.throws(()=>dependent.step([0,0,0,10,0,0],h),/зависимы|положительна/);assert.deepEqual(capture(dependent),prior);
  assert.throws(()=>new JointSmallStepsMotion({positions:p,mass,fixed:[0],constraints:[],jointCorrections:9}));
  report.results.push({case:'провис, зависимые связи и исчерпание лимита',complete:true});
  report.complete=true;console.log('Совместная коррекция: цепочки обоих знаков/порядков, работа движения, смешанная планка и ограниченные отказы прошли.');
} catch(error){report.complete=false;report.error=error.message;throw error;}
finally {if(out){report.sources=Object.fromEntries(['sim/cloth/cloth-small-steps.mjs','sim/cloth/cloth-small-steps-joint.mjs','tests/cloth-small-steps-joint.test.mjs']
  .map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}}
