// Публикация сил из того же прохода, который уже нагружает Boat.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Boat } from '../sim/physics.js';
import { stripLoadOf } from './lib/gennaker-observables.mjs';
const pack = JSON.parse(readFileSync(new URL('../out/export/physics.json',import.meta.url),'utf8'));
const close = (a,b) => assert(Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const vector = (a,b) => a.forEach((v,d)=>close(v,b[d]));
let count=0;
for (const up of [false,true]) for (const side of [-1,1]) for (const localPressure of [false,true]) {
  const b = new Boat(pack,null,{gennakerUp:up,localPressure});
  b.o.windSpeed=6;b.o.windDir=side*140*Math.PI/180;b.o.crewMass=0;
  b.phi=side*15*Math.PI/180;b.u=3;b.v=side*.1;
  for (let step=0;step<12;step++) {
    const out=b.rig.forces(b,b.apparentWind(),1/30), origin=[pack.mass.cg_m[0],0,pack.mass.cg_m[2]];
    assert.equal(out.frame,'body-horizontal');assert.equal(out.phase,'aero-after-cloth');
    assert.deepEqual(out.originM,origin);assert.equal(out.bySail.length,up?3:2);
    for (let sail=0;sail<out.bySail.length;sail++) {
      const independent=stripLoadOf(b.rig,b.phi,origin,sail);
      vector(out.bySail[sail].forceN,independent.forceN);
      vector(out.bySail[sail].momentNm,independent.momentNm);
    }
    const sum=key=>out.bySail.reduce((a,p)=>a.map((v,d)=>v+p[key][d]),[0,0,0]);
    vector(sum('forceN'),[out.fx,out.fy,out.fz]); vector(sum('momentNm'),[out.mx,out.my,out.mz]);
    count++;
  }
  // Сброс опубликованных сумм, в том числе нового My, на каждом проходе.
  // Нулевая площадь сама по себе не обнуляет прежнюю физику перехода решётки.
  for (const p of b.rig.sailOut.bySail) {p.forceN.fill(NaN);p.momentNm.fill(NaN);}
  b.rig.sailOut.my=NaN;
  const fresh=b.rig.forces(b,b.apparentWind(),1/30);
  const reference=stripLoadOf(b.rig,b.phi,fresh.originM);
  vector([fresh.fx,fresh.fy,fresh.fz],reference.forceN);
  vector([fresh.mx,fresh.my,fresh.mz],reference.momentNm);
  for (let sail=0;sail<fresh.bySail.length;sail++) {
    const part=stripLoadOf(b.rig,b.phi,fresh.originM,sail);
    vector(fresh.bySail[sail].forceN,part.forceN);vector(fresh.bySail[sail].momentNm,part.momentNm);
  }
  b.setGennaker(!up);
  assert.equal(b.rig.sailOut.bySail.length,up?2:3);
}
console.log(`ок: ${count} состояний рига, каждый парус/три момента, оба борта/режима давления и сброс без старой нагрузки`);
