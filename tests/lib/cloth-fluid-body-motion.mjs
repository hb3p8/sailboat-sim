// Общий проверочный шаг: декартовы узлы ткани и шесть скоростей тела/воды.
// Newton решает все реакции внутри шага. Прежние решатели не изменяются.
import {IMPLICIT_TOLERANCES} from './cloth-implicit-motion.mjs';
import {finiteArray,checkRotation,cayleyBodyPose,cross3,dotN,rotate3,transpose3,denseSolve} from './cloth-fluid-inertia.mjs';
const add=(a,b)=>a.map((v,d)=>v+b[d]),sub=(a,b)=>a.map((v,d)=>v-b[d]);
const point=(p,i)=>Array.from(p.slice(3*i,3*i+3));

export class FluidBodyEnergyMotion {
  constructor({positions,mass,constraints,body,velocityMS,dampingHz=6}) {
    if(positions?.length!==3*mass?.length||!Array.from(mass).every(v=>Number.isFinite(v)&&v>0)||
        !Array.from(positions).every(Number.isFinite)||!Array.isArray(constraints)||
        !(Number.isFinite(dampingHz)&&dampingHz>=0)||!finiteArray(body?.originM,3)||
        !finiteArray(body?.velocity6,6)||!finiteArray(body?.inertia?.matrix6,36)||
        !Array.isArray(body.attachments)||new Set(body.attachments).size!==body.attachments.length||
        body.attachments.some(i=>!Number.isInteger(i)||i<0||i>=mass.length)||body.frame!=='body-cg')
      throw new Error('Некорректная постановка общего тела, воды и ткани');
    checkRotation(body.orientation9);
    this.pos=Float64Array.from(positions);this.mass=Float64Array.from(mass);
    this.vel=velocityMS?Float64Array.from(velocityMS):new Float64Array(this.pos.length);
    if(!finiteArray(this.vel,this.pos.length))throw new Error('Некорректная скорость ткани');
    this.constraints=constraints.map(c=>({...c,lambda:0}));
    if(this.constraints.some(c=>!(Number.isFinite(c.alpha)&&c.alpha>=0)||typeof c.value!=='function'||(c.alpha>0&&c.unilateral)))
      throw new Error('Некорректный материал или связь');
    this.soft=this.constraints.filter(c=>c.alpha>0);this.hard=this.constraints.filter(c=>c.alpha===0);
    this.body={originM:Array.from(body.originM),orientation9:Array.from(body.orientation9),velocity6:Array.from(body.velocity6)};
    this.inertia=body.inertia;this.dampingHz=dampingHz;
    this.bindings=body.attachments.map(node=>Object.freeze({node,
      localM:Object.freeze(rotate3(transpose3(body.orientation9),sub(point(this.pos,node),body.originM)))}));
    this.bindings=Object.freeze(this.bindings);this.lastMu=new Float64Array(this.hard.length+3*this.bindings.length);
    this.tolerances=IMPLICIT_TOLERANCES;
  }

  validateState() {
    checkRotation(this.body.orientation9);
    if(!finiteArray(this.pos,3*this.mass.length)||!finiteArray(this.vel,this.pos.length)||
        !finiteArray(this.body.originM,3)||!finiteArray(this.body.velocity6,6))throw new Error('Неконечное состояние общего шага');
    for(const {node,localM} of this.bindings) {
      const target=add(this.body.originM,rotate3(this.body.orientation9,localM));
      if(Math.max(...sub(point(this.pos,node),target).map(Math.abs))>this.tolerances.lengthToleranceM)
        throw new Error('Крепление переставлено вне общего шага');
    }
  }

