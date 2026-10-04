// Разреженный блок ткани и малое дополнение шести скоростей тела/воды.
// Приближена только матрица направления (Gauss–Newton), не общий остаток.
import {gridDissection,sparsePattern} from './cloth-sparse-solve.mjs';
import {cross3,rotate3,transpose3,denseSolve} from './cloth-fluid-inertia.mjs';
import {gradientLayout,gradientValues} from './cloth-gradient-layout.mjs';

const coordinates=grad=>{
  const out=new Map();
  for(const [node,g] of grad)for(let d=0;d<3;d++)out.set(3*node+d,(out.get(3*node+d)??0)+g[d]);
  return Array.from(out);
};

export function fluidSchurDirection(m,z,s,old,load,h,active,{exact=false}={}) {
  const nc=m.pos.length,nh=m.hard.length,nb=3*m.bindings.length,n=nc+nh+nb;
  const soft=m.soft.map((c,j)=>{
    const v=s.softValues?.[j]??c.value(s.q),plan=m.fluidAssembly?.soft[j];
    if(v.values&&plan?.direct&&v.nodes.length===plan.layout.nodes.length&&
        v.nodes.every((node,k)=>node===plan.layout.nodes[k])) {
      // Пары координат нужны лишь внутри этого вызова направления. Снимок
      // материала принадлежит состоянию, рабочие пары — раскладке решателя.
      for(let k=0;k<plan.g.length;k++)plan.g[k][1]=0+v.values[k];
      return {c,g:plan.g};
    }
    const grad=v.grad??v.nodes.map((node,k)=>[node,Array.from(v.values.slice(3*k,3*k+3))]);
    if(!plan)return {c,grad,g:coordinates(grad)};
    const values=gradientValues(plan.layout,grad,plan.currentValues);
    for(let k=0;k<plan.g.length;k++)plan.g[k][1]=values[k];
    return {c,grad,g:plan.g};
  });
  const hard=m.hard.map(c=>({...m.hardValue(c,s.q,s)}));
  const hg=hard.map(c=>coordinates(c.grad));
  const bindings=m.bindings.flatMap(({node})=>[0,1,2].map(d=>[[3*node+d,1]]));
  const groups=[...hg,...bindings];
  if(!m.fluidPattern&&n) {
    const base=m.gridRows?Array.from(gridDissection(m.gridRows,m.gridCols,
      Int32Array.from(m.mass,(_,i)=>3*i),nc)):Array.from({length:nc},(_,i)=>i);
    const position=new Int32Array(nc);base.forEach((i,k)=>{position[i]=k;});
    const after=Array.from({length:nc+1},()=>[]),edges=[];
    groups.forEach((g,j)=>{
      const last=g.length?Math.max(...g.map(([i])=>position[i]))+1:0;
      after[last].push(nc+j);for(const [i] of g)edges.push([i,nc+j]);
    });
    const order=[...after[0]];base.forEach((i,k)=>{order.push(i,...after[k+1]);});
    m.fluidPattern=sparsePattern(n,[...soft.map(({g})=>g.map(([i])=>i)),...hg.map(g=>g.map(([i])=>i))],Int32Array.from(order),edges);
  }
  const p=m.fluidPattern,matrix=new Float64Array(p?.cols.length??0),signs=new Int32Array(n).fill(1);
  const add=(i,j,v)=>{
    const a=p.inverse[i],b=p.inverse[j],entry=p.locations[Math.max(a,b)].get(Math.min(a,b));
    if(entry===undefined)throw new Error('Изменилась структура общего разреженного блока');
    matrix[entry]+=v;
  };
  if(n&&!m.fluidAssembly) {
    const compile=(g,grad)=>{
      const entries=[];
      for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++) {
        const i=p.inverse[g[a][0]],j=p.inverse[g[b][0]];
        entries.push(p.locations[Math.max(i,j)].get(Math.min(i,j)));
      }
      const layout=gradientLayout(grad),size=layout.coordinates.length;
      return {coordinates:Int32Array.from(g,([i])=>i),entries:Int32Array.from(entries),layout,
        g:Array.from(g,([i])=>[i,0]),currentValues:new Float64Array(size),
        plusValues:new Float64Array(size),minusValues:new Float64Array(size),rawValues:new Float64Array(3*grad.length),
        direct:layout.slots.length===size&&layout.slots.every((slot,i)=>slot===i),hessian:new Float64Array(size*size)};
    };
    m.fluidAssembly={soft:soft.map(({g,grad})=>compile(g,grad)),hard:hg.map((g,j)=>compile(g,hard[j].grad))};
  }
  const checkPlan=(g,plan)=>{
    if(g.length!==plan.coordinates.length||g.some(([i],a)=>i!==plan.coordinates[a]))
      throw new Error('Изменился локальный набор узлов материала или кромки');
  };
  for(let i=0;i<nc;i++)add(i,i,m.mass[Math.floor(i/3)]/(h*h));
  if(exact) {
    // Один точный Newton-корректор после достижения прежнего допуска.
    // Каждая энергия/связь читается только в своём локальном окружении;
    // симметрия — тождество Hessian, а не новая материальная модель.
    const terms=[...soft.map(({c,g},k)=>({c,g,plan:m.fluidAssembly.soft[k],weight:1/c.alpha,soft:true})),
      ...active.map(j=>({c:m.hard[j],g:hg[j],plan:m.fluidAssembly.hard[j],weight:s.mu[j],soft:false}))];
    const plus=s.q.slice(),minus=s.q.slice();
    const read=(c,plan,q,target,buffered)=>{
      if(buffered&&plan.direct) {
        const C=c.valueInto(q,target);
        // Прежний Map начинал каждую сумму с +0, включая входное -0.
        for(let k=0;k<target.length;k++)target[k]=0+target[k];
        return C;
      }
      if(buffered) {
        const C=c.valueInto(q,plan.rawValues);target.fill(0);
        for(let k=0;k<plan.rawValues.length;k++)target[plan.layout.slots[k]]+=plan.rawValues[k];
        return C;
      }
      const {C,grad}=m.hardValue(c,q,s);gradientValues(plan.layout,grad,target);return C;
    };
    const buffered=t=>typeof t.c.valueInto==='function'&&t.c.gradientNodes?.length===t.plan.layout.nodes.length&&
      t.c.gradientNodes.every((node,i)=>node===t.plan.layout.nodes[i]);
    const assemble=({g,plan})=>{
      const size=g.length,H=plan.hessian;let entry=0;
      for(let a=0;a<size;a++)for(let b=0;b<=a;b++)matrix[plan.entries[entry++]]+=.5*(H[a*size+b]+H[b*size+a]);
    };
    for(let term=0;term<terms.length;) {
      const t=terms[term],{c,g,plan,weight,soft:isSoft}=t;
      checkPlan(g,plan);const size=g.length,H=plan.hessian,group=c.gradientGroup;
      const block=group?.size>1?terms.slice(term,term+group.size):[t];
      const batch=group&&block.length===group.size&&block.every((v,j)=>v.soft&&v.c.gradientGroup===group&&
        v.c.gradientSlot===j&&buffered(v)&&v.plan.direct&&v.g.length===size&&
        v.g.every(([k],i)=>k===g[i][0]));
      if(batch) {
        block.forEach(({g,plan})=>checkPlan(g,plan));
        const plusGradients=block.map(v=>v.plan.plusValues),minusGradients=block.map(v=>v.plan.minusValues);
        for(let j=0;j<size;j++) {
          const k=g[j][0],delta=2e-6*Math.max(1,Math.abs(s.q[k]));plus[k]+=delta;minus[k]-=delta;
          const Cp=group.valueInto(plus,plusGradients),Cm=group.valueInto(minus,minusGradients);
          for(let mode=0;mode<block.length;mode++) {
            const {plan,weight}=block[mode],gp=plan.plusValues,gm=plan.minusValues;
            for(let i=0;i<size;i++) {
              gp[i]=0+gp[i];gm[i]=0+gm[i];
              plan.hessian[i*size+j]=weight*(Cp[mode]*gp[i]-Cm[mode]*gm[i])/(2*delta);
            }
          }
          plus[k]=s.q[k];minus[k]=s.q[k];
        }
        // Слагаемые в общей матрице добавляются в прежнем порядке мод.
        block.forEach(assemble);term+=block.length;continue;
      }
      const useBuffer=buffered(t);
      for(let j=0;j<size;j++) {
        const k=g[j][0],delta=2e-6*Math.max(1,Math.abs(s.q[k]));
        plus[k]+=delta;minus[k]-=delta;
        const Cp=read(c,plan,plus,plan.plusValues,useBuffer),Cm=read(c,plan,minus,plan.minusValues,useBuffer);
        const gp=plan.plusValues,gm=plan.minusValues;
        for(let i=0;i<size;i++)H[i*size+j]=weight*((isSoft?Cp:1)*gp[i]-(isSoft?Cm:1)*gm[i])/(2*delta);
        plus[k]=s.q[k];minus[k]=s.q[k];
      }
      assemble(t);term++;
    }
  } else for(let k=0;k<soft.length;k++) {
    const {c,g}=soft[k],plan=m.fluidAssembly.soft[k];checkPlan(g,plan);let entry=0;
    for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++)matrix[plan.entries[entry++]]+=g[a][1]*g[b][1]/c.alpha;
  }
  const activeSet=new Set(active),rK=new Float64Array(n);rK.set(s.clothResidual);
  groups.forEach((g,j)=>{
    if(j>=nh||activeSet.has(j)) {
      for(const [i,v] of g)add(i,nc+j,v);signs[p.inverse[nc+j]]=-1;
      rK[nc+j]=j<nh?hard[j].C:
        s.residual[nc+6+active.length+j-nh]*m.tolerances.lengthToleranceM/m.tolerances.forceToleranceN;
    } else add(nc+j,nc+j,1);
  });

  // Шесть производных скоростей: закрепления и, при наличии верёвки,
  // её направление/длина. B читает настоящее уравнение тела.
  const B=new Float64Array(36),E=Array.from({length:6},()=>new Float64Array(n));
  for(let j=0;j<6;j++) {
    const delta=2e-6*Math.max(1,Math.abs(s.nu[j])),plus=s.nu.slice(),minus=s.nu.slice();
    plus[j]+=delta;minus[j]-=delta;
    const reactions=z.slice(nc+6+active.length),rp=m.bodyState(plus,old,load,h,reactions,s.q,s.mu),rm=m.bodyState(minus,old,load,h,reactions,s.q,s.mu);
    for(let d=0;d<6;d++)B[6*d+j]=(rp.bodyResidual[d]-rm.bodyResidual[d])/(2*delta)/(d<3?1:m.inertia.referenceLengthM);
    for(let d=0;d<nb;d++)E[j][nc+nh+d]=-(rp.targets[Math.floor(d/3)][d%3]-rm.targets[Math.floor(d/3)][d%3])/(2*delta);
    m.ropes.forEach((r,i)=>{
      const k=m.ropeHardStart+i,T=s.mu[k];
      for(let d=0;d<3;d++)E[j][3*r.node+d]+=T*(rp.ropeValues[i].direction[d]-rm.ropeValues[i].direction[d])/(2*delta);
      if(activeSet.has(k))E[j][nc+k]=(rp.ropeValues[i].C-rm.ropeValues[i].C)/(2*delta);
    });
  }
  // Часть D от реакций креплений: мировая сила и момент по середине плеча.
  const D=Array.from({length:6},()=>new Float64Array(n)),RT=transpose3(s.pose.averageRotation9),oldRT=transpose3(old.body.orientation9);
  m.bindings.forEach(({localM},b)=>{
    const lever=rotate3(s.pose.averageRotation9,localM);
    for(let d=0;d<3;d++) {
      const e=[0,0,0];e[d]=1;
      const column=[...rotate3(RT,e),...rotate3(oldRT,cross3(lever,e))];
      column.forEach((v,i)=>{D[i][nc+nh+3*b+d]=-v/(i<3?1:m.inertia.referenceLengthM);});
    }
  });
  if(m.ropes.length) {
    const reactions=z.slice(nc+6+active.length);
    // Уравнение тела зависит также от свободных узлов, поскольку они
    // задают направление силы верёвки. Остальное полотно здесь не читается.
    for(const node of new Set(m.ropes.map(r=>r.node)))for(let d=0;d<3;d++) {
      const k=3*node+d,delta=2e-6*Math.max(1,Math.abs(s.q[k])),plus=s.q.slice(),minus=s.q.slice();
      plus[k]+=delta;minus[k]-=delta;
      const rp=m.bodyState(s.nu,old,load,h,reactions,plus,s.mu),rm=m.bodyState(s.nu,old,load,h,reactions,minus,s.mu);
      for(let i=0;i<6;i++)D[i][k]=(rp.bodyResidual[i]-rm.bodyResidual[i])/(2*delta)/(i<3?1:m.inertia.referenceLengthM);
    }
    m.ropes.forEach((r,j)=>{
      const k=m.ropeHardStart+j;if(!activeSet.has(k))return;
      const u=s.ropeValues[j].direction,lever=rotate3(s.pose.averageRotation9,r.localM);
      const column=[...rotate3(RT,u),...rotate3(oldRT,cross3(lever,u))];
      column.forEach((v,i)=>{D[i][nc+k]=-v/(i<3?1:m.inertia.referenceLengthM);});
    });
  }
  // Порядок координат задан постоянным планом. Прямые циклы не создают
  // промежуточный массив с минусом и не вызывают функцию на каждое число.
  const permute=(v,negative=false)=>{
    const result=new Float64Array(n);
    for(let i=0;i<n;i++)result[i]=negative?-v[p.order[i]]:v[p.order[i]];
    return result;
  };
  let response;
  if(n) {
    const solve=m.wasmSparseFactor.ldl(matrix,p,signs);
    try {response=solve.many([permute(rK,true),...E.map(v=>permute(v))]).map(v=>{
      const result=new Float64Array(n);
      for(let i=0;i<n;i++)result[i]=v[p.inverse[i]];
      return result;
    });} finally {solve.release();}
  } else response=Array.from({length:7},()=>new Float64Array(0));
  // Начальное +0 и последовательность сумм прежние, включая знак нуля.
  const dot=(a,b)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]*b[i];return sum;},[y0,...U]=response;
  const S=B.map((v,k)=>v-dot(D[Math.floor(k/6)],U[k%6]));
  const rhs=new Float64Array(6);
  for(let i=0;i<6;i++)rhs[i]=-s.residual[nc+i]-dot(D[i],y0);
  const dNu=denseSolve(S,rhs),y=new Float64Array(n);
  for(let i=0;i<n;i++) {
    let sum=0;for(let j=0;j<U.length;j++)sum+=U[j][i]*dNu[j];
    y[i]=y0[i]-sum;
  }
  const result=new Float64Array(nc+6+active.length+nb);
  result.set(y.subarray(0,nc));result.set(dNu,nc);
  for(let i=0;i<active.length;i++)result[nc+6+i]=y[nc+active[i]];
  result.set(y.subarray(nc+nh),nc+6+active.length);
  return result;
}
