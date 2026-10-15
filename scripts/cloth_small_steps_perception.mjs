// Наглядное сравнение записанных форм. Физика здесь не пересчитывается.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const args=Object.fromEntries(process.argv.slice(2).map(a=>a.slice(2).split('=')));
const variants=[['fine','Новый, 8 шагов'],['coarse4','Новый, 4 шага'],
  ['coarse2','Новый, 2 шага'],['local','Прежний, 8 шагов']];
for(const key of ['fine','coarse4','coarse2','local','out','summary'])assert(args[key],`Нужен --${key}=путь`);
const norm=a=>Math.hypot(...a),round=v=>Number(v.toFixed(6)),unit=1e-5;
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const sources=variants.map(([key,label])=>({key,label,path:args[key],data:read(args[key])}));
const base=sources[0].data;
for(const s of sources) {
  assert(s.data.complete&&s.data.allCasesComplete,'Нужны завершённые записи');
  assert(s.data.spec.capturePositions,'Нужна запись --visual');
  assert.equal(s.data.spec.dtS,1/30);
  assert.equal(s.data.spec.candidate,s.key==='local'?'small-steps-impulse-v1':'block-hard-xpbd-v1');
  assert.equal(s.data.spec.substeps,{fine:8,coarse4:4,coarse2:2,local:8}[s.key]);
  assert.deepEqual(s.data.sources,base.sources,'Исходники/пакеты различаются');
  for(const k of ['windMPS','awaDeg','sheet','takeup','supports','holdSeconds','strictThresholds'])
    assert.deepEqual(s.data.spec[k],base.spec[k],`Различается вход ${k}`);
}
function varints(values) {
  const bytes=[];
  for(const q of values) {
    assert(Number.isSafeInteger(q)&&Math.abs(q)<2**30,'Переполнение упаковки');
    let u=(q<<1)^(q>>31);
    while(u>=128){bytes.push((u&127)|128);u>>>=7;}
    bytes.push(u);
  }
  return Buffer.from(bytes).toString('base64');
}
const select=[['supports','minus','Движение креплений: подъём 5 см и крен 1°'],
  ['hold','minus','Неподвижные крепления: верёвка натянута или свободна'],
  ['takeup','plus','Отпустить на 2 см и вернуть: перехват верёвки']];
