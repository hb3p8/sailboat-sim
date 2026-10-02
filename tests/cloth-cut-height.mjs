// Измерение исходного кроя по высоте без воздуха и движения ткани.
// Общие узлы могут совпадать при разрыве поверхности у границы.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), allowed=['rows','cols','grids','cut','out'];
const seen=new Set();
for(const a of args){const name=a.slice(2,a.indexOf('='));
  if(!a.startsWith('--') || !a.includes('=') || !allowed.includes(name) || seen.has(name) || !a.split('=')[1])
    throw new Error('Нужны уникальные --rows=11,21,… --cols=9 или --grids=11x9,21x17; --cut=original|continuous; --out=запись.json');
  seen.add(name);
}
const value=(name,fallback)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3) ?? fallback;
const rows=value('rows','11,21,41,81,161,321').split(',').map(Number),cols=Number(value('cols','9'));
const cut=value('cut','original'),gridArg=value('grids',null);
if(!['original','continuous'].includes(cut)) throw new Error('--cut: original или continuous');
if(gridArg && (seen.has('rows') || seen.has('cols'))) throw new Error('--grids заменяет --rows и --cols');
const grids=gridArg ? gridArg.split(',').map(s=>{
  if(!/^\d+x\d+$/.test(s)) throw new Error('--grids: нужны пары строкxстолбцов');
  const [rows,cols]=s.split('x').map(Number);return {rows,cols};
}) : rows.map(rows=>({rows,cols}));
if(grids.some((g,i)=>![g.rows,g.cols].every(n=>Number.isInteger(n)&&n>=5) ||
    g.rows>641 || g.cols>257 || g.rows*g.cols>50000 || (i &&
      (g.rows<grids[i-1].rows || g.cols<grids[i-1].cols ||
       (g.rows===grids[i-1].rows && g.cols===grids[i-1].cols) ||
       (g.rows-1)%(grids[i-1].rows-1) || (g.cols-1)%(grids[i-1].cols-1)))))
  throw new Error('Нужны растущие вложенные сетки: строки 5…641, столбцы 5…257, до 50000 узлов');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePaths=['tests/cloth-cut-height.mjs',...readdirSync(resolve(root,'sim'))
  .filter(p=>p.endsWith('.js')).map(p=>`sim/${p}`)];
