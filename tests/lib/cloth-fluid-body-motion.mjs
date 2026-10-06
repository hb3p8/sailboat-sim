// Общий проверочный шаг: декартовы узлы ткани и шесть скоростей тела/воды.
// Newton решает все реакции внутри шага. Прежние решатели не изменяются.
import {IMPLICIT_TOLERANCES} from './cloth-implicit-motion.mjs';
import {finiteArray,checkRotation,cayleyBodyPose,cross3,dotN,rotate3,transpose3,denseSolve} from './cloth-fluid-inertia.mjs';
import {fluidSchurDirection} from './cloth-fluid-schur-direction.mjs';
import {bodyRopes,ropeValue} from './cloth-body-rope.mjs';
const add=(a,b)=>a.map((v,d)=>v+b[d]),sub=(a,b)=>a.map((v,d)=>v-b[d]);
const point=(p,i)=>Array.from(p.slice(3*i,3*i+3));

export class FluidBodyEnergyMotion {
  constructor({positions,mass,constraints,body,velocityMS,dampingHz=6,
      linearBackend='reference-dense',wasmSparseFactor,assemblyKernel,gridRows,gridCols,newtonCorrection=true,ropes=[]}) {
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
    this.ropes=bodyRopes(ropes,mass.length);this.ropeLengthsM=Float64Array.from(this.ropes,r=>r.lengthM);
    this.ropeHardStart=this.constraints.filter(c=>c.alpha===0).length;
    this.constraints.push(...this.ropes.map((r,i)=>({alpha:0,unilateral:true,lambda:0,ropeIndex:i,
      value:(q,context)=>ropeValue(r,q,context.pose,context.ropeLengthsM[i])})));
    this.soft=this.constraints.filter(c=>c.alpha>0);this.hard=this.constraints.filter(c=>c.alpha===0);
    this.body={originM:Array.from(body.originM),orientation9:Array.from(body.orientation9),velocity6:Array.from(body.velocity6)};
    this.inertia=body.inertia;this.dampingHz=dampingHz;
    this.bindings=body.attachments.map(node=>Object.freeze({node,
      localM:Object.freeze(rotate3(transpose3(body.orientation9),sub(point(this.pos,node),body.originM)))}));
    this.bindings=Object.freeze(this.bindings);this.lastMu=new Float64Array(this.hard.length+3*this.bindings.length);
    this.tolerances=IMPLICIT_TOLERANCES;
    if(typeof newtonCorrection!=='boolean'||!['reference-dense','schur-wasm'].includes(linearBackend)||
        (linearBackend==='schur-wasm'&&typeof wasmSparseFactor?.ldl!=='function')||
        (assemblyKernel!==undefined&&(linearBackend!=='schur-wasm'||typeof assemblyKernel?.compile!=='function'))||
        ((gridRows!=null||gridCols!=null)&&(!Number.isInteger(gridRows)||gridRows<=0||
          !Number.isInteger(gridCols)||gridCols<=0||gridRows*gridCols!==mass.length)))
      throw new Error('Неизвестный или не загруженный способ общего решения либо сетка');
    Object.assign(this,{linearBackend,wasmSparseFactor,gridRows,gridCols,newtonCorrection});
    if(assemblyKernel!==undefined)this.assemblyKernel=assemblyKernel;
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
    if(!finiteArray(this.ropeLengthsM,this.ropes.length)||this.ropeLengthsM.some(v=>v<=0))
      throw new Error('Некорректная сохранённая длина верёвки');
    for(let i=0;i<this.ropes.length;i++)if(ropeValue(this.ropes[i],this.pos,this.body,this.ropeLengthsM[i]).C>
        this.tolerances.lengthToleranceM)throw new Error('Верёвка переставлена вне общего шага');
  }

