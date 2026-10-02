// Ткань Worker в существующей сцене. Лодка и нагрузка неподвижны;
// координаты полотна не сглаживаются и не дополняются другой анимацией.
import { gridTriangles } from '../tests/lib/cloth-material.mjs';
import { mountClothReview } from './cloth_browser_review.mjs';

const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b => b.toString(16).padStart(2,'0')).join('');
const bytesAt = async path => {
  const r = await fetch('/'+path); if (!r.ok) throw new Error(`Не удалось прочитать ${path}: ${r.status}`);
  return r.arrayBuffer();
};

export async function startClothSceneReview({renderer,genSail,boat,camera,BufferGeometry,BufferAttribute,build}) {
  if (!renderer.backend.isWebGPUBackend) throw new Error('Измерение требует WebGPU');
  // Условия кадра фиксированы: обычные органы не участвуют в этом опыте.
  for (const el of document.querySelectorAll('input,select,button')) el.disabled = true;
  const style = document.createElement('style');
  style.textContent = '#cloth-review-panel{position:fixed;left:14px;top:14px;z-index:20;max-width:600px;background:#10202eea;color:#e6edf4;padding:12px;border-radius:10px;font:13px system-ui}#cloth-review-panel button,#cloth-review-panel select{font:inherit;margin:4px;padding:6px}#cloth-review-panel pre{max-height:160px;overflow:auto;font:11px monospace;white-space:pre-wrap}#hud,#game,#panel,#help,#topcard,#compass{visibility:hidden}';
  document.head.append(style);
  const panel = document.createElement('section'); panel.id = 'cloth-review-panel';
  panel.innerHTML = '<b>Генакер в полной сцене: измерение</b><p>Лодка и время воды неподвижны. Ткань получает сохранённую нагрузку; воздух и движение лодки не пересчитываются.</p><label>Сторона ветра <select id="tack"><option value="plus">Первая</option><option value="minus">Другая</option></select></label><label>Где считать <select id="execution"><option value="worker">В отдельном потоке</option></select></label><label><input id="reuse" type="checkbox" checked>Повторно использовать память</label><button id="run">Измерить</button><a id="download" hidden>Скачать результат</a><p id="status">Готов к подготовке измерения.</p><details><summary>Числа и происхождение результата</summary><pre id="report"></pre></details>';
  document.body.append(panel);

  let pending = [], positions, recipe, geometry, step = 0, shownStep = 0, lastFrame;
  let source, signature, liveStart, frames = [], errors = new Set(), verifying = false;
  const composition = () => ({ canvasPixels:[renderer.domElement.width,renderer.domElement.height],
    geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures });
  const nextFrame = () => new Promise(resolve => pending.push(resolve));
  const adapter = {
    renderer, nextFrame,
    scope: 'Полная сцена яхты и воды, Worker ткани 11×9. Лодка, крепления и нагрузка неподвижны; воздух не пересчитывается. CPU кадра не является временем завершения GPU.',
    async verify(fixture) {
      source = fixture.sceneBuild;
      if (!source || source.build.dirty || JSON.stringify(build)!==JSON.stringify(source.build) ||
          !fixture.revision.startsWith(build.commit)) throw new Error('Сборка сцены не соответствует сохранённому входу');
      if (await digest(await bytesAt(location.pathname.slice(1)))!==source.sha256) throw new Error('Изменилась собранная сцена');
      for (const [path,sha] of Object.entries(source.assets))
        if (await digest(await bytesAt(path))!==sha) throw new Error('Изменился ассет сцены: '+path);
    },
    async prepareScene(pos,rows,cols,input) {
      verifying = false; frames = []; errors.clear(); signature = undefined; liveStart = undefined;
      recipe = input; positions = pos; step = 0;
      geometry?.dispose(); geometry = new BufferGeometry();
      geometry.setAttribute('position',new BufferAttribute(new Float32Array(pos.length),3));
      geometry.setAttribute('color',new BufferAttribute(new Float32Array(pos.length).fill(1),3));
      geometry.setIndex(gridTriangles(rows,cols).flat());
      genSail.geometry = geometry;
    },
    draw(pos,index) { positions = pos; step = index; return lastFrame.cpuMs; },
    beginVerification() { signature = composition(); verifying = true; },
    startLive(start) { liveStart = start; frames = []; },
    async finish() {
      // Последний ответ должен попасть в реальный кадр, а не только в память.
      while (shownStep!==100) await nextFrame();
      verifying = false;
      return { valid:errors.size===0, errors:Array.from(errors), build:source,
        stationaryBoat:{x:0,y:0,psi:0,phi:recipe.boat.phi,th:0,zc:0},
        camera:{eye:[9,5,16],at:[3,4,0]},composition:signature,
        frames, presentation:{lastShownStep:shownStep,elapsedMs:performance.now()-liveStart,
          maxVisibleResultDelayMs:Math.max(0,...frames.map(f=>f.visibleResultDelayMs))} };
    },
    cancel() { verifying = false; liveStart = undefined; }
  };
  mountClothReview(adapter);
  return {
    pose(b,prev) {
      if (!recipe) return;
      b.phi = recipe.boat.phi; b.th = 0; b.zc = 0;
      prev.phi = b.phi; prev.th = 0; prev.zc = 0;
    },
    update() {
      if (!positions) return;
      const a = geometry.attributes.position;
      for (let i=0;i<positions.length/3;i++) a.setXYZ(i,positions[3*i],positions[3*i+2],-positions[3*i+1]);
      a.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere();
      genSail.visible = true; shownStep = step;
      camera.position.set(9,5,16); camera.lookAt(3,4,0);
    },
    frame(data) {
      lastFrame = data;
      if (verifying) {
        if (JSON.stringify(composition())!==JSON.stringify(signature)) errors.add('Во время измерения изменились размеры или состав сцены');
        if (boat.x!==0 || boat.y!==0 || boat.psi!==0 || boat.phi!==recipe.boat.phi || boat.th!==0 || boat.zc!==0 || boat.u!==0 || boat.v!==0)
          errors.add('Лодка перестала быть неподвижной');
        if (liveStart!==undefined) frames.push({...data,shownStep,
          visibleResultDelayMs:Math.max(0,performance.now()-liveStart-(shownStep-40)*recipe.hS*1000)});
      }
      const ready = pending; pending = []; for (const resolve of ready) resolve(data.timestamp);
    }
  };
}
