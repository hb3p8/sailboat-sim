// Собрать локальный стенд для человеческой оценки сохранённых форм ткани.
// Геометрия читается из опыта; собственных физических поправок и анимации нет.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.some(a => !a.startsWith('--input=') && !a.startsWith('--out=')) ||
    args.some(a => a === '--input=' || a === '--out=') || args.filter(a => a.startsWith('--out=')).length !== 1)
  throw new Error('Нужны --input=запись (можно несколько) и --out=страница.html');
const paths = args.filter(a => a.startsWith('--input=')).map(a => resolve(a.slice(8)));
const destination = resolve(args.find(a => a.startsWith('--out=')).slice(6));
if (!paths.length || new Set(paths).size !== paths.length || paths.includes(destination))
  throw new Error('Нужны разные входы и отдельный результат');
const data = paths.map(path => {
  const bytes = readFileSync(path), record = JSON.parse(bytes);
  const cutOnly = record.config?.cutOnly === true;
  if ((!cutOnly && (!record.config?.energyMaterial || !record.config.fixedLoad || !record.config.holdCutClew)) || !record.results?.length)
    throw new Error('Нужен опыт нового материала с постоянной нагрузкой и неподвижными углами');
  return { file: path, sha256: createHash('sha256').update(bytes).digest('hex'), revision: record.revision,
    dirty: record.dirty, cutOnly, config: record.config, physicsSha256: record.physicsSha256,
    results: record.results.slice().sort((a,b) => a.referencePositionsM.length-b.referencePositionsM.length).map(r => ({ cols: r.cols, rows: r.referencePositionsM.length / (3 * r.cols),
      reference: r.referencePositionsM, final: cutOnly ? r.referencePositionsM : r.finalPositionsM,
      frames: cutOnly ? [] : r.samples.filter(s => s.positionsM).map(s => ({ timeS: s.timeS, positions: s.positionsM })) })) };
});
const cutOnly = data[0].cutOnly;
if (data.some(d => d.cutOnly !== cutOnly)) throw new Error('Крой и движение сравниваются в отдельных стендах');
for (const record of data) {
  const times = record.results[0].frames.map(f => f.timeS).filter(t => record.results.every(r => r.frames.some(f => f.timeS === t)));
  for (const result of record.results) {
    const valid = p => Array.isArray(p) && p.length === 3 * result.rows * result.cols && p.every(Number.isFinite);
    if (!Number.isInteger(result.rows) || result.rows < 4 || !Number.isInteger(result.cols) || result.cols < 4 ||
        !valid(result.reference) || !valid(result.final)) throw new Error('Некорректные координаты формы');
    result.frames = result.frames.filter(f => times.includes(f.timeS));
    if (result.frames.some(f => !Number.isFinite(f.timeS) || !valid(f.positions))) throw new Error('Некорректные кадры формы');
  }
}
if (new Set(data.map(d => d.cutOnly ? d.config.designSide : d.config.tack)).size !== data.length) throw new Error('По одной записи на сторону');
const encoded = JSON.stringify(data).replace(/</g, '\\u003c');
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Генакер — сравнение сохранённых форм</title>
<style>
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#eef2f4;color:#20303d;font:15px/1.45 system-ui,sans-serif}
main{max-width:1580px;margin:auto;padding:22px}h1{font-size:27px;margin:0 0 8px}p{margin:8px 0}.muted{color:#61717e}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin:18px 0}button,select{font:inherit;background:white;border:1px solid #c1ced6;border-radius:7px;padding:8px 12px;color:inherit;cursor:pointer}button.active{background:#234e66;color:white}
.cards{display:grid;grid-template-columns:repeat(${cutOnly ? 3 : 4},minmax(0,1fr));gap:12px}.card{background:white;border:1px solid #d4dfe5;border-radius:12px;overflow:hidden}.label{padding:12px 14px;border-bottom:1px solid #e1e8ec}.label strong{display:block}.label span{font-size:13px;color:#697d8b}canvas{width:100%;height:430px;display:block;touch-action:none;cursor:grab}.sections{width:100%;height:165px;cursor:default;background:#f9fbfc}.caption{padding:7px 14px;font-size:13px;color:#5d707e}
.questions,details{margin-top:20px;background:white;border:1px solid #d4dfe5;border-radius:10px;padding:16px}.questions h2{margin:0 0 8px;font-size:18px}li{margin:7px 0}summary{cursor:pointer}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}input[type=range]{width:180px;vertical-align:middle}
@media(max-width:950px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}canvas{height:350px}}@media(max-width:520px){main{padding:12px}.cards{grid-template-columns:1fr}canvas{height:400px}}
</style><main><h1>${cutOnly ? 'Исходный крой: переход от нижнего края к полотну' : 'Одна нагрузка, разная подробность расчёта'}</h1>
<p>Поверните любой парус мышью: все ракурсы изменятся вместе. Колесо мыши меняет масштаб. Оранжевая линия выделяет одно и то же сечение по высоте.</p>
<p class="muted">${cutOnly ? 'Показан исходный крой без движения под ветром. По ширине одинаковое число точек, по высоте — разное. Сравнение выявляет особенности построения формы; это ещё не летящий парус.' : 'Это сохранённые формы исследовательского опыта. Проверяется вид полотна под постоянной нагрузкой; управление верёвкой и потеря наполнения в манёвре здесь ещё не показаны.'}</p>
<div class="tools"><label>${cutOnly ? 'Борт кроя' : 'Ветер'}: <select id="side"></select></label><button data-view="side" class="active">Сбоку</button><button data-view="front">Со стороны переднего края</button><button data-view="top">Сверху</button><label><input id="mesh" type="checkbox"> Линии сетки</label>${cutOnly ? '<label>Участок: <select id="region"><option value="full">Весь парус</option><option value="bottom" selected>Нижняя часть крупнее</option></select></label>' : ''}</div>
<div class="tools" id="timeTools" hidden><label>Сохранённый кадр: <input type="range" id="frame" min="0" value="0"><span id="time"></span></label><button id="play">Проиграть кадры</button><span class="muted">Кадры сняты с промежутками; быстрые колебания между ними не видны.</span></div>
<div class="tools"><label>Сечение по высоте: <input type="range" id="height" min="${cutOnly ? 0 : 1}" max="9" value="${cutOnly ? 0 : 5}"><span id="heightLabel">${cutOnly ? 'Нижняя кромка' : '50%'}</span></label><span class="muted">Внизу — вид выбранного сечения сверху, в одинаковом масштабе.</span></div>
<div class="cards" id="cards"></div>
<section class="questions"><h2>Вопросы для визуальной оценки</h2><ol>
${cutOnly ? `<li>Как выглядит переход от нижнего края к остальному полотну в A → B → C: просто более гладко или появляется резкий перегиб/узкая полоса?</li>
<li>У переднего края и в середине нижней части видна ли «полка», которая выглядит неестественно для сшитого паруса? Укажите букву и место.</li>
<li>Есть ли похожий резкий переход у верхнего крепления, если выбрать весь парус? Это сравнение кроя, а не складок под нагрузкой.</li>` : `
<li>Есть ли неестественный резкий залом, складка или натяжение? Укажите букву паруса и место: верх, середина, передний край или нижний угол.</li>
<li>При переходе B → C → D меняется характер всей формы или лишь её гладкость? Какие различия вы считаете существенными?</li>
<li>Если доступны кадры во времени: есть ли резкое изменение между сохранёнными формами? Укажите время; по этим кадрам нельзя оценить быстрые движения между ними.</li>
`}
</ol><p class="muted">Можно отвечать свободным текстом. Полезно указать выбранные сторону, ракурс и сечение. ${cutOnly ? 'A/B/C — один исходный крой с растущим числом рядов.' : 'A — исходный крой, B/C/D — расчёт с растущим числом точек.'}</p></section>
<details><summary>Условия и происхождение</summary><pre id="provenance"></pre></details></main>
<script type="module">
const records=${encoded};
const cutOnly=${cutOnly},key=r=>cutOnly?r.config.designSide:r.config.tack;
const sideSelect=document.querySelector('#side'),cards=document.querySelector('#cards'),height=document.querySelector('#height'),frame=document.querySelector('#frame');
for(const r of records){const option=document.createElement('option');option.value=key(r);option.textContent=key(r)===1?'С первой стороны':'С другой стороны';sideSelect.append(option)}
let azimuth=-.8,elevation=.08,zoom=1,views=[],timer=null;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((x,k)=>x-b[k]);
const point=(p,i)=>p.slice(3*i,3*i+3);
function state(v){if(v.reference)return v.result.reference;const i=Number(frame.value);return v.result.frames[i]?.positions||v.result.final}
function projection(v,p){const bottom=cutOnly&&document.querySelector('#region').value==='bottom',centerZ=bottom?v.bottomCenterZ:v.center[2],x=p[0]-v.center[0],y=p[1]-v.center[1],z=p[2]-centerZ,c=Math.cos(azimuth),s=Math.sin(azimuth),e=Math.cos(elevation),t=Math.sin(elevation),scale=v.scale*zoom*(bottom?1.6:1);
 const horizontal=c*x+s*y,depth=-s*x+c*y;return [v.width/2+horizontal*scale,v.height/2-(e*z-t*depth)*scale,e*depth+t*z]}
function render(v){const canvas=v.canvas,ctx=canvas.getContext('2d'),rect=canvas.getBoundingClientRect(),ratio=devicePixelRatio||1;v.width=rect.width;v.height=rect.height;canvas.width=rect.width*ratio;canvas.height=rect.height*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);v.scale=Math.min(v.width/8.5,v.height/12);ctx.fillStyle='#f4f8fa';ctx.fillRect(0,0,v.width,v.height);
 const p=state(v),polygons=[],{rows,cols}=v.result;
 for(let r=0;r<rows-1;r++)for(let c=0;c<cols-1;c++){const a=r*cols+c,b=a+1,e=a+cols,g=e+1;for(const indices of [[a,b,e],[g,e,b]]){const xyz=indices.map(i=>point(p,i)),n=cross(sub(xyz[1],xyz[0]),sub(xyz[2],xyz[0])),nl=Math.hypot(...n)||1,light=Math.abs((.6*n[0]-.4*n[1]+.7*n[2])/nl),projected=xyz.map(q=>projection(v,q));polygons.push({projected,depth:projected.reduce((sum,q)=>sum+q[2],0)/3,shade:Math.round(168+65*light)})}}
 polygons.sort((a,b)=>b.depth-a.depth);for(const face of polygons){ctx.beginPath();face.projected.forEach((q,i)=>i?ctx.lineTo(q[0],q[1]):ctx.moveTo(q[0],q[1]));ctx.closePath();ctx.fillStyle='rgb('+face.shade+','+(face.shade+9)+','+(face.shade+16)+')';ctx.fill();ctx.strokeStyle=document.querySelector('#mesh').checked?'#647a8980':ctx.fillStyle;ctx.lineWidth=.45;ctx.stroke()}
 const row=Math.round(Number(height.value)/10*(rows-1)),points=Array.from({length:cols},(_,c)=>point(p,row*cols+c));ctx.strokeStyle='#de7c23';ctx.lineWidth=2.1;ctx.beginPath();points.forEach((q,i)=>{const a=projection(v,q);i?ctx.lineTo(a[0],a[1]):ctx.moveTo(a[0],a[1])});ctx.stroke();
 for(const [i,label] of [[0,'Низ спереди'],[(rows-1)*cols,'Верх'],[cols-1,'Нижний угол']]){const q=projection(v,point(p,i));if(q[0]<0||q[0]>v.width||q[1]<0||q[1]>v.height)continue;ctx.fillStyle='#234e66';ctx.beginPath();ctx.arc(q[0],q[1],3.5,0,2*Math.PI);ctx.fill();ctx.font='11px system-ui';ctx.fillText(label,Math.max(6,Math.min(v.width-95,q[0]+6)),Math.max(15,q[1]-6))}
 const sc=v.section,cr=sc.getBoundingClientRect(),sx=sc.getContext('2d');sc.width=cr.width*ratio;sc.height=cr.height*ratio;sx.setTransform(ratio,0,0,ratio,0,0);sx.fillStyle='#f9fbfc';sx.fillRect(0,0,cr.width,cr.height);sx.strokeStyle='#d9e2e7';sx.beginPath();sx.moveTo(12,cr.height/2);sx.lineTo(cr.width-12,cr.height/2);sx.stroke();sx.strokeStyle='#de7c23';sx.lineWidth=2;sx.beginPath();let sectionCenter=v.center;if(cutOnly){const first=records.find(r=>String(key(r))===sideSelect.value).results[0],row=Math.round(Number(height.value)/10*(first.rows-1)),base=Array.from({length:first.cols},(_,c)=>point(first.reference,row*first.cols+c));sectionCenter=[0,1].map(d=>(Math.min(...base.map(q=>q[d]))+Math.max(...base.map(q=>q[d])))/2)}const sectionScale=Math.min(cr.width/8.5,cr.height/6);points.forEach((q,i)=>{const scale=cutOnly?sectionScale:cr.width/8.5,x=cr.width/2+(q[0]-sectionCenter[0])*scale,y=cr.height/2+(q[1]-sectionCenter[1])*scale;i?sx.lineTo(x,y):sx.moveTo(x,y)});sx.stroke();}
function redraw(){document.querySelector('#heightLabel').textContent=cutOnly&&Number(height.value)===0?'Нижняя кромка':Number(height.value)*10+'%';const selected=records.find(r=>String(key(r))===sideSelect.value),time=selected.results[0].frames[Number(frame.value)]?.timeS;document.querySelector('#time').textContent=time==null?'Конечная форма':time.toFixed(1)+' с';views.forEach(render)}
function build(){if(timer){clearInterval(timer);timer=null;document.querySelector('#play').textContent='Проиграть кадры'}cards.replaceChildren();views=[];const record=records.find(r=>String(key(r))===sideSelect.value),result=record.results[0],ref=result.reference,center=[0,0,0];let bottomCenterZ;for(let d=0;d<3;d++){const values=ref.filter((_,i)=>i%3===d),lo=Math.min(...values),hi=Math.max(...values);center[d]=(lo+hi)/2;if(d===2)bottomCenterZ=lo+.17*(hi-lo)}const entries=cutOnly?record.results.map(result=>({reference:true,result})):[{reference:true,result},...record.results.map(result=>({reference:false,result}))];
 frame.max=Math.max(0,...record.results.map(r=>r.frames.length-1));frame.value=frame.max;document.querySelector('#timeTools').hidden=!record.results.some(r=>r.frames.length);
 entries.forEach((entry,i)=>{const card=document.createElement('article');card.className='card';const label=document.createElement('div');label.className='label';const title=document.createElement('strong');title.textContent=String.fromCharCode(65+i)+' · '+(cutOnly?'Рядов: '+entry.result.rows:entry.reference?'Исходный крой':i===1?'Меньше точек':i===entries.length-1?'Больше точек':'Среднее');const subtitle=document.createElement('span');subtitle.textContent=(entry.reference?'Без приложенной нагрузки':'Та же нагрузка, те же закрепления')+' · '+entry.result.rows+'×'+entry.result.cols;label.append(title,subtitle);const canvas=document.createElement('canvas'),section=document.createElement('canvas');section.className='sections';const caption=document.createElement('div');caption.className='caption';caption.textContent='Сечение сверху';card.append(label,canvas,caption,section);cards.append(card);const v={...entry,canvas,section,center,bottomCenterZ};views.push(v);let drag;
 canvas.addEventListener('pointerdown',e=>{drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId)});canvas.addEventListener('pointermove',e=>{if(!drag)return;azimuth+=(e.clientX-drag[0])*.007;elevation=Math.max(-1.5,Math.min(1.5,elevation+(e.clientY-drag[1])*.006));drag=[e.clientX,e.clientY];redraw()});canvas.addEventListener('pointerup',()=>drag=null);canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.55,Math.min(2.3,zoom*Math.exp(-e.deltaY*.001)));redraw()},{passive:false})});
 document.querySelector('#provenance').textContent=JSON.stringify(records.map(r=>({file:r.file,sha256:r.sha256,revision:r.revision,dirty:r.dirty,config:r.config,physicsSha256:r.physicsSha256})),null,2);redraw()}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));[azimuth,elevation]=button.dataset.view==='front'?[.8,0]:button.dataset.view==='top'?[-.8,1.5]:[-.8,.08];zoom=1;redraw()}));
sideSelect.addEventListener('change',build);height.addEventListener('input',redraw);frame.addEventListener('input',redraw);document.querySelector('#mesh').addEventListener('change',redraw);window.addEventListener('resize',redraw);
document.querySelector('#region')?.addEventListener('change',redraw);
document.querySelector('#play').addEventListener('click',()=>{if(timer){clearInterval(timer);timer=null;document.querySelector('#play').textContent='Проиграть кадры';return}frame.value=0;redraw();document.querySelector('#play').textContent='Остановить';timer=setInterval(()=>{if(Number(frame.value)>=Number(frame.max)){clearInterval(timer);timer=null;document.querySelector('#play').textContent='Проиграть кадры';return}frame.value=Number(frame.value)+1;redraw()},900)});
build();
</script></html>`;
mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, html);
console.log(`Стенд сохранённых форм: ${destination}`);
