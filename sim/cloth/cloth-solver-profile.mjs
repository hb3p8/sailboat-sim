// Диагностические часы. Вложенные интервалы имеют отдельное собственное время.
export class ClothSolverProfile {
  constructor(now=()=>performance.now()) {this.now=now;this.stack=[];this.reset();}
  reset() {
    if(this.stack.length)throw new Error('Нельзя обнулить незавершённое измерение ткани');
    this.stages={};
  }
  begin(name) {
    const at=this.now(),row=this.stages[name]??= {calls:0,failed:0,inclusiveMs:0,selfMs:0};
    const scope={name,row,at,childrenMs:0};this.stack.push(scope);return scope;
  }
  end(scope,failed=false) {
    const at=this.now(),index=this.stack.lastIndexOf(scope);
    if(index<0||(!failed&&index!==this.stack.length-1))throw new Error('Нарушен порядок измерителей ткани');
    // Исключение может выйти из блока до его последней отметки. Закрываем
    // такие блоки как отказы, сохраняя их стоимость внутри родителя.
    while(this.stack.length>index) {
      const current=this.stack.pop(),elapsed=at-current.at;
      current.row.calls++;current.row.failed+=Number(failed);
      current.row.inclusiveMs+=elapsed;current.row.selfMs+=elapsed-current.childrenMs;
      if(this.stack.length)this.stack.at(-1).childrenMs+=elapsed;
    }
  }
  measure(name,fn,owner,args=[]) {
    const scope=this.begin(name);let failed=true;
    try{const result=fn.apply(owner,args);failed=false;return result;}
    finally{this.end(scope,failed);}
  }
  wrap(owner,key,name) {
    const original=owner[key],profile=this;
    if(typeof original!=='function')throw new Error('Нет операции для измерения: '+key);
    owner[key]=function(...args){return profile.measure(name,original,this,args);};
  }
  snapshot() {
    if(this.stack.length)throw new Error('Измерение ткани ещё не завершено');
    return {schema:'cloth-solver-profile-v1',stages:structuredClone(this.stages)};
  }
}

// Рабочий вариант без профиля не получает обёрток и не читает часы.
export function observeClothSolver(motion,profile) {
  if(motion.solverProfile||motion.linearBackend!=='kkt-wasm')throw new Error('Измеритель требует отдельный расчёт kkt-wasm');
  motion.solverProfile=profile;
  for(const [key,name] of [['step','motionStep'],['solve','nonlinearSolve'],['state','state'],['direction','direction']])profile.wrap(motion,key,name);
  for(const c of motion.soft)profile.wrap(c,'value',c.family==='bending'?'materialBending':'materialMembrane');
  const factor=motion.kktFactor;
  motion.kktFactor=function(...args) {
    const solve=profile.measure('factor',factor,this,args);
    const wrapped=(...rhs)=>profile.measure('linearSolve',solve,undefined,rhs);
    if(solve.many)wrapped.many=(...a)=>profile.measure('linearSolve',solve.many,solve,a);
    if(solve.release)wrapped.release=(...a)=>profile.measure('linearRelease',solve.release,solve,a);
    return wrapped;
  };
}
