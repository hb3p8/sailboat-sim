// Опыт Small Steps: один локальный проход на подшаг, без глобальной матрицы.
// Обычный генакер этот модуль не подключает. Доведение строгого решателя
// не заменяется: остатки материала/кромок ниже — измерения, не приёмка.
// supportImpulseNs действует на ткань; нагрузка на опору имеет обратный знак.
import {EnergyMotion} from './cloth-energy-motion.mjs';

const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const vector=a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite);
export const SMALL_STEP_COUNTS=Object.freeze([1,2,4,8,16,32,64]);

export class SmallStepsMotion extends EnergyMotion {
  constructor(options) {
    if(options.translatingBody||options.dampingHz!==undefined&&options.dampingHz!==0)
      throw new Error('Первый опыт Small Steps требует заданные крепления и нулевое затухание');
    super({...options,dampingHz:0});
  }
  movingSupportsAllowed(){return true;}
  step(force,h,passes=1,targets) {
    if(passes!==1)throw new Error('Small Steps выполняет ровно один проход на подшаг');
    return super.step(force,h,passes,targets);
  }
  // Крепления идут по заданным отрезкам; нагрузка удерживается на всём
  // интервале. Отказ любого подшага возвращает весь интервал к началу.
  advance(force,dt,{substeps,supportTargets=[]}={}) {
    if(!SMALL_STEP_COUNTS.includes(substeps)||!Number.isFinite(dt)||dt<=0||
        force?.length!==this.pos.length||!Array.from(force).every(Number.isFinite)||!Array.isArray(supportTargets))
      throw new Error('Нужны конечная нагрузка, положительный интервал и ограниченное число подшагов');
    const targets=supportTargets.map(t=>{
      if(!t||!this.fixed.has(t.node)||!vector(t.positionM))throw new Error('Некорректная цель крепления Small Steps');
      return {node:t.node,from:Array.from(this.pos.slice(3*t.node,3*t.node+3)),to:t.positionM.slice()};
    });
    if(new Set(targets.map(t=>t.node)).size!==targets.length)throw new Error('Крепление Small Steps задано дважды');
    const saved={pos:this.pos.slice(),prev:this.prev.slice(),prevDt:this.prevDt,lambda:this.constraints.map(c=>c.lambda),
      fixed:new Map(Array.from(this.fixedPositions,([i,p])=>[i,p.slice()])),active:this.supportMotionActive};
    try {
      const audits=[],impulse=new Float64Array(this.pos.length),moment=[0,0,0],h=dt/substeps;
      for(let j=1;j<=substeps;j++) {
        const sample=targets.map(t=>({node:t.node,positionM:j===substeps?t.to:t.from.map((v,d)=>v+(t.to[d]-v)*j/substeps)}));
        const audit=this.step(force,h,1,sample);audits.push(audit);
        for(let k=0;k<impulse.length;k++)impulse[k]+=audit.supportImpulseNs[k];
        for(let d=0;d<3;d++)moment[d]+=audit.supportMomentImpulseNms[d];
      }
      return {model:'small-steps-impulse-v1',dtS:dt,substeps,passesPerSubstep:1,
        projectionCalls:substeps*this.constraints.length,audits,supportImpulseNs:impulse,
        supportForceN:impulse.map(v=>v/dt),supportMomentImpulseNms:moment,
        supportWorkJ:audits.reduce((s,a)=>s+a.supportWorkJ,0),
        energyDefectJ:audits.reduce((s,a)=>s+a.energyDefectJ,0),
        maxForceResidualN:Math.max(...audits.map(a=>a.maxForceResidualN)),
        maxHardViolationM:Math.max(...audits.map(a=>a.maxHardViolationM))};
    } catch(error) {
      this.pos.set(saved.pos);this.prev.set(saved.prev);this.prevDt=saved.prevDt;
      this.constraints.forEach((c,j)=>c.lambda=saved.lambda[j]);this.fixedPositions=saved.fixed;
      this.supportMotionActive=saved.active;throw error;
    }
  }
  readSoft(p,gradient) {
    let energy=0;
    for(const c of this.constraints)if(c.alpha>0) {
      const {C,grad}=c.value(p);energy+=.5*C*C/c.alpha;
      if(gradient)for(const [i,g] of grad)for(let d=0;d<3;d++)gradient[3*i+d]+=C*g[d]/c.alpha;
    }
    return energy;
  }
  advanceStep(force,h,passes,targets,old,prior) {
    if(this.board)for(const field of [old,prior])for(let j=0;j<this.board.nodes.length;j++)for(let d=0;d<3;d++) {
      const {head,end,nodes,fractions}=this.board,value=field[3*nodes[j]+d],expected=field[3*head+d]+fractions[j]*(field[3*end+d]-field[3*head+d]);
      if(Math.abs(value-expected)>32*Number.EPSILON*Math.max(1,Math.abs(value),Math.abs(expected)))
        throw new Error('Планка Small Steps изменена вне модели');
    }
    const priorDt=this.prevDt||h,initialVelocity=old.map((v,k)=>(v-prior[k])/priorDt),initialSoftEnergyJ=this.readSoft(old);
    const reducedForce=this.reduceField(force);
    for(const {node,positionM} of targets)this.pos.set(positionM,3*node);
    for(let i=0;i<this.mass.length;i++)if(this.w[i])for(let d=0;d<3;d++) {
      const k=3*i+d;this.pos[k]+=h*initialVelocity[k]+h*h*this.w[i]*reducedForce[k];
    }
    if(this.board)for(let d=0;d<3;d++) {
      const k=3*this.board.head+d,delta=this.pos[k]-old[k]-h*initialVelocity[k];
      if(delta!==0)this.pos[3*this.board.end+d]-=this.boardCrossMass/this.boardMass*delta;
    }
    this.reconstruct();
    const constraintImpulse=new Float64Array(this.pos.length),softImpulse=new Float64Array(this.pos.length);
    const projectionMoment=[0,0,0];
    for(const c of this.constraints)c.lambda=0;
    for(const c of this.constraints) {
      const {C,grad}=c.value(this.pos),reduced=this.reduce(grad),scaled=c.alpha/(h*h);
      if(!Number.isFinite(C)||grad.some(([i,g])=>!Number.isInteger(i)||i<0||i>=this.mass.length||!vector(g)))
        throw new Error('Неконечное значение или градиент Small Steps');
      let denominator=scaled;
      for(const [i,g] of reduced)denominator+=this.w[i]*g.reduce((s,v)=>s+v*v,0);
      if(!(denominator>0))continue;
      const raw=(-C-scaled*c.lambda)/denominator,next=c.unilateral?Math.min(0,c.lambda+raw):c.lambda+raw,delta=next-c.lambda;
      c.lambda=next;
      // Импульс вычисляется с тем же градиентом, который двигал координаты,
      // до следующей поправки. Последний градиент шага его не заменяет.
      for(const [i,g] of grad) {
        const impulse=g.map(v=>v*delta/h),torque=cross(Array.from(this.pos.slice(3*i,3*i+3)),impulse);
        for(let d=0;d<3;d++){constraintImpulse[3*i+d]+=impulse[d];if(c.alpha>0)softImpulse[3*i+d]+=impulse[d];projectionMoment[d]+=torque[d];}
      }
      for(const [i,g] of reduced)for(let d=0;d<3;d++)this.pos[3*i+d]+=this.w[i]*delta*g[d];
      if(this.board&&delta&&reduced.some(([i])=>i===this.board.end))this.reconstruct();
    }
    if(!Array.from(this.pos).every(Number.isFinite))throw new Error('Неконечное положение Small Steps');
    const velocity=this.pos.map((v,k)=>(v-old[k])/h),residual=new Float64Array(this.pos.length),support=new Float64Array(this.pos.length);
    let initialKineticJ=0,kineticJ=0,kineticIncrementJ=0,appliedWorkJ=0,projectionWorkJ=0;
    for(let i=0;i<this.mass.length;i++)for(let d=0;d<3;d++) {
      const k=3*i+d,dv=velocity[k]-initialVelocity[k];
      residual[k]=this.mass[i]*dv-force[k]*h-constraintImpulse[k];
      initialKineticJ+=.5*this.mass[i]*initialVelocity[k]**2;kineticJ+=.5*this.mass[i]*velocity[k]**2;
      kineticIncrementJ+=.5*this.mass[i]*dv*dv;
      appliedWorkJ+=force[k]*(this.pos[k]-old[k]);projectionWorkJ+=constraintImpulse[k]*velocity[k];
      const boardIndex=this.board?.nodes.indexOf(i)??-1;
      if(boardIndex>=0)support[3*this.board.head+d]+=(1-this.board.fractions[boardIndex])*residual[k];
      else if(this.fixed.has(i))support[k]=residual[k];
    }
    const reducedResidual=this.reduceField(residual),materialGradient=new Float64Array(this.pos.length);
    const softEnergyJ=this.readSoft(this.pos,materialGradient),constitutive=this.reduceField(softImpulse.map((v,k)=>v/h+materialGradient[k]));
    let supportWorkJ=0,maxFreeImpulseResidualNs=0,maxForceResidualN=0,maxHardViolationM=0;
    const momentumResidual=[0,0,0],angularResidual=[0,0,0],supportMoment=[0,0,0];
    for(let i=0;i<this.mass.length;i++) {
      const lever=[0,1,2].map(d=>(this.pos[3*i+d]+old[3*i+d])/2);
      const external=[0,1,2].map(d=>force[3*i+d]*h+support[3*i+d]);
      const oldL=cross(Array.from(old.slice(3*i,3*i+3)),Array.from(initialVelocity.slice(3*i,3*i+3),v=>v*this.mass[i]));
      const newL=cross(Array.from(this.pos.slice(3*i,3*i+3)),Array.from(velocity.slice(3*i,3*i+3),v=>v*this.mass[i]));
      const externalM=cross(lever,external),supportM=cross(lever,Array.from(support.slice(3*i,3*i+3)));
      for(let d=0;d<3;d++) {
        const k=3*i+d;momentumResidual[d]+=this.mass[i]*(velocity[k]-initialVelocity[k])-external[d];
        angularResidual[d]+=newL[d]-oldL[d]-externalM[d];supportMoment[d]+=supportM[d];
        if(this.fixed.has(i))supportWorkJ+=support[k]*velocity[k];
        if(this.w[i]){maxFreeImpulseResidualNs=Math.max(maxFreeImpulseResidualNs,Math.abs(reducedResidual[k]));maxForceResidualN=Math.max(maxForceResidualN,Math.abs(constitutive[k]));}
      }
    }
    for(const c of this.constraints)if(c.alpha===0){const {C}=c.value(this.pos);maxHardViolationM=Math.max(maxHardViolationM,c.unilateral?Math.max(0,C):Math.abs(C));}
    this.prev.set(old);this.prevDt=h;
    return {hS:h,passes:1,initialKineticJ,kineticJ,initialSoftEnergyJ,softEnergyJ,kineticIncrementJ,
      appliedWorkJ,projectionWorkJ,supportWorkJ,supportImpulseNs:support,supportMomentImpulseNms:supportMoment,
      constraintImpulseNs:constraintImpulse,projectionMomentImpulseNms:projectionMoment,maxFreeImpulseResidualNs,
      linearMomentumResidualNs:momentumResidual,angularMomentumResidualNms:angularResidual,
      impulseWorkResidualJ:kineticJ-initialKineticJ+kineticIncrementJ-appliedWorkJ-projectionWorkJ-supportWorkJ,
      energyDefectJ:kineticJ-initialKineticJ+softEnergyJ-initialSoftEnergyJ-appliedWorkJ-supportWorkJ,
      maxForceResidualN,maxHardViolationM};
  }
}
