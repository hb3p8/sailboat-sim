// S0: аналитические дискретные ответы, независимые ОДУ и фактические импульсы.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {SmallStepsMotion} from '../sim/cloth/cloth-small-steps.mjs';
import {materialSurface} from '../sim/cloth/cloth-material.mjs';
import {distance} from '../sim/cloth/cloth-compliance.mjs';

// Предел округления взят из прежнего независимого cloth-energy-motion.test.
// Убывание ошибки — контроль сходимости, не допуск интерактивного паруса.
const spec=Object.freeze({schema:'small-steps-s0-spec-v1',dtS:1/30,counts:[2,4,8,16,32],seconds:.5,
  relativeRoundoff:2e-11,referenceSubstepsPerFrame:4096,acceptance:'точные известные ответы и убывание ошибки; полный парус не принимается'});
const close=(a,b)=>assert(Math.abs(a-b)<=spec.relativeRoundoff*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const out=process.argv.find(v=>v.startsWith('--out='))?.slice(6);if(out)assert(!existsSync(out));
const report={schema:'small-steps-s0-check-v1',spec,results:[]};
const max=a=>Math.max(0,...a.map(Math.abs));
function audit(r) {for(const a of r.audits){close(a.maxFreeImpulseResidualNs,0);close(a.impulseWorkResidualJ,0);close(max(a.linearMomentumResidualNs),0);}}
const state=m=>({pos:Array.from(m.pos),prev:Array.from(m.prev),prevDt:m.prevDt,lambda:m.constraints.map(c=>c.lambda),
  fixed:Array.from(m.fixedPositions),active:m.supportMotionActive});
// RK4 — независимое скалярное уравнение; таблица только на концах кадров.
function reference(acceleration) {
  let q=0,v=0;const rows=[];
  for(let frame=0;frame<Math.round(spec.seconds/spec.dtS);frame++) {
    const h=spec.dtS/spec.referenceSubstepsPerFrame;
    for(let j=0;j<spec.referenceSubstepsPerFrame;j++) {
      const a=acceleration(q,v),b=acceleration(q+h*v/2,v+h*a/2),c=acceleration(q+h*(v+h*a/2)/2,v+h*b/2),d=acceleration(q+h*(v+h*b/2),v+h*c);
      q+=h*(v+2*(v+h*a/2)+2*(v+h*b/2)+(v+h*c))/6;v+=h*(a+2*b+2*c+d)/6;
    }
    rows.push({q,v});
  }
  return rows;
}
try {
  // Один линейный пружинный шаг с движущейся опорой: точный backward Euler.
  const h=spec.dtS,K=20,F=8,H=.1,m=3;
  const spring=new SmallStepsMotion({positions:[0,0,0,1,0,0],mass:[2,m],fixed:[0],constraints:[distance(0,1,1,1/K)]});
  const r=spring.advance([0,0,0,F,0,0],h,{substeps:1,supportTargets:[{node:0,positionM:[H,0,0]}]}),a=r.audits[0];
  const x=(m+h*h*(F+K*(H+1)))/(m+K*h*h),C=x-H-1;
  close(spring.pos[3],x);close(a.supportImpulseNs[0],2*H/h-K*C*h);
  close(a.supportWorkJ,a.supportImpulseNs[0]*H/h);close(a.maxForceResidualN,0);
  close(a.energyDefectJ+a.kineticIncrementJ+.5*K*C*C,0);audit(r);
  report.results.push({case:'движущаяся опора и линейная энергия',positionM:x,supportImpulseNs:a.supportImpulseNs[0],supportWorkJ:a.supportWorkJ});

  // Аффинная планка: известна полная смешанная масса головы и конца.
  const board={head:0,end:4,nodes:[0,1,2,3,4],fractions:[0,.25,.5,.75,1]},mass=[1,2,3,4,5];
  const positions=[0,0,0,.5,0,0,1,0,0,1.5,0,0,2,0,0];
  const linear={alpha:1/K,value:p=>({C:p[7]-p[1],grad:[[2,[0,1,0]],[0,[0,-1,0]]]})};
  const b=new SmallStepsMotion({positions,mass,fixed:[0],board,constraints:[linear]});
  const applied=new Float64Array(15);applied[7]=F;
  const br=b.advance(applied,h,{substeps:1,supportTargets:[{node:0,positionM:[0,H,0]}]}),ba=br.audits[0];
  const ME=mass.reduce((s,m,i)=>s+m*board.fractions[i]**2,0),MH=mass.reduce((s,m,i)=>s+m*(1-board.fractions[i])**2,0),crossMass=mass.reduce((s,m,i)=>s+m*board.fractions[i]*(1-board.fractions[i]),0);
  const y=(-crossMass*H+h*h*(F*.5+K*.25*H))/(ME+h*h*K*.25),strain=.5*(y-H);
  const expectedSupport=MH*H/h+crossMass*y/h-F*.5*h-K*strain*.5*h;
  close(b.pos[13],y);close(ba.supportImpulseNs[1],expectedSupport);audit(br);
  close(ba.energyDefectJ+ba.kineticIncrementJ+.5*K*strain*strain,0);
  report.results.push({case:'движущаяся планка',endM:y,supportImpulseNs:expectedSupport,workJ:ba.supportWorkJ});

  // Свободная скорость переживает смену частоты без пересчёта импульса.
  const free=new SmallStepsMotion({positions:[0,0,0],mass:[2],constraints:[]});free.prev[0]=-2/60;free.prevDt=1/60;
  for(const n of spec.counts){const r=free.advance([0,0,0],h,{substeps:n});close((free.pos[0]-free.prev[0])/free.prevDt,2);audit(r);}

  // Провис не толкает. Остановка на натянутой верёвке передаёт весь импульс.
  const rope=new SmallStepsMotion({positions:[0,0,0,.8,0,0],mass:[1,1],fixed:[0],constraints:[distance(0,1,1,0,true)]});
  rope.prev[3]=.8-2/60;rope.prevDt=1/60;let impulse=0,defect=0;
  for(let j=0;j<6;j++) {
    const r=rope.advance([0,0,0,0,0,0],h,{substeps:8});audit(r);impulse+=r.supportImpulseNs[0];defect+=r.energyDefectJ;
    if(j===0)close(r.supportImpulseNs[0],0);
    assert(r.maxHardViolationM<spec.relativeRoundoff);
  }
  close(rope.pos[3],1);close(impulse,-2);close(defect,-2);
  const slack=rope.advance([0,0,0,-10,0,0],h,{substeps:8});audit(slack);close(slack.supportImpulseNs[0],0);assert(rope.pos[3]<1);
  const pulled=new SmallStepsMotion({positions:[0,0,0,1,0,0],mass:[1,1],fixed:[0],constraints:[distance(0,1,1,0,true)]});pulled.mass[0]=0;
  const pr=pulled.advance([0,0,0,0,0,0],h,{substeps:8,supportTargets:[{node:0,positionM:[-.1,0,0]}]});audit(pr);
  close(pulled.pos[3],.9);close(pr.supportImpulseNs[0],-3);close(pr.supportWorkJ,9);
  report.results.push({case:'провис, натяжение и движение точки шкота',stopImpulseNs:impulse,stopEnergyDefectJ:defect,movingSupportImpulseNs:pr.supportImpulseNs[0]});

  // Реальная нелинейная энергия треугольника: x''=10−262.5*x*(x²−1).
  const triangleReference=reference((q,v)=>10-.25*1050*(q+1)*((q+1)**2-1)),triangle=[];
  for(const n of spec.counts) {
    const p=[0,0,0,1,0,0,0,1,0],surface=materialSurface(p,[[0,1,2]],{bulkNPerM:1000,shearNPerM:50,bendingNm:0});
    const motion=new SmallStepsMotion({positions:p,mass:[1,1,1],fixed:[0,2],constraints:surface.constraints});
    let error=0,forceResidual=0,energyDefect=0;const start=performance.now();
    for(const ref of triangleReference){const r=motion.advance([0,0,0,10,0,0,0,0,0],h,{substeps:n});audit(r);
      error=Math.max(error,Math.abs(motion.pos[3]-(1+ref.q)));forceResidual=Math.max(forceResidual,r.maxForceResidualN);energyDefect+=r.energyDefectJ;}
    triangle.push({substeps:n,maxPositionErrorM:error,maxForceResidualN:forceResidual,energyDefectJ:energyDefect,wallMs:performance.now()-start});
  }
  assert(triangle.at(-1).maxPositionErrorM<triangle.at(-2).maxPositionErrorM&&triangle.at(-2).maxPositionErrorM<triangle.at(-3).maxPositionErrorM);
  report.results.push({case:'нелинейный треугольник, независимое ОДУ',series:triangle});

  const rodReference=reference((q,v)=>4/(ME*2)*Math.cos(q)),rod=[];
  for(const n of spec.counts) {
    const motion=new SmallStepsMotion({positions,mass,fixed:[0],board,constraints:[distance(0,4,2,0)]});
    let error=0,angularDefect=0;
    for(const ref of rodReference){const r=motion.advance(applied,h,{substeps:n});audit(r);error=Math.max(error,Math.abs(Math.atan2(motion.pos[13],motion.pos[12])-ref.q));
      for(const a of r.audits)angularDefect+=a.angularMomentumResidualNms[2];}
    close(Math.hypot(...motion.pos.slice(12)),2);rod.push({substeps:n,maxAngleErrorRad:error,angularMomentumDefectNms:angularDefect});
  }
  assert(rod.at(-1).maxAngleErrorRad<rod.at(-2).maxAngleErrorRad&&rod.at(-2).maxAngleErrorRad<rod.at(-3).maxAngleErrorRad);
  assert(Math.abs(rod.at(-1).angularMomentumDefectNms)<Math.abs(rod.at(-2).angularMomentumDefectNms));
  report.results.push({case:'жёсткая планка, независимое ОДУ',series:rod});

  // Отказ после уже законченного подшага откатывает весь интервал.
  const fail=new SmallStepsMotion({positions:[0,0,0,1,0,0],mass:[1,1],fixed:[0],constraints:[{alpha:.1,value(p){
    if(p[0]>.04)throw new Error('Заданный отказ второго подшага');return {C:p[3]-p[0]-1,grad:[[1,[1,0,0]],[0,[-1,0,0]]]};}}]});
  const before=state(fail);assert.throws(()=>fail.advance([0,0,0,1,0,0],h,{substeps:4,supportTargets:[{node:0,positionM:[.1,0,0]}]}),/второго/);assert.deepEqual(state(fail),before);
  assert.throws(()=>fail.advance([0,0,0,0,0,0],h,{substeps:128}));assert.throws(()=>fail.step([0,0,0,0,0,0],h,2));
  assert.throws(()=>new SmallStepsMotion({positions:[0,0,0],mass:[1],constraints:[],dampingHz:NaN}));
  assert.throws(()=>new SmallStepsMotion({positions:[0,0,0],mass:[1],constraints:[],translatingBody:{}}));
  report.complete=true;
  for(const r of report.results)console.log(`${r.case}: ${JSON.stringify(r.series??r)}`);
} catch(error){report.complete=false;report.error=error.message;throw error;}
finally {
  report.revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();report.node=process.version;
  report.sources=Object.fromEntries(['sim/cloth/cloth-small-steps.mjs','sim/cloth/cloth-energy-motion.mjs','sim/cloth/cloth-material.mjs','tests/cloth-small-steps.test.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
  if(out)writeFileSync(out,JSON.stringify(report,(_,v)=>ArrayBuffer.isView(v)?Array.from(v):v,2)+'\n',{flag:'wx'});
}
