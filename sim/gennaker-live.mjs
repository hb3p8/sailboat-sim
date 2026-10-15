// Обычная сцена и UI; новый генакер не создаёт вторую лодку.
import {gennakerPose,worldPoint,localPoint,gennakerBodyPack,energyCloth,intermediatePose} from './gennaker-energy.mjs';
import {rotate3} from './cloth/cloth-fluid-inertia.mjs';
import {GennakerMetrics} from './gennaker-metrics.mjs';
import {gennakerScenario,restoredGennakerScenario} from './gennaker-scenario.mjs';
import {GENNAKER_SESSION_SCHEMA,SESSION_DERIVED,captureSessionModel,prepareSessionModel,verifySessionSolver,sessionDataEqual} from './gennaker-session.mjs';
import {gennakerWorkerChannel} from './gennaker-worker-channel.mjs';
import {GennakerRecording,recordingInput,recordingOutput,applyRecordingInput,validateRecording} from './gennaker-recording.mjs';

const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
async function bytesAt(path,sha) {
  const response=await fetch('/'+path,{cache:'no-store'});
  if(!response.ok)throw new Error('Не найден файл новой ткани: '+path);
  const bytes=await response.arrayBuffer();
  if(sha&&await digest(bytes)!==sha)throw new Error('Изменился файл новой ткани: '+path);
  return bytes;
}
async function runtimeHashes() {
  const seen=new Set(),hashes={};
  let batch=['sim/gennaker-live.mjs','sim/gennaker-energy-worker.mjs','sim/main.js','sim/controls.js','sim/mobile.js','sim/session-ui.js','sim/trace.js'];
  while(batch.length) {
    const paths=batch.filter(p=>!seen.has(p));paths.forEach(p=>seen.add(p));batch=[];
    const loaded=await Promise.all(paths.map(async path=>{const bytes=await bytesAt(path);return {path,bytes,code:new TextDecoder().decode(bytes)};}));
    for(const {path,bytes,code} of loaded) {
      hashes[path]=await digest(bytes);
      // Замыкаем статические относительные импорты рабочего графа, включая
      // материал/решатель из tests. Исследовательские динамические маршруты
      // main.js в формат обычной сессии не входят; Worker — явный корень.
      const imports=code.matchAll(/^\s*(?:import|export)\s+(?:[^;]*?\s+from\s*)?['"]([^'"]+)['"]/gm);
      for(const [,relative] of imports)if(relative.startsWith('.')) {
        const next=new URL(relative,'https://sv20.invalid/'+path).pathname.slice(1);
        if(/\.(?:mjs|js)$/.test(next)&&!seen.has(next)&&!batch.includes(next))batch.push(next);
      }
    }
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b)));
}
export async function startGennakerSimulator({boat,ui,manifestPath,gameUI=false,terrainHash=null,record=true}) {
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
  const runtimeSha256=await runtimeHashes();
  const display=document.createElement('div');display.id='gennaker-energy-status';
  Object.assign(display.style,{position:'absolute',top:gameUI?'80px':'8px',left:'50%',transform:'translateX(-50%)',width:'max-content',maxWidth:'min(460px, 90%)',padding:'6px 9px',background:'#18212dcc',color:'white',font:'12px sans-serif',pointerEvents:'none',zIndex:5});
  document.getElementById('stage').append(display);
  let worker,continueAfterFrame=false,cloth,fixture,snapshot,material,busy=false,failed=false,steps=0,lastRig,completedSteps=0,lastBoatTime=0,deferred,lastStarted=0,renderFrame=0,commandFrames,failure,initialReset=true;
  let scenario=gennakerScenario(location.search,source.sheet.lengthM),transactions=0,transactionActive=false,queue=Promise.resolve();
  const idleWaiters=[],history=[],recording=new GennakerRecording(),wallStart=performance.now();
  let checkpointing=false;
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
    save.onclick=async()=>{
      let dump;
      try{dump=await window.sv20snapshot();}catch(error){dump={...window.sv20dump(),snapshotError:error.message};}
      const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(dump)],{type:'application/json'}));
      a.href=url;a.download='sv20-physics-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    document.getElementById('stage').append(save);
  }
  const request=message=>worker.request(message);
  function idle() {
    if(busy)return;
    for(const resolve of idleWaiters.splice(0))resolve();
    if(!transactions&&deferred){const callback=deferred;deferred=undefined;callback();}
  }
  function exclusive(operation) {
    transactions++;
    const result=queue.then(async()=>{
      if(busy)await new Promise(resolve=>idleWaiters.push(resolve));
      transactionActive=true;const previous=metrics.operation;metrics.state('preparing');
      try{return await operation();}finally{transactionActive=false;metrics.state(metrics.operation==='preparing'?previous:metrics.operation);}
    }).finally(()=>{transactions--;idle();});
    queue=result.catch(()=>{});return result;
  }
  function dispose() {
    worker?.dispose();worker=undefined;cloth=undefined;snapshot=undefined;material=undefined;lastRig=undefined;
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
    worker=gennakerWorkerChannel(()=>{if(commandFrames)commandFrames.progressMs=performance.now();if(schedule==='message')continueStep();else continueAfterFrame=true;});
    display.textContent='Генакер: подготавливается новая ткань…';
    const ready=await request({type:'init',fixture,pack:originalPack,pose,bytes,materialBytes,profile});material=ready.material;metrics.state('running');
  }
  function continueStep() {
    continueAfterFrame=false;
    if(commandFrames){commandFrames.continued=renderFrame;commandFrames.continuedMs=performance.now();}
    worker?.continue();
  }
  function applySnapshot(result) {
    const old=snapshot;snapshot=result;
    for(let i=0;i<cloth.n;i++) {
      cloth.pos.set(localPoint(result.targetPose,Array.from(result.positions.slice(3*i,3*i+3))),3*i);
      cloth.prev.set(localPoint(old.targetPose,Array.from(old.positions.slice(3*i,3*i+3))),3*i);
    }
    cloth.prevDt=1/30;
  }
  async function capture() {
    if(failed)throw new Error('После отказа доступен диагностический дамп; полного принятого состояния нет');
    if(boat.o.gennakerUp&&(!worker||lastRig!==boat.rig))throw new Error('Генакер ещё не получил полный шаг');
    const model=captureSessionModel(boat,boat.o.gennakerUp?snapshot:null);
    if(JSON.parse(model.air.configuration).oldSail)throw new Error('Полный снимок требует измеренную поляру');
    const solver=boat.o.gennakerUp?(await request({type:'snapshot'})).state:null;
    return {schema:GENNAKER_SESSION_SCHEMA,runtimeSha256,physicsSha256:source.physicsSha256,
      engine:navigator.userAgent,environment:{terrainHash,ui:gameUI?'game':'debug'},
      side:boat.o.gennakerUp?fixture.side:null,source:boat.o.gennakerUp?manifest.inputs[fixture.side]:null,
      model,solver,adapter:{steps,scenario:scenario?.snapshot()??null},material:material?.backend??null};
  }
  async function checkpoint(input) {
    if(!record)return;
    checkpointing=true;
    try{await recording.accepted(input,recordingOutput(boat),capture);}finally{checkpointing=false;}
  }
  return {get busy(){return busy||transactions>0;},get transitioning(){return transactionActive||checkpointing;},
    capture(publish=s=>s){return exclusive(async()=>{const state=await capture();let replay;
      try{replay=recording.snapshot(state);}catch(error){replay={error:error.message};}
      return publish(state,replay);});},
    legacyLoad(apply){return exclusive(()=>{
      if(JSON.parse(boat.rig.airSnapshot().configuration).oldSail)throw new Error('Загрузка сессии требует измеренную поляру');
      const candidate=new boat.constructor(originalPack,boat.terrain);apply(candidate);dispose();for(const k of SESSION_DERIVED)delete boat[k];Object.assign(boat,candidate);delete boat.gennakerEnergy;
      scenario=undefined;history.length=0;recording.reset();steps=0;metrics.reset();metrics.state('running');
    });},
    restore(raw,publish=()=>{}) {return exclusive(()=>restore(raw,publish));},
    replay(raw) {return exclusive(async()=>{
      const r=validateRecording(raw);
      await restore(r.anchor);
      for(let i=0;i<r.inputs.length;i++) {
        await runStep(1/30,()=>{},()=>{},r.inputs[i]);
        if(failed)throw new Error('Повтор остановлен на шаге '+i+': '+failure.message);
        if(!sessionDataEqual(recordingOutput(boat),r.inputs[i].output))throw new Error('Повтор расходится на шаге '+i);
      }
      // Между последним принятым шагом и сохранением мог прийти новый ответ
      // воды/вид UI. Это вход перед будущим шагом, не поправка динамики лодки.
      const v=r.end.model.local;
      applyRecordingInput(boat,{controls:v.controls,wind:v.wind,water:[v.body.waveZ,v.body.waveSE,v.body.waveSN]});
      const actual=await capture();
      if(!sessionDataEqual(actual,r.end))throw new Error('Конечный полный снимок повтора не совпал');
      recording.reset(actual);completedSteps=0;metrics.reset();metrics.context.resumeModelTimeS=boat.t;
      metrics.state(scenario?.done?'complete':'running');
      return {exact:true,steps:r.inputs.length,startS:r.anchor.model.local.body.t,endS:boat.t};
    });},performance(){const result=metrics.snapshot();return {...result,inFlight:busy,queued:transactions,recording:recording.stats(),
    scenario:scenario?.snapshot(),failure};},
    observeFrame(options){metrics.frame(options);},restart(){if(busy||transactions)throw new Error('Сначала завершите текущую операцию физики');dispose();scenario?.reset();if(!initialReset||metrics.steps)metrics.reset();initialReset=false;metrics.state('running');history.length=0;recording.reset();steps=0;lastBoatTime=0;lastStarted=0;renderFrame=0;commandFrames=undefined;delete display.dataset.error;delete boat.gennakerEnergy;},canAdvance(dt,acc=Infinity){return !transactions&&!scenario?.done&&(failed?performance.now()-lastStarted>=dt*1000:schedule==='frame'?(acc>=dt||boat.o.gennakerUp)&&performance.now()-lastStarted>=dt*1000:metrics.due(dt));},afterStep(callback){deferred=callback;},drainSteps(){const count=completedSteps;completedSteps=0;return count;},frame() {
    renderFrame++;
    if(continueAfterFrame)continueStep();
  },advance(dt,before,after) {
    if(busy||transactions)throw new Error('Шаг занят сохранением или загрузкой');
    void runStep(dt,before,after);
  }};
  async function restore(raw,publish=()=>{}) {
    const state=structuredClone(raw),same=sessionDataEqual;
    if(state?.schema!==GENNAKER_SESSION_SCHEMA||!same(state.runtimeSha256,runtimeSha256)||state.physicsSha256!==source.physicsSha256||
      state.engine!==navigator.userAgent||!same(state.environment,{terrainHash,ui:gameUI?'game':'debug'}))throw new Error('Снимок сессии требует те же исходники, данные, движок, UI и акваторию');
    if(![null,'plus','minus'].includes(state.side)||!same(state.source,state.side?manifest.inputs[state.side]:null)||
      !Number.isSafeInteger(state.adapter?.steps)||state.adapter.steps<0||JSON.parse(state.model.air.configuration).oldSail||
      JSON.parse(boat.rig.airSnapshot().configuration).oldSail)throw new Error('Некорректная постановка сессии');
    const chosen=state.side?inputs[state.side]:undefined;
    const candidate=prepareSessionModel(boat,originalPack,chosen,state.model);
    const nextScenario=restoredGennakerScenario(state.adapter.scenario,candidate.boat.t,source.sheet.lengthM);
    let nextWorker,nextMaterial;
    try {
      if(chosen){
        verifySessionSolver(state.model,state.solver);
        nextWorker=gennakerWorkerChannel(()=>{if(commandFrames)commandFrames.progressMs=performance.now();if(schedule==='message')continueStep();else continueAfterFrame=true;});
        const ready=await nextWorker.request({type:'init',fixture:chosen,pack:originalPack,pose:candidate.snapshot.targetPose,bytes,materialBytes,profile,state:state.solver});
        if(ready.material.backend!==state.material)throw new Error('Изменился численный режим материала');nextMaterial=ready.material;
      } else if(state.solver!==null||state.material!==null)throw new Error('Worker у убранного генакера');
      const oldWorker=worker;
      // До этой точки действующая лодка/ткань/Worker не изменялись.
      for(const k of SESSION_DERIVED)delete boat[k];Object.assign(boat,candidate.boat);worker=nextWorker;nextWorker=undefined;oldWorker?.dispose();
      fixture=chosen;cloth=boat.rig.cloth;snapshot=candidate.snapshot;material=nextMaterial;lastRig=chosen?boat.rig:undefined;
      steps=state.adapter.steps;scenario=nextScenario;lastBoatTime=boat.t;lastStarted=0;completedSteps=0;
      continueAfterFrame=false;commandFrames=undefined;failed=false;failure=undefined;history.length=0;recording.reset(state);delete boat.gennakerEnergy;delete display.dataset.error;
      metrics.reset();metrics.context.resumeModelTimeS=boat.t;metrics.context.wakeSlice=boat.o.wakeSlice;metrics.state(scenario?.done?'complete':'running');
      if(chosen)boat.gennakerEnergy={runtimeSha256,material,active:true,model:'boat-prescribed-energy-v1',grid:[11,9],steps,history,source:manifest.inputs[fixture.side],state:{...candidate.snapshot,positions:Array.from(candidate.snapshot.positions),velocity:Array.from(candidate.snapshot.velocity)}};
      display.textContent='Состояние загружено. Управление и расчёт готовы к продолжению.';publish();
    } finally {nextWorker?.dispose();}

  }

  async function runStep(dt,before,after,replayInput) {
    busy=true;lastStarted=performance.now();
    const timings=profile?{}:undefined;
    try {
      scenario?.apply(boat,ui);
      if(replayInput)applyRecordingInput(boat,replayInput);
      metrics.context.wakeSlice=boat.o.wakeSlice;
      if(!boat.o.gennakerUp) {
        delete display.dataset.error;
        if(worker||failed){dispose();metrics.state('running');if(boat.gennakerEnergy)boat.gennakerEnergy.active=false;}before();const input=recordingInput(boat,dt),start=profile?performance.now():0;boat.step(dt);completedSteps++;lastBoatTime=boat.t;after();
        scenario?.accepted(boat);metrics.accepted(dt,{modelTimeS:boat.t,gennakerUp:false,
          totalMs:profile?performance.now()-start:undefined});
        if(scenario?.done)metrics.state('complete');
        display.textContent='Грот и стаксель. Генакер убран; новая ткань готова к подъёму.';if(!replayInput)await checkpoint(input);return;
      }
      if(failed)return;
      if(lastRig!==boat.rig || boat.t<lastBoatTime){const start=profile?performance.now():0;await hoist();if(timings)timings.preparationMs=performance.now()-start;}
      const physicsStart=profile?performance.now():0;
      before();
      const input=recordingInput(boat,dt);
      // Boat захватывает эти три значения до паузы на Worker. Последний
      // ответ воды после ожидания может быть другим и вход шага не заменяет.
      const waterInput={zM:boat.waveZ,slopeEast:boat.waveSE,slopeNorth:boat.waveSN};
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
        frames:{...commandFrames,received:renderFrame},partsMs:result.partsMs,audits:result.audits,lengthM:result.lengthM,nodalAirForceN:Array.from(forceN),waterInput});
      if(history.length>300)history.shift();
      // Для дампа сохраняется действительная принятая физика, а не DOM.
      boat.gennakerEnergy={runtimeSha256,material,active:true,model:'boat-prescribed-energy-v1',grid:[11,9],steps,history,
        source:manifest.inputs[fixture.side],state:{positions:Array.from(result.positions),velocity:Array.from(result.velocity),targetPose:result.targetPose,lengthM:result.lengthM},wallS:(performance.now()-wallStart)/1000};
      display.textContent=`Новый генакер 11×9 · ${material.backend==='js'?'режим совместимости · ':''}${steps} шагов · ${boat.t.toFixed(2)} с модели · шкот ${result.lengthM.toFixed(3)} м · ${result.partsMs.reduce((a,b)=>a+b,0).toFixed(0)} мс расчёта`+(scenario?.done?' · Замер окончен':'');
      if(!replayInput)await checkpoint(input);
    } catch(error) {
      failed=true;failure={message:error.message,timeS:boat.t,attempts:error.attempts,timings};metrics.state('failed');display.textContent='Новая ткань остановлена: '+error.message+'. Уберите и поднимите генакер для нового запуска.';
      display.dataset.error=error.message;
      if(boat.gennakerEnergy)boat.gennakerEnergy.failure=failure;
    } finally {busy=false;idle();}
  }
}