  bodyState(nu,old,load,h,reactions,q,mu) {
    const pose=cayleyBodyPose(old.body.originM,old.body.orientation9,nu,h);
    const RT=transpose3(pose.averageRotation9),oldRT=transpose3(old.body.orientation9);
    const deltaNu=sub(nu,old.body.velocity6),inertial=this.inertia.momentum(deltaNu).map(v=>v/h);
    const convective=this.inertia.convective(nu),external=[...rotate3(RT,load.forceN),...rotate3(oldRT,load.momentNm)];
    const bodyForceN=[0,0,0],bodyMomentNm=[0,0,0],targets=[];
    this.bindings.forEach(({localM},b)=>{
      const lever=rotate3(pose.averageRotation9,localM),reaction=Array.from(reactions.slice(3*b,3*b+3));
      targets.push(add(pose.originM,rotate3(pose.orientation9,localM)));
      for(let d=0;d<3;d++)bodyForceN[d]+=reaction[d];
      const torque=cross3(lever,reaction);for(let d=0;d<3;d++)bodyMomentNm[d]+=torque[d];
    });
    let ropeState;
    if(this.ropes.length) {
      const bindingInterfaceLoad=[...rotate3(RT,bodyForceN),...rotate3(oldRT,bodyMomentNm)];
      const ropeLengthsM=load.ropeLengthsM??this.ropeLengthsM;
      const ropeValues=this.ropes.map((r,i)=>ropeValue(r,q,pose,ropeLengthsM[i]));
      const ropeForceN=[0,0,0],ropeMomentNm=[0,0,0];
      const ropeReactions=this.ropes.map((r,i)=>{
        const force=ropeValues[i].direction.map(v=>v*mu[this.ropeHardStart+i]);
        const torque=cross3(rotate3(pose.averageRotation9,r.localM),force);
        for(let d=0;d<3;d++){ropeForceN[d]+=force[d];ropeMomentNm[d]+=torque[d];bodyForceN[d]+=force[d];bodyMomentNm[d]+=torque[d];}
        return {bodyForceN:force,bodyMomentNm:torque,interfaceLoad:[...rotate3(RT,force),...rotate3(oldRT,torque)]};
      });
      ropeState={ropeValues,ropeReactions,ropeLengthsM,bindingInterfaceLoad,
        ropeInterfaceLoad:[...rotate3(RT,ropeForceN),...rotate3(oldRT,ropeMomentNm)]};
    }
    const interfaceLoad=[...rotate3(RT,bodyForceN),...rotate3(oldRT,bodyMomentNm)];
    const bodyResidual=inertial.map((v,d)=>v+convective[d]-external[d]-interfaceLoad[d]);
    return {nu,pose,convective,external,interfaceLoad,bodyResidual,bodyForceN,bodyMomentNm,targets,...ropeState};
  }

  hardValue(c,q,context) {return c.ropeIndex==null?c.value(q):c.value(q,context);}

  readSoft(q) {
    // Каждое промежуточное состояние владеет своими градиентами. Неудачный
    // поиск шага не меняет уже рассчитанный остаток или его направление.
    const samples=[],buffered=c=>typeof c.valueInto==='function'&&Array.isArray(c.gradientNodes);
    const sample=c=>({nodes:c.gradientNodes.slice(),values:new Float64Array(3*c.gradientNodes.length)});
    for(let j=0;j<this.soft.length;) {
      const c=this.soft[j],group=c.gradientGroup,block=group?.size>1?this.soft.slice(j,j+group.size):[c];
      if(group&&block.length===group.size&&block.every((v,k)=>v.gradientGroup===group&&v.gradientSlot===k&&buffered(v))) {
        const values=block.map(sample),C=group.valueInto(q,values.map(v=>v.values));
        values.forEach((v,k)=>{v.C=C[k];samples.push(v);});j+=block.length;
      } else if(buffered(c)) {
        const v=sample(c);v.C=c.valueInto(q,v.values);samples.push(v);j++;
      } else {samples.push(c.value(q));j++;}
    }
    return samples;
  }

