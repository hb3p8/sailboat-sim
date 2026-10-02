// Известная поверхность и геометрические контракты опытного кроя.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchedCutSurface } from '../sim/cloth-cut.js';
import { Boat } from '../sim/physics.js';
import { Cloth } from '../sim/cloth.js';

const put = (out, values) => { values.forEach((x,k)=>out[k]=x); return out; };
const distance = (a,b) => Math.hypot(...a.map((x,k)=>x-b[k]));
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
const make = (rows,cols,side,continuousCut) => {
  const c = new Cloth(b.rig.sails[2],2,{rows,cols,continuousCut,rigidBoard:true});
  c.gen=b.p.rig.gennaker;c.designSide=side;c.design3d([]);return c;
};
const point = (c,r,col) => {const i=c.ix(r,col);return [c.dx[i],c.dy[i],c.dz[i]];};
const coarse=make(11,9,-1,true),old=make(11,9,-1,false),fine=make(21,17,-1,true);
// Обе поперечные границы остаются побитно прежними, включая четыре угла.
for(const r of [0,10])for(let c=0;c<9;c++)assert.deepEqual(point(coarse,r,c),point(old,r,c));
for(let r=0;r<11;r++)for(let c=0;c<9;c++)assert.deepEqual(point(coarse,r,c),point(fine,r*2,c*2));
const mirrored=make(21,17,1,true);
for(let r=0;r<21;r++)for(let c=0;c<17;c++) {
  const p=point(fine,r,c),q=point(mirrored,r,c);
  p.forEach((x,k)=>assert.ok(x===(k===1?-q[k]:q[k])));
}
// Проверяем предел у ОБЕИХ границ на долях, которые не являются узлами сетки.
// Фиксированная верхняя оценка 100 м на единицу параметра значительно больше
// размеров паруса; 1 нм — запас для обращения высоты 40 делениями пополам.
for(const u of [0,.071,.25,.5,.793,1])for(const v of [0,1])for(const eps of [1e-5,1e-7,1e-9]) {
  const p=coarse.cutAt(u,v,[]),q=coarse.cutAt(u,v===0?eps:1-eps,[]);
  assert.ok(distance(p,q)<=100*eps+1e-9,`Разрыв у границы u=${u}, v=${v}, шаг=${eps}`);
}
// Геометрическое качество: оба треугольника каждой ячейки ненулевые и
// ориентированы согласованно. Это не доказательство отсутствия самопересечений.
const dense=make(41,33,-1,true),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((x,k)=>x-b[k]);
for(let r=0;r<40;r++)for(let c=0;c<32;c++) {
  const a=point(dense,r,c),bb=point(dense,r,c+1),e=point(dense,r+1,c),g=point(dense,r+1,c+1);
  const n1=cross(sub(bb,a),sub(e,a)),n2=cross(sub(e,g),sub(bb,g));
  assert.ok(Math.hypot(...n1)>0 && Math.hypot(...n2)>0);
  assert.ok(n1.reduce((s,x,k)=>s+x*n2[k],0)>0);
}
// Длина строки читается с одной поверхности и не меняется со столбцами.
for(let r=0;r<11;r++)assert.equal(coarse.rowW[r],fine.rowW[r*2]);
console.log('Непрерывный крой: известная поверхность, границы, пределы, зеркало, общие узлы и ячейки проверены.');