const sourceSha256=Object.fromEntries(sourcePaths.map(p=>[p,sha(readFileSync(resolve(root,p)))]));
const packBytes=readFileSync(resolve(root,'out/export/physics.json'));
const b=new Boat(JSON.parse(packBytes));b.setGennaker(true);
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const dirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim());
const results=[];
for(const {rows:count,cols} of grids){
  const cuts=[-1,1].map(side=>{
    const cloth=new Cloth(b.rig.sails[2],2,{rows:count,cols,rigidBoard:true,continuousCut:cut==='continuous'});
    cloth.gen=b.p.rig.gennaker;cloth.designSide=side;cloth.design3d([]);
    return Array.from({length:cloth.n*3},(_,k)=>[cloth.dx,cloth.dy,cloth.dz][k%3][Math.floor(k/3)]);
  });
  assert.ok(cuts.every(p=>p.every(Number.isFinite)),'Не-конечный крой');
  for(let k=0;k<cuts[0].length;k++) assert.ok(cuts[0][k] === (k%3===1?-cuts[1][k]:cuts[1][k]),
    'Крой не является точным зеркалом'); // +0 и −0 — одна координата.
  const p=cuts[0],points=Array.from({length:cols},(_,c)=>c/(cols-1));
  const distance=(r,s,c)=>Math.hypot(...[0,1,2].map(k=>p[3*(r*cols+c)+k]-p[3*(s*cols+c)+k]));
  const bottomToFirstM=points.map((_,c)=>distance(0,1,c));
  const lastToTopM=points.map((_,c)=>distance(count-2,count-1,c));
  if(results.length){
    const prev=results.at(-1),stride=(count-1)/(prev.rows-1),colStride=(cols-1)/(prev.cols-1);
    for(let r=0;r<prev.rows;r++)for(let c=0;c<prev.cols;c++)for(let k=0;k<3;k++)
      assert.equal(p[3*(r*stride*cols+c*colStride)+k],prev.referencePositionsM[3*(r*prev.cols+c)+k],
        'Общий узел кроя изменился');
  }
  const point=i=>p.slice(3*i,3*i+3),sub=(a,b)=>a.map((x,k)=>x-b[k]);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const normal=(a,b,c)=>cross(sub(point(b),point(a)),sub(point(c),point(a)));
  let surfaceAreaM2=0,minTriangleAreaM2=Infinity,minCellNormalCosine=1;
  for(let r=0;r<count-1;r++)for(let c=0;c<cols-1;c++){
    const a=r*cols+c,e=a+cols,n1=normal(a,a+1,e),n2=normal(e+1,e,a+1);
    const l1=Math.hypot(...n1),l2=Math.hypot(...n2);
    surfaceAreaM2+=(l1+l2)/2;minTriangleAreaM2=Math.min(minTriangleAreaM2,l1/2,l2/2);
    minCellNormalCosine=Math.min(minCellNormalCosine,n1.reduce((s,x,k)=>s+x*n2[k],0)/(l1*l2));
  }
  const pathLength=indices=>indices.slice(1).reduce((s,i,k)=>s+Math.hypot(...sub(point(i),point(indices[k]))),0);
  const boundaryLengthsM={front:pathLength(Array.from({length:count},(_,r)=>r*cols)),
    back:pathLength(Array.from({length:count},(_,r)=>r*cols+cols-1)),
    bottom:pathLength(Array.from({length:cols},(_,c)=>c)),
    top:pathLength(Array.from({length:cols},(_,c)=>(count-1)*cols+c))};
  assert.ok(minTriangleAreaM2>0 && Number.isFinite(minCellNormalCosine),'Вырожденная ячейка');
  results.push({rows:count,cols,parameterStep:1/(count-1),chordFractions:points,
    bottomToFirstM,lastToTopM,surfaceAreaM2,minTriangleAreaM2,minCellNormalCosine,
    boundaryLengthsM,referencePositionsM:p});
  console.log(`${count}×${cols} | шаг ${(1/(count-1)).toFixed(6)} | низ→первый ряд передний край/середина/задний край: ${[0,Math.floor(cols/2),cols-1].map(c=>bottomToFirstM[c].toFixed(6)).join('/')} м`);
  console.log(`  площадь ${surfaceAreaM2.toFixed(6)} м²; длины переднего/заднего/нижнего/верхнего краёв ${Object.values(boundaryLengthsM).map(x=>x.toFixed(6)).join('/')} м; наименьшая площадь треугольника ${minTriangleAreaM2.toExponential(3)} м²; косинус между треугольниками ячейки ${minCellNormalCosine.toFixed(6)}`);
}
for(const path of sourcePaths)assert.equal(sha(readFileSync(resolve(root,path))),sourceSha256[path]);
assert.equal(sha(readFileSync(resolve(root,'out/export/physics.json'))),sha(packBytes));
const output=value('out',null);
if(output){const destination=resolve(root,output);mkdirSync(dirname(destination),{recursive:true});
  writeFileSync(destination,JSON.stringify({schema:1,createdAt:new Date().toISOString(),revision,dirty,
    physicsSha256:sha(packBytes),sourceSha256,
    config:{cutOnly:true,cutModel:cut,designSide:-1,grids,
      declaredLengthsM:{front:b.p.rig.gennaker.luff_m,back:b.p.rig.gennaker.leech_m,
        bottom:b.p.rig.gennaker.foot_cloth_m,top:b.p.rig.gennaker.head_width_m},
      declaredAreaM2:b.p.rig.gennaker.area_m2},
    rule:'прямое чтение Cloth.design3d; воздух, масса, энергия и движение не рассчитываются; проверены точное зеркало и общие узлы',
    results},null,2)+'\n');console.log(`Запись исходного кроя: ${destination}`);
}
