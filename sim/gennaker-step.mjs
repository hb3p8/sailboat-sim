// Порядок одного шага Boat/воздуха/новой ткани без DOM и расписания Worker.
import {gennakerPose,intermediatePose,localPoint} from './gennaker-energy.mjs';
import {rotate3} from './cloth/cloth-fluid-inertia.mjs';

// Заменяемая фаза получает контекст шага. Базовые фазы сохраняют прежний
// последовательный обмен: воздух 30 Гц, два подшага ткани по 1/60 с.
export const GENNAKER_STEP_PHASES=Object.freeze({
  prepareAir({boat,dt,timings}) {
    // Захват до паузы: более поздний ответ воды не меняет вход этого шага.
    const waterInput={zM:boat.waveZ,slopeEast:boat.waveSE,slopeNorth:boat.waveSN};
    const pose=gennakerPose(boat),work=boat.stepWithGennaker(dt,timings),part=work.next();
    if(part.done)throw new Error('Обычная лодка не запросила новую ткань');
    return {waterInput,pose,work};
  },
  clothLoads({boat,cloth}) {
    cloth.forcesAt(boat,1/60,boat.rigSide,boat.p.environment);
  },
  clothCommand({boat,cloth,snapshot,pose}) {
    const forceN=new Float64Array(cloth.frc.length);
    for(let i=0;i<cloth.n;i++)forceN.set(rotate3(pose.orientation9,Array.from(cloth.frc.slice(3*i,3*i+3))),3*i);
    // Поворот середины берётся из средних углов, а не средней матрицы.
    const mid=intermediatePose(snapshot.targetPose,pose);
    return {type:'step',forceN,poses:[mid,pose],sheetLengthM:boat.o.genSheetLen};
  },
  transferReactions({boat,cloth,snapshot,result}) {
    const c=Math.cos(boat.psi),s=Math.sin(boat.psi),heading=v=>[c*v[0]+s*v[1],-s*v[0]+c*v[1],v[2]];
    const load={forceN:heading(result.forceN),momentNm:heading(result.momentNm),audit:result.audit};
    for(let i=0;i<cloth.n;i++) {
      cloth.pos.set(localPoint(result.targetPose,Array.from(result.positions.slice(3*i,3*i+3))),3*i);
      cloth.prev.set(localPoint(snapshot.targetPose,Array.from(snapshot.positions.slice(3*i,3*i+3))),3*i);
    }
    cloth.prevDt=1/30;
    return {snapshot:result,load};
  },
  finishBoat({work,load}) {
    if(!work.next(load).done)throw new Error('Лодка запросила повторную нагрузку');
  }
});

// Один экземпляр — один шаг. Ткань вычисляет переданная функция: обычный
// адаптер ждёт Worker, проверка может вызвать тот же решатель в своём потоке.
// Синхронная публикация разрешена после завершения лодки и ровно один раз.
// Отказ не откатывает подготовленный воздух; продолжать такой шаг нельзя.
export function createGennakerStep(input,phases=GENNAKER_STEP_PHASES) {
  const selected=phases===GENNAKER_STEP_PHASES?phases:Object.fromEntries(Object.keys(GENNAKER_STEP_PHASES).map(key=>{
    if(typeof phases[key]!=='function')throw new Error('Не задана фаза генакера: '+key);
    return [key,phases[key]];
  }));
  const context={...input},now=input.now??(()=>performance.now());
  let phase='created';
  function enter(expected,next) {
    if(phase!==expected)throw new Error('Неверный порядок фаз генакера: '+phase+' → '+next);
    phase=next;
  }
  function guarded(action) {
    try{return action();}catch(error){phase='failed';throw error;}
  }
  return {
    get phase(){return phase;},
    prepare() {
      enter('created','preparing');
      return guarded(()=>{
        const start=context.physicsStart??(context.timings?now():0);
        Object.assign(context,selected.prepareAir(context));
        const beforeLoads=context.timings?now():0;
        if(context.timings)context.timings.boatPrepareMs=beforeLoads-start;
        selected.clothLoads(context);
        const afterLoads=context.timings?now():0;
        if(context.timings)context.timings.clothLoadsMs=afterLoads-beforeLoads;
        context.command=selected.clothCommand(context);
        if(context.timings)context.timings.toWorldMs=now()-afterLoads;
        phase='prepared';
        return {command:context.command,waterInput:context.waterInput};
      });
    },
    async calculate(solve) {
      enter('prepared','calculating');
      try{context.result=await solve(context.command);phase='calculated';return context.result;}
      catch(error){phase='failed';throw error;}
    },
    transfer() {
      enter('calculated','transferring');
      return guarded(()=>{
        const accepted=selected.transferReactions(context);Object.assign(context,accepted);
        phase='transferred';return accepted;
      });
    },
    finish() {
      enter('transferred','finishing');
      return guarded(()=>{selected.finishBoat(context);phase='finished';});
    },
    publish(accept) {
      enter('finished','publishing');
      return guarded(()=>{const value=accept({command:context.command,waterInput:context.waterInput,
        result:context.result,load:context.load,snapshot:context.snapshot});phase='complete';return value;});
    }
  };
}
