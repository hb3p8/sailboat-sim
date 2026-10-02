// Независимые известные перемещения для измерителя общих узлов.
import assert from 'node:assert/strict';
import {commonNodeDistances} from './cloth-motion-refinement.mjs';
const coarse={rows:2,cols:2},fine={rows:3,cols:3};
const points=g=>Array.from({length:g.rows*g.cols},(_,i)=>
  [i%g.cols/(g.cols-1),Math.floor(i/g.cols)/(g.rows-1),0]).flat();
const a=points(coarse),b=points(fine);
// Треугольник 3–4–5: одно и то же расстояние во всех общих точках.
const shifted=b.map((x,k)=>x+[.03,.04,0][k%3]);
let measured=commonNodeDistances(coarse,fine,a,shifted);
assert.ok(Math.abs(measured.maximumM-.05)<1e-14 && Math.abs(measured.rmsM-.05)<1e-14);
// z=0.02uv: из четырёх общих углов смещается только один; RMS=0.02/√4.
const corner=b.map((x,k)=>k%3===2 ? .02*b[k-2]*b[k-1] : x);
measured=commonNodeDistances(coarse,fine,a,corner);
assert.equal(measured.maximumM,.02);assert.equal(measured.rmsM,.01);
assert.deepEqual(measured.location,{row:1,col:1,u:1,v:1});
// Один опорный набор сохраняет четыре угла при сравнении уже более плотных сеток.
const finest={rows:5,cols:5},p=points(finest),spot=p.map((x,k)=>k%3===2 ? .02*p[k-2]*p[k-1] : x);
measured=commonNodeDistances(fine,finest,b,spot,coarse);
assert.equal(measured.nodeCount,4);assert.equal(measured.maximumM,.02);assert.equal(measured.rmsM,.01);
assert.throws(()=>commonNodeDistances(coarse,fine,a,b,fine),/Опорная/);
assert.throws(()=>commonNodeDistances({rows:3,cols:3},{rows:4,cols:5},[],[]),/вложенные/);
assert.throws(()=>commonNodeDistances(coarse,fine,a,[NaN]),/координаты/);
console.log('Сравнение движения: известные сдвиг 5 см, локальное отклонение и неверные входы проверены.');
