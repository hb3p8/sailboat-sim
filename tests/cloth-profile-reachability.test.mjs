// Известные полиномы и независимо измеренные кубические кривые.
import assert from 'node:assert/strict';
import {cubicPeakRange} from './lib/cloth-profile-reachability.mjs';
import {bezierSectionPeak} from '../sim/cloth-cut.js';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
const right=cubicPeakRange(.2,Math.PI/2,Math.PI/2);
close(right.minAt,7/27);close(right.maxAt,20/27);
const sloped=cubicPeakRange(.1,Math.PI/4,Math.PI/4);
close(sloped.minAt,7/27+.1);close(sloped.maxAt,20/27-.1);
// Здесь x(t)=3t²−2t³+.24(3−6t) имеет внутренние экстремумы .4/.6.
const turning=cubicPeakRange(.24,Math.PI/4,Math.PI/4);
close(turning.minAt,.496);close(turning.maxAt,.504);
assert.equal(turning.extrema.length,4);
for(const entry of [40,61,90,110])for(const exit of [43,70])for(const a of [.1,.4,.8])for(const b of [.1,.3,.7]) {
  const fin=entry*Math.PI/180,fex=exit*Math.PI/180;
  const peak=bezierSectionPeak([0,0,a*Math.cos(fin),a*Math.sin(fin),1-b*Math.cos(fex),b*Math.sin(fex),1,0]);
  const range=cubicPeakRange(peak.cam,fin,fex);
  assert.ok(peak.at>=range.minAt-1e-12 && peak.at<=range.maxAt+1e-12);
}
assert.throws(()=>cubicPeakRange(.2,0,Math.PI/4),/углы/);
console.log('Диапазон кубического профиля: известные пределы, внутренние экстремумы и независимые кривые проверены.');
