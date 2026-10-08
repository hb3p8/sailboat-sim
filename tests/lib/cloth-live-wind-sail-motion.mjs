// Первый общий шаг с пересчитываемым ветром. Масса/вода пока лабораторные.
import {fluidSailMotion} from './cloth-fluid-sail-motion.mjs';
import {integrateDensity} from './cloth-shared-input.mjs';
import {createClothLiveWind} from './cloth-live-wind.mjs';

export function liveWindSailMotion(r,bodyInput,factor,{pack,wind,sheet,materialKernel,assemblyKernel}={}) {
  if(!(pack?.environment?.g>0)||r.hS!==1/60)throw new Error('Нужны физический пакет живого ветра и проверенный шаг 1/60 с');
  const base=fluidSailMotion(r,bodyInput,factor,{sheet,materialKernel,assemblyKernel}),air=createClothLiveWind(pack,r),integrated=integrateDensity(r.field,r.rows,r.cols);
  // Модуль прежнего узлового веса — отдельное назначенное исходное данное.
  // Воздух не становится грузом. В этом опыте вертикаль мира — действующая g.
  const weightN=Array.from({length:r.rows*r.cols},(_,i)=>Math.hypot(...integrated.slice(16*i+3,16*i+6)));
  let load,airAudit,timeS=0,commands={windSpeedMPS:wind?.speedMPS??6,windFromDeg:wind?.fromDeg??140};
  function prepareLoad(controls={}) {
    if(Object.keys(controls).some(k=>!['windSpeedMPS','windFromDeg','sheetRateMPS'].includes(k)))throw new Error('Живой ветер принимает ветер и скорость верёвки');
    const next={...commands,...controls},rate=controls.sheetRateMPS??0;
    if(!Number.isFinite(rate)||Math.abs(rate)>(base.sheetControl?.maxSpeedMPS??0))throw new Error('Скорость верёвки вне проверенного окна');
    const sampled=air.evaluate(base.motion,next,timeS);base.forceN.set(sampled.forceN);
    for(let i=0;i<weightN.length;i++)base.forceN[3*i+2]-=weightN[i];
    load={frame:'inertial-cartesian-cg',clothForceN:base.forceN,forceN:[0,0,0],momentNm:[0,0,0]};
    if(sheet){const s=base.sheetControl;load.ropeLengthsM=[Math.max(s.minLengthM,Math.min(s.maxLengthM,base.motion.ropeLengthsM[0]+base.hS*rate))];}
    commands={windSpeedMPS:next.windSpeedMPS,windFromDeg:next.windFromDeg};airAudit=sampled.audit;
  }
  function solve() {
    if(!load)throw new Error('Нагрузка живого ветра не подготовлена');
    const audit=base.motion.step(load,base.hS,r.iterations);load=undefined;
    if(Math.abs(audit.discreteBalanceResidualJ)>audit.workLimitJ||Math.abs(audit.bodyWorkCancellationResidualJ)>audit.interfaceWorkLimitJ)
      throw new Error('Живой шаг не выполнил прежнюю проверку работы сил');
    timeS+=base.hS;return {...audit,air:airAudit};
  }
  return {...base,liveWind:{model:air.model,wind:commands,scope:'живой ветер, лабораторная опора; руль/гидросилы/SV20 ещё не подключены'},prepareLoad,solve,step(c){prepareLoad(c);return solve();}};
}
