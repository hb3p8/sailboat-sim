import { readFileSync } from 'node:fs';
import { Boat } from './sim/physics.js';
import { gennakerSetOf } from './sim/aero.js';
const PACK=JSON.parse(readFileSync('out/export/physics.json','utf8'));
const D=Math.PI/180;
const wrap=a=>((a+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
function once(len,twa,u0){
  const b=new Boat(PACK);
  b.o.freeWake=true;b.o.wakeForces=true;b.o.crewHike=-1;b.o.crewMass=219.9;
  b.wind.o.gust=0;b.wind.o.shift=0;b.setGennaker(true);
  b.o.sheet=70*D;b.o.twist=8*D;b.o.genSheetLen=len;b.reset();
  b.o.windSpeed=6;b.o.windDir=100*D;b.u=u0;b.psi=(100-twa)*D;
  let gmax=0,jump=0,prev=null,ref=1;
  for(let i=0;i<25*30;i++){
    b.o.rudderTarget=Math.max(-25*D,Math.min(25*D,-(2.2*wrap((100-twa)*D-b.psi)-0.9*b.r)));
    b.step(1/30);
    if(i<=10*30){prev=b.telemetry.driveN;continue;}
    const Gs=b.rig.stripGamma;
    if(Gs)for(let k=0;k<Gs.length;k++)gmax=Math.max(gmax,Math.abs(Gs[k]));
    const d=b.telemetry.driveN;
    if(Number.isFinite(d)){ref=Math.max(ref,Math.abs(d)); if(prev!==null)jump=Math.max(jump,Math.abs(d-prev));}
    prev=d;
  }
  return {jump:jump/ref, fuse:b.rig.fuseTrips||0};
}
const G=PACK.rig.gennaker;
for(const twa of [120,135,150]){
  let line=`TWA ${twa}°: `;
  for(const L of [4.5,5.0,5.5,6.0,6.5]){
    const r=Math.max(once(L,twa,3).jump, once(L,twa,3.05).jump);
    line += `${L.toFixed(1)}м(вынос ${(gennakerSetOf({genSheetLen:L},G)/D).toFixed(0)}°) ${(r*100).toFixed(1)}%  `;
  }
  console.log(line);
}
