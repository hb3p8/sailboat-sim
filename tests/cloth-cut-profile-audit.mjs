// Воспроизводимый аудит причины скачка и достижимости параметров профиля.
// Закрытые функции открываются только в копиях модуля в памяти, файлы не меняются.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Boat} from '../sim/physics.js';
import {Cloth} from '../sim/cloth.js';
import {designAt,DESIGN_DRAFT,DESIGN_ENTRY,DESIGN_EXIT} from '../sim/aero.js';
import {cubicPeakRange} from './lib/cloth-profile-reachability.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
assert.ok(args.length===1 && args[0].startsWith('--out=') && args[0].slice(6),
  'Нужен отдельный результат --out=запись.json');
const sha=x=>createHash('sha256').update(x).digest('hex');
const paths=['tests/cloth-cut-profile-audit.mjs','tests/lib/cloth-profile-reachability.mjs',
  ...readdirSync(resolve(root,'sim')).filter(p=>p.endsWith('.js')).map(p=>`sim/${p}`)];
const sourceSha256=Object.fromEntries(paths.map(p=>[p,sha(readFileSync(resolve(root,p)))]));
const source=readFileSync(resolve(root,'sim/cloth.js'),'utf8'),pack=readFileSync(resolve(root,'out/export/physics.json'));
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const dirty=!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim();
const copyModule=async divisions=>{
  const line='const divisions = analyticPeak ? 40 : 24;';
  assert.equal(source.split(line).length,2,'Изменился способ назначения числа делений: обновите контроль');
  const variant=divisions===null?source:source.replace(line,`const divisions = ${divisions};`);
  const code=variant.replace(/from (['"])(\.\/[^'"]+)\1/g,(_,q,p)=>`from '${new URL('../sim/'+p.slice(2),import.meta.url).href}'`)
    +'\nexport {bezSolve};';
  return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
};
const b=new Boat(JSON.parse(pack));b.setGennaker(true);
const scan=(c,u,v0,v1,step)=>{
  let last=c.cutAt(u,v0,[]),maxDistanceM=0,atV=null;
  for(let i=1;i<=Math.round((v1-v0)/step);i++){
    const v=v0+i*step,p=c.cutAt(u,v,[]),d=Math.hypot(...p.map((x,k)=>x-last[k]));
    if(d>maxDistanceM){maxDistanceM=d;atV=v;}last=p;
  }
  return {step,maxDistanceM,atV};
};
const causes=[];let referenceEdges=null;
for(const divisions of [24,40]) {
  const {Cloth:VariantCloth}=await copyModule(divisions);
  for(const analyticCutProfile of [false,true]) {
    const c=new VariantCloth(b.rig.sails[2],2,{rows:11,cols:9,continuousCut:true,analyticCutProfile,rigidBoard:true});
    c.gen=b.p.rig.gennaker;c.designSide=-1;c.design3d([]);
    const edges=[];
    for(let i=0;i<=32;i++)for(const [u,v] of [[i/32,0],[i/32,1],[0,i/32],[1,i/32]])edges.push(...c.cutAt(u,v,[]));
    if(referenceEdges)assert.deepEqual(edges,referenceEdges,'Границы контроля изменились');else referenceEdges=edges;
    causes.push({divisions,analyticCutProfile,...scan(c,.1875,.1,.115,.00001)});
  }
}
const {bezSolve}=await copyModule(null);
const fit=v=>{
  const target={cam:designAt(b.rig.sails[2].design,v),at:designAt(DESIGN_DRAFT.gennaker,v),
    entryDeg:designAt(DESIGN_ENTRY.gennaker,v),exitDeg:DESIGN_EXIT.gennaker};
  const s=bezSolve(target.cam,target.at,target.entryDeg*Math.PI/180,target.exitDeg*Math.PI/180,true,true);
  const a=Math.hypot(s.P[2],s.P[3]),back=Math.hypot(1-s.P[4],s.P[5]);
  const range=cubicPeakRange(target.cam,target.entryDeg*Math.PI/180,target.exitDeg*Math.PI/180);
  return {v,target,actual:{cam:s.cam,at:s.at,handleBackFraction:back/(a+back),handleSum:a+back},
    camError:s.cam-target.cam,atError:s.at-target.at,reachability:{...range,
      targetInClosure:target.at>=range.minAt && target.at<=range.maxAt,
      targetDistanceToClosure:Math.max(range.minAt-target.at,target.at-range.maxAt,0)}};
};
const samples=Array.from({length:1001},(_,i)=>fit(i/1000));
const c=new Cloth(b.rig.sails[2],2,{rows:11,cols:9,continuousCut:true,analyticCutProfile:true,rigidBoard:true});
c.gen=b.p.rig.gennaker;c.designSide=-1;c.design3d([]);
const profileScan=[.001,.0001,.00001].map(step=>scan(c,13/96,.125,.155,step));
for(const p of paths)assert.equal(sha(readFileSync(resolve(root,p))),sourceSha256[p],'Исходник изменился');
assert.equal(sha(readFileSync(resolve(root,'out/export/physics.json'))),sha(pack),'Пакет изменился');
const output={schema:1,createdAt:new Date().toISOString(),revision,dirty,sourceSha256,physicsSha256:sha(pack),
  config:{cutModel:'continuous-analytic',fitStage:'до согласования с границами',
    causalScan:{u:.1875,vRange:[.1,.115],step:.00001},profileScan:{u:13/96,vRange:[.125,.155]}},
  rule:'измерение достигнутых параметров и отдельный контроль причины; силовые допуски, данные и файлы не меняются; общей приёмки нет',
  causes,stations:Array.from({length:7},(_,i)=>fit(i/6)),nearHandleLimit:[.13716,.13717,.13718,.13719,.13720].map(fit),
  maxCamError:Math.max(...samples.map(p=>Math.abs(p.camError))),
  outsideCubicClosure:samples.filter(p=>!p.reachability.targetInClosure).length,
  minimumAtDerivative:Math.min(...samples.map(p=>p.reachability.minimumDerivative)),
  maxAtError:samples.reduce((a,p)=>Math.abs(p.atError)>Math.abs(a.atError)?p:a),profileScan,samples};
const destination=resolve(root,args[0].slice(6));mkdirSync(dirname(destination),{recursive:true});
writeFileSync(destination,JSON.stringify(output,null,2)+'\n');
for(const r of causes)console.log(`${r.analyticCutProfile?'Максимум по производной':'Максимум по отсчётам'}, ${r.divisions} делений: расстояние ${(1000*r.maxDistanceM).toFixed(6)} мм`);
console.log(`Ошибка глубины до ${output.maxCamError.toExponential(6)}; места максимума до ${Math.abs(output.maxAtError.atError).toFixed(6)} хорды`);
console.log(`Недостижимых заданных сечений: ${output.outsideCubicClosure} из ${samples.length}; минимальная производная места максимума ${output.minimumAtDerivative.toFixed(6)}`);
console.log(`Сохранено: ${destination}`);
