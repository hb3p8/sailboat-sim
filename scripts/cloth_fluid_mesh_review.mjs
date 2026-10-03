// Сравнение завершённых сеточных опытов: числа и несглаженные сохранённые формы.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {commonNodeDistances} from '../tests/cloth-motion-refinement.mjs';

const args=process.argv.slice(2);
assert(args.every(v=>/^--(input|out-prefix)=.+$/.test(v))&&args.filter(v=>v.startsWith('--out-prefix=')).length===1);
const paths=args.filter(v=>v.startsWith('--input=')).map(v=>v.slice(8)),prefix=args.find(v=>v.startsWith('--out-prefix=')).slice(13);
assert(paths.length>=2&&new Set(paths).size===paths.length&&!existsSync(prefix+'.json')&&!existsSync(prefix+'.html'),
  'Нужны разные завершённые входы и новый префикс отчёта/стенда');
const hash=b=>createHash('sha256').update(b).digest('hex'),records=paths.map(path=>{
  const bytes=readFileSync(path),r=JSON.parse(bytes);
  assert.equal(r.schema,'cloth-fluid-mesh-v1');assert.equal(r.phase,'complete');
  assert.equal(r.steps.length,r.config.requestedSteps);
  for(const [p,sha] of Object.entries(r.sourceSha256))assert.equal(hash(readFileSync(p)),sha,'Изменился исходник '+p);
  for(const p of [r.input,r.wasm])assert.equal(hash(readFileSync(p.path)),p.sha256,'Изменился вход '+p.path);
  assert.equal(hash(readFileSync('out/export/physics.json')),r.physicsSha256);
  if(!r.dirty)for(const [p,sha] of Object.entries(r.sourceSha256))
    assert.equal(hash(execFileSync('git',['show',`${r.revision}:${p}`],{maxBuffer:16*1024*1024})),sha);
  return {path,sha256:hash(bytes),...r};
});
const first=records[0];
const unique=new Set();
for(const r of records) {
  const key=[r.config.tack,r.config.pressureScale,r.config.rows,r.config.cols].join(':');
  assert(!unique.has(key));unique.add(key);
  assert.deepEqual(r.parameters,first.parameters);
  assert.deepEqual(r.sourceSha256,first.sourceSha256);assert.equal(r.physicsSha256,first.physicsSha256);
  assert.equal(r.config.hS,first.config.hS);
}
const local=(p,body)=>{
  const {originM:o,orientation9:r}=body;
  return p.map((_,k)=>{const i=k-k%3,d=k%3,x=p.slice(i,i+3).map((v,j)=>v-o[j]);
    return r[d]*x[0]+r[3+d]*x[1]+r[6+d]*x[2];});
};
const sample=(r,step)=>step===0?r.initial:r.steps[step-1];
const comparisons=[];
for(const tack of [...new Set(records.map(r=>r.config.tack))])for(const scale of [...new Set(records.map(r=>r.config.pressureScale))]) {
  const group=records.filter(r=>r.config.tack===tack&&r.config.pressureScale===scale).sort((a,b)=>a.config.rows-b.config.rows);
  if(!group.length)continue;
  assert(group.length>=2,'В каждой группе нужны минимум две сетки');
  for(const r of group)assert.deepEqual(r.recipe.field,group[0].recipe.field);
  for(let j=1;j<group.length;j++) {
    const a=group[j-1],b=group[j];
    assert.equal(commonNodeDistances(a.recipe,b.recipe,a.recipe.reference,b.recipe.reference).maximumM,0);
    for(const step of [0,15,30,60,120,300].filter(i=>i<=Math.min(a.steps.length,b.steps.length))) {
      const sa=sample(a,step),sb=sample(b,step);
      comparisons.push({tack,pressureScale:scale,step,timeS:step*a.config.hS,
        world:commonNodeDistances(a.recipe,b.recipe,sa.positionsM,sb.positionsM),
        bodyRelative:commonNodeDistances(a.recipe,b.recipe,local(sa.positionsM,sa.body),local(sb.positionsM,sb.body)),
        fixedGridWorld:commonNodeDistances(a.recipe,b.recipe,sa.positionsM,sb.positionsM,group[0].recipe),
        fixedGridBodyRelative:commonNodeDistances(a.recipe,b.recipe,local(sa.positionsM,sa.body),local(sb.positionsM,sb.body),group[0].recipe)});
    }
  }
}
const report={schema:'cloth-fluid-mesh-review-v1',createdAt:new Date().toISOString(),
  revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  sourceSha256:Object.fromEntries(['scripts/cloth_fluid_mesh_review.mjs','tests/cloth-motion-refinement.mjs'].map(p=>[p,hash(readFileSync(p))])),
  physicalAcceptance:false,
  scope:'Углы ломаных краёв и соседних граней по координатам; кривизна — угол в радианах / полусумма длин соседних участков. Различия формы в общих узлах отдельно в мире и относительно опоры; без подгонки поз или интерполяции времени. Не воспроизводит неизвестные команды/момент пользовательского снимка.',
  sources:records.map(r=>({path:r.path,sha256:r.sha256,revision:r.revision,dirty:r.dirty,config:r.config,
    fieldTotals:r.fieldTotals,referenceComparison:r.referenceComparison})),comparisons,
  final:records.map(r=>({path:r.path,config:r.config,turns:r.steps.at(-1).turns}))};
