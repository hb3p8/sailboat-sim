// Живой лабораторный режим общей ткани/опоры. Вид читает принятый шаг Worker.
import {createFluidWorker} from '../tests/lib/cloth-fluid-client.mjs';
import {gridTriangles} from '../tests/lib/cloth-material.mjs';
import {rotate3,transpose3} from '../tests/lib/cloth-fluid-inertia.mjs';
import {bodyPointLocalX,bodyPointLocalY,bodyPointLocalZ,bodyPoseSceneMatrix,rudderRotY} from '../sim/axes.js';
import {liveWindCycleControls,sv20WindCycleControls} from '../tests/lib/cloth-live-wind-controls.mjs';
import {sv20BodyAngles} from '../tests/lib/cloth-sv20-water.mjs';
import {saveBrowserRecord} from '../tests/probes/browser-record-save.mjs';
const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
async function bytesAt(path) {
  if(!/^[\w./-]+$/.test(path)||path.includes('..'))throw new Error('Некорректный путь входа');
  const r=await fetch('/'+path,{cache:'no-store'});if(!r.ok)throw new Error(`Не удалось прочитать ${path}: ${r.status}`);
  return r.arrayBuffer();
}
export async function startFluidLiveScene({renderer,genSail,boatGroup,mainSail,jibSail,scene,sea,sunTarget,camera,BufferGeometry,BufferAttribute,indicators=[],rudderPivot,crewGroup,windVisual}) {
  if(!renderer.backend.isWebGPUBackend)throw new Error('Живой стенд требует WebGPU');
  const query=new URLSearchParams(location.search),play=query.has('sail-live');
  const prefix=query.get('sail-live')??query.get('fluid-live');
  if(!/^[\w-]+$/.test(prefix))throw new Error('Укажите имя подготовленной серии в fluid-live');
  for(const el of document.querySelectorAll('input,select,button'))el.disabled=true;
  const style=document.createElement('style');
  style.textContent='#fluid-live-panel{position:fixed;left:12px;top:12px;z-index:30;width:min(420px,calc(100vw - 48px));padding:12px;border-radius:10px;background:#10202ef0;color:#e6edf4;font:13px system-ui}#fluid-live-panel.fluid-compact{top:auto;bottom:12px}#fluid-live-panel.fluid-compact>*:not(b):not(#fluid-collapse):not(#fluid-status):not(#fluid-run):not(#fluid-application){display:none!important}#fluid-live-panel [hidden]{display:none!important}#fluid-live-panel p{margin:8px 0}#fluid-live-panel button,#fluid-live-panel select{font:inherit;margin:4px;padding:6px}#fluid-live-panel label{display:block;margin:8px 0}#fluid-live-panel input{width:150px;vertical-align:middle}#hud,#game,#panel,#help,#topcard,#compass,#perf,#gperf,#keys{visibility:hidden}';
  document.head.append(style);
  if(play)style.textContent+='#fluid-live-panel{max-height:calc(100vh - 48px);overflow-y:auto}';
  const panel=document.createElement('section');panel.id='fluid-live-panel';
  panel.innerHTML='<b>Генакер: отпускание и возврат верёвки</b><p>Лабораторный опыт. Нагрузка на парус сохранена заранее. Движение опоры рассчитано с назначенными массами; настоящий ветер, руль и силы воды ещё не подключены.</p><label>Сторона при перезапуске <select id="fluid-side"><option value="plus">Первая</option><option value="minus">Другая</option></select></label><label>Нагрузка на парус <input id="fluid-pressure" type="range" min="0" max="150" value="100" step="5"> <output id="fluid-pressure-value">100%</output></label><label>Внешний поворачивающий момент <input id="fluid-yaw" type="range" min="-100" max="100" value="0" step="10"> <output id="fluid-yaw-value">0 Н·м</output></label><p id="fluid-sheet-state">Верёвка ещё не подготовлена.</p><button id="fluid-sheet-in" disabled>Подтягивать</button><button id="fluid-sheet-hold" disabled>Держать</button><button id="fluid-sheet-out" disabled>Отпускать</button><p id="fluid-sheet-command"></p><button id="fluid-cycle" disabled>Показать цикл</button><button id="fluid-prepare">Начать заново</button><button id="fluid-run" disabled>Запустить</button><button id="fluid-step" disabled>Один шаг</button><button id="fluid-save" disabled>Скачать запись</button><p id="fluid-status">Подготовьте опыт. Один запуск — до 5 секунд модельного времени.</p><p id="fluid-speed"></p>';
  document.body.append(panel);
  if(play)panel.querySelector('b').textContent='Управление генакером';
  const collapse=document.createElement('button');collapse.id='fluid-collapse';collapse.textContent='Свернуть панель';panel.prepend(collapse);
  collapse.onclick=()=>{const compact=panel.classList.toggle('fluid-compact');collapse.textContent=compact?'Показать управление':'Свернуть панель';};
  const inspect=document.createElement('button');inspect.id='fluid-inspect';inspect.textContent='Показать запись';inspect.disabled=true;panel.querySelector('#fluid-save').after(inspect);
  const saveProject=document.createElement('button');saveProject.textContent='Сохранить в проект';saveProject.disabled=true;inspect.after(saveProject);
  const savedRecord=document.createElement('p');saveProject.after(savedRecord);
  const recordDialog=document.createElement('dialog');recordDialog.innerHTML='<p>Запись принятого опыта</p><textarea aria-label="Запись опыта" readonly style="width:min(75vw,700px);height:50vh"></textarea><p><button>Закрыть</button></p>';
  document.body.append(recordDialog);recordDialog.querySelector('button').onclick=()=>recordDialog.close();
  // Ветер доступен только отдельной постановке. Ползунок старой нагрузки
  // остаётся прежним для воспроизведения замороженных серий.
  panel.querySelector('#fluid-pressure').closest('label').id='fluid-pressure-label';
  panel.querySelector('#fluid-yaw').closest('label').id='fluid-yaw-label';
  const windControls=document.createElement('div');windControls.id='fluid-wind-controls';windControls.hidden=true;
  windControls.innerHTML='<label>Скорость ветра <input id="fluid-wind-speed" type="range" min="0" max="12" value="6" step="0.5"> <output id="fluid-wind-speed-value">6 м/с</output></label><label>Направление к исходному курсу <input id="fluid-wind-from" type="range" min="-180" max="180" value="140" step="5"> <output id="fluid-wind-from-value">140°</output></label><p id="fluid-air-state"></p>';
  panel.querySelector('#fluid-yaw-label').after(windControls);
  const rudderControls=document.createElement('div');rudderControls.id='fluid-rudder-controls';rudderControls.hidden=true;
  rudderControls.innerHTML='<label>Цель руля <input id="fluid-rudder" type="range" min="-25" max="25" value="0" step="1"> <output id="fluid-rudder-value">0°</output></label><p id="fluid-boat-state"></p>';
  windControls.after(rudderControls);
  const applicationReadout=document.createElement('p');applicationReadout.id='fluid-application';applicationReadout.style.color='#ffd08a';applicationReadout.hidden=true;rudderControls.after(applicationReadout);
  // Клавиши панели должны выполнять обычное действие браузера. Они не
  // управляют прежним рулём, камерой или парусами замороженного Boat.
  for(const type of ['keydown','keyup']) {
    panel.addEventListener(type,event=>event.stopPropagation());
    window.addEventListener(type,event=>{
      if(!panel.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();}
    },true);
  }
  const el=id=>panel.querySelector('#fluid-'+id),status=el('status');
  let client,fixture,geometry,snapshot,running=false,busy=false,savingRecord=false,generation=0,timer,wallMs=0,steps=[];
  let shownStep=0,initial,preparation,snapshotCGM,sheetDirection=0,automaticCycle=false,renderFrame=0;
  const waterStopped=()=>play&&snapshot?.audit?.application&&!snapshot.audit.application.dryCloth;
  const cycleDirection=()=>steps.length<30?0:steps.length<60?1:steps.length<90?0:steps.length<120?-1:0;
  const controls=()=>{
    if(fixture?.liveWind&&automaticCycle){const command=fixture.liveWind.bodyProfile?sv20WindCycleControls(steps.length,fixture.side,fixture.liveWind.cycleWind):liveWindCycleControls(steps.length,fixture.side);
      el('wind-speed').value=String(command.windSpeedMPS);el('wind-from').value=String(command.windFromDeg);el('wind-speed').oninput();el('wind-from').oninput();
      if(fixture.liveWind.bodyProfile){el('rudder').value=String(command.rudderDeg);el('rudder').oninput();}return command;}
    return {...((fixture?.liveWind)?{windSpeedMPS:Number(el('wind-speed').value),windFromDeg:Number(el('wind-from').value)}:
      {pressureScale:Number(el('pressure').value)/100,yawMomentNm:Number(el('yaw').value)}),
      ...(fixture?.liveWind?.bodyProfile?{rudderDeg:Number(el('rudder').value)}:{}),
      ...(client.ready.sheetControl?{sheetRateMPS:(automaticCycle?cycleDirection():sheetDirection)*client.ready.sheetControl.maxSpeedMPS}:{})};
  };
  for(const [id,suffix] of [['pressure','%'],['yaw',' Н·м']])el(id).oninput=()=>{el(id+'-value').textContent=el(id).value+suffix;};
  for(const [id,suffix] of [['wind-speed',' м/с'],['wind-from','°']])el(id).oninput=()=>{el(id+'-value').textContent=el(id).value+suffix;};
  for(const id of ['wind-speed','wind-from'])el(id).addEventListener('input',()=>{automaticCycle=false;sheetReadout();});
  el('rudder').oninput=()=>{el('rudder-value').textContent=el('rudder').value+'°';};
  el('rudder').addEventListener('input',()=>{automaticCycle=false;sheetReadout();});
  function sheetReadout() {
    const limits=client?.ready.sheetControl,rope=snapshot?.audit?.ropes?.[0];
    el('sheet-state').textContent=!limits?'В этой постановке нижний угол закреплён.':
      `Длина ${(rope?.lengthM??limits.minLengthM).toFixed(3)} м · диапазон ${limits.minLengthM.toFixed(3)}–${limits.maxLengthM.toFixed(3)} м`+
      (rope?` · натяжение ${rope.tensionN.toFixed(2)} Н · провис ${rope.slackM.toFixed(3)} м`:' · натяжение появится после первого шага');
    el('sheet-command').textContent=!limits?'':automaticCycle?'Цикл: держать → отпустить → держать → вернуть → держать.':
      `Следующая команда: ${sheetDirection<0?'подтягивать':sheetDirection>0?'отпускать':'держать'} · скорость ${limits.maxSpeedMPS} м/с при изменении длины.`;
    for(const [id,d] of [['sheet-in',-1],['sheet-hold',0],['sheet-out',1]])el(id).setAttribute('aria-pressed',String(!automaticCycle&&sheetDirection===d));
  }
  function stop(){running=false;sheetDirection=0;clearTimeout(timer);el('run').textContent='Запустить';panel.dataset.running='false';sheetReadout();}
  function buttons() {
    const ended=waterStopped()||!play&&steps.length>=300;
    el('run').disabled=(!running&&busy)||!client||ended;el('step').disabled=busy||running||!client||ended;
    el('save').disabled=busy||running||!snapshot;
    inspect.disabled=el('save').disabled;
    saveProject.disabled=el('save').disabled||savingRecord;
    for(const id of ['sheet-in','sheet-hold','sheet-out'])el(id).disabled=!client?.ready.sheetControl||ended;
    el('cycle').disabled=busy||!client?.ready.sheetControl;
  }
  async function step(token=generation) {
    if(!client||busy||waterStopped()||!play&&steps.length>=300)return;
    busy=true;buttons();const sentAt=performance.now(),sentFrame=renderFrame,command=controls();
    try {
      const result=await client.step(command);if(token!==generation)return;
      const receivedAt=performance.now();wallMs+=receivedAt-sentAt;
      snapshot=result;steps.push({...result,positions:Array.from(result.positions),forceN:Array.from(result.forceN),sentAt,receivedAt,
        visibilityState:document.visibilityState,...(play?{frames:{sent:sentFrame,received:renderFrame}}:{})});
      if(play&&steps.length>300)steps.shift();
      if(fixture.liveWind)el('air-state').textContent=`Ветер ${result.audit.air.windSpeedMPS.toFixed(1)} м/с · направление ${result.audit.air.windFromDeg.toFixed(0)}° · нагрузка на парус ${Math.hypot(...result.audit.air.totalForceN).toFixed(1)} Н`;
      if(fixture.liveWind?.bodyProfile){const {phi,psi}=sv20BodyAngles(result.body.orientation9),V=rotate3(result.body.orientation9,result.body.velocity6.slice(0,3));
        el('boat-state').textContent=`Ход ${Math.hypot(V[0],V[1]).toFixed(2)} м/с · крен ${(phi*180/Math.PI).toFixed(1)}° · курс ${(psi*180/Math.PI).toFixed(1)}° · руль ${result.audit.water.rudderDeg.toFixed(1)}°`;}
      if(result.audit.application){el('application').hidden=result.audit.application.dryCloth;el('application').textContent='Парус касается воды: водная нагрузка на ткань пока не рассчитана. Этот участок выходит за проверенную область.';}
      sheetReadout();
      panel.dataset.step=String(result.index);panel.dataset.modelSeconds=String(result.index*result.hS);
      status.textContent=`Принято ${result.index} шагов · время модели ${(result.index*result.hS).toFixed(2)} с · последний расчёт ${result.stepMs.toFixed(1)} мс`;
      el('speed').textContent=play?'Модельное время замедлено; ветер, верёвка и руль применяются на следующем шаге.':`Темп расчёта: ${(result.index*result.hS/(wallMs/1000)).toFixed(2)}× реального времени (без пауз и ожидания кадра).`;
      if(play&&result.audit.application&&!result.audit.application.dryCloth){stop();status.textContent+=' · остановка у воды';}
      else if(!play&&steps.length>=300){stop();status.textContent+=' · окно завершено';}
      else if(automaticCycle&&steps.length>=180){automaticCycle=false;stop();status.textContent+=' · цикл завершён';}
    } catch(error) {
      if(token!==generation)return;
      stop();client?.terminate();client=undefined;status.textContent='Расчёт остановлен: '+error.message+'. Показан последний принятый шаг.';
      panel.dataset.error=error.message;
    } finally {
      if(token===generation){busy=false;buttons();}
    }
    if(!play&&token===generation&&running&&client)timer=setTimeout(()=>{void step(token);},Math.max(0,fixture.recipe.hS*1000-(performance.now()-sentAt)));
  }
  async function prepare(cycle=false) {
    const token=++generation;stop();automaticCycle=cycle;client?.terminate();client=undefined;busy=true;snapshot=undefined;steps=[];wallMs=0;shownStep=0;renderFrame=0;preparation=undefined;savedRecord.replaceChildren();sheetReadout();
    if(cycle)for(const [id,value] of [['pressure','100'],['yaw','0']]){el(id).value=value;el(id).oninput();}
    delete panel.dataset.error;panel.dataset.step='0';buttons();status.textContent='Проверяю вход и подготавливаю расчёт…';
    let prepared;
    try {
      const prepareStart=performance.now(),bytes=await bytesAt(`out/acceptance/${prefix}-${el('side').value}.json`),input=JSON.parse(new TextDecoder().decode(bytes));
      if(input.schema!=='cloth-fluid-live-v1'||input.side!==el('side').value)throw new Error('Некорректная постановка');
      for(const [path,sha] of Object.entries(input.sourceSha256))if(await digest(await bytesAt(path))!==sha)throw new Error('Изменились исходники: '+path);
      if(await digest(await bytesAt(location.pathname.slice(1)))!==input.scene.sha256)throw new Error('Пересобранная сцена требует новой серии');
      if(await digest(await bytesAt('out/export/physics.json'))!==input.physicsSha256)throw new Error('Изменился физический пакет');
      if(Boolean(input.sheet)!==Boolean(input.sheetProof))throw new Error('Верёвке требуется сохранённое доказательство');
      if(input.sheetProof) {
        const proofBytes=await bytesAt(input.sheetProof.path);
        if(await digest(proofBytes)!==input.sheetProof.sha256)throw new Error('Изменился опыт верёвки');
        const proof=JSON.parse(new TextDecoder().decode(proofBytes));
        if(proof.schema!=='cloth-fluid-rope-sail-v1'||proof.phase!=='complete'||proof.dirty||proof.revision!==input.sheetProof.revision||
            proof.input.sha256!==input.input.sha256||proof.physicsSha256!==input.physicsSha256||proof.parameters.hS!==input.recipe.hS||
            JSON.stringify(proof.parameters.sheet)!==JSON.stringify(input.sheet)||JSON.stringify(proof.parameters.bodyInput)!==JSON.stringify(input.bodyInput))
          throw new Error('Верёвка не соответствует сохранённому опыту');
      }
      const wasm=await bytesAt(input.wasm.path);if(await digest(wasm)!==input.wasm.sha256)throw new Error('Изменился WASM');
      let materialBytes,assemblyBytes;
      if(input.materialWasm!==undefined) {
        if(!input.materialWasm?.path||!/^[a-f0-9]{64}$/.test(input.materialWasm.sha256))throw new Error('Некорректный модуль материала');
        materialBytes=await bytesAt(input.materialWasm.path);
        if(await digest(materialBytes)!==input.materialWasm.sha256)throw new Error('Изменился WASM материала');
      }
      if(input.assemblyWasm!==undefined) {
        if(!input.assemblyWasm?.path||!/^[a-f0-9]{64}$/.test(input.assemblyWasm.sha256))throw new Error('Некорректный модуль сборки');
        assemblyBytes=await bytesAt(input.assemblyWasm.path);
        if(await digest(assemblyBytes)!==input.assemblyWasm.sha256)throw new Error('Изменился WASM сборки');
      }
      const verifiedAt=performance.now();
      let liveWind;
      if(input.liveWind){if(input.liveWind.model!=='rig-current-surface-body-projected-v1')throw new Error('Неизвестная постановка живого ветра');
        if(input.liveWind.bodyProfile!==undefined&&input.liveWind.bodyProfile!=='sv20-rig-budget-point-v1')throw new Error('Неизвестный профиль SV20');
        if(input.liveWind.bodyProfile&&input.liveWind.worldVelocityDampingHz!==0)throw new Error('Вход SV20 содержит мировое торможение ткани');
        liveWind={pack:JSON.parse(new TextDecoder().decode(await bytesAt('out/export/physics.json'))),wind:input.liveWind.wind,...(input.liveWind.bodyProfile?{bodyProfile:input.liveWind.bodyProfile}:{})};}
      if(play&&!input.liveWind?.bodyProfile)throw new Error('Живому управлению нужна постановка SV20 с ветром и водой');
      prepared=await createFluidWorker(input.recipe,input.bodyInput,wasm,{sheet:input.sheet,profile:input.profileWorker??false,frameSliced:play,materialBytes,assemblyBytes,...(liveWind?{liveWind}:{})});
      if(Boolean(prepared.ready.material)!==Boolean(input.materialWasm))throw new Error('Расчёт выбрал другой материал');
      if(Boolean(prepared.ready.assembly)!==Boolean(input.assemblyWasm))throw new Error('Расчёт выбрал другую сборку');
      if(Boolean(prepared.ready.massBudget)!==Boolean(input.liveWind?.bodyProfile))throw new Error('Расчёт выбрал другую массу опоры');
      if(input.liveWind?.bodyProfile&&prepared.ready.liveWind.worldVelocityDampingHz!==0)throw new Error('В SV20 включено мировое торможение');
      if(token!==generation){prepared.terminate();return;}
      client=prepared;fixture=input;snapshot=client.ready;snapshotCGM=client.ready.geometryCGM?.slice();initial={positions:Array.from(snapshot.positions),body:structuredClone(snapshot.body)};
      panel.querySelector('#fluid-pressure-label').hidden=Boolean(liveWind);panel.querySelector('#fluid-yaw-label').hidden=Boolean(liveWind);windControls.hidden=!liveWind;
      rudderControls.hidden=!input.liveWind?.bodyProfile;
      panel.querySelector('p').textContent=input.liveWind?.bodyProfile?'Парус и яхта движутся вместе. Эксперимент: спокойная вода до начала глиссирования, без экипажа; масса из пакета SV20, доля генакера оценочная.':liveWind?'Ветер пересчитывает нагрузку по движущемуся парусу. Корпус показывает общую лабораторную опору: руль, плавучесть и сопротивление воды ещё не подключены.':'Лабораторный опыт. Нагрузка на парус сохранена заранее. Движение опоры рассчитано с назначенными массами; настоящий ветер, руль и силы воды ещё не подключены.';
      if(liveWind){el('wind-speed').value=String(input.liveWind.wind.speedMPS);el('wind-from').value=String(input.liveWind.wind.fromDeg);el('wind-speed').oninput();el('wind-from').oninput();el('air-state').textContent='Нагрузка появится после первого шага.';}
      el('application').hidden=true;
      if(input.liveWind?.bodyProfile){el('rudder').value='0';el('rudder').oninput();el('boat-state').textContent='Ход и крен появятся после первого шага.';}
      preparation={verifyMs:verifiedAt-prepareStart,workerMs:performance.now()-verifiedAt,setupMs:client.ready.setupMs,
        ...(client.ready.material?{material:client.ready.material}:{}),
        ...(client.ready.assembly?{assembly:client.ready.assembly}:{}),
        ...(client.ready.massBudget?{massBudget:client.ready.massBudget,geometryCGM:client.ready.geometryCGM}:{}),
        ...(input.profileWorker?{compileMs:client.ready.compileMs,modelMs:client.ready.modelMs}:{}),
        visibilityState:document.visibilityState};
      geometry?.dispose();geometry=new BufferGeometry();
      geometry.setAttribute('position',new BufferAttribute(new Float32Array(snapshot.positions.length),3));
      geometry.setAttribute('color',new BufferAttribute(new Float32Array(snapshot.positions.length).fill(1),3));
      geometry.setIndex(gridTriangles(input.recipe.rows,input.recipe.cols).flat());genSail.geometry=geometry;
      sheetReadout();
      const cycleWind=input.liveWind?.cycleWind??{baseMPS:6,peakMPS:7};
      status.textContent='Готово. Выберите команду верёвки и запустите опыт. «Показать цикл» повторит отпускание на 25 см и возврат за 3 секунды модели.'+(liveWind?` В цикле ветер меняет скорость ${cycleWind.baseMPS}→${cycleWind.peakMPS}→${cycleWind.baseMPS} м/с и направление 140→130→160→140° для выбранной стороны.`:'')+(input.dirty?' Вход подготовлен с незакоммиченными изменениями.':'');
      el('speed').textContent='';
      if(play){status.textContent='Готово к управлению. Отпускайте и подтягивайте верёвку, меняйте ветер и руль. Время замедлено.';
        panel.querySelector('p').textContent='Парус и яхта движутся вместе. Пока доступны спокойная вода и генакер без экипажа; у контакта паруса с водой движение остановится.';}
    } catch(error) {
      prepared?.terminate();if(token===generation){status.textContent=error.message;panel.dataset.error=error.message;}
    } finally {if(token===generation){busy=false;buttons();}}
    if(token===generation&&(cycle||play)&&client)start();
  }
  function start(){running=true;el('run').textContent='Пауза';panel.dataset.running='true';if(!play)void step();}
  el('prepare').onclick=()=>{void prepare();};
  el('cycle').onclick=()=>{void prepare(true);};
  for(const [id,direction] of [['sheet-in',-1],['sheet-hold',0],['sheet-out',1]])el(id).onclick=()=>{automaticCycle=false;sheetDirection=direction;sheetReadout();};
  el('run').onclick=()=>{if(running){stop();buttons();}else start();};
  el('step').onclick=()=>{void step();};
  function recordedText() {
    const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
    const record={schema:'cloth-fluid-live-result-v1',fixture,initial,steps:serial(steps),shownStep,wallMs,preparation,
      ...(play?{session:{mode:'continuous-three-frame-parts-v1',firstStep:steps[0]?.index??0,lastStep:snapshot?.index??0,retainedSteps:steps.length,completeHistory:!steps.length||steps[0].index===1}}:{}),
      environment:{userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,
        devicePixelRatio,viewport:[innerWidth,innerHeight],visibilityState:document.visibilityState,crossOriginIsolated},
      scope:fixture.liveWind?.bodyProfile?'SV20: единый сухой бюджет с явной оценкой доли генакера, спокойная вода/малый ход/руль, без экипажа/течения/волн/глиссирования. Прежний проекционный воздух; G1–G4/C1 не приняты.':fixture.liveWind?'Живой ветер по принятой форме/движению; прежняя проекционная аэродинамика, лабораторные масса и вода. Руль/гидросилы/сухой бюджет SV20 ещё не подключены.':
        'Живой лабораторный опыт; неподвижное поле с управляемым масштабом давления, внешним моментом и необязательной верёвкой. Нет закона воздуха, руля, гидросил и измеренных масс SV20; пик идеальной нерастяжимой верёвки не принят как реальная нагрузка.'};
    return JSON.stringify(record,null,2)+'\n';
  }
  inspect.onclick=()=>{recordDialog.querySelector('textarea').value=recordedText();recordDialog.showModal();};
  saveProject.onclick=async()=>{const token=generation;savingRecord=true;buttons();savedRecord.textContent='Сохранение записи…';
    try{const receipt=await saveBrowserRecord(recordedText());if(token!==generation)return;
      const a=document.createElement('a');a.href='/'+receipt.file;a.textContent='Запись сохранена: '+receipt.file;savedRecord.replaceChildren(a);}
    catch(error){if(token===generation)savedRecord.textContent='Запись не сохранена: '+error.message;}
    finally{savingRecord=false;buttons();}};
  el('save').onclick=()=>{
    const url=URL.createObjectURL(new Blob([recordedText()],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`${prefix}-${fixture.side}-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  if(play)void prepare();
  return {
    pose(){},frame(){if(play){renderFrame++;if(client){if(busy)client.resume();else if(running)void step();}}},
    update() {
      if(!snapshot||!geometry)return;
      const {originM,orientation9}=snapshot.body,RT=transpose3(orientation9),positions=snapshot.positions;
      const geometryCGM=snapshotCGM;
      const geometryOriginM=geometryCGM?originM.map((v,d)=>v-rotate3(orientation9,geometryCGM)[d]):originM;
      // Полотно задано в мире. Сначала в связанные оси, затем единый перевод сцены.
      const a=geometry.attributes.position;
      for(let i=0;i<positions.length/3;i++) {
        const p=rotate3(RT,[positions[3*i]-originM[0],positions[3*i+1]-originM[1],positions[3*i+2]-originM[2]]);
        const g=geometryCGM?p.map((v,d)=>v+geometryCGM[d]):p;
        a.setXYZ(i,bodyPointLocalX(g[0]),bodyPointLocalY(g[2]),bodyPointLocalZ(g[1]));
      }
      a.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingSphere();
      boatGroup.matrixAutoUpdate=false;boatGroup.matrix.set(...bodyPoseSceneMatrix(geometryOriginM,orientation9));boatGroup.matrixWorldNeedsUpdate=true;
      if(crewGroup)crewGroup.visible=!geometryCGM;
      if(rudderPivot&&geometryCGM)rudderPivot.rotation.y=rudderRotY((snapshot.audit?.water.rudderDeg??0)*Math.PI/180);
      const shownWind=snapshot.audit?.air??snapshot.liveWind?.wind;
      if(windVisual&&shownWind){windVisual.direction.value=shownWind.windFromDeg*Math.PI/180;windVisual.speed.value=shownWind.windSpeedMPS;windVisual.gust.value=0;windVisual.shade.value=0;windVisual.time.value=snapshot.index*snapshot.hS;}
      // Лабораторные оси не привязаны к акватории; фоновые объекты не участвуют.
      for(const object of scene.children)if(object!==boatGroup&&object!==sea&&!object.isLight&&object!==sunTarget)object.visible=false;
      genSail.visible=true;mainSail.visible=false;jibSail.visible=false;
      // Ленточки читают остановленный Rig; воздух Worker им пока не передаётся.
      for(const indicator of indicators)indicator.visible=false;
      const [x,y,z]=geometryOriginM;camera.position.set(x+9,z+5,-y+16);camera.lookAt(x+3,z+4,-y);
      shownStep=snapshot.index??0;panel.dataset.shownStep=String(shownStep);
      const saved=steps.at(-1);if(saved?.index===shownStep&&saved.presentedAt===undefined){saved.presentedAt=performance.now();if(play)saved.frames.presented=renderFrame;}
    }
  };
}
