// Общий шаг с пересчитываемым ветром; профиль SV20 включает массу и воду.
import {fluidSailMotion} from './cloth-fluid-sail-motion.mjs';
import {integrateDensity} from './cloth-shared-input.mjs';
import {createClothLiveWind} from './cloth-live-wind.mjs';
import {createSV20Water} from './cloth-sv20-water.mjs';
import {rudderAngleAfter} from '../../sim/rudder.js';

export function liveWindSailMotion(r,bodyInput,factor,{pack,wind,sheet,materialKernel,assemblyKernel,bodyProfile='laboratory-v1',hS=r.hS,timeRefinement}={}) {
  const research=timeRefinement==='sampled-air-60hz-v1';
  if(timeRefinement!==undefined&&!research||!(pack?.environment?.g>0)||r.hS!==1/60||
      (!research&&hS!==r.hS)||research&&(![1/60,1/120,1/240].includes(hS)||bodyProfile!=='sv20-rig-budget-point-v1'))
    throw new Error('Нужны пакет и проверенный шаг 1/60 с либо явный временной контроль SV20 60/120/240 Гц');
  if(!['laboratory-v1','sv20-rig-budget-point-v1'].includes(bodyProfile))throw new Error('Неизвестный профиль тела живого ветра');
  const isSV20=bodyProfile==='sv20-rig-budget-point-v1';
  const base=fluidSailMotion(r,bodyInput,factor,{sheet,materialKernel,assemblyKernel,hS,...(isSV20?{sv20Pack:pack}:{})});
  const air=createClothLiveWind(pack,r,{geometryCGM:base.geometryCGM,hS,...(research?{pressureClock:'sampled-60hz-v1'}:{})}),integrated=integrateDensity(r.field,r.rows,r.cols);
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
    timeS+=base.hS;
    let application;
    if(water){let minHeightM=Infinity,submergedNodes=0;for(let i=2;i<base.motion.pos.length;i+=3){minHeightM=Math.min(minHeightM,base.motion.pos[i]);if(base.motion.pos[i]<0)submergedNodes++;}
      application={phase:'accepted-state-after-step',flatWaterLevelM:0,minHeightM,submergedNodes,clothWaterLoadModel:false,dryCloth:submergedNodes===0};}
    return {...audit,air:airAudit,...(water?{water:waterAudit,application}:{} )};
  }
  return {...base,liveWind:{model:air.model,wind:commands,...(isSV20?{bodyProfile,worldVelocityDampingHz:base.motion.dampingHz}:{}),
    ...(research?{timeRefinement:{model:timeRefinement,hS,pressureFrequencyHz:60,scope:'Уточнение механики с удерживаемым давлением Rig 60 Гц, не полный временной предел воздуха'}}:{}),
    scope:isSV20?'SV20: явный сухой бюджет, спокойная вода/руль до исходного начала глиссирования, без экипажа/волн; мировое численное торможение выключено.':'живой ветер, лабораторная опора; руль/гидросилы/SV20 ещё не подключены'},prepareLoad,solve,step(c){prepareLoad(c);return solve();}};
}
