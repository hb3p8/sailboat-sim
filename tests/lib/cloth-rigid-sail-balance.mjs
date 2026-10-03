// Независимый баланс всех физических масс по двум положениям и входным
// силам. Не читает предсказание решателя или его измеритель реакции.
import {IMPLICIT_TOLERANCES as tol} from './cloth-implicit-motion.mjs';
const point=(p,i)=>Array.from(p.slice(3*i,3*i+3));
const sub=(a,b)=>a.map((v,d)=>v-b[d]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

export function rigidSailBalance(m,a,old,prior,priorDt,force) {
  const h=a.hS,dt=priorDt||h,residual=new Float64Array(m.pos.length);
  const linearNs=[0,0,0],angularNms=[0,0,0],bodyAngularNms=[0,0,0],bodyIncrementNms=[0,0,0];
  let leverSum=0,linearConstraintForce=0,displacementSum=0,identityJ=0,bodyMomentLimitNms=1e-9;
  const bodyNodes=new Set(m.rigidBody.nodes),M=a.bodyProperties.totalMassKg;
  const oldOrigin=[0,0,0],oldVelocity=[0,0,0];
  for(const i of bodyNodes)for(let d=0;d<3;d++) {
    oldOrigin[d]+=m.mass[i]*old[3*i+d]/M;
    oldVelocity[d]+=m.mass[i]*(old[3*i+d]-prior[3*i+d])/(M*dt);
  }
  for(let i=0;i<m.mass.length;i++) {
    const p=point(m.pos,i),p0=point(old,i),v=p.map((x,d)=>(x-p0[d])/h);
    const v0=p0.map((x,d)=>(x-prior[3*i+d])/dt),dp=v.map((x,d)=>m.mass[i]*(x-v0[d]));
    const decay=m.decayAtNode(i,h,Math.exp(-m.dampingHz*h));
    const f=point(force,i).map((x,d)=>x+m.mass[i]*(decay-1)*v0[d]/h);
    const deltaL=sub(cross(p,v.map(x=>m.mass[i]*x)),cross(p0,v0.map(x=>m.mass[i]*x)));
    const increment=cross(sub(p,p0),dp),torque=cross(p,f);
    leverSum+=p.reduce((s,x)=>s+Math.abs(x),0);
    for(let d=0;d<3;d++) {
      residual[3*i+d]=dp[d]/h-f[d];
      linearNs[d]+=dp[d]-h*f[d];angularNms[d]+=deltaL[d]+increment[d]-h*torque[d];
    }
    if(bodyNodes.has(i)) {
      const r=sub(p,a.bodyOriginM),r0=sub(p0,oldOrigin);
      const rv=sub(v,a.bodyProperties.velocityMS),rv0=sub(v0,oldVelocity);
      const drp=rv.map((x,d)=>m.mass[i]*(x-rv0[d]));
      const inc=cross(sub(r,r0),drp);
      const dL=sub(cross(r,rv.map(x=>m.mass[i]*x)),cross(r0,rv0.map(x=>m.mass[i]*x)));
      const interfaceTorque=cross(r,point(a.bodyNodeInterfaceForceN,i));
      const weightSum=m.rigidBody.bindings.reduce((s,b)=>s+Math.abs(b.weights.find(([node])=>node===i)[1]),0);
      bodyMomentLimitNms+=h*(1+weightSum)*tol.forceToleranceN*r.reduce((s,x)=>s+Math.abs(x),0);
      for(let d=0;d<3;d++) {
        bodyIncrementNms[d]+=inc[d];bodyAngularNms[d]+=dL[d]+inc[d]-h*interfaceTorque[d];
      }
    }
  }
  for(const c of m.constraints) {
    const {C,grad}=c.value(m.pos),coefficient=c.alpha>0?C/c.alpha:-c.lambda/(h*h);
    for(const [i,g] of grad)for(let d=0;d<3;d++)residual[3*i+d]+=coefficient*g[d];
  }
  for(const c of m.geometryConstraints)if(c.family!=='жёсткое тело')
    linearConstraintForce+=Math.abs(c.lambda/(h*h))*c.value(m.pos).grad.reduce((s,[,g])=>s+g.reduce((q,v)=>q+Math.abs(v),0),0);
  for(let k=0;k<m.pos.length;k++) {
    const delta=m.pos[k]-old[k];displacementSum+=Math.abs(delta);identityJ+=residual[k]*delta;
  }
  const energyScale=['initialKineticJ','kineticJ','initialSoftEnergyJ','softEnergyJ','appliedWorkJ','dampingWorkJ',
    'hardWorkEstimateJ','supportWorkJ','inertiaIncrementJ','materialIncrementJ'].reduce((s,k)=>s+Math.abs(a[k]),0);
  let workLimitJ=1e-9;
  for(const {node} of m.rigidBody.bindings)workLimitJ+=2*tol.lengthToleranceM*
    point(a.bodyAttachmentForceN,node).reduce((s,v)=>s+Math.abs(v),0);
  return {linearNs,angularNms,bodyAngularNms,bodyIncrementNms,identityJ,
    maxNodeResidualN:Math.max(...residual.map(Math.abs)),
    energyLimitJ:tol.forceToleranceN*displacementSum+16*m.pos.length*Number.EPSILON*energyScale,
    linearLimitNs:m.mass.length*tol.forceToleranceN*h+1e-9,
    angularLimitNms:h*(tol.forceToleranceN*leverSum+tol.lengthToleranceM*linearConstraintForce)+1e-9,bodyMomentLimitNms,
    workLimitJ};
}