const displayed=records.map(r=>({file:r.path,sha256:r.sha256,revision:r.revision,dirty:r.dirty,config:r.config,
  frames:[...new Set([0,15,30,60,120,300,r.steps.length])].filter(i=>i<=r.steps.length).sort((a,b)=>a-b).map(step=>{const s=sample(r,step);
    return {step,timeS:step*r.config.hS,positionsM:local(s.positionsM,s.body),turns:s.turns};})}));
const payload=JSON.stringify(displayed).replace(/</g,'\\u003c');
const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Излом и плотность сетки паруса</title>
<style>body{margin:24px;color:#213d4d;background:#f3f7fa;font:15px system-ui}h1{font-size:24px}.controls{display:flex;gap:20px;flex-wrap:wrap;margin:20px 0}label{display:flex;gap:8px;align-items:center}select{padding:6px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}article{background:white;border:1px solid #d0dee6;border-radius:10px;padding:12px}canvas{width:100%;height:520px;touch-action:none;cursor:grab}.numbers{font-size:13px;min-height:54px;line-height:1.6}details{margin:20px 0}pre{white-space:pre-wrap;font-size:12px}p{max-width:1100px}</style>
<h1>Излом и плотность сетки паруса</h1>
<p>Здесь сохранённые расчёты ткани с общей движущейся опорой. Сетка уточняется по высоте и ширине, материал и нагрузка одинаковые. Геометрия показана без сглаживания и интерполяции; плоское освещение подчёркивает грани. Поворот мышью и масштаб колесом общие для всех вариантов.</p>
<div class="controls"><label>Сторона <select id="side"></select></label><label>Давление <select id="pressure"></select></label><label>Время <select id="time"></select></label><label><input id="wire" type="checkbox">Показать сетку</label><button id="reset">Исходный ракурс</button></div>
<p>Оранжевый — задний край; синий — передний; фиолетовый — нижний.</p><div id="cards" class="cards"></div><p>Человеческая оценка: похож ли заметный излом на тот, что виден в живом опыте? Если сохраняется на плотной сетке — укажите край или участок. Размер сетки, углы, силы и точность расчёта проверяются инструментами.</p>
<details><summary>Происхождение и границы опыта</summary><pre id="provenance"></pre></details>
<script>const records=${payload};
const side=document.querySelector('#side'),pressure=document.querySelector('#pressure'),time=document.querySelector('#time'),wire=document.querySelector('#wire'),cards=document.querySelector('#cards');
for(const s of [...new Set(records.map(r=>r.config.tack))])side.add(new Option(s===1?'Плюс':'Минус',s));
if(records.some(r=>r.config.tack===1))side.value='1';
for(const s of [...new Set(records.map(r=>r.config.pressureScale))].sort())pressure.add(new Option((s*100)+'%',s));pressure.value='1.5';
const steps=[...new Set(records.flatMap(r=>r.frames.map(f=>f.step)))].sort((a,b)=>a-b);for(const s of steps)time.add(new Option((s/60)+' с',s));time.value=steps.includes(60)?'60':String(steps.at(-1));
let az=-Math.PI/3,pitch=.17,zoom=1,views=[];
const sub=(a,b)=>a.map((v,d)=>v-b[d]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const point=(p,i)=>p.slice(3*i,3*i+3);
function draw(){for(const v of views){const rect=v.canvas.getBoundingClientRect(),ratio=devicePixelRatio||1,ctx=v.canvas.getContext('2d');v.canvas.width=rect.width*ratio;v.canvas.height=rect.height*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle='#f3f8fa';ctx.fillRect(0,0,rect.width,rect.height);const frame=v.r.frames.find(f=>f.step===Number(time.value));
if(!frame){v.numbers.textContent='Этот момент на данной сетке не рассчитан.';continue;}
const p=frame.positionsM,rows=v.r.config.rows,cols=v.r.config.cols,scale=Math.min(rect.width/9,rect.height/12)*zoom;
const project=q=>{const a=q.map((x,d)=>x-[4,-2*v.r.config.tack,5][d]),ca=Math.cos(az),sa=Math.sin(az),cp=Math.cos(pitch),sp=Math.sin(pitch);return [rect.width/2+scale*(-sa*a[0]+ca*a[1]),rect.height/2-scale*(-sp*(ca*a[0]+sa*a[1])+cp*a[2]),cp*(ca*a[0]+sa*a[1])+sp*a[2]];};
const polys=[];for(let r=0;r<rows-1;r++)for(let c=0;c<cols-1;c++){const a=r*cols+c;for(const t of [[a,a+1,a+cols],[a+1,a+cols+1,a+cols]]){const xyz=t.map(i=>point(p,i)),n=cross(sub(xyz[1],xyz[0]),sub(xyz[2],xyz[0])),len=Math.hypot(...n),shade=170+55*Math.abs((.5*n[0]-.6*n[1]+.6*n[2])/(len||1)),q=xyz.map(project);polys.push({q,depth:q.reduce((s,x)=>s+x[2],0)/3,shade});}}
polys.sort((a,b)=>a.depth-b.depth);for(const t of polys){ctx.beginPath();t.q.forEach((q,i)=>i?ctx.lineTo(q[0],q[1]):ctx.moveTo(q[0],q[1]));ctx.closePath();ctx.fillStyle='rgb('+t.shade+','+(t.shade-5)+','+(t.shade-20)+')';ctx.fill();if(wire.checked){ctx.strokeStyle='#56717b99';ctx.lineWidth=.55;ctx.stroke();}}
for(const [nodes,color] of [[Array.from({length:rows},(_,r)=>r*cols),'#297fab'],[Array.from({length:rows},(_,r)=>r*cols+cols-1),'#dd772a'],[Array.from({length:cols},(_,c)=>c),'#77619c']]){ctx.beginPath();nodes.map(i=>project(point(p,i))).forEach((q,i)=>i?ctx.lineTo(q[0],q[1]):ctx.moveTo(q[0],q[1]));ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();}
const e=frame.turns.boundary;v.numbers.textContent='Поворот заднего края: '+e.leech.maximumAngle.angleDeg.toFixed(2)+'°; нижнего: '+e.foot.maximumAngle.angleDeg.toFixed(2)+'°. Между гранями: '+frame.turns.maximumDihedral.angleDeg.toFixed(2)+'°.';}}
function setup(){cards.replaceChildren();views=[];const selected=records.filter(r=>r.config.tack===Number(side.value)&&r.config.pressureScale===Number(pressure.value)).sort((a,b)=>a.config.rows-b.config.rows);selected.forEach((r,i)=>{const card=document.createElement('article'),title=document.createElement('strong'),canvas=document.createElement('canvas'),numbers=document.createElement('div');numbers.className='numbers';title.textContent=String.fromCharCode(65+i)+' · '+r.config.rows+'×'+r.config.cols+' · '+((r.config.rows-1)*(r.config.cols-1)*2)+' треугольников';card.append(title,canvas,numbers);cards.append(card);views.push({r,canvas,numbers});let drag;canvas.addEventListener('pointerdown',e=>{drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId)});canvas.addEventListener('pointermove',e=>{if(!drag)return;az+=(e.clientX-drag[0])*.009;pitch=Math.max(-1.4,Math.min(1.4,pitch+(e.clientY-drag[1])*.006));drag=[e.clientX,e.clientY];draw()});canvas.addEventListener('pointerup',()=>drag=null);canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.4,Math.min(3,zoom*Math.exp(-e.deltaY*.001)));draw()},{passive:false});});document.querySelector('#provenance').textContent=JSON.stringify(selected.map(({file,sha256,revision,dirty,config})=>({file,sha256,revision,dirty,config})),null,2);draw();}
side.addEventListener('change',setup);pressure.addEventListener('change',setup);time.addEventListener('change',draw);wire.addEventListener('change',draw);document.querySelector('#reset').addEventListener('click',()=>{az=-Math.PI/3;pitch=.17;zoom=1;draw()});window.addEventListener('resize',draw);setup();</script></html>`;
writeFileSync(prefix+'.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
writeFileSync(prefix+'.html',html,{flag:'wx'});
console.log(JSON.stringify({отчёт:prefix+'.json',стенд:prefix+'.html',записей:records.length,сравнений:comparisons.length}));
