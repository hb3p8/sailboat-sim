// Наблюдение оболочки линейного решения; коэффициенты и ответы не копируются.
export function observeSparseFactor(source, now = () => performance.now()) {
  const totals = {factorMs:0,solveMs:0,factorCalls:0,solveCalls:0};
  const timed = (owner, fn, args, name) => {
    const start=now();totals[name+'Calls']++;
    try {return fn.apply(owner,args);} finally {totals[name+'Ms']+=now()-start;}
  };
  const wrap = (fn,args) => {
    const solve=timed(source,fn,args,'factor');
    const result=(...rhs)=>timed(solve,solve,rhs,'solve');
    if(solve.many)result.many=(...rhs)=>timed(solve,solve.many,rhs,'solve');
    if(solve.release)result.release=(...args)=>solve.release(...args);
    return result;
  };
  const factor=(...args)=>wrap(source,args);
  if(source.ldl)factor.ldl=(...args)=>wrap(source.ldl,args);
  factor.statistics=()=>source.statistics();
  return {factor, snapshot:()=>({...totals})};
}
