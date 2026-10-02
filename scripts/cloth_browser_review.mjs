// Только измерительный стенд: основная физика Boat не переключается.
import { browserMotion } from '../tests/lib/cloth-browser-motion.mjs';
import { loadSparseFactor } from '../tests/lib/cloth-sparse-wasm.mjs';
import { gridTriangles } from '../tests/lib/cloth-material.mjs';
import { IMPLICIT_TOLERANCES } from '../tests/lib/cloth-implicit-motion.mjs';
import { createMotionWorker } from '../tests/lib/cloth-browser-client.mjs';

const $ = id => document.getElementById(id);
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
const bytesAt = async path => {
  const r = await fetch('/' + path); if (!r.ok) throw new Error(`Не удалось прочитать ${path}: ${r.status}`);
  return r.arrayBuffer();
};
const statistics = a => {
  const s = a.slice().sort((x,y) => x-y);
  return { count: a.length, meanMs: a.reduce((t,x) => t+x,0)/a.length,
    p50Ms: s[Math.ceil(s.length*.5)-1], p95Ms: s[Math.ceil(s.length*.95)-1], maxMs: s.at(-1) };
};
// Один измеритель для отдельного паруса и основной сцены. Адаптер сцены
// отдаёт завершённые кадры её собственного цикла, а не второй рендерер.
export function mountClothReview(adapter = null) {
const frame = adapter?.nextFrame ?? (() => new Promise(resolve => requestAnimationFrame(resolve)));
const supportMode=new URLSearchParams(location.search).has('support-commands');
const profileMode=new URLSearchParams(location.search).has('worker-profile');
const controlIds=['run','tack','execution','reuse',...(supportMode?['motion']:[])];
let THREE, renderer = adapter?.renderer, scene, camera, geometry;
async function prepareScene(positions, rows, cols) {
  if (!renderer) {
    THREE = await import('../viewer/vendor/three.webgpu.js');
    renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize($('view').clientWidth, 520);
    $('view').appendChild(renderer.domElement);
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend) throw new Error('Измерение требует WebGPU');
  }
  geometry?.dispose(); scene = new THREE.Scene(); scene.background = new THREE.Color(0xdce9f0);
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions.length),3));
  geometry.setIndex(gridTriangles(rows,cols).flat());
  scene.add(new THREE.Mesh(geometry, new THREE.MeshNormalMaterial({side: THREE.DoubleSide})));
  const grid = new THREE.GridHelper(18,18,0x99adba,0xbdcdd8); scene.add(grid);
  updateScene(positions);
  geometry.computeBoundingSphere();
  const center = geometry.boundingSphere.center, radius = geometry.boundingSphere.radius;
  camera = new THREE.PerspectiveCamera(38,$('view').clientWidth/520,.1,200);
  camera.position.copy(center).add(new THREE.Vector3(radius*2.4,radius*.5,radius*2.3)); camera.lookAt(center);
}
function updateScene(pos) {
  const a = geometry.attributes.position;
  for (let i = 0; i < pos.length/3; i++) a.setXYZ(i,pos[3*i],pos[3*i+2],-pos[3*i+1]);
  a.needsUpdate = true; geometry.computeVertexNormals();
}
function draw(pos) {
  const start = performance.now(); updateScene(pos); renderer.render(scene,camera);
  return performance.now()-start;
}