let referencePackingErrorM=0,candidatePackingErrorM=0,maxCommandLengthDifferenceM=0;
const cases=select.map(([scenario,side,label])=>{
  const find=s=>s.data.results.find(r=>r.scenario===scenario&&r.side===side);
  const ref=find(sources[0]);assert(ref?.complete);
  const n=ref.frames.length,quantized=[],refRaw=ref.frames.map(f=>f.visual.referenceM);
  assert(refRaw.every(a=>a.length===297));
  const q=refRaw.map(p=>p.map(v=>Math.round(v/unit)));
  for(let f=0;f<n;f++)for(let k=0;k<297;k++)quantized.push(q[f][k]-(f?q[f-1][k]:0));
  for(let f=0;f<n;f++)for(let i=0;i<99;i++)referencePackingErrorM=Math.max(referencePackingErrorM,
    norm([0,1,2].map(d=>q[f][i*3+d]*unit-refRaw[f][i*3+d])));
  const candidate=sources.map(s=>{
    const r=find(s);assert(r?.complete);assert.equal(r.frames.length,n);
    const deltas=[],shapeM=[],forceErrorN=[],momentErrorNm=[];
    for(let f=0;f<n;f++) {
      const a=r.frames[f],b=ref.frames[f];assert.equal(a.timeS,b.timeS);
      // Один закон команды: разное число сложений ограничителя даёт несколько ULP.
      const lengthDifference=Math.abs(a.lengthM-b.lengthM);
      assert(lengthDifference<=32*Number.EPSILON*Math.max(1,Math.abs(b.lengthM)),'Различается команда длины');
      maxCommandLengthDifferenceM=Math.max(maxCommandLengthDifferenceM,lengthDifference);
      assert.deepEqual(a.visual.targets,b.visual.targets,'Крепления не совпали');
      let max=0;
      for(let i=0;i<99;i++) {
        const delta=[0,1,2].map(d=>a.visual.candidateM[3*i+d]-refRaw[f][3*i+d]);
        const dq=delta.map(v=>Math.round(v/unit));deltas.push(...dq);
        candidatePackingErrorM=Math.max(candidatePackingErrorM,norm(dq.map((v,d)=>
          (q[f][3*i+d]+v)*unit-a.visual.candidateM[3*i+d])));
        max=Math.max(max,norm(delta));
      }
      shapeM.push(max);forceErrorN.push(norm(a.candidate.forceN.map((v,d)=>v-b.reference.forceN[d])));
      momentErrorNm.push(norm(a.candidate.momentNm.map((v,d)=>v-b.reference.momentNm[d])));
    }
    const tension=r.frames.flatMap(f=>f.smallParts.map(p=>p.sheetImpulseForceN));
    const tensionRef=ref.frames.flatMap(f=>f.strictParts.map(p=>p.sheetImpulseForceN));
    const ratio=8/s.data.spec.substeps;
    let maxTensionErrorN=0,maxTensionAtS=0;
    tension.forEach((v,i)=>{const diff=Math.abs(v-tensionRef[(i+1)*ratio-1]);
      if(diff>maxTensionErrorN){maxTensionErrorN=diff;maxTensionAtS=(i+1)*s.data.spec.hS;}});
    const indexMax=a=>a.indexOf(Math.max(...a));
    return {key:s.key,label:s.label,hS:s.data.spec.hS,delta:varints(deltas),
      forceN:r.frames.map(f=>f.candidate.forceN.map(round)),tensionN:tension.map(v=>Number(v.toPrecision(8))),
      shapeMm:shapeM.map(v=>round(v*1000)),forceErrorN:forceErrorN.map(round),
      maxima:{shapeMm:Math.max(...shapeM)*1000,shapeFrame:indexMax(shapeM),
        forceN:Math.max(...forceErrorN),forceFrame:indexMax(forceErrorN),momentNm:Math.max(...momentErrorNm),
        tensionN:maxTensionErrorN,tensionAtS:maxTensionAtS}};
  });
  return {scenario,side,label,n,reference:varints(quantized),
    forceN:ref.frames.map(f=>f.reference.forceN.map(round)),
    tensionN:ref.frames.flatMap(f=>f.strictParts.map(p=>Number(p.sheetImpulseForceN.toPrecision(8)))),
    anchorM:ref.frames.map(f=>f.visual.targets.find(t=>t.node===99).positionM.map(round)),
    candidates:candidate};
});
assert(referencePackingErrorM<Math.sqrt(3)*unit/2+1e-12);
assert(candidatePackingErrorM<Math.sqrt(3)*unit+1e-12);
const provenance=sources.map(s=>({key:s.key,path:s.path,revision:s.data.revision,
  sha256:createHash('sha256').update(readFileSync(s.path)).digest('hex'),substeps:s.data.spec.substeps}));
const data={schema:'small-steps-perception-v1',dtS:1/30,unit,cases,provenance,
  packing:{referenceErrorMm:referencePackingErrorM*1000,candidateErrorMm:candidatePackingErrorM*1000},
  maxCommandLengthDifferenceM};
const template=readFileSync('tests/probes/cloth-small-steps-perception.html','utf8');
assert.equal(template.split('__COMPARISON_DATA__').length,2,'Должен быть один слот данных');
const html=template.replace('__COMPARISON_DATA__',JSON.stringify(data).replaceAll('<','\\u003c'));
assert(Buffer.byteLength(html)<1_000_000,'Сравнение превышает размер встроенного просмотра');
writeFileSync(args.out,html);
const summary={schema:data.schema,provenance,sources:base.sources,packing:data.packing,maxCommandLengthDifferenceM,bytes:Buffer.byteLength(html),
  cases:cases.map(c=>({scenario:c.scenario,side:c.side,frames:c.n,
    candidates:c.candidates.map(v=>({key:v.key,...v.maxima}))}))};
writeFileSync(args.summary,JSON.stringify(summary,null,2)+'\n');
console.log(`Сравнение: ${summary.bytes} байт; погрешность записи формы ≤${data.packing.candidateErrorMm.toFixed(4)} мм.`);
for(const c of summary.cases)for(const v of c.candidates)
  console.log(`${c.scenario}/${c.side}/${v.key}: ${v.shapeMm.toFixed(3)} мм; ${v.forceN.toFixed(3)} Н; натяжение ${v.tensionN.toFixed(3)} Н.`);
