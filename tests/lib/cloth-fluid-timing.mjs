// Длительности методов общего шага. Вложенное время не суммируется дважды.
// Наблюдение принадлежит одному экземпляру; ответы и аргументы не копируются.
export function observeFluidStages(motion, now = () => performance.now()) {
  const names=['validateState','bodyState','readSoft','state','direction','audit'];
  const totals=Object.fromEntries(names.map(name=>[name,{calls:0,inclusiveMs:0,selfMs:0}])),stack=[];
  for(const name of names) {
    const original=motion[name];
    if(typeof original!=='function')throw new Error('Не найден измеряемый метод '+name);
    motion[name]=function(...args) {
      const frame={start:now(),childrenMs:0};stack.push(frame);totals[name].calls++;
      try {return original.apply(this,args);} finally {
        const duration=now()-frame.start;stack.pop();
        totals[name].inclusiveMs+=duration;totals[name].selfMs+=duration-frame.childrenMs;
        if(stack.length)stack[stack.length-1].childrenMs+=duration;
      }
    };
  }
  return {snapshot:()=>Object.fromEntries(names.map(name=>[name,{...totals[name]}]))};
}

export const stageDifference=(after,before)=>Object.fromEntries(Object.keys(after).map(name=>
  [name,Object.fromEntries(Object.keys(after[name]).map(key=>[key,after[name][key]-before[name][key]]))]));
