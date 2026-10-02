// Сводка сохранённых браузерных замеров: происхождение и числа отдельно от FPS.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { IMPLICIT_TOLERANCES } from '../tests/lib/cloth-implicit-motion.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const sourceCache = new Map();
const [output, ...paths] = process.argv.slice(2);
assert(output && paths.length, 'Нужны новый путь сводки и JSON измерений');
const series = paths.map(path => {
  const bytes = readFileSync(path), r = JSON.parse(bytes);
  assert(r.valid && r.complete && !r.fixture.dirty && !r.environment.hiddenDuringCalculation, `Недействительное измерение ${path}`);
  const fixtureBytes = readFileSync(r.fixture.path), f = JSON.parse(fixtureBytes);
  assert.equal(hash(fixtureBytes), r.fixture.sha256);
  assert.equal(f.revision, r.fixture.revision); assert.equal(f.dirty, false);
  assert.deepEqual(r.wasm, f.wasm); assert.equal(hash(readFileSync(f.wasm.path)), f.wasm.sha256);
  assert.equal(hash(readFileSync(f.baseline.path)), f.baseline.sha256);
  assert.equal(hash(readFileSync('out/export/physics.json')), f.physicsSha256);
  for (const [p, sha] of Object.entries(f.sourceSha256)) {
    const key = `${f.revision}:${p}`;
    if (!sourceCache.has(key)) sourceCache.set(key,hash(execFileSync('git', ['show',key],{maxBuffer:16*1024*1024})));
    assert.equal(sourceCache.get(key),sha, `Исходник не соответствует ревизии: ${p}`);
  }
  assert.equal(r.comparison.checkedSteps, 100); assert.equal(r.comparison.physicalMatches, true);
  assert.deepEqual(r.comparison.tolerances, IMPLICIT_TOLERANCES);
  for (const [name, limit] of Object.entries({ maxPositionDifferenceM: 1e-8, maxEnergyDifferenceJ: 1e-7,
    maxForceN: IMPLICIT_TOLERANCES.forceToleranceN, maxLengthM: IMPLICIT_TOLERANCES.lengthToleranceM,
    maxDualN: IMPLICIT_TOLERANCES.dualToleranceN, maxComplementarityJ: IMPLICIT_TOLERANCES.complementarityToleranceJ }))
    assert(Number.isFinite(r.comparison[name]) && r.comparison[name] >= 0 && r.comparison[name] <= limit, `Нарушена проверка ${name}`);
  assert.equal(r.allSteps.length, 100); assert.equal(r.scheduler.discardedTimeMs, 0);
  assert.equal(r.scheduler.hS, f.recipe.hS);
  for (const name of ['renderOnly','renderOnlyIntervals','liveFrameCost','liveFrameIntervals',...(r.execution==='worker'?['replyLatency']:[])]) {
    const s=r[name]; assert(Number.isInteger(s?.count) && s.count>0,`Нет временных отсчётов ${name}`);
    for (const k of ['meanMs','p50Ms','p95Ms','maxMs']) assert(Number.isFinite(s[k]) && s[k]>=0,`Неверное время ${name}.${k}`);
    assert(s.p50Ms<=s.p95Ms && s.p95Ms<=s.maxMs && s.meanMs<=s.maxMs);
  }
  if (r.execution==='worker') {
    assert.equal(r.replyLatency.count,100);
    assert(Number.isFinite(r.scheduler.maxResultDelayMs) && r.scheduler.maxResultDelayMs>=0);
  }
  if (r.scene) {
    assert.equal(r.execution,'worker'); assert.equal(r.scene.valid,true); assert.deepEqual(r.scene.errors,[]);
    assert.deepEqual(r.scene.build,f.sceneBuild);
    const buildBytes=readFileSync(f.sceneBuild.path);
    assert.equal(hash(buildBytes),f.sceneBuild.sha256);
    assert.deepEqual(JSON.parse(buildBytes.toString().match(/^const BUILD = (.+);$/m)[1]),f.sceneBuild.build);
    assert(f.revision.startsWith(f.sceneBuild.build.commit) && !f.sceneBuild.build.dirty);
    for (const [p,sha] of Object.entries(f.sceneBuild.assets)) assert.equal(hash(readFileSync(p)),sha,`Изменился ассет ${p}`);
    assert.deepEqual(r.scene.stationaryBoat,{x:0,y:0,psi:0,phi:f.recipe.boat.phi,th:0,zc:0});
    assert.deepEqual(r.scene.composition.canvasPixels,r.environment.canvasPixels);
    const frames=r.scene.frames; assert(frames.length>=2);
    assert.equal(r.scene.presentation.lastShownStep,100); assert.equal(frames.at(-1).shownStep,100);
    assert(Number.isFinite(r.scene.presentation.elapsedMs) && r.scene.presentation.elapsedMs>=1000);
    for (let i=0;i<frames.length;i++) {
      const a=frames[i]; assert(Number.isInteger(a.shownStep) && a.shownStep>=40 && a.shownStep<=100);
      assert(Number.isFinite(a.timestamp) && Number.isFinite(a.cpuMs) && a.cpuMs>=0);
      assert(Number.isFinite(a.visibleResultDelayMs) && a.visibleResultDelayMs>=0);
      if (i) assert(a.timestamp>frames[i-1].timestamp && a.shownStep>=frames[i-1].shownStep);
    }
    assert.equal(r.scene.presentation.maxVisibleResultDelayMs,Math.max(...frames.map(a=>a.visibleResultDelayMs)));
  } else assert(!f.sceneBuild,'Нет контроля полной сцены');
  for (const [name, first, last] of [['warmup', 0, 40], ['live', 40, 100]]) {
    const a = r.allSteps.slice(first,last).map(s => s.timeMs), s = a.slice().sort((x,y) => x-y);
    assert(a.every(v => Number.isFinite(v) && v > 0));
    assert.equal(r[name].count,a.length);
    assert.equal(r[name].meanMs,a.reduce((sum,x)=>sum+x,0)/a.length);
    assert.equal(r[name].p50Ms,s[Math.ceil(s.length*.5)-1]);
    assert.equal(r[name].p95Ms,s[Math.ceil(s.length*.95)-1]); assert.equal(r[name].maxMs,s.at(-1));
  }
  return { path, sha256: hash(bytes), tack: f.tack, fixture: r.fixture, environment: r.environment,
    execution: r.execution ?? 'main', reuseMemory: r.reuseMemory ?? null,
    wasmMemory: r.wasmMemory, replyLatency: r.replyLatency,
    preparation: r.preparation, renderOnly: r.renderOnly, renderOnlyIntervals: r.renderOnlyIntervals,
    warmup: r.warmup, live: r.live, liveFrameCost: r.liveFrameCost, liveFrameIntervals: r.liveFrameIntervals,
    scheduler: r.scheduler, comparison: r.comparison, ...(r.scene?{scene:r.scene}:{}), scope:r.scope };
});
const result = { schema: 1, createdAt: new Date().toISOString(), series,
  interpretation: 'Достоверность записи и повторение модели проверены. Скорость измерена на коротком окне; это не приёмка интерактивного манёвра или всей сцены.' };
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
for (const r of series) console.log(`Галс ${r.tack}: средний шаг ${r.live.meanMs.toFixed(2)} мс, 95 % ${r.live.p95Ms.toFixed(2)} мс, максимум ${r.live.maxMs.toFixed(2)} мс; ${r.path}`);
console.log(`Проверено ${series.length} замеров; сводка ${output}`);
