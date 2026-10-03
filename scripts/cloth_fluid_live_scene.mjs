// Живой лабораторный режим общей ткани/опоры. Вид читает принятый шаг Worker.
import {createFluidWorker} from '../tests/lib/cloth-fluid-client.mjs';
import {gridTriangles} from '../tests/lib/cloth-material.mjs';
import {rotate3,transpose3} from '../tests/lib/cloth-fluid-inertia.mjs';
import {bodyPointLocalX,bodyPointLocalY,bodyPointLocalZ,bodyPoseSceneMatrix} from '../sim/axes.js';
const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
async function bytesAt(path) {
  if(!/^[\w./-]+$/.test(path)||path.includes('..'))throw new Error('Некорректный путь входа');
  const r=await fetch('/'+path,{cache:'no-store'});if(!r.ok)throw new Error(`Не удалось прочитать ${path}: ${r.status}`);
  return r.arrayBuffer();
}
export async function startFluidLiveScene({renderer,genSail,boatGroup,mainSail,jibSail,scene,sea,sunTarget,camera,BufferGeometry,BufferAttribute}) {
  if(!renderer.backend.isWebGPUBackend)throw new Error('Живой стенд требует WebGPU');
  const prefix=new URLSearchParams(location.search).get('fluid-live');
  if(!/^[\w-]+$/.test(prefix))throw new Error('Укажите имя подготовленной серии в fluid-live');
  for(const el of document.querySelectorAll('input,select,button'))el.disabled=true;
  const style=document.createElement('style');
  style.textContent='#fluid-live-panel{position:fixed;left:12px;top:12px;z-index:30;width:min(420px,calc(100vw - 48px));padding:12px;border-radius:10px;background:#10202ef0;color:#e6edf4;font:13px system-ui}#fluid-live-panel p{margin:8px 0}#fluid-live-panel button,#fluid-live-panel select{font:inherit;margin:4px;padding:6px}#fluid-live-panel label{display:block;margin:8px 0}#fluid-live-panel input{width:150px;vertical-align:middle}#hud,#game,#panel,#help,#topcard,#compass,#perf,#gperf,#keys{visibility:hidden}';
  document.head.append(style);
  const panel=document.createElement('section');panel.id='fluid-live-panel';
  panel.innerHTML='<b>Генакер и движущаяся опора: живой опыт</b><p>Это лабораторная модель. Меняется сохранённая нагрузка, а не ветер. Масса опоры и инерция воды назначены для проверки. Верёвка, настоящий руль и силы воды пока не подключены.</p><label>Сторона при перезапуске <select id="fluid-side"><option value="plus">Первая</option><option value="minus">Другая</option></select></label><label>Нагрузка на парус <input id="fluid-pressure" type="range" min="0" max="150" value="100" step="5"> <output id="fluid-pressure-value">100%</output></label><label>Внешний поворачивающий момент <input id="fluid-yaw" type="range" min="-100" max="100" value="0" step="10"> <output id="fluid-yaw-value">0 Н·м</output></label><button id="fluid-prepare">Начать заново</button><button id="fluid-run" disabled>Запустить</button><button id="fluid-step" disabled>Один шаг</button><button id="fluid-save" disabled>Скачать запись</button><p id="fluid-status">Подготовьте опыт. Один запуск — до 5 секунд модельного времени.</p><p id="fluid-speed"></p>';
  document.body.append(panel);
  // Клавиши панели должны выполнять обычное действие браузера. Они не
  // управляют прежним рулём, камерой или парусами замороженного Boat.
  for(const type of ['keydown','keyup']) {
    panel.addEventListener(type,event=>event.stopPropagation());
    window.addEventListener(type,event=>{
      if(!panel.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();}
    },true);
  }
  const el=id=>panel.querySelector('#fluid-'+id),status=el('status');
  let client,fixture,geometry,snapshot,running=false,busy=false,generation=0,timer,wallMs=0,steps=[];
  let shownStep=0,initial;
  const controls=()=>({pressureScale:Number(el('pressure').value)/100,yawMomentNm:Number(el('yaw').value)});
  for(const [id,suffix] of [['pressure','%'],['yaw',' Н·м']])el(id).oninput=()=>{el(id+'-value').textContent=el(id).value+suffix;};
  function stop(){running=false;clearTimeout(timer);el('run').textContent='Запустить';panel.dataset.running='false';}
  function buttons() {
    el('run').disabled=(!running&&busy)||!client||steps.length>=300;el('step').disabled=busy||running||!client||steps.length>=300;
    el('save').disabled=!snapshot;
  }
  async function step(token=generation) {
    if(!client||busy||steps.length>=300)return;
    busy=true;buttons();const sentAt=performance.now(),command=controls();
    try {
      const result=await client.step(command);if(token!==generation)return;
      const receivedAt=performance.now();wallMs+=receivedAt-sentAt;
      snapshot=result;steps.push({...result,positions:Array.from(result.positions),forceN:Array.from(result.forceN),sentAt,receivedAt});
      panel.dataset.step=String(result.index);panel.dataset.modelSeconds=String(result.index*result.hS);
      status.textContent=`Принято ${result.index} шагов · время модели ${(result.index*result.hS).toFixed(2)} с · последний расчёт ${result.stepMs.toFixed(1)} мс`;
      el('speed').textContent=`Темп расчёта: ${(result.index*result.hS/(wallMs/1000)).toFixed(2)}× реального времени (без пауз и ожидания кадра).`;
      if(steps.length>=300){stop();status.textContent+=' · окно завершено';}
    } catch(error) {
      if(token!==generation)return;
      stop();client?.terminate();client=undefined;status.textContent='Расчёт остановлен: '+error.message+'. Показан последний принятый шаг.';
      panel.dataset.error=error.message;
    } finally {
      if(token===generation){busy=false;buttons();}
    }
    if(token===generation&&running&&client)timer=setTimeout(()=>{void step(token);},Math.max(0,fixture.recipe.hS*1000-(performance.now()-sentAt)));
  }
  el('prepare').onclick=async()=>{
    const token=++generation;stop();client?.terminate();client=undefined;busy=true;snapshot=undefined;steps=[];wallMs=0;shownStep=0;
    delete panel.dataset.error;panel.dataset.step='0';buttons();status.textContent='Проверяю вход и подготавливаю расчёт…';
    let prepared;
    try {
      const bytes=await bytesAt(`out/acceptance/${prefix}-${el('side').value}.json`),input=JSON.parse(new TextDecoder().decode(bytes));
      if(input.schema!=='cloth-fluid-live-v1'||input.side!==el('side').value)throw new Error('Некорректная постановка');
      for(const [path,sha] of Object.entries(input.sourceSha256))if(await digest(await bytesAt(path))!==sha)throw new Error('Изменились исходники: '+path);
      if(await digest(await bytesAt(location.pathname.slice(1)))!==input.scene.sha256)throw new Error('Пересобранная сцена требует новой серии');
      if(await digest(await bytesAt('out/export/physics.json'))!==input.physicsSha256)throw new Error('Изменился физический пакет');
      const wasm=await bytesAt(input.wasm.path);if(await digest(wasm)!==input.wasm.sha256)throw new Error('Изменился WASM');
      prepared=await createFluidWorker(input.recipe,input.bodyInput,wasm);
      if(token!==generation){prepared.terminate();return;}
      client=prepared;fixture=input;snapshot=client.ready;initial={positions:Array.from(snapshot.positions),body:structuredClone(snapshot.body)};
      geometry?.dispose();geometry=new BufferGeometry();
      geometry.setAttribute('position',new BufferAttribute(new Float32Array(snapshot.positions.length),3));
      geometry.setAttribute('color',new BufferAttribute(new Float32Array(snapshot.positions.length).fill(1),3));
      geometry.setIndex(gridTriangles(input.recipe.rows,input.recipe.cols).flat());genSail.geometry=geometry;
      status.textContent='Готово. Запустите опыт и меняйте нагрузку.'+(input.dirty?' Вход подготовлен с незакоммиченными изменениями.':'');
      el('speed').textContent='';
    } catch(error) {
      prepared?.terminate();if(token===generation){status.textContent=error.message;panel.dataset.error=error.message;}
    } finally {if(token===generation){busy=false;buttons();}}
  };
  el('run').onclick=()=>{if(running){stop();buttons();}else{running=true;el('run').textContent='Пауза';panel.dataset.running='true';void step();}};
  el('step').onclick=()=>{void step();};
  el('save').onclick=()=>{
    const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
    const record={schema:'cloth-fluid-live-result-v1',fixture,initial,steps:serial(steps),shownStep,wallMs,
      scope:'Живой лабораторный опыт; неподвижное поле с управляемым масштабом давления и внешним моментом. Нет закона воздуха, верёвки, руля, гидросил и измеренных масс SV20.'};
    const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)+'\n'],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`${prefix}-${fixture.side}-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return {
    pose(){},frame(){},
    update() {
      if(!snapshot||!geometry)return;
      const {originM,orientation9}=snapshot.body,RT=transpose3(orientation9),positions=snapshot.positions;
      // Полотно задано в мире. Сначала в связанные оси, затем единый перевод сцены.
      const a=geometry.attributes.position;
      for(let i=0;i<positions.length/3;i++) {
        const p=rotate3(RT,[positions[3*i]-originM[0],positions[3*i+1]-originM[1],positions[3*i+2]-originM[2]]);
        a.setXYZ(i,bodyPointLocalX(p[0]),bodyPointLocalY(p[2]),bodyPointLocalZ(p[1]));
      }
      a.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingSphere();
      boatGroup.matrixAutoUpdate=false;boatGroup.matrix.set(...bodyPoseSceneMatrix(originM,orientation9));boatGroup.matrixWorldNeedsUpdate=true;
      // Лабораторные оси не привязаны к акватории; фоновые объекты не участвуют.
      for(const object of scene.children)if(object!==boatGroup&&object!==sea&&!object.isLight&&object!==sunTarget)object.visible=false;
      genSail.visible=true;mainSail.visible=false;jibSail.visible=false;
      const [x,y,z]=originM;camera.position.set(x+9,z+5,-y+16);camera.lookAt(x+3,z+4,-y);
      shownStep=snapshot.index??0;panel.dataset.shownStep=String(shownStep);
      const saved=steps[shownStep-1];if(saved&&saved.presentedAt===undefined)saved.presentedAt=performance.now();
    }
  };
}