  state(z,old,load,h,active) {
    const nc=this.pos.length,q=z.slice(0,nc),nu=Array.from(z.slice(nc,nc+6));
    const mu=new Float64Array(this.lastMu.length);
    active.forEach((j,a)=>{mu[j]=z[nc+6+a];});
    const body=this.bodyState(nu,old,load,h,z.slice(nc+6+active.length),q,mu);
    const clothResidual=new Float64Array(nc),materialGradient=new Float64Array(nc),hardForce=new Float64Array(nc);
    let softEnergyJ=0;
    const decay=Math.exp(-this.dampingHz*h),dampingForce=new Float64Array(nc);
    for(let k=0;k<nc;k++) {
      const m=this.mass[Math.floor(k/3)];dampingForce[k]=m*(decay-1)*old.vel[k]/h;
      clothResidual[k]=m*((q[k]-old.pos[k])/h-old.vel[k])/h-load.clothForceN[k]-dampingForce[k];
    }
    const softValues=this.readSoft(q);
    for(let j=0;j<this.soft.length;j++) {
      const c=this.soft[j],{C,grad,nodes,values}=softValues[j];softEnergyJ+=.5*C*C/c.alpha;
      if(values)for(let k=0;k<nodes.length;k++)for(let d=0;d<3;d++)materialGradient[3*nodes[k]+d]+=C*values[3*k+d]/c.alpha;
      else for(const [i,g] of grad)for(let d=0;d<3;d++)materialGradient[3*i+d]+=C*g[d]/c.alpha;
    }
    const constraintResidual=[];
    let maxLengthM=0,dualViolationN=0,complementarityJ=0;
    for(let j=0;j<this.hard.length;j++) {
      const c=this.hard[j],{C,grad}=this.hardValue(c,q,body),a=active.indexOf(j),value=mu[j];
      maxLengthM=Math.max(maxLengthM,c.unilateral?Math.max(0,C):Math.abs(C));
      if(a>=0)constraintResidual.push(C);
      for(const [i,g] of grad)for(let d=0;d<3;d++)hardForce[3*i+d]-=value*g[d];
      if(c.unilateral){dualViolationN=Math.max(dualViolationN,-value);complementarityJ=Math.max(complementarityJ,Math.abs(value*C));}
    }
    const attachmentForceN=new Float64Array(nc);
    for(let b=0;b<this.bindings.length;b++) {
      const {node}=this.bindings[b];
      const reaction=Array.from(z.slice(nc+6+active.length+3*b,nc+6+active.length+3*b+3));
      const C=sub(point(q,node),body.targets[b]);
      maxLengthM=Math.max(maxLengthM,...C.map(Math.abs));constraintResidual.push(...C);
      mu.set(reaction,this.hard.length+3*b);attachmentForceN.set(reaction.map(v=>-v),3*node);
      for(let d=0;d<3;d++)clothResidual[3*node+d]+=reaction[d];
    }
    for(let k=0;k<nc;k++)clothResidual[k]+=materialGradient[k]-hardForce[k];
    const bodyForceEquivalent=body.bodyResidual.map((v,d)=>d<3?v:v/this.inertia.referenceLengthM);
    const maxForceN=Math.max(0,...clothResidual.map(Math.abs),...bodyForceEquivalent.map(Math.abs));
    const residual=Float64Array.from([...clothResidual,...bodyForceEquivalent,
      ...constraintResidual.map(v=>v*this.tolerances.forceToleranceN/this.tolerances.lengthToleranceM)]);
    if(!residual.every(Number.isFinite)||!Number.isFinite(softEnergyJ))throw new Error('Переполнение общего остатка');
    return {q,...body,mu,residual,clothResidual,
      maxForceN,maxLengthM,dualViolationN,complementarityJ,materialGradient,hardForce,dampingForce,
      attachmentForceN,softEnergyJ,softValues};
  }

