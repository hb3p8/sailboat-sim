// Составной профиль: независимая известная форма и геометрические контракты.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {joinedCubicSection} from '../sim/cloth-cut.js';
import {Boat} from '../sim/physics.js';
import {designAt,DESIGN_DRAFT,DESIGN_ENTRY,DESIGN_EXIT} from '../sim/aero.js';
const close=(a,b,eps=1e-12)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
// При d=1/3, x*=1/2, углах 45°: x=t,
// z=t−4t³/3 в первой половине, зеркальное продолжение во второй.
const known=joinedCubicSection(1/3,.5,Math.PI/4,Math.PI/4);
for(let i=0;i<=100;i++) {
  const t=i/100,s=Math.min(t,1-t),p=known.parameterPoint(t,[]);
  close(p[0],t);close(p[1],s-4*s*s*s/3);
}
const quarter=joinedCubicSection(.25,.5,Math.PI/4,Math.PI/4);
const q=quarter.parameterPoint(.25,[]);close(q[0],29/128);close(q[1],11/64);
const b=new Boat(JSON.parse(readFileSync(new URL('../out/export/physics.json',import.meta.url))));b.setGennaker(true);
let margin=Infinity;
for(let i=0;i<=1000;i++) {
  const v=i/1000,d=designAt(b.rig.sails[2].design,v),at=designAt(DESIGN_DRAFT.gennaker,v),
    entry=designAt(DESIGN_ENTRY.gennaker,v)*Math.PI/180,exit=DESIGN_EXIT.gennaker*Math.PI/180;
  const sol=joinedCubicSection(d,at,entry,exit),[left,right]=sol.segments;
  margin=Math.min(margin,sol.controlOrderMargin);
  const peak=sol.parameterPoint(.5,[]);close(peak[0],at);close(peak[1],d);
  assert.deepEqual(sol.parameterPoint(0,[]),[0,0]);assert.deepEqual(sol.parameterPoint(1,[]),[1,0]);
  close(Math.atan2(left[3],left[2]),entry);
  close(Math.atan2(right[5],1-right[4]),exit);
  for(const k of [0,1]) {
    // Производные кубика по его локальному параметру: масштаб обоих равен.
    close(3*(left[6+k]-left[4+k]),3*(right[2+k]-right[k]));
    close(6*(left[6+k]-2*left[4+k]+left[2+k]),6*(right[4+k]-2*right[2+k]+right[k]));
  }
  let lastX=-Infinity;
  for(let j=0;j<=64;j++) {
    const p=sol.parameterPoint(j/64,[]);
    assert.ok(p[0]>=lastX && p[1]>=0 && p[1]<=d+1e-15);lastX=p[0];
  }
}
// Сохранение угла >90° отдельно от монотонности x у нынешней таблицы.
const hook=joinedCubicSection(.2,.5,110*Math.PI/180,Math.PI/4);
assert.ok(hook.parameterPoint(.001,[])[0]<0);
assert.throws(()=>joinedCubicSection(.2,.95,Math.PI/4,Math.PI/4),/порядок/);
assert.throws(()=>joinedCubicSection(0,.5,Math.PI/4,Math.PI/4),/глубина/);
console.log(`Составной профиль: известная форма, оба угла, максимум, две производные и 1001 заданное сечение проверены; запас контрольных точек ≥${margin.toFixed(6)}.`);