  state(z,old,load,h,active) {
    const nc=this.pos.length,q=z.slice(0,nc),nu=Array.from(z.slice(nc,nc+6));
    const pose=cayleyBodyPose(old.body.originM,old.body.orientation9,nu,h);
    const RT=transpose3(pose.averageRotation9),oldRT=transpose3(old.body.orientation9);
    const deltaNu=sub(nu,old.body.velocity6),inertial=this.inertia.momentum(deltaNu).map(v=>v/h);
    const convective=this.inertia.convective(nu),external=[...rotate3(RT,load.forceN),...rotate3(oldRT,load.momentNm)];
    const clothResidual=new Float64Array(nc),materialGradient=new Float64Array(nc),hardForce=new Float64Array(nc);
    let softEnergyJ=0;
    const decay=Math.exp(-this.dampingHz*h),dampingForce=new Float64Array(nc);
    for(let k=0;k<nc;k++) {
      const m=this.mass[Math.floor(k/3)];dampingForce[k]=m*(decay-1)*old.vel[k]/h;
      clothResidual[k]=m*((q[k]-old.pos[k])/h-old.vel[k])/h-load.clothForceN[k]-dampingForce[k];
    }
    for(const c of this.soft) {
      const {C,grad}=c.value(q);softEnergyJ+=.5*C*C/c.alpha;
      for(const [i,g] of grad)for(let d=0;d<3;d++)materialGradient[3*i+d]+=C*g[d]/c.alpha;
    }
    const constraintResidual=[],mu=new Float64Array(this.lastMu.length);
    let maxLengthM=0,dualViolationN=0,complementarityJ=0;
    for(let j=0;j<this.hard.length;j++) {
      const c=this.hard[j],{C,grad}=c.value(q),a=active.indexOf(j),value=a<0?0:z[nc+6+a];mu[j]=value;
      maxLengthM=Math.max(maxLengthM,c.unilateral?Math.max(0,C):Math.abs(C));
      if(a>=0)constraintResidual.push(C);
      for(const [i,g] of grad)for(let d=0;d<3;d++)hardForce[3*i+d]-=value*g[d];
      if(c.unilateral){dualViolationN=Math.max(dualViolationN,-value);complementarityJ=Math.max(complementarityJ,Math.abs(value*C));}
    }
    const bodyForceN=[0,0,0],bodyMomentNm=[0,0,0],attachmentForceN=new Float64Array(nc);
    for(let b=0;b<this.bindings.length;b++) {
      const {node,localM}=this.bindings[b],lever=rotate3(pose.averageRotation9,localM);
      const reaction=Array.from(z.slice(nc+6+active.length+3*b,nc+6+active.length+3*b+3));
      const target=add(pose.originM,rotate3(pose.orientation9,localM)),C=sub(point(q,node),target);
      maxLengthM=Math.max(maxLengthM,...C.map(Math.abs));constraintResidual.push(...C);
      mu.set(reaction,this.hard.length+3*b);attachmentForceN.set(reaction.map(v=>-v),3*node);
      for(let d=0;d<3;d++) {clothResidual[3*node+d]+=reaction[d];bodyForceN[d]+=reaction[d];}
      const torque=cross3(lever,reaction);for(let d=0;d<3;d++)bodyMomentNm[d]+=torque[d];
    }
    for(let k=0;k<nc;k++)clothResidual[k]+=materialGradient[k]-hardForce[k];
    const interfaceLoad=[...rotate3(RT,bodyForceN),...rotate3(oldRT,bodyMomentNm)];
    const bodyResidual=inertial.map((v,d)=>v+convective[d]-external[d]-interfaceLoad[d]);
    const bodyForceEquivalent=bodyResidual.map((v,d)=>d<3?v:v/this.inertia.referenceLengthM);
    const maxForceN=Math.max(0,...clothResidual.map(Math.abs),...bodyForceEquivalent.map(Math.abs));
    const residual=Float64Array.from([...clothResidual,...bodyForceEquivalent,
      ...constraintResidual.map(v=>v*this.tolerances.forceToleranceN/this.tolerances.lengthToleranceM)]);
    if(!residual.every(Number.isFinite)||!Number.isFinite(softEnergyJ))throw new Error('Переполнение общего остатка');
    return {q,nu,pose,mu,residual,clothResidual,bodyResidual,convective,external,interfaceLoad,
      maxForceN,maxLengthM,dualViolationN,complementarityJ,materialGradient,hardForce,dampingForce,
      bodyForceN,bodyMomentNm,attachmentForceN,softEnergyJ};
  }