  step(load,h,passes=80) {
    this.validateState();
    if(load?.frame!=='inertial-cartesian-cg'||!finiteArray(load.clothForceN,this.pos.length)||
        !finiteArray(load.forceN,3)||!finiteArray(load.momentNm,3)||!(Number.isFinite(h)&&h>0)||
        !Number.isInteger(passes)||passes<1||
        (load.ropeLengthsM!=null&&(!finiteArray(load.ropeLengthsM,this.ropes.length)||Array.from(load.ropeLengthsM).some(v=>v<=0))))
      throw new Error('Некорректная нагрузка, команда верёвки или шаг тела с водой');
    const old={pos:this.pos.slice(),vel:this.vel.slice(),body:structuredClone(this.body),ropeLengthsM:this.ropeLengthsM.slice()};
    let active=this.hard.flatMap((c,j)=>!c.unilateral||this.lastMu[j]>this.tolerances.dualToleranceN?[j]:[]);
    let state,z,iterations=0,polishIterations=0,polishStalls=0;
    const polishFactorizationFailures=[];
    for(let set=0;set<4*this.hard.length+10;set++) {
      const nc=this.pos.length,seed=state;
      z=Float64Array.from([...(seed?seed.q:old.pos),...(seed?seed.nu:old.body.velocity6),
        ...active.map(j=>(seed?.mu??this.lastMu)[j]),...Array.from((seed?.mu??this.lastMu).slice(this.hard.length))]);
      state=this.state(z,old,load,h,active);
      let iteration=0;
      for(;iteration<=passes;iteration++) {
        // Отрицательная реакция односторонней связи удаляется после решения
        // равенств. Здесь она не мешает Newton закончить этот набор связей.
        const activeLength=Math.max(0,...state.residual.slice(nc+6).map(v=>Math.abs(v)*this.tolerances.lengthToleranceM/this.tolerances.forceToleranceN));
        const satisfied=state.maxForceN<=this.tolerances.forceToleranceN&&activeLength<=this.tolerances.lengthToleranceM;
        if(satisfied)break;
        if(iteration===passes)throw new Error('Общий шаг воды и ткани не доведён за заданное число попыток');
        const direction=this.direction(z,state,old,load,h,active),norm=dotN(state.residual,state.residual);
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
      this.hard.forEach((c,j)=>{if(c.unilateral&&!active.includes(j)){const {C}=this.hardValue(c,state.q,state);if(C>worst){worst=C;include=j;}}});
      if(include>=0){active.push(include);continue;}
      if(this.linearBackend==='schur-wasm'&&this.newtonCorrection&&iteration>0&&iteration<passes) {
        // Один точный корректор только окончательного набора натянутых кромок.
        // После уже выполненных допусков отсутствие улучшения при округлении
        // сохраняется в аудите; ни один физический допуск не ослабляется.
        let direction;
        try {direction=this.direction(z,state,old,load,h,active,{exact:true});} catch(error) {
          // Полная Hessian нелинейной энергии может быть неопределённой даже
          // при выполненном общем уравнении. Отказ вспомогательной коррекции
          // допускается только для уже проверенного физического шага.
          if(error?.code!=='CLOTH_SPARSE_FACTOR_REJECTED')throw error;
          const checked=this.audit(state,old,load,h,iterations);
          if(!(state.maxForceN<=this.tolerances.forceToleranceN&&state.maxLengthM<=this.tolerances.lengthToleranceM&&
              state.dualViolationN<=this.tolerances.dualToleranceN&&state.complementarityJ<=this.tolerances.complementarityToleranceJ&&
              Math.abs(checked.discreteBalanceResidualJ)<=checked.workLimitJ&&
              Math.abs(checked.bodyWorkCancellationResidualJ)<=checked.interfaceWorkLimitJ&&
              this.validRopeAudit(checked)))throw error;
          polishFactorizationFailures.push({pivot:error.pivot});
        }
        const norm=dotN(state.residual,state.residual);
        let accepted=false;
        for(let line=0;direction&&line<24;line++) {
          const fraction=2**-line,next=z.map((v,j)=>v+fraction*direction[j]);let trial;
          try {trial=this.state(next,old,load,h,active);} catch {continue;}
          if(dotN(trial.residual,trial.residual)<norm*(1-1e-4*fraction)) {z=next;state=trial;accepted=true;break;}
        }
        if(accepted){iterations++;polishIterations++;}else polishStalls++;
      }
      if(state.maxForceN>this.tolerances.forceToleranceN)throw new Error('Корректор не выполнил прежний допуск сил');
      if(state.maxLengthM>this.tolerances.lengthToleranceM||state.dualViolationN>this.tolerances.dualToleranceN||
          state.complementarityJ>this.tolerances.complementarityToleranceJ)throw new Error('Не выполнены условия кромок общего шага');
      const audit=this.audit(state,old,load,h,iterations);
      if(this.ropes.length&&(!(Math.abs(audit.discreteBalanceResidualJ)<=audit.workLimitJ&&
          Math.abs(audit.bodyWorkCancellationResidualJ)<=audit.interfaceWorkLimitJ)||!this.validRopeAudit(audit))) {
        const error=new Error('Не выполнен баланс работы управляемой верёвки');error.audit=audit;throw error;
      }
      if(this.linearBackend==='schur-wasm')Object.assign(audit.solver,{newtonCorrection:this.newtonCorrection,polishIterations,polishStalls});
      if(polishFactorizationFailures.length)Object.assign(audit.solver,{polishFactorizationFailures});
      checkRotation(state.pose.orientation9);
      const softLambdas=this.soft.map(c=>-h*h*c.value(state.q).C/c.alpha);
      this.pos.set(state.q);this.vel.set(state.q.map((v,k)=>(v-old.pos[k])/h));
      this.body={originM:state.pose.originM.slice(),orientation9:state.pose.orientation9.slice(),velocity6:state.nu.slice()};
      this.lastMu=state.mu.slice();this.soft.forEach((c,j)=>{c.lambda=softLambdas[j];});
      this.hard.forEach((c,j)=>{c.lambda=-h*h*state.mu[j];});
      if(this.ropes.length)this.ropeLengthsM=Float64Array.from(state.ropeLengthsM);
      return audit;
    }
    throw new Error('Не сошёлся выбор кромок общего шага');
  }

  direction(z,state,old,load,h,active,options) {
    if(this.linearBackend==='schur-wasm')return fluidSchurDirection(this,z,state,old,load,h,active,options);
    const n=z.length,J=new Float64Array(n*n);
    for(let j=0;j<n;j++) {
      const delta=2e-6*Math.max(1,Math.abs(z[j])),plus=z.slice(),minus=z.slice();plus[j]+=delta;minus[j]-=delta;
      const rp=this.state(plus,old,load,h,active).residual,rm=this.state(minus,old,load,h,active).residual;
      for(let i=0;i<n;i++)J[i*n+j]=(rp[i]-rm[i])/(2*delta);
    }
    return denseSolve(J,state.residual.map(v=>-v));
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
    let ropeAudit,ropeInterfaceResidualJ=0,bindingBodyWorkJ=bodyWorkJ;
    if(this.ropes.length) {
      bindingBodyWorkJ=h*dotN(s.nu,s.bindingInterfaceLoad);
      const records=this.ropes.map((r,i)=>{
        const value=s.ropeValues[i],initial=ropeValue(r,old.pos,old.body,old.ropeLengthsM[i]);
        const tensionN=s.mu[this.ropeHardStart+i],{bodyForceN,bodyMomentNm,interfaceLoad}=s.ropeReactions[i];
        const ropeBodyWorkJ=h*dotN(s.nu,interfaceLoad);
        const endpointWorkJ=dotN(bodyForceN,sub(value.endpointM,initial.endpointM));
        const ropeClothWorkJ=-dotN(bodyForceN,sub(point(s.q,r.node),point(old.pos,r.node)));
        const actualWorkJ=ropeBodyWorkJ+ropeClothWorkJ;
        const controlWorkJ=-tensionN*(value.lengthM-initial.lengthM);
        // При выборе направления в конце шага изменение направления и
        // выбор начального провиса дают неотрицательную численную потерю.
        const engagementLossJ=tensionN*Math.max(0,initial.lengthM-initial.distanceM);
        const turnLossJ=tensionN*Math.max(0,initial.distanceM-dotN(value.direction,initial.relativeM));
        const controlResidualJ=actualWorkJ-controlWorkJ+engagementLossJ+turnLossJ;
        const controlLimitJ=2*this.tolerances.lengthToleranceM*Math.abs(tensionN)+
          128*Number.EPSILON*Math.max(1,Math.abs(actualWorkJ),Math.abs(controlWorkJ),Math.abs(engagementLossJ),Math.abs(turnLossJ));
        // Вычитание мировых координат имеет абсолютную ошибку от самих
        // координат, даже при малом перемещении. Это оценка округления
        // операций, а не новый физический допуск или поправка силы.
        const endpointRoundoffJ=128*Number.EPSILON*bodyForceN.reduce((sum,v,d)=>
          sum+Math.abs(v)*(Math.abs(value.endpointM[d])+Math.abs(initial.endpointM[d])),0);
        ropeInterfaceResidualJ+=ropeBodyWorkJ-endpointWorkJ;
        return {node:r.node,localM:r.localM.slice(),oldLengthM:initial.lengthM,lengthM:value.lengthM,
          distanceM:value.distanceM,slackM:Math.max(0,-value.C),violationM:Math.max(0,value.C),tensionN,
          bodyForceN,bodyMomentNm,clothForceN:bodyForceN.map(v=>-v),
          bodyWorkJ:ropeBodyWorkJ,clothWorkJ:ropeClothWorkJ,actualWorkJ,controlWorkJ,
          engagementLossJ,turnLossJ,controlResidualJ,controlLimitJ,
          endpointWorkResidualJ:ropeBodyWorkJ-endpointWorkJ,endpointRoundoffJ};
      });
      // hardWork уже содержит работу верёвки на ткани. Добавляем работу
      // её другого конца; равные силы на движущихся концах не обязаны
      // давать нулевую суммарную работу при изменении длины.
      hardWorkJ+=records.reduce((sum,r)=>sum+r.bodyWorkJ,0);
      ropeAudit={ropes:records,ropeControlWorkJ:records.reduce((sum,r)=>sum+r.controlWorkJ,0),
        ropeActualWorkJ:records.reduce((sum,r)=>sum+r.actualWorkJ,0),bindingBodyWorkJ,ropeInterfaceResidualJ};
    }
    const workJ=bodyExternalWorkJ+clothWorkJ,kineticChangeJ=after-before,softChangeJ=s.softEnergyJ-softBeforeJ;
    const materialIncrementJ=materialGradientWorkJ-softChangeJ;
    const bindingCancellationResidualJ=bindingBodyWorkJ+attachmentWorkJ;
    const bodyWorkCancellationResidualJ=bindingCancellationResidualJ+ropeInterfaceResidualJ;
    const discreteBalanceResidualJ=kineticChangeJ+softChangeJ-workJ-dampingWorkJ-hardWorkJ+
      inertiaIncrementJ+materialIncrementJ-bindingCancellationResidualJ;
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
      128*Number.EPSILON*Math.max(1,Math.abs(bodyWorkJ),Math.abs(attachmentWorkJ))+
      (ropeAudit?.ropes.reduce((sum,r)=>sum+r.endpointRoundoffJ,0)??0);
    return {solver:{method:'общее уравнение обобщённой инерции и ткани',converged:true,iterations,linearBackend:this.linearBackend,
        ...this.tolerances},maxPhysicalResidualN:s.maxForceN,maxHardViolationM:s.maxLengthM,
      dualViolationN:s.dualViolationN,complementarityJ:s.complementarityJ,
      bodyOriginM:s.pose.originM.slice(),bodyRotation9:s.pose.orientation9.slice(),bodyVelocity6:s.nu.slice(),
      bodyFrame:'body-cg',bodyResidual6:s.bodyResidual.slice(),clothNodeResidualN:s.clothResidual.slice(),
      bodyForceN:s.bodyForceN.slice(),bodyMomentNm:s.bodyMomentNm.slice(),bodyAttachmentForceN:s.attachmentForceN.slice(),
      initialKineticJ:before,kineticJ:after,softEnergyJ:s.softEnergyJ,workJ,clothWorkJ,bodyExternalWorkJ,dampingWorkJ,hardWorkJ,
      inertiaIncrementJ,materialIncrementJ,discreteBalanceResidualJ,residualIdentityJ,workLimitJ,
      bodyWorkJ,attachmentWorkJ,bodyWorkCancellationResidualJ,interfaceWorkLimitJ,
      convectivePowerW:dotN(s.nu,s.convective),bodyIncrementVelocity6:deltaBody,...ropeAudit};
  }

  validRopeAudit(audit) {
    return !this.ropes.length||audit.ropes.every(r=>Number.isFinite(r.controlResidualJ)&&
      Math.abs(r.controlResidualJ)<=r.controlLimitJ);
  }
}
