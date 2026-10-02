// Расстояния новых узлов до треугольников прежней сетки исходного кроя.
// Только сохранённая геометрия: модель, воздух и ткань не пересчитываются.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const args=process.argv.slice(2);
assert.equal(args.length,2,'Нужны --input=крой.json --out=измерение.json');
const value=name=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const input=value('input'),output=value('out');
assert.ok(input && output && resolve(input)!==resolve(output),'Нужны разные вход и результат');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=readFileSync(input),d=JSON.parse(bytes);
assert.ok(d.config?.cutOnly && d.results?.length>1,'Нужны несколько сеток исходного кроя');
const results=[];
for(let i=1;i<d.results.length;i++) {
  const coarse=d.results[i-1],fine=d.results[i],sr=(fine.rows-1)/(coarse.rows-1),sc=(fine.cols-1)/(coarse.cols-1);
  assert.ok(sr>=1 && sc>=1 && Number.isInteger(sr) && Number.isInteger(sc),'Нужны вложенные сетки');
  for(const g of [coarse,fine])assert.ok(g.referencePositionsM.length===3*g.rows*g.cols &&
    g.referencePositionsM.every(Number.isFinite),'Нужны конечные координаты всех узлов');
  let maxDistanceM=0,squaredSumM2=0,location=null;
  for(let r=0;r<fine.rows;r++)for(let c=0;c<fine.cols;c++) {
    const rr=r/sr,cc=c/sc,r0=Math.min(Math.floor(rr),coarse.rows-2),c0=Math.min(Math.floor(cc),coarse.cols-2);
    const v=rr-r0,u=cc-c0,a=r0*coarse.cols+c0,indices=[a,a+1,a+coarse.cols,a+coarse.cols+1];
    // Одинаковая диагональ с измерителем площади: b—e.
    const weights=u+v<=1 ? [1-u-v,u,v,0] : [0,1-v,1-u,u+v-1];
    const delta=[0,1,2].map(k=>fine.referencePositionsM[3*(r*fine.cols+c)+k]-
      weights.reduce((s,w,j)=>s+w*coarse.referencePositionsM[3*indices[j]+k],0));
    if(r%sr===0 && c%sc===0)assert.deepEqual(delta,[0,0,0],'Общий узел изменился');
    const distanceM=Math.hypot(...delta);squaredSumM2+=distanceM**2;
    if(distanceM>maxDistanceM){maxDistanceM=distanceM;location={row:r,col:c,u:c/(fine.cols-1),v:r/(fine.rows-1)};}
  }
  const result={from:[coarse.rows,coarse.cols],to:[fine.rows,fine.cols],maxDistanceM,
    rmsDistanceM:Math.sqrt(squaredSumM2/(fine.rows*fine.cols)),location,
    areaChangeM2:fine.surfaceAreaM2-coarse.surfaceAreaM2};
  results.push(result);console.log(`${result.from.join('×')}→${result.to.join('×')}: максимум ${(1e3*maxDistanceM).toFixed(6)} мм; среднеквадратичное ${(1e3*result.rmsDistanceM).toFixed(6)} мм`);
}
assert.equal(sha(readFileSync(input)),sha(bytes),'Вход изменился во время измерения');
const destination=resolve(output);mkdirSync(dirname(destination),{recursive:true});
writeFileSync(destination,JSON.stringify({schema:1,createdAt:new Date().toISOString(),
  input:resolve(input),inputSha256:sha(bytes),inputRevision:d.revision,inputDirty:d.dirty,
  cutModel:d.config.cutModel,physicsSha256:d.physicsSha256,
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
  sourceSha256:sha(readFileSync(new URL(import.meta.url))),
  rule:'линейная интерполяция в тех же параметрах u,v; диагональ b—e; RMS по всем новым узлам, включая общие; это измерение, а не приёмка',results},null,2)+'\n');