  step(load,h,passes=80) {
    this.validateState();
    if(load?.frame!=='inertial-cartesian-cg'||!finiteArray(load.clothForceN,this.pos.length)||
        !finiteArray(load.forceN,3)||!finiteArray(load.momentNm,3)||!(Number.isFinite(h)&&h>0)||
        !Number.isInteger(passes)||passes<1)throw new Error('Некорректная нагрузка или шаг тела с водой');
    const old={pos:this.pos.slice(),vel:this.vel.slice(),body:structuredClone(this.body)};
    let active=this.hard.flatMap((c,j)=>!c.unilateral||this.lastMu[j]>this.tolerances.dualToleranceN?[j]:[]);
    let state,z,iterations=0;
    for(let set=0;set<4*this.hard.length+10;set++) {
      const nc=this.pos.length,seed=state;
      z=Float64Array.from([...(seed?seed.q:old.pos),...(seed?seed.nu:old.body.velocity6),
        ...active.map(j=>(seed?.mu??this.lastMu)[j]),...Array.from((seed?.mu??this.lastMu).slice(this.hard.length))]);
      state=this.state(z,old,load,h,active);
      for(let iteration=0;iteration<=passes;iteration++) {
        // Отрицательная реакция односторонней связи удаляется после решения
        // равенств. Здесь она не мешает Newton закончить этот набор связей.
        const activeLength=Math.max(0,...state.residual.slice(nc+6).map(v=>Math.abs(v)*this.tolerances.lengthToleranceM/this.tolerances.forceToleranceN));
        if(state.maxForceN<=this.tolerances.forceToleranceN&&activeLength<=this.tolerances.lengthToleranceM)break;
        if(iteration===passes)throw new Error('Общий шаг воды и ткани не доведён за заданное число попыток');
        const n=z.length,J=new Float64Array(n*n);
        for(let j=0;j<n;j++) {
          const delta=2e-6*Math.max(1,Math.abs(z[j])),plus=z.slice(),minus=z.slice();plus[j]+=delta;minus[j]-=delta;
          const rp=this.state(plus,old,load,h,active).residual,rm=this.state(minus,old,load,h,active).residual;
          for(let i=0;i<n;i++)J[i*n+j]=(rp[i]-rm[i])/(2*delta);
        }
        const direction=denseSolve(J,state.residual.map(v=>-v)),norm=dotN(state.residual,state.residual);
        let accepted=false;
        for(let line=0;line<24;line++) {
          const fraction=2**-line,next=z.map((v,j)=>v+fraction*direction[j]);let trial;
          try {trial=this.state(next,old,load,h,active);} catch {continue;}
          if(dotN(trial.residual,trial.residual)<norm*(1-1e-4*fraction)) {z=next;state=trial;accepted=true;break;}
        }
        if(!accepted)throw new Error('Не найден убывающий общий шаг воды и ткани');
        iterations++;
      }
      let remove=-1;
      for(const j of active)if(this.hard[j].unilateral&&state.mu[j]<-this.tolerances.dualToleranceN&&
          (remove<0||state.mu[j]<state.mu[remove]))remove=j;
      if(remove>=0){active=active.filter(j=>j!==remove);continue;}
      let include=-1,worst=this.tolerances.lengthToleranceM;
      this.hard.forEach((c,j)=>{if(c.unilateral&&!active.includes(j)){const {C}=c.value(state.q);if(C>worst){worst=C;include=j;}}});
      if(include>=0){active.push(include);continue;}
      if(state.maxLengthM>this.tolerances.lengthToleranceM||state.dualViolationN>this.tolerances.dualToleranceN||
          state.complementarityJ>this.tolerances.complementarityToleranceJ)throw new Error('Не выполнены условия кромок общего шага');
      const audit=this.audit(state,old,load,h,iterations);checkRotation(state.pose.orientation9);
      const softLambdas=this.soft.map(c=>-h*h*c.value(state.q).C/c.alpha);
      this.pos.set(state.q);this.vel.set(state.q.map((v,k)=>(v-old.pos[k])/h));
      this.body={originM:state.pose.originM.slice(),orientation9:state.pose.orientation9.slice(),velocity6:state.nu.slice()};
      this.lastMu=state.mu.slice();this.soft.forEach((c,j)=>{c.lambda=softLambdas[j];});
      this.hard.forEach((c,j)=>{c.lambda=-h*h*state.mu[j];});
      return audit;
    }
    throw new Error('Не сошёлся выбор кромок общего шага');
  }

