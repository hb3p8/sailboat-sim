// Независимые интегралы силы, момента и виртуальной работы заданного поля.
import assert from 'node:assert/strict';
import { densityFromNodalIntegrals, integrateDensity, installSharedInput } from './lib/cloth-shared-input.mjs';
import { wrenchOf } from './lib/gennaker-observables.mjs';

const close = (a,b,tolerance=2e-12) => assert.ok(Math.abs(a-b) <= tolerance, `${a} ≠ ${b}`);
const makeField = (rows,cols,components,fn) => ({ rows,cols,components,
  values: Float64Array.from(Array.from({length:rows*cols}, (_,i) =>
    fn((i%cols)/(cols-1),Math.floor(i/cols)/(rows-1))).flat()) });
const field = makeField(3,4,3,(u,v) => [1+u,2+v,u*v]);
for (const [rows,cols] of [[3,4],[5,7],[9,13],[3,13],[9,4]]) {
  const load = integrateDensity(field,rows,cols);
  const points=[], forces=[], displacement=[];
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) {
    const u=c/(cols-1),v=r/(rows-1),i=r*cols+c;
    points.push([u,v,u*v]); forces.push(Array.from(load.slice(3*i,3*i+3)));
    displacement.push([2+u,3-v,1+u*v]);
  }
  const wrench=wrenchOf(points,forces);
  wrench.forceN.forEach((x,k)=>close(x,[1.5,2.5,.25][k]));
  wrench.momentNm.forEach((x,k)=>close(x,[-.5,.25,.5][k]));
  const work=forces.reduce((s,f,i)=>s+f.reduce((q,x,k)=>q+x*displacement[i][k],0),0);
  close(work,373/36);
  console.log(`ок: ${rows}×${cols}, известные сила, три момента и работа билинейного перемещения`);
}

// Произвольные исходные интегралы: новая интерполяция не возвращает те же
// узловые числа на исходной сетке, но сохраняет их общую сумму.
const raw=Float64Array.from({length:3*4*3},(_,i)=>Math.sin(1.3*i)-.2*i);
const reconstructed=densityFromNodalIntegrals(3,4,3,raw);
for (const [rows,cols] of [[3,4],[5,7],[9,13]]) {
  const load=integrateDensity(reconstructed,rows,cols);
  for (let d=0;d<3;d++) close(load.reduce((s,x,i)=>s+(i%3===d?x:0),0),
    raw.reduce((s,x,i)=>s+(i%3===d?x:0),0));
}
assert.notDeepEqual(integrateDensity(reconstructed,3,4),raw);
assert.throws(()=>integrateDensity(field,6,7),/вложенная/);
assert.throws(()=>integrateDensity(field,3,3),/вложенная/);
assert.throws(()=>densityFromNodalIntegrals(3,4,3,[NaN]),/интегралы/);
console.log('ок: общая сила сохранена при восстановлении поля; невложенные входы отклонены');

// Известный заданный вход: масса 7 кг на весь квадрат, давление [1,2,3] Н,
// вес [0,0,-5] Н, сопротивление diag(2,3,4) Н·с/м на весь квадрат.
const input=makeField(3,3,16,()=>[1,2,3,0,0,-5,7,2,0,0,0,3,0,0,0,4]);
const rows=5,cols=5,n=rows*cols,head=(rows-1)*cols;
const cloth={rows,cols,n,head,tack:0,clew:cols-1,boardEnd:n-1,rigidBoard:true,freeClew:false,
  mass:new Float64Array(n),w:new Float64Array(n),pos:new Float64Array(3*n),prev:new Float64Array(3*n),
  nrm:new Float64Array(3*n),frc:new Float64Array(3*n),pattern(){},velocityDt(){return .1;},
  prepareBoard(){this.boardMass=0;for(let c=0;c<cols;c++) {
    this.boardMass+=this.mass[head+c]*(c/(cols-1))**2;this.w[head+c]=0;
  }this.w[this.boardEnd]=1/this.boardMass;}};
installSharedInput(cloth,input);cloth.pattern();
close(cloth.mass.reduce((s,x)=>s+x,0),7);
// Верх: площадь полосы 1/8, ∫u² du≈.34375 при узловой массе.
close(cloth.boardMass,7/8*.34375);
assert.equal(cloth.w[cloth.tack],0);assert.equal(cloth.w[cloth.clew],0);assert.equal(cloth.w[cloth.head],0);
for(let i=0;i<n;i++) {cloth.pos[3*i]=.1;cloth.pos[3*i+1]=.2;cloth.pos[3*i+2]=.3;}
const boat={phi:0,p:{mass:{cg_m:[0,0,0]}}};cloth.forcesAt(boat,.1);
for(let d=0;d<3;d++) close(cloth.frc.reduce((s,x,i)=>s+(i%3===d?x:0),0),[-1,-4,-14][d]);
for(let d=0;d<3;d++) close(cloth.pressureForce.reduce((s,x,i)=>s+x*cloth.nrm[3*i+d],0),[1,2,3][d]);
const p=cloth.pressureForce.slice(),normals=cloth.nrm.slice();
cloth.pos.fill(0);cloth.forcesAt(boat,.1);
assert.deepEqual(cloth.pressureForce,p);assert.deepEqual(cloth.nrm,normals);
for(let d=0;d<3;d++) close(cloth.frc.reduce((s,x,i)=>s+(i%3===d?x:0),0),[1,2,-2][d]);
console.log('ок: масса/инерция планки, вес, сопротивление и давление из одного поля');
