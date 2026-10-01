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
const args=process.argv.slice(2), allowed=['rows','cols','out'];
const seen=new Set();
for(const a of args){const name=a.slice(2,a.indexOf('='));
  if(!a.startsWith('--') || !a.includes('=') || !allowed.includes(name) || seen.has(name) || !a.split('=')[1])
    throw new Error('Нужны уникальные --rows=11,21,… --cols=9 --out=запись.json');
  seen.add(name);
}
const value=(name,fallback)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3) ?? fallback;
const rows=value('rows','11,21,41,81,161,321').split(',').map(Number),cols=Number(value('cols','9'));
if(rows.some(n=>!Number.isInteger(n)||n<5||n>641) || !Number.isInteger(cols)||cols<5||cols>65 ||
    rows.some((n,i)=>i && (n<=rows[i-1] || (n-1)%(rows[i-1]-1))))
  throw new Error('Нужны растущие вложенные строки 5…641 и столбцы 5…65');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePaths=['tests/cloth-cut-height.mjs',...readdirSync(resolve(root,'sim'))
  .filter(p=>p.endsWith('.js')).map(p=>`sim/${p}`)];
const sourceSha256=Object.fromEntries(sourcePaths.map(p=>[p,sha(readFileSync(resolve(root,p)))]));
const packBytes=readFileSync(resolve(root,'out/export/physics.json'));
const b=new Boat(JSON.parse(packBytes));b.setGennaker(true);
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const dirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim());
const results=[];
for(const count of rows){
  const cuts=[-1,1].map(side=>{
    const cloth=new Cloth(b.rig.sails[2],2,{rows:count,cols,rigidBoard:true});
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
    const prev=results.at(-1),stride=(count-1)/(prev.rows-1);
    for(let r=0;r<prev.rows;r++)for(let c=0;c<cols;c++)for(let k=0;k<3;k++)
      assert.equal(p[3*(r*stride*cols+c)+k],prev.referencePositionsM[3*(r*cols+c)+k],
        'Общий узел кроя изменился');
  }
  results.push({rows:count,cols,parameterStep:1/(count-1),chordFractions:points,
    bottomToFirstM,lastToTopM,referencePositionsM:p});
  console.log(`${count}×${cols} | шаг ${(1/(count-1)).toFixed(6)} | низ→первый ряд передний край/середина/задний край: ${[0,Math.floor(cols/2),cols-1].map(c=>bottomToFirstM[c].toFixed(6)).join('/')} м`);
}
for(const path of sourcePaths)assert.equal(sha(readFileSync(resolve(root,path))),sourceSha256[path]);
assert.equal(sha(readFileSync(resolve(root,'out/export/physics.json'))),sha(packBytes));
const output=value('out',null);
if(output){const destination=resolve(root,output);mkdirSync(dirname(destination),{recursive:true});
  writeFileSync(destination,JSON.stringify({schema:1,createdAt:new Date().toISOString(),revision,dirty,
    physicsSha256:sha(packBytes),sourceSha256,
    config:{cutOnly:true,designSide:-1,rows,cols},
    rule:'прямое чтение Cloth.design3d; воздух, масса, энергия и движение не рассчитываются; проверены точное зеркало и общие узлы',
    results},null,2)+'\n');console.log(`Запись исходного кроя: ${destination}`);
}
