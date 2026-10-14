// Обычная сцена и UI; новый генакер не создаёт вторую лодку.
import {gennakerPose,worldPoint,localPoint,gennakerBodyPack,energyCloth,intermediatePose} from './gennaker-energy.mjs';
import {rotate3} from '../tests/lib/cloth-fluid-inertia.mjs';
import {GennakerMetrics} from './gennaker-metrics.mjs';
import {gennakerScenario} from './gennaker-scenario.mjs';

const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
async function bytesAt(path,sha) {
  const response=await fetch('/'+path,{cache:'no-store'});
  if(!response.ok)throw new Error('Не найден файл новой ткани: '+path);
  const bytes=await response.arrayBuffer();
  if(sha&&await digest(bytes)!==sha)throw new Error('Изменился файл новой ткани: '+path);
  return bytes;
}
export async function startGennakerSimulator({boat,ui,manifestPath,gameUI=false}) {
  const parameters=new URLSearchParams(location.search),profile=parameters.get('physics-profile')==='1';
  const schedule=parameters.get('physics-schedule')??'message';
  if(!['message','frame'].includes(schedule))throw new Error('Неизвестное расписание физики');
  const metrics=new GennakerMetrics({profile,context:{ui:gameUI?'game':'debug',MOBILE_UI:gameUI,
    userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],schedule,wakeSlice:boat.o.wakeSlice}});
  document.addEventListener('visibilitychange',()=>metrics.visibility(document.hidden));
  const originalPack=boat.p,manifest=JSON.parse(new TextDecoder().decode(await bytesAt(manifestPath)));
  const inputs={};
  for(const side of ['plus','minus']) {
    const source=manifest.inputs[side];inputs[side]=JSON.parse(new TextDecoder().decode(await bytesAt(source.path,source.sha256)));
    if(inputs[side].schema!=='cloth-fluid-live-v1'||inputs[side].dirty||inputs[side].side!==side)
      throw new Error('Нет чистого исходного кроя обеих сторон');
  }
  const source=inputs.plus;
  const currentPack=JSON.parse(new TextDecoder().decode(await bytesAt('out/export/physics.json',source.physicsSha256)));
  if(JSON.stringify(currentPack)!==JSON.stringify(originalPack))throw new Error('Встроенный физический пакет устарел: пересоберите симулятор');
  const bytes=await bytesAt(source.wasm.path,source.wasm.sha256),materialBytes=await bytesAt(source.materialWasm.path,source.materialWasm.sha256);
  const runtimeSha256=Object.fromEntries(await Promise.all(['sim/gennaker-live.mjs','sim/gennaker-energy.mjs','sim/gennaker-energy-worker.mjs','sim/gennaker-material.mjs','sim/gennaker-metrics.mjs','sim/gennaker-scenario.mjs','tests/probes/cloth-material-wasm.mjs','tests/probes/cloth-material-engine-check.mjs','sim/physics.js','sim/main.js','sim/controls.js','sim/trace.js'].map(async path=>[path,await digest(await bytesAt(path))])));
  const display=document.createElement('div');display.id='gennaker-energy-status';
  Object.assign(display.style,{position:'absolute',top:gameUI?'80px':'8px',left:'50%',transform:'translateX(-50%)',width:'max-content',maxWidth:'min(460px, 90%)',padding:'6px 9px',background:'#18212dcc',color:'white',font:'12px sans-serif',pointerEvents:'none',zIndex:5});
  document.getElementById('stage').append(display);
  let worker,pending,requestTimer,continueAfterFrame=false,cloth,fixture,snapshot,material,busy=false,failed=false,steps=0,lastRig,completedSteps=0,lastBoatTime=0,deferred,lastStarted=0,renderFrame=0,commandFrames,failure,initialReset=true;
  const history=[],wallStart=performance.now(),scenario=gennakerScenario(location.search,source.sheet.lengthM);
  metrics.state('running');
  display.textContent='Грот и стаксель готовы. Поднимите генакер: новая ткань 11×9, первый просмотр при ветре 4 м/с.';
  // Реальная длина в метрах, без переназначения прежнего диапазона 3–9.2 м.
  // Принятый источник воздуха не включает опытное местное давление.
  ui.genpressure.checked=false;
  ui.wind.value=String(source.liveWind.wind.speedMPS);ui.wind.dispatchEvent(new Event('input'));
  ui.gensheet.min=String(source.sheet.lengthM);ui.gensheet.max=String(source.sheet.lengthM+.25);ui.gensheet.step='.001';
  ui.gensheet.value=String(source.sheet.lengthM);ui.gensheet.dispatchEvent(new Event('input'));
  document.getElementById('gennote').textContent='Генакер использует новую ткань. Подъём убирает стаксель; грот остаётся управляемым. Шкот: 5.218–5.468 м, изменение до 0.5 м/с. Клавиша N — поднять или убрать.';
  if(profile||scenario) {
    const save=document.createElement('button');save.type='button';save.textContent='Скачать замер физики';
    save.onpointerdown=e=>e.stopPropagation();
    Object.assign(save.style,{position:'absolute',top:gameUI?'130px':'60px',left:'50%',transform:'translateX(-50%)',zIndex:10});
    save.onclick=()=>{
      const dump=window.sv20dump();
      const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(dump)],{type:'application/json'}));
      a.href=url;a.download='sv20-physics-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    document.getElementById('stage').append(save);
  }
  function request(message) {
    if(pending)throw new Error('Повторная команда нового генакера');
    return new Promise((resolve,reject)=>{pending={resolve,reject};requestTimer=setTimeout(()=>{pending=undefined;reject(new Error('Расчёт не ответил за 30 с'));worker?.terminate();},30000);worker.postMessage(message);});
  }
  function dispose() {
    worker?.terminate();clearTimeout(requestTimer);worker=undefined;cloth=undefined;snapshot=undefined;material=undefined;lastRig=undefined;
    boat.p=originalPack;boat.mass=originalPack.mass.total_kg;boat.rig.p=originalPack;
    failed=false;failure=undefined;continueAfterFrame=false;
  }
  async function hoist() {
    metrics.state('preparing');dispose();lastRig=boat.rig;
    const side=boat.apparentWind().angle>0?'minus':'plus';fixture=inputs[side];
    const {pack}=gennakerBodyPack(originalPack,fixture.recipe);boat.p=pack;boat.mass=pack.mass.total_kg;boat.rig.p=pack;
    const r=fixture.recipe,n=r.rows*r.cols,pose=gennakerPose(boat);
    cloth=energyCloth(r,originalPack);
    boat.rig.cloth=cloth;
    snapshot={targetPose:pose,positions:Float64Array.from(Array.from({length:n},(_,i)=>worldPoint(pose,Array.from(cloth.pos.slice(3*i,3*i+3)))).flat())};
    worker=new Worker(new URL('./gennaker-energy-worker.mjs',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{
      if(data.type==='progress'){if(commandFrames)commandFrames.progressMs=performance.now();if(schedule==='message')continueStep();else continueAfterFrame=true;return;}
      const waiting=pending;pending=undefined;clearTimeout(requestTimer);
      if(data.type==='error')waiting?.reject(Object.assign(new Error(data.message),{attempts:data.attempts}));else waiting?.resolve(data);
    };
    worker.onerror=event=>{const waiting=pending;pending=undefined;clearTimeout(requestTimer);waiting?.reject(new Error(event.message));};
    display.textContent='Генакер: подготавливается новая ткань…';
    const ready=await request({type:'init',fixture,pack:originalPack,pose,bytes,materialBytes,profile});material=ready.material;metrics.state('running');
  }
  function continueStep() {
    continueAfterFrame=false;
    if(commandFrames){commandFrames.continued=renderFrame;commandFrames.continuedMs=performance.now();}
    worker?.postMessage({type:'continue'});
  }
  function applySnapshot(result) {
    const old=snapshot;snapshot=result;
    for(let i=0;i<cloth.n;i++) {
      cloth.pos.set(localPoint(result.targetPose,Array.from(result.positions.slice(3*i,3*i+3))),3*i);
      cloth.prev.set(localPoint(old.targetPose,Array.from(old.positions.slice(3*i,3*i+3))),3*i);
    }
    cloth.prevDt=1/30;
  }
  return {get busy(){return busy;},performance(){const result=metrics.snapshot();return {...result,inFlight:busy,queued:0,
    scenario:scenario?.snapshot(),failure};},
    observeFrame(options){metrics.frame(options);},restart(){dispose();scenario?.reset();if(!initialReset||metrics.steps)metrics.reset();initialReset=false;metrics.state('running');history.length=0;steps=0;lastBoatTime=0;lastStarted=0;renderFrame=0;commandFrames=undefined;delete display.dataset.error;delete boat.gennakerEnergy;},canAdvance(dt,acc=Infinity){return !scenario?.done&&(failed?performance.now()-lastStarted>=dt*1000:schedule==='frame'?(acc>=dt||boat.o.gennakerUp)&&performance.now()-lastStarted>=dt*1000:metrics.due(dt));},afterStep(callback){deferred=callback;},drainSteps(){const count=completedSteps;completedSteps=0;return count;},frame() {
    renderFrame++;
    if(continueAfterFrame)continueStep();
  },advance(dt,before,after) {
    busy=true;lastStarted=performance.now();
    const timings=profile?{}:undefined;
    void (async()=>{
      try {
        scenario?.apply(boat,ui);
        metrics.context.wakeSlice=boat.o.wakeSlice;
        if(!boat.o.gennakerUp) {
          delete display.dataset.error;
          if(worker||failed){dispose();metrics.state('running');if(boat.gennakerEnergy)boat.gennakerEnergy.active=false;}before();const start=profile?performance.now():0;boat.step(dt);completedSteps++;lastBoatTime=boat.t;after();
          scenario?.accepted(boat);metrics.accepted(dt,{modelTimeS:boat.t,gennakerUp:false,
            totalMs:profile?performance.now()-start:undefined});
          if(scenario?.done)metrics.state('complete');
          display.textContent='Грот и стаксель. Генакер убран; новая ткань готова к подъёму.';return;
        }
        if(failed)return;
        if(lastRig!==boat.rig || boat.t<lastBoatTime){const start=profile?performance.now():0;await hoist();if(timings)timings.preparationMs=performance.now()-start;}
        const physicsStart=profile?performance.now():0;
        before();
        const pose=gennakerPose(boat),work=boat.stepWithGennaker(dt,timings),part=work.next();
        const beforeLoads=profile?performance.now():0;if(timings)timings.boatPrepareMs=beforeLoads-physicsStart;
        if(part.done)throw new Error('Обычная лодка не запросила новую ткань');
        cloth.forcesAt(boat,1/60,boat.rigSide,boat.p.environment);
        const afterLoads=profile?performance.now():0;if(timings)timings.clothLoadsMs=afterLoads-beforeLoads;
        const forceN=new Float64Array(cloth.frc.length);
        for(let i=0;i<cloth.n;i++)forceN.set(rotate3(pose.orientation9,Array.from(cloth.frc.slice(3*i,3*i+3))),3*i);
        // Два отсчёта креплений: от прошлого принятого положения до текущего.
        // Поворот середины берётся из средних углов, а не средней матрицы.
        const mid=intermediatePose(snapshot.targetPose,pose);
        commandFrames={sent:renderFrame};
        const sendMs=performance.now();if(timings)timings.toWorldMs=sendMs-afterLoads;
        const result=await request({type:'step',forceN,poses:[mid,pose],sheetLengthM:boat.o.genSheetLen});
        const receivedMs=performance.now();
        if(timings){timings.workerRoundTripMs=receivedMs-sendMs;timings.workerComputeMs=result.partsMs.reduce((a,b)=>a+b,0);
          timings.waitAndTransferMs=Math.max(0,timings.workerRoundTripMs-timings.workerComputeMs);
          timings.frameWaitMs=commandFrames.continuedMs-commandFrames.progressMs;}
        const c=Math.cos(boat.psi),s=Math.sin(boat.psi),heading=v=>[c*v[0]+s*v[1],-s*v[0]+c*v[1],v[2]];
        const load={forceN:heading(result.forceN),momentNm:heading(result.momentNm),audit:result.audit};
        applySnapshot(result);
        const boatFinishStart=profile?performance.now():0;if(timings)timings.applySnapshotMs=boatFinishStart-receivedMs;
        if(!work.next(load).done)throw new Error('Лодка запросила повторную нагрузку');
        steps++;completedSteps++;lastBoatTime=boat.t;after();
        if(timings){timings.boatFinishMs=performance.now()-boatFinishStart;timings.physicsWallMs=performance.now()-physicsStart;}
        scenario?.accepted(boat);metrics.accepted(dt,profile?{modelTimeS:boat.t,gennakerUp:true,wakeSlice:boat.o.wakeSlice,
          timings,attempts:result.attempts,frames:{...commandFrames,received:renderFrame}}:undefined);
        if(scenario?.done)metrics.state('complete');
        history.push({side:fixture.side,step:steps,timeS:boat.t,pose:gennakerPose(boat),controls:{...boat.o},forceN:load.forceN,momentNm:load.momentNm,
          frames:{...commandFrames,received:renderFrame},partsMs:result.partsMs,audits:result.audits,lengthM:result.lengthM,nodalAirForceN:Array.from(forceN)});
        if(history.length>300)history.shift();
        // Для дампа сохраняется действительная принятая физика, а не DOM.
        boat.gennakerEnergy={runtimeSha256,material,active:true,model:'boat-prescribed-energy-v1',grid:[11,9],steps,history,
          source:manifest.inputs[fixture.side],state:{positions:Array.from(result.positions),velocity:Array.from(result.velocity),targetPose:result.targetPose,lengthM:result.lengthM},wallS:(performance.now()-wallStart)/1000};
        display.textContent=`Новый генакер 11×9 · ${material.backend==='js'?'режим совместимости · ':''}${steps} шагов · ${boat.t.toFixed(2)} с модели · шкот ${result.lengthM.toFixed(3)} м · ${result.partsMs.reduce((a,b)=>a+b,0).toFixed(0)} мс расчёта`+(scenario?.done?' · Замер окончен':'');
      } catch(error) {
        failed=true;failure={message:error.message,timeS:boat.t,attempts:error.attempts,timings};metrics.state('failed');display.textContent='Новая ткань остановлена: '+error.message+'. Уберите и поднимите генакер для нового запуска.';
        display.dataset.error=error.message;
        if(boat.gennakerEnergy)boat.gennakerEnergy.failure=failure;
      } finally {busy=false;if(deferred){const callback=deferred;deferred=undefined;callback();}}
    })();
  }};
}
