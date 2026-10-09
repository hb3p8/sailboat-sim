// Первый общий шаг с пересчитываемым ветром. Масса/вода пока лабораторные.
import {fluidSailMotion} from './cloth-fluid-sail-motion.mjs';
import {integrateDensity} from './cloth-shared-input.mjs';
import {createClothLiveWind} from './cloth-live-wind.mjs';
import {createSV20Water} from './cloth-sv20-water.mjs';
import {rudderAngleAfter} from '../../sim/rudder.js';

export function liveWindSailMotion(r,bodyInput,factor,{pack,wind,sheet,materialKernel,assemblyKernel,bodyProfile='laboratory-v1'}={}) {
  if(!(pack?.environment?.g>0)||r.hS!==1/60)throw new Error('Нужны физический пакет живого ветра и проверенный шаг 1/60 с');
  if(!['laboratory-v1','sv20-rig-budget-point-v1'].includes(bodyProfile))throw new Error('Неизвестный профиль тела живого ветра');
  const isSV20=bodyProfile==='sv20-rig-budget-point-v1';
  const base=fluidSailMotion(r,bodyInput,factor,{sheet,materialKernel,assemblyKernel,...(isSV20?{sv20Pack:pack}:{})});
  const air=createClothLiveWind(pack,r,{geometryCGM:base.geometryCGM}),integrated=integrateDensity(r.field,r.rows,r.cols);
  const water=isSV20?createSV20Water(pack,base.geometryCGM,base.massBudget.bodyKg):undefined;
  // Модуль прежнего узлового веса — отдельное назначенное исходное данное.
  // Воздух не становится грузом. В этом опыте вертикаль мира — действующая g.
  const weightN=Array.from({length:r.rows*r.cols},(_,i)=>Math.hypot(...integrated.slice(16*i+3,16*i+6)));
  let load,airAudit,waterAudit,timeS=0,rudderRad=0,commands={windSpeedMPS:wind?.speedMPS??6,windFromDeg:wind?.fromDeg??140,...(isSV20?{rudderDeg:0}:{})};
  function prepareLoad(controls={}) {
    if(Object.keys(controls).some(k=>!['windSpeedMPS','windFromDeg','sheetRateMPS',...(isSV20?['rudderDeg']:[])].includes(k)))throw new Error('Живой ветер принимает ветер, скорость верёвки и руль только для SV20');
    const next={...commands,...controls},rate=controls.sheetRateMPS??0;
    if(!Number.isFinite(rate)||Math.abs(rate)>(base.sheetControl?.maxSpeedMPS??0))throw new Error('Скорость верёвки вне проверенного окна');
    const sampled=air.evaluate(base.motion,next,timeS);base.forceN.set(sampled.forceN);
    for(let i=0;i<weightN.length;i++)base.forceN[3*i+2]-=weightN[i];
    load={frame:'inertial-cartesian-cg',clothForceN:base.forceN,forceN:[0,0,0],momentNm:[0,0,0]};
    if(water){if(!Number.isFinite(next.rudderDeg)||Math.abs(next.rudderDeg)>25)throw new Error('Цель руля должна быть −25…25°');
      rudderRad=rudderAngleAfter(rudderRad,next.rudderDeg*Math.PI/180,base.hS);
      const sampledWater=water.evaluate(base.motion.body,{rudderDeg:rudderRad*180/Math.PI});load.forceN=sampledWater.forceN;load.momentNm=sampledWater.momentNm;waterAudit={...sampledWater.audit,rudderTargetDeg:next.rudderDeg};}
    if(sheet){const s=base.sheetControl;load.ropeLengthsM=[Math.max(s.minLengthM,Math.min(s.maxLengthM,base.motion.ropeLengthsM[0]+base.hS*rate))];}
    commands={windSpeedMPS:next.windSpeedMPS,windFromDeg:next.windFromDeg,...(isSV20?{rudderDeg:next.rudderDeg}:{})};airAudit=sampled.audit;
    // Проверочный повтор может заменить воздушные/водные силы записанными.
    // Рабочий Worker использует эту же собственную нагрузку без замены.
    return load;
  }
  function solve() {
    if(!load)throw new Error('Нагрузка живого ветра не подготовлена');
    const audit=base.motion.step(load,base.hS,r.iterations);load=undefined;
    if(Math.abs(audit.discreteBalanceResidualJ)>audit.workLimitJ||Math.abs(audit.bodyWorkCancellationResidualJ)>audit.interfaceWorkLimitJ)
      throw new Error('Живой шаг не выполнил прежнюю проверку работы сил');
    timeS+=base.hS;return {...audit,air:airAudit,...(water?{water:waterAudit}:{} )};
  }
  return {...base,liveWind:{model:air.model,wind:commands,...(isSV20?{bodyProfile}:{}),
    scope:isSV20?'SV20: явный сухой бюджет, спокойная вода/руль до 2 м/с, без экипажа/волн/глиссирования; генакер как прежде в опыте.':'живой ветер, лабораторная опора; руль/гидросилы/SV20 ещё не подключены'},prepareLoad,solve,step(c){prepareLoad(c);return solve();}};
}
