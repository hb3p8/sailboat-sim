import { readFileSync } from 'node:fs';
import { Boat } from './sim/physics.js';
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
  return {jump:jump/ref, gmax, fuse:b.rig.fuseTrips||0, v:b.telemetry.speedKn};
}
const [twa,len]=[Number(process.argv[2]||135), Number(process.argv[3]||5.5)];
for(const u of [3.000,3.001,3.010,3.030,3.050,3.070,3.100]){
  const r=once(len,twa,u);
  console.log(`u0=${u.toFixed(3)}  скачок ${(r.jump*100).toFixed(1)} %  Γ ${r.gmax.toExponential(1)}  предохр ${r.fuse}  ход ${r.v.toFixed(2)}`);
}
