// Сравнение всей истории при уменьшении временного шага, без выравнивания форм.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
assert.equal(args.length,4,'Нужны три опыта 60/120/240 Гц и новый путь сравнения');
const output=args[3], hash=b=>createHash('sha256').update(b).digest('hex');
assert(!existsSync(output),'Сохранённое сравнение нельзя перезаписывать');
const sources=args.slice(0,3).map(path=>{const bytes=readFileSync(path);return {path,sha256:hash(bytes),record:JSON.parse(bytes)};});
const [coarse,medium,fine]=sources.map(s=>s.record),condition=record=>{const {hS,...rest}=record.config;return rest;};
assert.deepEqual(sources.map(s=>Math.round(1/s.record.config.hS)),[60,120,240]);
const verified=new Set();
for (const {record:r} of sources) {
  assert.equal(r.phase,'complete'); assert.equal(r.dirty,false,'Нужен опыт на чистой ревизии');
  assert.deepEqual(r.sourceSha256,coarse.sourceSha256); assert.deepEqual(r.input,coarse.input);
  assert.deepEqual(r.wasm,coarse.wasm); assert.equal(r.physicsSha256,coarse.physicsSha256);
  assert.deepEqual(r.recipe,coarse.recipe); assert.deepEqual(r.initial,coarse.initial);
  assert.deepEqual(r.command,coarse.command); assert.deepEqual(condition(r),condition(coarse));
  if (!verified.has(r.revision)) {
    for (const [path,sha] of Object.entries(r.sourceSha256))
      assert.equal(hash(execFileSync('git',['show',`${r.revision}:${path}`],{maxBuffer:16*1024*1024})),sha,'Записанная модель не соответствует коммиту');
    verified.add(r.revision);
  }
  assert.equal(r.steps.length,Math.round((r.config.durationS+r.config.holdS)/r.config.hS));
  r.steps.forEach((s,i)=>assert.equal(s.timeS,(i+1)*r.config.hS));
}
function cumulative(record) {let work=0;return record.steps.map(s=>work+=s.audit.supportWorkJ);}
function compare(a,b,sampling=a) {
  const wa=cumulative(a),wb=cumulative(b),nodeCount=a.recipe.rows*a.recipe.cols;
  const result={fromHz:Math.round(1/a.config.hS),toHz:Math.round(1/b.config.hS),samplingHz:Math.round(1/sampling.config.hS),
    maxPositionM:0,maxSupportForceN:0,maxCumulativeWorkJ:0,maxKineticDifferenceJ:0,maxMaterialDifferenceJ:0,
    positionTimeS:0,forceTimeS:0,workTimeS:0};
  for (const frame of sampling.steps) {
    const indexA=Math.round(frame.timeS/a.config.hS)-1,indexB=Math.round(frame.timeS/b.config.hS)-1;
    const x=a.steps[indexA],y=b.steps[indexB];
    assert.equal(x.timeS,frame.timeS); assert.equal(y.timeS,frame.timeS);
    for (let i=0;i<nodeCount;i++) {
      const distance=Math.hypot(...[0,1,2].map(d=>x.positionsM[3*i+d]-y.positionsM[3*i+d]));
      if (distance>result.maxPositionM) {result.maxPositionM=distance;result.positionTimeS=frame.timeS;}
    }
    for (const i of a.recipe.fixed) {
      const difference=Math.hypot(...[0,1,2].map(d=>x.supportForceN[3*i+d]-y.supportForceN[3*i+d]));
      if (difference>result.maxSupportForceN) {result.maxSupportForceN=difference;result.forceTimeS=frame.timeS;}
    }
    const work=Math.abs(wa[indexA]-wb[indexB]);
    if (work>result.maxCumulativeWorkJ) {result.maxCumulativeWorkJ=work;result.workTimeS=frame.timeS;}
    result.maxKineticDifferenceJ=Math.max(result.maxKineticDifferenceJ,Math.abs(x.audit.kineticJ-y.audit.kineticJ));
    result.maxMaterialDifferenceJ=Math.max(result.maxMaterialDifferenceJ,Math.abs(x.audit.softEnergyJ-y.audit.softEnergyJ));
  }
  result.netWorkDifferenceJ=Math.abs(wa.at(-1)-wb.at(-1));return result;
}
const comparison={adjacent:[compare(coarse,medium),compare(medium,fine)],
  fixedTimes:[compare(coarse,medium,coarse),compare(medium,fine,coarse)]};
writeFileSync(output,JSON.stringify({schema:1,createdAt:new Date().toISOString(),
  toolSha256:hash(readFileSync(new URL(import.meta.url))),
  sources:sources.map(({path,sha256,record:r})=>({path,sha256,revision:r.revision})),
  rule:'все узлы/закрепления, накопленная работа; совпадающие времена без интерполяции; отдельно времена каждой пары и общий набор 60 Гц; это измерение различий, не приёмка G4',
  comparison},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,comparison},null,2));
