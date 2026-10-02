// Только измерительный стенд: основная физика Boat не переключается.
import * as THREE from '../viewer/vendor/three.webgpu.js';
import { browserMotion } from '../tests/lib/cloth-browser-motion.mjs';
import { loadSparseFactor } from '../tests/lib/cloth-sparse-wasm.mjs';
import { gridTriangles } from '../tests/lib/cloth-material.mjs';
import { IMPLICIT_TOLERANCES } from '../tests/lib/cloth-implicit-motion.mjs';

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
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
let renderer, scene, camera, geometry;
async function prepareScene(positions, rows, cols) {
  if (!renderer) {
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
  $('run').disabled = true; $('tack').disabled = true; $('download').hidden = true; $('report').textContent = '';
  let report;
  try {
    if (document.visibilityState !== 'visible') throw new Error('Вкладка должна быть видима');
    const series = new URLSearchParams(location.search).get('series') || 'browser-cloth';
    if (!/^[a-z0-9-]+$/.test(series)) throw new Error('Недопустимое имя серии');
    const tack = $('tack').value, fixturePath = `out/acceptance/${series}-${tack}.json`;
    $('status').textContent = 'Проверка сохранённого входа и исходников…';
    const fixtureBytes = await bytesAt(fixturePath), fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const changed = [];
    // Проверка не входит в время физического шага; порядок чтения детерминирован.
    for (const [path, sha] of Object.entries(fixture.sourceSha256)) if (await digest(await bytesAt(path)) !== sha) changed.push(path);
    if (changed.length) throw new Error('После подготовки изменились исходники: '+changed.join(', '));
    const loadStart = performance.now(), wasmBytes = await bytesAt(fixture.wasm.path), fetchedMs = performance.now()-loadStart;
    if (await digest(wasmBytes) !== fixture.wasm.sha256) throw new Error('Изменился модуль WASM');
    const compileStart = performance.now(), factor = await loadSparseFactor(wasmBytes), compileMs = performance.now()-compileStart;
    const setupStart = performance.now(), calculation = browserMotion(fixture.recipe,factor), setupMs = performance.now()-setupStart;
    const { motion } = calculation;
    const sceneStart = performance.now(); await prepareScene(motion.pos,fixture.recipe.rows,fixture.recipe.cols);
    // Предварительные кадры исключают первую компиляцию графических программ.
    for (let i = 0; i < 20; i++) { await frame(); draw(motion.pos); }
    const sceneWarmupMs = performance.now()-sceneStart;
    const renderOnly = [], intervalsOnly = [];
    let previousFrame;
    for (let i = 0; i < 60; i++) {
      const t = await frame(); if (previousFrame !== undefined) intervalsOnly.push(t-previousFrame);
      previousFrame = t; renderOnly.push(draw(motion.pos));
    }
    const warmSteps = [], liveSteps = [], frameCosts = [], liveIntervals = [], allSteps = [];
    let maxPositionDifferenceM = 0, maxEnergyDifferenceJ = 0, maxForceN = 0, maxLengthM = 0, maxDualN = 0, maxComplementarityJ = 0;
    let stepIndex = 0, hidden = false;
    const visibility = () => { if (document.visibilityState !== 'visible') hidden = true; };
    document.addEventListener('visibilitychange',visibility);
    function advance(times) {
      visibility(); const t = performance.now(), audit = calculation.step(); times.push(performance.now()-t);
      const expected = fixture.expected[stepIndex++];
      for (let i = 0; i < motion.mass.length; i++) maxPositionDifferenceM = Math.max(maxPositionDifferenceM,
        Math.hypot(...Array.from(motion.pos.slice(3*i,3*i+3),(v,d) => v-expected.positionsM[3*i+d])));
      for (const [key,value] of Object.entries(audit)) if (key.endsWith('J') && typeof value === 'number')
        maxEnergyDifferenceJ = Math.max(maxEnergyDifferenceJ,Math.abs(value-expected.audit[key]));
      maxForceN = Math.max(maxForceN,audit.solver.maxForceResidualN);
      maxLengthM = Math.max(maxLengthM,audit.solver.maxHardViolationM);
      for (const c of motion.hard) if (c.unilateral)
        maxDualN = Math.max(maxDualN,c.lambda/(fixture.recipe.hS**2));
      maxComplementarityJ = Math.max(maxComplementarityJ,audit.solver.complementarityJ);
      allSteps.push({ timeMs: times.at(-1), iterations: audit.solver.iterations });
    }
    $('status').textContent = 'Начальная посадка: 40 шагов…';
    for (let i = 0; i < 40; i++) { await frame(); advance(warmSteps); draw(motion.pos); }
    $('status').textContent = 'Движение: 60 шагов, накопленное время сохраняется…';
    const start = await frame(); previousFrame = start;
    let maxLagMs = 0, maxStepsPerFrame = 0;
    while (stepIndex < 100) {
      const t = await frame(), costStart = performance.now(); liveIntervals.push(t-previousFrame); previousFrame = t;
      const due = Math.min(60,Math.floor((t-start)/(1000/60)));
      let steps = 0;
      while (stepIndex-40 < due && steps < 4) { advance(liveSteps); steps++; }
      draw(motion.pos); frameCosts.push(performance.now()-costStart);
      maxStepsPerFrame = Math.max(maxStepsPerFrame,steps);
      maxLagMs = Math.max(maxLagMs, Math.max(0,t-start-(stepIndex-40)*1000/60));
    }
    const elapsedMs = performance.now()-start;
    document.removeEventListener('visibilitychange',visibility);
    const physicalMatches = maxPositionDifferenceM <= 1e-8 && maxEnergyDifferenceJ <= 1e-7 &&
      maxForceN <= IMPLICIT_TOLERANCES.forceToleranceN && maxLengthM <= IMPLICIT_TOLERANCES.lengthToleranceM &&
      maxDualN <= IMPLICIT_TOLERANCES.dualToleranceN && maxComplementarityJ <= IMPLICIT_TOLERANCES.complementarityToleranceJ;
    report = { schema: 1, complete: true, createdAt: new Date().toISOString(),
      fixture: { path: fixturePath, sha256: await digest(fixtureBytes), revision: fixture.revision, dirty: fixture.dirty },
      wasm: fixture.wasm, environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        renderer: renderer.backend.constructor.name, pixelRatio: devicePixelRatio,
        canvasPixels: [renderer.domElement.width,renderer.domElement.height], hiddenDuringCalculation: hidden },
      scope: 'Один генакер и сетка пола; без лодки, воды и пересчёта воздуха. Время отрисовки — команды CPU, не завершение GPU.',
      preparation: { fetchedMs, compileMs, setupMs, sceneWarmupMs },
      wasmMemory: factor.statistics?.(),
      renderOnly: statistics(renderOnly), renderOnlyIntervals: statistics(intervalsOnly),
      warmup: statistics(warmSteps), live: statistics(liveSteps), liveFrameCost: statistics(frameCosts), liveFrameIntervals: statistics(liveIntervals),
      scheduler: { hS: fixture.recipe.hS, elapsedMs, simulationMs: 1000, maxLagMs, maxStepsPerFrame, discardedTimeMs: 0 },
      comparison: { physicalMatches, maxPositionDifferenceM, maxEnergyDifferenceJ, maxForceN, maxLengthM, maxDualN, maxComplementarityJ,
        checkedSteps: stepIndex, tolerances: IMPLICIT_TOLERANCES }, allSteps,
      valid: physicalMatches && !hidden && !fixture.dirty };
    $('status').textContent = report.valid ? 'Измерение завершено; все 100 шагов совпали с проверенным расчётом.' : 'Измерение завершено с ограничением; см. результат.';
  } catch (e) { report = { complete: false, error: e.message }; $('status').textContent = 'Измерение отклонено: '+e.message; }
  $('report').textContent = JSON.stringify(report,null,2);
  const blob = new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'});
  if ($('download').href.startsWith('blob:')) URL.revokeObjectURL($('download').href);
  $('download').href = URL.createObjectURL(blob); $('download').download = 'cloth-browser-result.json'; $('download').hidden = false;
  $('run').disabled = false; $('tack').disabled = false;
});
