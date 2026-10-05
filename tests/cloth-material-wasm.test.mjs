// Значения/градиенты независимого вычислителя против действующего JS,
// владение входом/выходом, рост памяти и отказы до изменения массивов.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {loadMaterialKernel} from './probes/cloth-material-wasm.mjs';
import {materialSurface,gridTriangles,MODEL_MATERIAL} from './lib/cloth-material.mjs';
const args=process.argv.slice(2),wasm=args.find(v=>v.startsWith('--wasm='))?.slice(7),out=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(wasm&&args.length===(out?2:1)&&args.every(v=>/^--(wasm|out)=.+$/.test(v)));
const bytes=readFileSync(wasm),kernel=await loadMaterialKernel(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
await assert.rejects(loadMaterialKernel(Uint8Array.from([0,97,115,109,1,0,0,0])),/Несовместимая/);
const report={schema:'cloth-material-wasm-check-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),runtime:process.version,v8:process.versions.v8,
 wasm:{path:wasm,sha256:hash(bytes)},sourceSha256:Object.fromEntries(['tests/cloth-material-wasm.test.mjs','tests/probes/cloth-material-wasm.c','tests/probes/cloth-material-wasm.mjs','tests/lib/cloth-material.mjs','tests/cloth-compliance.mjs'].map(p=>[p,hash(readFileSync(p))])),
 values:0,gradientComponents:0,hessianComponents:0,hypotCases:0,rejected:1};
process.once('uncaughtException',e=>{report.phase='failed';report.failure={message:e.message,stack:e.stack};if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.error('Проверка материала WASM остановлена: '+e.message);process.exitCode=1;});
for(let i=0;i<2048;i++) {
 const scale=10**(i%601-300),v=[scale*Math.sin(i*.47),scale*Math.cos(i*.19),scale*Math.sin(i*.31)];
 assert(Object.is(kernel.hypot3(...v),Math.hypot(...v)),`Длина вектора ${i}`);report.hypotCases++;
}
for(const v of [[0,0,-0],[Infinity,NaN,0],[NaN,0,1],[Number.MIN_VALUE,-Number.MIN_VALUE,0],[1e308,-1e308,0]]) {
 assert(Object.is(kernel.hypot3(...v),Math.hypot(...v)));report.hypotCases++;
}
const input='out/acceptance/rigid-sail-60321b9-plus-five.json',recipe=JSON.parse(readFileSync(input)).recipe;
report.input={path:input,sha256:hash(readFileSync(input))};
const reference=Array.from({length:20},(_,i)=>{const x=i%5*.37,y=Math.floor(i/5)*.31;return[x,y,.09*Math.sin(x*1.3)*Math.cos(y*.7)];}).flat();
for(const setup of [
 {rows:4,cols:5,reference,current:reference.map((v,k)=>v*(k%3===0?1.03:k%3===1?.98:1)+.02*Math.sin(k*.47)),side:1,bending:'curvature'},
 {rows:4,cols:5,reference,current:reference.map((v,k)=>v+.02*Math.cos(k*.19)),side:-1,bending:'curvature'},
 {rows:4,cols:5,reference,current:reference.map((v,k)=>v+.02*Math.sin(k*.27)),side:1,bending:'hinge'},
 ...[1,-1].map(side=>({rows:recipe.rows,cols:recipe.cols,reference:recipe.reference,current:recipe.positions.slice(0,recipe.reference.length),side,bending:'curvature'}))]) {
 const mirror=p=>Float64Array.from(p,(v,k)=>k%3===1?setup.side*v:v),ref=mirror(setup.reference),q=mirror(setup.current),
  options={bendingModel:setup.bending,rows:setup.rows,cols:setup.cols},tris=gridTriangles(setup.rows,setup.cols),
  js=materialSurface(ref,tris,MODEL_MATERIAL,options),native=materialSurface(ref,tris,MODEL_MATERIAL,{...options,materialKernel:kernel});
 const states=[ref,q];
 for(const k of [0,1,2,q.length-3,q.length-2,q.length-1])for(const sign of [-1,1]){const p=q.slice();p[k]+=sign*2e-6*Math.max(1,Math.abs(p[k]));states.push(p);}
 for(const p of states) {
  const before=p.slice();assert.deepEqual(native.evaluate(p,true),js.evaluate(p,true));
  for(let j=0;j<js.constraints.length;j++) {
   const a=js.constraints[j],b=native.constraints[j],expected=a.value(p),actual=b.value(p);assert.deepEqual(actual,expected);report.values++;
   if(!b.valueInto)continue;
   const g=new Float64Array(3*b.gradientNodes.length),saved=structuredClone(actual);
   assert(Object.is(b.valueInto(p,g),expected.C));assert.deepEqual(Array.from(g),expected.grad.flatMap(([,v])=>v));report.gradientComponents+=g.length;
   g.fill(17);b.valueInto(ref,g);assert.deepEqual(actual,saved);
   const wrong=new Float64Array(g.length+1).fill(31);assert.throws(()=>b.valueInto(p,wrong));assert(wrong.every(v=>v===31));report.rejected++;
   if(b.gradientSlot!==0)continue;
   const group=b.gradientGroup,modes=native.constraints.slice(j,j+group.size),gradients=modes.map(c=>new Float64Array(3*c.gradientNodes.length)),C=group.valueInto(p,gradients);
   for(let k=0;k<modes.length;k++) {const v=js.constraints[j+k].value(p);assert(Object.is(C[k],v.C));assert.deepEqual(Array.from(gradients[k]),v.grad.flatMap(([,v])=>v));}
   const old=gradients.map(v=>v.slice());group.valueInto(ref,modes.map(c=>new Float64Array(3*c.gradientNodes.length)));assert.deepEqual(gradients,old);
   if((p===ref||p===q)&&typeof group.hessianInto==='function') {
    const size=gradients[0].length,weights=modes.map(c=>1/c.alpha),H=modes.map(()=>new Float64Array(size*size)),
     expectedH=modes.map(()=>new Float64Array(size*size)),plus=p.slice(),minus=p.slice(),
     gp=modes.map(()=>new Float64Array(size)),gm=modes.map(()=>new Float64Array(size));
    for(let column=0;column<size;column++) {
     const coordinate=3*modes[0].gradientNodes[Math.floor(column/3)]+column%3,delta=2e-6*Math.max(1,Math.abs(p[coordinate]));
     plus[coordinate]+=delta;minus[coordinate]-=delta;
     const Cp=js.constraints[j].gradientGroup.valueInto(plus,gp),Cm=js.constraints[j].gradientGroup.valueInto(minus,gm);
     for(let mode=0;mode<3;mode++)for(let row=0;row<size;row++)expectedH[mode][row*size+column]=
       weights[mode]*(Cp[mode]*(0+gp[mode][row])-Cm[mode]*(0+gm[mode][row]))/(2*delta);
     plus[coordinate]=p[coordinate];minus[coordinate]=p[coordinate];
    }
    group.hessianInto(p,weights,H);assert.deepEqual(H.map(v=>Array.from(v)),expectedH.map(v=>Array.from(v)));
    report.hessianComponents+=3*size*size;
    H.forEach(v=>v.fill(43));assert.throws(()=>group.hessianInto(p,weights.slice(1),H));assert(H.every(v=>v.every(x=>x===43)));report.rejected++;
   }
  }
  assert.deepEqual(p,before,'Вычислитель изменил вход');
 }
 if(setup.bending==='curvature') {
  const group=native.constraints.find(c=>c.family==='bending').gradientGroup,
   modes=native.constraints.filter(c=>c.family==='bending').slice(0,3),g=modes.map(c=>new Float64Array(3*c.gradientNodes.length).fill(23));
  assert.throws(()=>group.valueInto(new Float64Array(ref.length),g),/Вырожденная/);assert(g.every(v=>v.every(x=>x===23)));report.rejected++;
  const H=modes.map(c=>new Float64Array((3*c.gradientNodes.length)**2).fill(29));
  assert.throws(()=>group.hessianInto(new Float64Array(ref.length),modes.map(c=>1/c.alpha),H),/Вырожденная/);
  assert(H.every(v=>v.every(x=>x===29)));report.rejected++;
 }
}
// Память одной поверхности растёт после первого сохранённого вычислителя.
const descriptor={kind:'membrane',nodes:[0,1,2],bx:[-1,1,0],by:[-1,0,1]},context=kernel.createSurface(),g=context.compile(descriptor),
 q=Float64Array.from([0,0,0,1,0,0,0,1,0]),target=Array.from({length:3},()=>new Float64Array(9));
const C=g.valueInto(q,target),saved=target.map(v=>v.slice());
for(let i=0;i<800;i++)context.compile(descriptor);assert(context.statistics().growths>0);
assert.deepEqual(g.valueInto(q,target),C);assert.deepEqual(target,saved);
descriptor.nodes[0]=7;descriptor.bx[1]=19;
assert.deepEqual(g.valueInto(q,target),C);assert.deepEqual(target,saved,'Изменились скопированные веса');
const independent=kernel.createSurface().compile({kind:'membrane',nodes:[0,1,2],bx:[-1,1,0],by:[-1,0,1]});
const different=independent.valueInto(q.map(v=>v*1.2),target);assert(different.every(Number.isFinite));assert.notDeepEqual(different,C);
assert.deepEqual(g.valueInto(q,target),C);assert.deepEqual(target,saved);
const before=context.statistics();assert.throws(()=>context.compile({...descriptor,nodes:[0,0,1]}));assert.deepEqual(context.statistics(),before);report.rejected++;
const overlap=q.slice(),old=overlap.slice();assert.throws(()=>g.singleInto(overlap,0,overlap),/перекрываться/);assert.deepEqual(overlap,old);report.rejected++;
assert.throws(()=>materialSurface(q,[[0,1,2]],{...MODEL_MATERIAL,bendingNm:0},{materialKernel:{}}),/фабрика/);report.rejected++;
assert.throws(()=>materialSurface(q,[[0,1,2]],{...MODEL_MATERIAL,bendingNm:0},{materialKernel:{createSurface:()=>null}}),/компиляция/);report.rejected++;
report.phase='complete';if(out)writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Материал WASM: ${report.values} значений, ${report.gradientComponents} компонент, ${report.hessianComponents} элементов местных матриц и ${report.hypotCases} длин совпали строго; ${report.rejected} отказов, отдельные экземпляры, рост памяти и независимость снимков — пройдены.`);
