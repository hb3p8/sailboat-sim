// Независимые известные линии: гладкая окружность и настоящий угол при уточнении.
import assert from 'node:assert/strict';
import {polylineTurns,surfaceTurns} from './lib/cloth-surface-turns.mjs';
const near=(a,b,t=1e-10)=>assert(Math.abs(a-b)<=t,`${a} ≠ ${b}`);
for(const n of [4,8,16]) {
  const arc=Array.from({length:n+1},(_,i)=>[2*Math.cos(i*Math.PI/2/n),2*Math.sin(i*Math.PI/2/n),0]);
  const m=polylineTurns(arc);
  near(m.maximumAngle.angleDeg,90/n);
  near(m.maximumCurvature.curvaturePerM,(Math.PI/2/n)/(4*Math.sin(Math.PI/4/n)));
  // Угол 90° в середине линии сохраняется при делении прямых участков.
  const corner=Array.from({length:2*n+1},(_,i)=>i<=n?[i/n,0,0]:[1,(i-n)/n,0]);
  near(polylineTurns(corner).maximumAngle.angleDeg,90);
}
const grid={rows:3,cols:3};
const flat=Array.from({length:9},(_,i)=>[i%3,Math.floor(i/3),0]).flat();
const plane=surfaceTurns(grid,flat);
near(plane.maximumDihedral.angleDeg,0);assert.equal(plane.degenerateTriangles,0);
for(const edge of Object.values(plane.boundary))near(edge.maximumAngle.angleDeg,0);
// Две плоские половины встречаются под 90°, без вырожденных треугольников.
const folded=Array.from({length:9},(_,i)=>[Math.min(i%3,1),Math.floor(i/3),Math.max(0,i%3-1)]).flat();
near(surfaceTurns(grid,folded).maximumDihedral.angleDeg,90);
assert.throws(()=>polylineTurns([[0,0,0],[0,0,0],[1,0,0]]),/Нулевая/);
assert.throws(()=>surfaceTurns(grid,[NaN]),/конечная/);
console.log('Измерители излома: окружность, неизменный угол и сгиб поверхности проверены.');