  audit(s,old,load,h,iterations) {
    let before=this.inertia.kineticJ(old.body.velocity6),after=this.inertia.kineticJ(s.nu);
    let inertiaIncrementJ=.5*dotN(sub(s.nu,old.body.velocity6),this.inertia.momentum(sub(s.nu,old.body.velocity6)));
    let softBeforeJ=0;for(const c of this.soft)softBeforeJ+=.5*c.value(old.pos).C**2/c.alpha;
    const bodyExternalWorkJ=h*dotN(s.nu,s.external),bodyWorkJ=h*dotN(s.nu,s.interfaceLoad);
    let clothWorkJ=0,dampingWorkJ=0,hardWorkJ=0,attachmentWorkJ=0,materialGradientWorkJ=0;
    for(let k=0;k<s.q.length;k++) {
      const displacement=s.q[k]-old.pos[k],v=displacement/h,m=this.mass[Math.floor(k/3)];
      before+=.5*m*old.vel[k]**2;after+=.5*m*v*v;inertiaIncrementJ+=.5*m*(v-old.vel[k])**2;
      clothWorkJ+=load.clothForceN[k]*displacement;dampingWorkJ+=s.dampingForce[k]*displacement;
      hardWorkJ+=s.hardForce[k]*displacement;attachmentWorkJ+=s.attachmentForceN[k]*displacement;
      materialGradientWorkJ+=s.materialGradient[k]*displacement;
    }
    const workJ=bodyExternalWorkJ+clothWorkJ,kineticChangeJ=after-before,softChangeJ=s.softEnergyJ-softBeforeJ;
    const materialIncrementJ=materialGradientWorkJ-softChangeJ;
    const bodyWorkCancellationResidualJ=bodyWorkJ+attachmentWorkJ;
    const discreteBalanceResidualJ=kineticChangeJ+softChangeJ-workJ-dampingWorkJ-hardWorkJ+
      inertiaIncrementJ+materialIncrementJ-bodyWorkCancellationResidualJ;
    const deltaBody=sub(s.nu,old.body.velocity6),bodyResidualWorkJ=h*dotN(s.nu,s.bodyResidual);
    let residualIdentityJ=bodyResidualWorkJ,workLimitJ=0;
    for(let k=0;k<s.q.length;k++) {
      const displacement=s.q[k]-old.pos[k];residualIdentityJ+=s.clothResidual[k]*displacement;
      workLimitJ+=this.tolerances.forceToleranceN*Math.abs(displacement);
    }
    workLimitJ+=h*this.tolerances.forceToleranceN*s.nu.reduce((sum,v,d)=>sum+Math.abs(v)*(d<3?1:this.inertia.referenceLengthM),0);
    workLimitJ+=128*Number.EPSILON*Math.max(1,Math.abs(before),Math.abs(after),Math.abs(workJ),Math.abs(inertiaIncrementJ),Math.abs(materialGradientWorkJ));
    const interfaceWorkLimitJ=2*this.tolerances.lengthToleranceM*this.bindings.reduce((sum,{node})=>
      sum+point(s.attachmentForceN,node).reduce((q,v)=>q+Math.abs(v),0),0)+
      128*Number.EPSILON*Math.max(1,Math.abs(bodyWorkJ),Math.abs(attachmentWorkJ));
    return {solver:{method:'общее уравнение обобщённой инерции и ткани',converged:true,iterations,linearBackend:'reference-dense',
        ...this.tolerances},maxPhysicalResidualN:s.maxForceN,maxHardViolationM:s.maxLengthM,
      dualViolationN:s.dualViolationN,complementarityJ:s.complementarityJ,
      bodyOriginM:s.pose.originM.slice(),bodyRotation9:s.pose.orientation9.slice(),bodyVelocity6:s.nu.slice(),
      bodyFrame:'body-cg',bodyResidual6:s.bodyResidual.slice(),clothNodeResidualN:s.clothResidual.slice(),
      bodyForceN:s.bodyForceN.slice(),bodyMomentNm:s.bodyMomentNm.slice(),bodyAttachmentForceN:s.attachmentForceN.slice(),
      initialKineticJ:before,kineticJ:after,softEnergyJ:s.softEnergyJ,workJ,clothWorkJ,bodyExternalWorkJ,dampingWorkJ,hardWorkJ,
      inertiaIncrementJ,materialIncrementJ,discreteBalanceResidualJ,residualIdentityJ,workLimitJ,
      bodyWorkJ,attachmentWorkJ,bodyWorkCancellationResidualJ,interfaceWorkLimitJ,
      convectivePowerW:dotN(s.nu,s.convective),bodyIncrementVelocity6:deltaBody};
  }
}
