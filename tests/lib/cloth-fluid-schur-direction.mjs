// Разреженный блок ткани и малое дополнение шести скоростей тела/воды.
// Приближена только матрица направления (Gauss–Newton), не общий остаток.
import {gridDissection,sparsePattern} from './cloth-sparse-solve.mjs';
import {cross3,rotate3,transpose3,denseSolve} from './cloth-fluid-inertia.mjs';

const coordinates=grad=>{
  const out=new Map();
  for(const [node,g] of grad)for(let d=0;d<3;d++)out.set(3*node+d,(out.get(3*node+d)??0)+g[d]);
  return Array.from(out);
};

export function fluidSchurDirection(m,z,s,old,load,h,active,{exact=false}={}) {
  const nc=m.pos.length,nh=m.hard.length,nb=3*m.bindings.length,n=nc+nh+nb;
  const soft=m.soft.map(c=>({c,g:coordinates(c.value(s.q).grad)}));
  const hard=m.hard.map(c=>({...c.value(s.q)}));
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
    const compile=g=>{
      const entries=[];
      for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++) {
        const i=p.inverse[g[a][0]],j=p.inverse[g[b][0]];
        entries.push(p.locations[Math.max(i,j)].get(Math.min(i,j)));
      }
      return {coordinates:Int32Array.from(g,([i])=>i),entries:Int32Array.from(entries)};
    };
    m.fluidAssembly={soft:soft.map(({g})=>compile(g)),hard:hg.map(compile)};
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
    for(const {c,g,plan,weight,soft:isSoft} of terms) {
      checkPlan(g,plan);
      const size=g.length,H=new Float64Array(size*size);
      for(let j=0;j<size;j++) {
        const k=g[j][0],delta=2e-6*Math.max(1,Math.abs(s.q[k])),plus=s.q.slice(),minus=s.q.slice();
        plus[k]+=delta;minus[k]-=delta;
        const vp=c.value(plus),vm=c.value(minus),gp=new Map(coordinates(vp.grad)),gm=new Map(coordinates(vm.grad));
        for(let i=0;i<size;i++)H[i*size+j]=weight*((isSoft?vp.C:1)*gp.get(g[i][0])-
          (isSoft?vm.C:1)*gm.get(g[i][0]))/(2*delta);
      }
      let entry=0;
      for(let a=0;a<size;a++)for(let b=0;b<=a;b++)matrix[plan.entries[entry++]]+=.5*(H[a*size+b]+H[b*size+a]);
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

  // Только шесть производных скоростей. Ткань в общем остатке от nu не зависит;
  // E хранит производные положения закреплений, B — настоящего уравнения тела.
  const B=new Float64Array(36),E=Array.from({length:6},()=>new Float64Array(n));
  for(let j=0;j<6;j++) {
    const delta=2e-6*Math.max(1,Math.abs(s.nu[j])),plus=s.nu.slice(),minus=s.nu.slice();
    plus[j]+=delta;minus[j]-=delta;
    const reactions=z.slice(nc+6+active.length),rp=m.bodyState(plus,old,load,h,reactions),rm=m.bodyState(minus,old,load,h,reactions);
    for(let d=0;d<6;d++)B[6*d+j]=(rp.bodyResidual[d]-rm.bodyResidual[d])/(2*delta)/(d<3?1:m.inertia.referenceLengthM);
    for(let d=0;d<nb;d++)E[j][nc+nh+d]=-(rp.targets[Math.floor(d/3)][d%3]-rm.targets[Math.floor(d/3)][d%3])/(2*delta);
  }
  // D зависит только от реакций креплений: мировая сила и момент по середине плеча.
  const D=Array.from({length:6},()=>new Float64Array(n)),RT=transpose3(s.pose.averageRotation9),oldRT=transpose3(old.body.orientation9);
  m.bindings.forEach(({localM},b)=>{
    const lever=rotate3(s.pose.averageRotation9,localM);
    for(let d=0;d<3;d++) {
      const e=[0,0,0];e[d]=1;
      const column=[...rotate3(RT,e),...rotate3(oldRT,cross3(lever,e))];
      column.forEach((v,i)=>{D[i][nc+nh+3*b+d]=-v/(i<3?1:m.inertia.referenceLengthM);});
    }
  });
  const permute=v=>Float64Array.from({length:n},(_,i)=>v[p.order[i]]);
  let response;
  if(n) {
    const solve=m.wasmSparseFactor.ldl(matrix,p,signs);
    try {response=solve.many([permute(rK.map(v=>-v)),...E.map(permute)]).map(v=>
      Float64Array.from({length:n},(_,i)=>v[p.inverse[i]]));} finally {solve.release();}
  } else response=Array.from({length:7},()=>new Float64Array(0));
  const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0),[y0,...U]=response;
  const S=B.map((v,k)=>v-dot(D[Math.floor(k/6)],U[k%6]));
  const rhs=Float64Array.from({length:6},(_,i)=>-s.residual[nc+i]-dot(D[i],y0));
  const dNu=denseSolve(S,rhs),y=y0.map((v,i)=>v-U.reduce((sum,u,j)=>sum+u[i]*dNu[j],0));
  return Float64Array.from([...y.slice(0,nc),...dNu,...active.map(j=>y[nc+j]),...y.slice(nc+nh)]);
}
