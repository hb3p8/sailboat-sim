// Сопоставить неизменяемые края кроя и входные параметры внутренних сечений.
// Прямая верхняя планка даёт независимый геометрический контроль; силы не считаются.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Boat} from '../sim/physics.js';
import {Cloth} from '../sim/cloth.js';
import {designAt,DESIGN_DRAFT,DESIGN_ENTRY,DESIGN_EXIT} from '../sim/aero.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
assert.ok(args.length===1 && args[0].startsWith('--out=') && args[0].slice(6),
  'Нужен отдельный результат --out=запись.json');
const sha=x=>createHash('sha256').update(x).digest('hex');
const paths=['tests/cloth-cut-boundaries.mjs','data/sail/deparday_j80_2016.json',
  ...readdirSync(resolve(root,'sim')).filter(p=>p.endsWith('.js')).map(p=>`sim/${p}`)];
const sourceSha256=Object.fromEntries(paths.map(p=>[p,sha(readFileSync(resolve(root,p)))]));
const pack=readFileSync(resolve(root,'out/export/physics.json'));
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const dirty=!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim();
const b=new Boat(JSON.parse(pack));b.setGennaker(true);
const target=v=>({camber:designAt(b.rig.sails[2].design,v),
  draft:designAt(DESIGN_DRAFT.gennaker,v),entryDeg:designAt(DESIGN_ENTRY.gennaker,v),
  exitDeg:DESIGN_EXIT.gennaker});
const sampleCount=513,results=[];
let referenceEdges=null;
for(const model of ['continuous','continuous-analytic','continuous-joined']) {
  const c=new Cloth(b.rig.sails[2],2,{rows:11,cols:9,rigidBoard:true,continuousCut:true,
    analyticCutProfile:model==='continuous-analytic',joinedCutProfile:model==='continuous-joined'});
  c.gen=b.p.rig.gennaker;c.designSide=-1;c.design3d([]);
  // Общий измеритель формы; адаптер сохраняет контракт rf=индекс ряда, t=доля ширины.
  // Здесь берутся точки непрерывной поверхности, а не интерполяция девяти узлов.
  const samples={cols:sampleCount,cutAt:(rf,t,out)=>c.cutSurfaceAt(t,rf/(c.rows-1),out)};
  const shape=v=>Cloth.prototype.rowShape.call(samples,v*(c.rows-1),true);
  const edges=[];
  for(let i=0;i<sampleCount;i++)for(const [u,v] of [[i/(sampleCount-1),0],
    [i/(sampleCount-1),1],[0,i/(sampleCount-1)],[1,i/(sampleCount-1)]])
    edges.push(...c.cutSurfaceAt(u,v,[]));
  if(referenceEdges)assert.deepEqual(edges,referenceEdges,'Граничные кривые контроля различаются');
  else referenceEdges=edges;
  const head=[c.gen.head[0],0,c.gen.head[1]],aft=[c.gen.head_aft[0],0,c.gen.head_aft[1]];
  const chord=Math.hypot(...aft.map((x,k)=>x-head[k]));
  assert.ok(chord>0,'Верхнее крепление должно иметь ненулевую длину');
  assert.ok(Math.abs(chord-c.gen.head_width_m)<1e-12,'Длина планки не равна её хорде');
  let maxTopLineErrorM=0;
  for(let i=0;i<sampleCount;i++) {
    const u=i/(sampleCount-1),p=c.cutSurfaceAt(u,1,[]);
    maxTopLineErrorM=Math.max(maxTopLineErrorM,
      Math.hypot(...p.map((x,k)=>x-((1-u)*head[k]+u*aft[k]))));
  }
  assert.ok(maxTopLineErrorM<1e-12,'Верхний край отклоняется от прямой планки');
  const boundaries=[0,1].map(v=>({v,target:target(v),actual:shape(v)}));
  assert.ok(boundaries[1].actual.camber<1e-12,'Прямая планка получила выпуклость');
  assert.ok(target(1).camber>0,'Контроль несовместимости требует ненулевой глубины таблицы');
  const nearTop=[.01,.001,.0001,.00001,.000001].map(distance=>({
    v:1-distance,target:target(1-distance),actual:shape(1-distance)}));
  results.push({cutModel:model,topChordM:chord,maxTopLineErrorM,boundaries,nearTop});
  console.log(`${model}: низ ${boundaries[0].actual.camber.toFixed(6)} вместо ${target(0).camber.toFixed(6)}; `+
    `верх ${boundaries[1].actual.camber.toFixed(6)} вместо ${target(1).camber.toFixed(6)}; `+
    `ошибка прямой планки ${maxTopLineErrorM.toExponential(3)} м`);
}
for(const p of paths)assert.equal(sha(readFileSync(resolve(root,p))),sourceSha256[p],'Исходник изменился');
assert.equal(sha(readFileSync(resolve(root,'out/export/physics.json'))),sha(pack),'Пакет изменился');
const destination=resolve(root,args[0].slice(6));
assert.ok(!paths.map(p=>resolve(root,p)).includes(destination) && destination!==resolve(root,'out/export/physics.json'),
  'Результат не должен заменять входной файл');
mkdirSync(dirname(destination),{recursive:true});
writeFileSync(destination,JSON.stringify({schema:1,createdAt:new Date().toISOString(),revision,dirty,
  physicsSha256:sha(pack),sourceSha256,config:{sampleCount,rows:11,cols:9,designSide:-1},
  rule:'общий измеритель непрерывной поверхности; независимая прямая верхнего крепления; '+
    'таблица задаёт внутреннее семейство до согласования, не окончательные края; '+
    'точность 1e-12 только для округления прямой, не новый порог физической приёмки',results},null,2)+'\n');
console.log(`Аудит краёв: ${destination}`);
