// Известная поверхность и геометрические контракты опытного кроя.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchedCutSurface, bezierSectionPeak } from '../sim/cloth-cut.js';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';

const put = (out, values) => { values.forEach((x,k)=>out[k]=x); return out; };
const distance = (a,b) => Math.hypot(...a.map((x,k)=>x-b[k]));
// Известные полиномы с независимыми максимумами: 3t(1-t),
// 3t(1-t)^2 и 3t²(1-t). Линейный x(t)=t задаёт место максимума.
for (const [z1,z2,t,cam] of [[1,1,.5,.75],[1,0,1/3,4/9],[0,1,2/3,4/9]]) {
  for (const [scale,offset] of [[1,0],[2,3],[1e-9,0],[1e9,0]]) {
    const peak=bezierSectionPeak([0,offset,1/3,offset+scale*z1,2/3,offset+scale*z2,1,offset]);
    assert.ok(Math.abs(peak.t-t)<1e-14 && Math.abs(peak.at-t)<1e-14);
    assert.ok(Math.abs(peak.cam-(offset+scale*cam))<1e-14*Math.max(1,scale,offset));
  }
}
assert.deepEqual(bezierSectionPeak([0,0,1/3,1/3,2/3,2/3,1,1]),{t:1,cam:1,at:1});
assert.deepEqual(bezierSectionPeak([0,1,1/3,2/3,2/3,1/3,1,0]),{t:0,cam:1,at:0});
assert.deepEqual(bezierSectionPeak([0,2,1/3,2,2/3,2,1,2]),{t:0,cam:2,at:0});
// Ложная выпуклость, линейная по высоте, должна исчезнуть целиком:
// все четыре границы задают плоский квадрат. Остаточная выпуклость u(1-u)v(1-v)
// имеет нулевые границы и должна сохраниться, с известной высотой 1/16 в центре.
for (const residual of [0,1]) {
  const surface = matchedCutSurface((u,v,out)=>put(out,[u,v,u*(1-u)*(2+v+residual*v*(1-v))]),
    (u,out)=>put(out,[u,0,0]),(u,out)=>put(out,[u,1,0]));
  for(const u of [0,.1,.5,.9,1])for(const v of [0,1e-9,.25,.5,.9,1-1e-9,1]) {
    assert.ok(distance(surface(u,v,[]),[u,v,residual*u*(1-u)*v*(1-v)])<1e-15);
  }
}
const b = new Boat(JSON.parse(readFileSync(new URL('../out/export/physics.json',import.meta.url))));
b.setGennaker(true);
const make = (rows,cols,side,continuousCut,analyticCutProfile=false) => {
  const c = new Cloth(b.rig.sails[2],2,{rows,cols,continuousCut,analyticCutProfile,rigidBoard:true});
  c.gen=b.p.rig.gennaker;c.designSide=side;c.design3d([]);return c;
};
const point = (c,r,col) => {const i=c.ix(r,col);return [c.dx[i],c.dy[i],c.dz[i]];};
const previous=make(11,9,-1,true);
// Прежний дискретный поиск остаётся явным отрицательным контролем.
assert.ok(distance(previous.cutSurfaceAt(.1875,.10530,[]),previous.cutSurfaceAt(.1875,.10531,[]))>.04);
assert.throws(()=>make(11,9,-1,false,true),/непрерывного кроя/);
for(const analytic of [false,true]) {
const coarse=make(11,9,-1,true,analytic),old=make(11,9,-1,false),fine=make(21,17,-1,true,analytic);
// Обе поперечные границы остаются побитно прежними, включая четыре угла.
for(const r of [0,10])for(let c=0;c<9;c++)assert.deepEqual(point(coarse,r,c),point(old,r,c));
for(let r=0;r<11;r++)for(let c=0;c<9;c++)assert.deepEqual(point(coarse,r,c),point(fine,r*2,c*2));
// У нового способа поиска сохраняются также обе боковые кривые.
for(let r=0;r<11;r++)for(const col of [0,8])assert.deepEqual(point(coarse,r,col),point(previous,r,col));
const mirrored=make(21,17,1,true,analytic);
for(let r=0;r<21;r++)for(let c=0;c<17;c++) {
  const p=point(fine,r,c),q=point(mirrored,r,c);
  p.forEach((x,k)=>assert.ok(x===(k===1?-q[k]:q[k])));
}
// Проверяем предел у ОБЕИХ границ на долях, которые не являются узлами сетки.
// Фиксированная верхняя оценка 100 м на единицу параметра значительно больше
// размеров паруса; 1 нм — запас для обращения высоты 40 делениями пополам.
for(const u of [0,.071,.25,.5,.793,1])for(const v of [0,1])for(const eps of [1e-5,1e-7,1e-9]) {
  const p=coarse.cutSurfaceAt(u,v,[]),q=coarse.cutSurfaceAt(u,v===0?eps:1-eps,[]);
  assert.ok(distance(p,q)<=100*eps+1e-9,`Разрыв у границы u=${u}, v=${v}, шаг=${eps}`);
}
// Геометрическое качество: оба треугольника каждой ячейки ненулевые и
// ориентированы согласованно. Это не доказательство отсутствия самопересечений.
const dense=make(41,33,-1,true,analytic),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((x,k)=>x-b[k]);
for(let r=0;r<40;r++)for(let c=0;c<32;c++) {
  const a=point(dense,r,c),bb=point(dense,r,c+1),e=point(dense,r+1,c),g=point(dense,r+1,c+1);
  const n1=cross(sub(bb,a),sub(e,a)),n2=cross(sub(e,g),sub(bb,g));
  assert.ok(Math.hypot(...n1)>0 && Math.hypot(...n2)>0);
  assert.ok(n1.reduce((s,x,k)=>s+x*n2[k],0)>0);
}
// Длина строки читается с одной поверхности и не меняется со столбцами.
for(let r=0;r<11;r++)assert.equal(coarse.rowW[r],fine.rowW[r*2]);
// cutAt(rf,t) обязан читать узлы по индексу ряда, как sample() для летящего
// полотна. Аналитическая поверхность имеет другой аргумент и другое имя.
// Независимый плоский квадрат в буферах поймает подмену одного метода другим.
const sampled=make(11,9,-1,true,analytic);
for(let r=0;r<11;r++)for(let col=0;col<9;col++) {
  const i=sampled.ix(r,col);sampled.dx[i]=col/8;sampled.dy[i]=r/10;sampled.dz[i]=0;
}
for(const rf of [0,.5,5.3,10]) {
  for(const u of [0,.17,.5,.87,1])
    assert.ok(distance(sampled.cutAt(rf,u,[]),[u,rf/10,0])<1e-15);
  const shape=sampled.rowShape(rf,true);
  assert.equal(shape.chord,1);assert.equal(shape.camber,0);assert.equal(shape.arc,1);
  assert.equal(shape.back,0);assert.equal(shape.flip,0);assert.equal(shape.kink,0);
}
if(analytic) {
  // Тот же предел 100 м/единицу параметра, что у границ: проверяем область
  // найденного разрыва и стыки проектных станций без изменения допуска.
  for(const u of [.071,.1875,.5,.793])for(const step of [.001,.0001,.00001]) {
    let last=coarse.cutSurfaceAt(u,.1,[]);
    for(let i=1;i<=Math.round(.015/step);i++) {
      const p=coarse.cutSurfaceAt(u,.1+i*step,[]);
      assert.ok(distance(p,last)<=100*step+1e-9,`Скачок внутри кроя, u=${u}, шаг=${step}`);last=p;
    }
  }
  for(const v of [.25,.5,.75])for(const u of [.071,.1875,.5,.793])for(const eps of [1e-5,1e-7,1e-9])
    assert.ok(distance(coarse.cutSurfaceAt(u,v-eps,[]),coarse.cutSurfaceAt(u,v+eps,[]))<=200*eps+1e-9);
}
}
console.log('Крой: известные максимумы, поверхности, все границы, внутренние пределы, зеркало, общие узлы и ячейки проверены; отрицательный контроль сохранён.');
