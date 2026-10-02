// Сравнить сохранённые движения на вложенных сетках с одним входом и моделью.
// Это измерение различий координат, а не автоматическая приёмка G2.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export function commonNodeDistances(coarse,fine,a,b) {
  assert.ok([coarse.rows,coarse.cols,fine.rows,fine.cols].every(n=>Number.isInteger(n)&&n>=2),
    'Нужны целые размеры сеток не менее двух');
  const sr=(fine.rows-1)/(coarse.rows-1),sc=(fine.cols-1)/(coarse.cols-1);
  assert.ok(sr>=1 && sc>=1 && Number.isInteger(sr) && Number.isInteger(sc),
    'Нужны вложенные сетки');
  for(const [grid,p] of [[coarse,a],[fine,b]])
    assert.ok(p.length===3*grid.rows*grid.cols && p.every(Number.isFinite),'Нужны конечные координаты всех узлов');
  let maximumM=0,squaredSumM2=0,location=null;
  for(let r=0;r<coarse.rows;r++)for(let c=0;c<coarse.cols;c++) {
    const i=3*(r*coarse.cols+c),j=3*(r*sr*fine.cols+c*sc);
    const distanceM=Math.hypot(...[0,1,2].map(k=>b[j+k]-a[i+k]));
    squaredSumM2+=distanceM*distanceM;
    if(distanceM>maximumM){maximumM=distanceM;location={row:r,col:c,u:c/(coarse.cols-1),v:r/(coarse.rows-1)};}
  }
  return {from:[coarse.rows,coarse.cols],to:[fine.rows,fine.cols],nodeCount:coarse.rows*coarse.cols,
    maximumM,rmsM:Math.sqrt(squaredSumM2/(coarse.rows*coarse.cols)),location};
}

function main() {
  const args=process.argv.slice(2);
  assert.ok(args.every(a=>/^--(input|out)=.+$/.test(a)) &&
    args.filter(a=>a.startsWith('--out=')).length===1 && args.filter(a=>a.startsWith('--input=')).length>=1,
    'Нужны --input=запись (можно несколько) и один --out=сравнение.json');
  const inputPaths=args.filter(a=>a.startsWith('--input=')).map(a=>resolve(a.slice(8)));
  const destination=resolve(args.find(a=>a.startsWith('--out=')).slice(6));
  assert.ok(new Set(inputPaths).size===inputPaths.length && !inputPaths.includes(destination),
    'Нужны разные входы и отдельный результат');
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const sources=inputPaths.map(path=>{const bytes=readFileSync(path);return {path,bytes,record:JSON.parse(bytes)};});
  const first=sources[0].record,physicalSource=first.sourceSha256;
  const condition=record=>{const {grids,cols,...rest}=record.config;return rest;};
  assert.ok(physicalSource && Object.keys(physicalSource).length && first.sharedInputField,
    'Нужны отпечатки модели и заданный общий вход');
  const results=[];
  for(const {record:d} of sources) {
    assert.ok(d.phase==='complete' && d.inputsVerified===true && d.dirty===false,
      'Нужна завершённая чистая запись с проверенными входами');
    assert.ok(d.config?.implicitMotion && d.config.energyMaterial && d.config.sharedInput &&
      d.config.fixedLoad && d.config.holdCutClew && !d.config.auditInput,'Нужен полный опыт движения с одним заданным входом');
    assert.equal(d.physicsSha256,first.physicsSha256,'Пакеты различаются');
    assert.deepEqual(d.sourceSha256,physicalSource,'Источники модели различаются: нужен контроль одной версии');
    assert.deepEqual(condition(d),condition(first),'Условия движения различаются');
    assert.deepEqual(d.sharedInputField,first.sharedInputField,'Заданные поля различаются');
    for(const r of d.results) {
      assert.deepEqual(r.energyMotion.parameters,first.results[0].energyMotion.parameters,'Материал различается');
      assert.equal(r.energyMotion.hS,first.results[0].energyMotion.hS,'Подшаг различается');
      results.push(r);
    }
  }
  results.sort((a,b)=>a.rows*a.cols-b.rows*b.cols);
  assert.ok(results.length>1 && new Set(results.map(r=>`${r.rows}x${r.cols}`)).size===results.length,
    'Нужны несколько разных сеток');
  const times=results[0].samples.map(s=>s.timeS).filter(t=>results.every(r=>r.samples.some(s=>s.timeS===t)));
  assert.ok(times.includes(first.config.seconds),'Нет общего конечного кадра');
  for(let i=1;i<results.length;i++) {
    const rest=commonNodeDistances(results[i-1],results[i],results[i-1].referencePositionsM,results[i].referencePositionsM);
    assert.equal(rest.maximumM,0,'Исходный крой различается в общих узлах');
  }
  const comparison=times.map(timeS=>({timeS,pairs:results.slice(1).map((r,i)=>
    commonNodeDistances(results[i],r,results[i].samples.find(s=>s.timeS===timeS).positionsM,
      r.samples.find(s=>s.timeS===timeS).positionsM))}));
  for(const {timeS,pairs} of comparison)for(const p of pairs)
    console.log(`${timeS.toFixed(3)} с, ${p.from.join('×')}→${p.to.join('×')}: максимум ${(1e3*p.maximumM).toFixed(6)} мм, RMS ${(1e3*p.rmsM).toFixed(6)} мм`);
  for(const {path,bytes} of sources)assert.equal(sha(readFileSync(path)),sha(bytes),'Запись изменилась во время сравнения');
  for(const [path,hash] of Object.entries(physicalSource))assert.equal(sha(readFileSync(path)),hash,'Текущая модель отличается от записанной');
  assert.equal(sha(readFileSync('out/export/physics.json')),first.physicsSha256,'Текущий пакет отличается от записанного');
  const toolPath=fileURLToPath(import.meta.url);
  assert.ok(destination!==toolPath && !Object.keys(physicalSource).map(p=>resolve(p)).includes(destination) &&
    destination!==resolve('out/export/physics.json'),'Результат не должен заменять исходники или пакет');
  const output={schema:1,createdAt:new Date().toISOString(),
    revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
    provenanceKind:'сравнение завершённых записей; не отдельный физический прогон',
    sourceSha256:{[toolPath]:sha(readFileSync(toolPath))},physicalSourceSha256:physicalSource,
    sourceRecords:sources.map(({path,bytes,record:d})=>({file:path,sha256:sha(bytes),revision:d.revision,dirty:d.dirty})),
    physicsSha256:first.physicsSha256,phase:'complete',inputsVerified:true,physicalAcceptance:false,
    config:{...first.config,grids:results.map(r=>({rows:r.rows,cols:r.cols})),cols:results.map(r=>r.cols)},
    rule:'евклидовы расстояния в общих узлах и сохранённых кадрах; без переноса, поворота или интерполяции времени; '+
      'RMS по общим узлам, не по всей площади; совпавший вход и модель не принимают физику',comparison,results};
  mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,JSON.stringify(output,null,2)+'\n');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
