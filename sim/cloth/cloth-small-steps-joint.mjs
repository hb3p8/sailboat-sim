// Опытный блочный XPBD только для жёстких кромок/шкота. Материал — один
// локальный проход. Никакой регуляризации зависимых связей или дробления h.
import {SmallStepsMotion} from './cloth-small-steps.mjs';
import {IMPLICIT_TOLERANCES} from './cloth-implicit-motion.mjs';
import {bandFactor} from './cloth-linear-solve.mjs';

export const JOINT_HARD_LIMITS=Object.freeze({corrections:8,activeSetPerConstraint:4,activeSetExtra:10});
const dot=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0);
export class JointSmallStepsMotion extends SmallStepsMotion {
  constructor(options) {
    super(options);
    const corrections=options.jointCorrections??JOINT_HARD_LIMITS.corrections;
    if(!Number.isInteger(corrections)||corrections<1||corrections>JOINT_HARD_LIMITS.corrections)
      throw new Error('Совместная коррекция допускает от одного до восьми проходов');
    this.jointCorrections=corrections;
    this.hard=this.constraints.filter(c=>c.alpha===0);
  }
  projectConstraints(h,apply,applyBatch) {
    const stats={method:'block-hard-xpbd-v1',localProjections:0,corrections:0,
      activeSetSolves:0,factorizations:0,hardEvaluations:0,hardProjectionCalls:0,maxActive:0};
    try{return this.projectBlock(h,apply,applyBatch,stats);}
    catch(error){error.jointProjection={...stats};throw error;}
  }
  projectBlock(h,apply,applyBatch,stats) {
    for(const c of this.constraints)if(c.alpha>0){this.projectLocal(c,h,apply);stats.localProjections++;}
    const t=IMPLICIT_TOLERANCES,hard=this.hard;
    const rows=()=>hard.map(c=>{
      const {C,grad}=c.value(this.pos),reduced=this.reduce(grad).filter(([i,g])=>this.w[i]&&g.some(v=>v!==0));
      stats.hardEvaluations++;
      if(!Number.isFinite(C)||grad.some(([i,g])=>!Number.isInteger(i)||i<0||i>=this.mass.length||g.length!==3||!g.every(Number.isFinite)))
        throw new Error('Неконечная жёсткая связь совместной коррекции');
      const violation=c.unilateral?Math.max(0,C):Math.abs(C);
      if(!reduced.length&&violation>t.lengthToleranceM)throw new Error('Нарушена жёсткая связь неподвижных точек');
      return {c,C,grad,reduced};
    });
    for(let iteration=0;iteration<=this.jointCorrections;iteration++) {
      const state=rows();let violation=0,complementarity=0,dual=0;
      for(const {c,C} of state) {
        violation=Math.max(violation,c.unilateral?Math.max(0,C):Math.abs(C));
        if(c.unilateral){complementarity=Math.max(complementarity,Math.abs(c.lambda*C/(h*h)));dual=Math.max(dual,c.lambda/(h*h));}
      }
      if(violation<=t.lengthToleranceM&&complementarity<=t.complementarityToleranceJ&&dual<=t.dualToleranceN)
        return {...stats,violationM:violation,complementarityJ:complementarity,dualViolationN:dual};
      if(iteration===this.jointCorrections)throw new Error(`Совместная коррекция не доведена за ${iteration}: ${violation} м, ${complementarity} Дж`);
      const n=hard.length,A=Array.from({length:n},()=>new Float64Array(n));
      for(let a=0;a<n;a++)for(let b=0;b<=a;b++) {
        let value=0;
        for(const [i,g] of state[a].reduced)for(const [j,f] of state[b].reduced)if(i===j)value+=this.w[i]*dot(g,f);
        A[a][b]=A[b][a]=value;
      }
      // b=C−Aλ_old. Для μ=−λ_new: b−Aμ≤0, μ≥0; равенства
      // свободны по знаку. Поправка использует λ_new−λ_old.
      const b=Float64Array.from(state,({C},a)=>C-A[a].reduce((s,v,j)=>s+v*hard[j].lambda,0));
      const active=new Set(state.flatMap(({c,reduced},i)=>reduced.length&&(!c.unilateral||-c.lambda/(h*h)>t.dualToleranceN)?[i]:[]));
      let answer;
      for(let qp=0;qp<JOINT_HARD_LIMITS.activeSetPerConstraint*n+JOINT_HARD_LIMITS.activeSetExtra;qp++) {
        stats.activeSetSolves++;const ids=Array.from(active),size=ids.length,matrix=new Float64Array(size*size);
        for(let i=0;i<size;i++)for(let j=0;j<=i;j++)matrix[i*size+i-j]=A[ids[i]][ids[j]];
        const mu=new Float64Array(n);
        if(size) {
          stats.factorizations++;
          const x=bandFactor(matrix,size,size-1)(Float64Array.from(ids,i=>b[i]));
          ids.forEach((id,j)=>mu[id]=x[j]);
        }
        let remove=-1,worstNegative=-t.dualToleranceN*h*h;
        for(const i of ids)if(hard[i].unilateral&&mu[i]<worstNegative){worstNegative=mu[i];remove=i;}
        if(remove>=0){active.delete(remove);continue;}
        let insert=-1,worstViolation=t.lengthToleranceM;
        for(let i=0;i<n;i++)if(hard[i].unilateral&&!active.has(i)&&state[i].reduced.length) {
          const gap=b[i]-A[i].reduce((s,v,j)=>s+v*mu[j],0);
          if(gap>worstViolation){worstViolation=gap;insert=i;}
        }
        if(insert>=0){active.add(insert);continue;}
        answer=mu;stats.maxActive=Math.max(stats.maxActive,active.size);break;
      }
      if(!answer)throw new Error('Исчерпан выбор натянутых связей совместной коррекции');
      const changes=state.map((row,i)=>({...row,delta:-answer[i]-row.c.lambda}));
      for(let i=0;i<n;i++)hard[i].lambda=-answer[i];
      applyBatch(changes);stats.corrections++;stats.hardProjectionCalls+=n;
    }
  }
  advanceStep(...args) {
    const a=super.advanceStep(...args),h=args[1],material=new Float64Array(this.pos.length),expectedHard=new Float64Array(this.pos.length);
    this.readSoft(this.pos,material);
    for(const c of this.hard)for(const [i,g] of c.value(this.pos).grad)for(let d=0;d<3;d++)expectedHard[3*i+d]+=c.lambda*g[d]/(h*h);
    const hardResidual=this.reduceField(a.constraintImpulseNs.map((v,k)=>(v-a.softConstraintImpulseNs[k])/h-expectedHard[k]));
    const fullResidual=this.reduceField(a.constraintImpulseNs.map((v,k)=>v/h+material[k]-expectedHard[k]));
    a.materialForceResidualN=a.maxForceResidualN;a.maxHardGradientResidualN=0;a.maxForceResidualN=0;
    for(let i=0;i<this.mass.length;i++)if(this.w[i])for(let d=0;d<3;d++) {
      a.maxHardGradientResidualN=Math.max(a.maxHardGradientResidualN,Math.abs(hardResidual[3*i+d]));
      a.maxForceResidualN=Math.max(a.maxForceResidualN,Math.abs(fullResidual[3*i+d]));
    }
    return a;
  }
  advance(...args) {
    const {passesPerSubstep,...a}=super.advance(...args);
    return {...a,model:'small-steps-joint-hard-v1',materialPassesPerSubstep:passesPerSubstep,
      projectionCalls:a.audits.reduce((s,v)=>s+v.projection.localProjections+v.projection.hardProjectionCalls,0)};
  }
}