$('run').addEventListener('click', async () => {
  const preparationTimeline=[{stage:'start',atMs:performance.now()}];
  const mark=stage=>preparationTimeline.push({stage,atMs:performance.now()});
  for (const id of controlIds) $(id).disabled = true;
  $('download').hidden = true; $('report').textContent = '';
  let report, workerClient, drawTask, stopDrawing = false, drawFailure;
  let visibility,detachCommand;
  try {
    if (document.visibilityState !== 'visible') throw new Error('Вкладка должна быть видима');
    const series = new URLSearchParams(location.search).get('series') || 'browser-cloth';
    if (!/^[a-z0-9-]+$/.test(series)) throw new Error('Недопустимое имя серии');
    if (supportMode && (!adapter || !$('command'))) throw new Error('Команды доступны в измерении полной сцены');
    const tack = $('tack').value, action=supportMode?$('motion').value:undefined;
    const fixturePath = `out/acceptance/${series}-${tack}${supportMode?'-'+action:''}.json`;
    $('status').textContent = 'Проверка сохранённого входа и исходников…';
    const fixtureBytes = await bytesAt(fixturePath), fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    mark('fixtureLoaded');
    if(Boolean(fixture.workerProfile)!==profileMode)throw new Error('Режим измерения стадий не соответствует входу');
    if(profileMode && $('execution').value!=='worker')throw new Error('Стадии измеряются в отдельном потоке');
    if (Boolean(fixture.supportCommands)!==supportMode || (supportMode && fixture.supportCommands.action!==action))
      throw new Error('Постановка не соответствует выбранной команде');
    const measurement = fixture.measurement ?? {warmupSteps:40,liveSteps:60,durationS:1};
    const {warmupSteps,liveSteps:liveStepCount,durationS} = measurement, totalSteps = warmupSteps+liveStepCount, hMs=fixture.recipe.hS*1000;
    if (warmupSteps!==40 || !Number.isInteger(liveStepCount) || liveStepCount<60 || liveStepCount>1800 ||
        durationS!==liveStepCount*fixture.recipe.hS || fixture.expected.length!==totalSteps) throw new Error('Несогласованное окно измерения');
    const changed = [];
    // Проверка не входит в время физического шага; порядок чтения детерминирован.
    for (const [path, sha] of Object.entries(fixture.sourceSha256)) if (await digest(await bytesAt(path)) !== sha) changed.push(path);
    if (changed.length) throw new Error('После подготовки изменились исходники: '+changed.join(', '));
    mark('sourceVerified');
    const loadStart = performance.now(), wasmBytes = await bytesAt(fixture.wasm.path), fetchedMs = performance.now()-loadStart;
    mark('wasmFetched');
    if (await digest(wasmBytes) !== fixture.wasm.sha256) throw new Error('Изменился модуль WASM');
    mark('wasmVerified');
    const execution = $('execution').value, reuseMemory = $('reuse').checked;
    let factor, calculation, motion, positions, compileMs, setupMs, workerReadyMs,workerInitialMemory;
    if (execution === 'worker') {
      const start = performance.now(); workerClient = await createMotionWorker(fixture.recipe,wasmBytes,{reuse:reuseMemory,profile:profileMode});
      workerReadyMs = performance.now()-start;
      ({compileMs,setupMs} = workerClient.ready); positions = workerClient.ready.positions;
      workerInitialMemory=workerClient.ready.wasmMemory;
    } else {
      const compileStart = performance.now(); factor = await loadSparseFactor(wasmBytes,{reuse:reuseMemory}); compileMs = performance.now()-compileStart;
      const setupStart = performance.now(); calculation = browserMotion(fixture.recipe,factor); setupMs = performance.now()-setupStart;
      motion = calculation.motion; positions = motion.pos;
    }
    mark('workerReady');
    await adapter?.verify(fixture);
    mark('sceneVerified');
    const prepare = adapter?.prepareScene ?? prepareScene, drawScene = adapter?.draw ?? draw;
    const sceneStart = performance.now(); await prepare(positions,fixture.recipe.rows,fixture.recipe.cols,fixture.recipe);
    mark('geometryReady');
    // Предварительные кадры исключают первую компиляцию графических программ.
    for (let i = 0; i < 20; i++) { await frame(); drawScene(positions,0); }
    const sceneWarmupMs = performance.now()-sceneStart;
    mark('graphicsWarm');
    adapter?.beginVerification();
    const renderOnly = [], intervalsOnly = [];
    let previousFrame;
    for (let i = 0; i < 60; i++) {
      const t = await frame(); if (previousFrame !== undefined) intervalsOnly.push(t-previousFrame);
      previousFrame = t; renderOnly.push(drawScene(positions,0));
    }
    mark('renderControlFinished');
    const warmSteps = [], liveSteps = [], frameCosts = [], liveIntervals = [], allSteps = [];
    let maxPositionDifferenceM = 0, maxEnergyDifferenceJ = 0, maxSupportDifferenceN=0;
    let maxForceN = 0, maxLengthM = 0, maxDualN = 0, maxComplementarityJ = 0;
    let inputCommand;
    let stepIndex = 0, hidden = false, wasmMemory, liveDrawPhase = false, liveStart, maxResultDelayMs = 0;
    const replyTimes = [];
    visibility = () => { if (document.visibilityState !== 'visible') hidden = true; };
    document.addEventListener('visibilitychange',visibility);
    function checkStep(audit, dualViolationN, timeMs, times, trace={}) {
      const checkStart=performance.now();
      visibility(); times.push(timeMs);
      const expected = fixture.expected[stepIndex++];
      for (let i = 0; i < positions.length/3; i++) maxPositionDifferenceM = Math.max(maxPositionDifferenceM,
        Math.hypot(...Array.from(positions.slice(3*i,3*i+3),(v,d) => v-expected.positionsM[3*i+d])));
      for (const [key,value] of Object.entries(audit)) if (key.endsWith('J') && typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isFinite(expected.audit[key])) throw new Error('Неизвестная или нечисловая энергия: '+key);
        maxEnergyDifferenceJ = Math.max(maxEnergyDifferenceJ,Math.abs(value-expected.audit[key]));
      }
      for (const [key,value] of Object.entries(IMPLICIT_TOLERANCES))
        if (audit.solver[key]!==value) throw new Error('Изменён допуск решателя: '+key);
      if (expected.supportForceN) {
        if (trace.supportForceN?.length!==expected.supportForceN.length) throw new Error('Нет снимка реакций');
        trace.supportForceN.forEach((v,k)=>{if(!Number.isFinite(v))throw new Error('Нечисловая реакция');
          maxSupportDifferenceN=Math.max(maxSupportDifferenceN,Math.abs(v-expected.supportForceN[k]));});
      }
      maxForceN = Math.max(maxForceN,audit.solver.maxForceResidualN);
      maxLengthM = Math.max(maxLengthM,audit.solver.maxHardViolationM);
      maxDualN = Math.max(maxDualN,dualViolationN);
      maxComplementarityJ = Math.max(maxComplementarityJ,audit.solver.complementarityJ);
      const {supportForceN,...recordedTrace}=trace;
      allSteps.push({ timeMs: times.at(-1), iterations: audit.solver.iterations,...recordedTrace });
      if (liveDrawPhase) maxResultDelayMs = Math.max(maxResultDelayMs,performance.now()-liveStart-(stepIndex-warmupSteps)*hMs);
      allSteps.at(-1).validationMs=performance.now()-checkStart;
    }
    function advance(times) {
      const t = performance.now(), audit = calculation.step(), timeMs = performance.now()-t;
      let dual = 0; for (const c of motion.hard) if (c.unilateral) dual = Math.max(dual,c.lambda/(fixture.recipe.hS**2));
      checkStep(audit,dual,timeMs,times);
    }
    async function advanceWorker(times) {
      const supportTargets=fixture.expected[stepIndex].supportTargets;
      const t = performance.now(), reply = await workerClient.step(supportTargets),receivedAtMs=performance.now(); replyTimes.push(receivedAtMs-t);
      if (reply.index !== stepIndex || reply.type !== 'step') throw new Error('Нарушен порядок шагов ткани');
      positions = reply.positions; wasmMemory = reply.wasmMemory;
      checkStep(reply.audit,reply.dualViolationN,reply.timeMs,times,supportMode
        ? {requestAtMs:t,receivedAtMs,supportForceN:reply.supportForceN,...(supportTargets?{supportTargets}: {}),
          ...(reply.timing?{timing:reply.timing}:{})}:{});
      if (adapter) drawScene(positions,stepIndex);
      if (drawFailure) throw drawFailure;
    }
    if (workerClient) {
      // Экран продолжает работать, пока единственный запрос ожидает расчёта.
      drawTask = (async () => {
        let previous;
        while (!stopDrawing) {
          const t = await frame(); if (stopDrawing) break;
          visibility(); const frameCost = drawScene(positions,stepIndex);
          if (liveDrawPhase) {
            frameCosts.push(frameCost);
            if (previous !== undefined) liveIntervals.push(t-previous);
            previous = t;
            maxResultDelayMs = Math.max(maxResultDelayMs,performance.now()-liveStart-(stepIndex-warmupSteps)*hMs);
          }
        }
      })().catch(e => { drawFailure = e; stopDrawing = true; });
    }
    $('status').textContent = `Начальная посадка: ${warmupSteps} шагов…`;
    for (let i = 0; i < warmupSteps; i++) {
      if (workerClient) await advanceWorker(warmSteps);
      else { await frame(); advance(warmSteps); drawScene(positions,stepIndex); }
    }
    mark('clothWarm');
    $('status').textContent = `Движение: ${liveStepCount} шагов за ${durationS} с, накопленное время сохраняется…`;
    const start = supportMode?await new Promise(resolve=>{
      const button=$('command');
      button.textContent={inward:'Подтянуть и вернуть',outward:'Отвести и вернуть',held:'Удерживать'}[action];
      const click=event=>{
        button.disabled=true;
        inputCommand={...fixture.supportCommands,eventTimeMs:event.timeStamp,receivedAtMs:performance.now()};
        $('status').textContent=`Команда принята; ${liveStepCount} шагов за ${durationS} с…`;
        resolve(inputCommand.receivedAtMs);
      };
      button.addEventListener('click',click,{once:true});detachCommand=()=>button.removeEventListener('click',click);
      button.disabled=false;$('status').textContent='Расчёт подготовлен. Нажмите «'+button.textContent+'».';
    }):await frame();
    liveStart = start; liveDrawPhase = true; previousFrame = start;
    adapter?.startLive(start,measurement);
    let maxLagMs = 0, maxStepsPerFrame = 0;
    while (stepIndex < totalSteps) {
      const t = await frame(), costStart = performance.now();
      if (!workerClient) { liveIntervals.push(t-previousFrame); previousFrame = t; }
      const due = Math.min(liveStepCount,Math.floor((t-start)/hMs));
      let steps = 0;
      while (stepIndex-warmupSteps < due && steps < 4) {
        if (workerClient) await advanceWorker(liveSteps); else advance(liveSteps);
        steps++;
      }
      if (!workerClient) { drawScene(positions,stepIndex); frameCosts.push(performance.now()-costStart); }
      maxStepsPerFrame = Math.max(maxStepsPerFrame,steps);
      maxLagMs = Math.max(maxLagMs, Math.max(0,t-start-(stepIndex-warmupSteps)*hMs));
    }
    const elapsedMs = performance.now()-start;
    if (workerClient) { stopDrawing = true; await drawTask; drawScene(positions,stepIndex); }
    const sceneReport = await adapter?.finish();
    let command;
    if (supportMode) {
      const first=allSteps[warmupSteps],shown=sceneReport.frames.find(f=>f.shownStep>warmupSteps);
      if (!shown) throw new Error('Результат команды не попал в кадр');
      command={...inputCommand,firstRequestedAtMs:first.requestAtMs,firstReceivedAtMs:first.receivedAtMs,
        firstShownAtMs:shown.presentedAtMs,firstShownStep:shown.shownStep,
        requestDelayMs:first.requestAtMs-inputCommand.receivedAtMs,
        replyDelayMs:first.receivedAtMs-inputCommand.receivedAtMs,
        frameDelayMs:shown.presentedAtMs-inputCommand.receivedAtMs};
    }
    const physicalMatches = maxPositionDifferenceM <= 1e-8 && maxEnergyDifferenceJ <= 1e-7 &&
      maxForceN <= IMPLICIT_TOLERANCES.forceToleranceN && maxLengthM <= IMPLICIT_TOLERANCES.lengthToleranceM &&
      maxDualN <= IMPLICIT_TOLERANCES.dualToleranceN && maxComplementarityJ <= IMPLICIT_TOLERANCES.complementarityToleranceJ &&
      maxSupportDifferenceN <= IMPLICIT_TOLERANCES.forceToleranceN;
    report = { schema: 1, complete: true, createdAt: new Date().toISOString(), measurement,
      fixture: { path: fixturePath, sha256: await digest(fixtureBytes), revision: fixture.revision, dirty: fixture.dirty },
      wasm: fixture.wasm, environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        renderer: renderer.backend.constructor.name, pixelRatio: devicePixelRatio,
        canvasPixels: [renderer.domElement.width,renderer.domElement.height], hiddenDuringCalculation: hidden },
      scope: adapter?.scope ?? 'Один генакер и сетка пола; без лодки, воды и пересчёта воздуха. Время отрисовки — команды CPU, не завершение GPU.',
      ...(sceneReport ? { scene: sceneReport } : {}),
      ...(command?{command}:{}),
      execution, reuseMemory, workerProfile:profileMode,
      preparation: { fetchedMs, compileMs, setupMs, sceneWarmupMs, timeline:preparationTimeline,
        ...(workerClient ? {workerReadyMs,workerInitialMemory} : {}) },
      wasmMemory: workerClient ? wasmMemory : factor.statistics(),
      ...(workerClient ? {replyLatency:statistics(replyTimes)} : {}),
      renderOnly: statistics(renderOnly), renderOnlyIntervals: statistics(intervalsOnly),
      warmup: statistics(warmSteps), live: statistics(liveSteps), liveFrameCost: statistics(frameCosts), liveFrameIntervals: statistics(liveIntervals),
      scheduler: { hS: fixture.recipe.hS, elapsedMs, simulationMs:durationS*1000, maxLagMs, maxResultDelayMs, maxStepsPerFrame, discardedTimeMs: 0 },
      comparison: { physicalMatches, maxPositionDifferenceM, maxEnergyDifferenceJ, maxForceN, maxLengthM, maxDualN, maxComplementarityJ,
        ...(supportMode?{maxSupportDifferenceN}:{}),
        checkedSteps: stepIndex, tolerances: IMPLICIT_TOLERANCES }, allSteps,
      valid: physicalMatches && !hidden && !fixture.dirty && (sceneReport?.valid ?? true) };
    $('status').textContent = report.valid ? `Измерение завершено; все ${totalSteps} шагов совпали с проверенным расчётом.` : 'Измерение завершено с ограничением; см. результат.';
  } catch (e) { report = { complete: false, error: e.message }; $('status').textContent = 'Измерение отклонено: '+e.message; }
  finally {
    detachCommand?.();if($('command'))$('command').disabled=true;
    stopDrawing = true; await drawTask; workerClient?.terminate();
    adapter?.cancel();
    if (visibility) document.removeEventListener('visibilitychange',visibility);
  }
  $('report').textContent = JSON.stringify(report,null,2);
  const blob = new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'});
  if ($('download').href.startsWith('blob:')) URL.revokeObjectURL($('download').href);
  $('download').href = URL.createObjectURL(blob); $('download').download = 'cloth-browser-result.json'; $('download').hidden = false;
  for (const id of controlIds) $(id).disabled = false;
});
}

if (document.getElementById('view')) mountClothReview();
