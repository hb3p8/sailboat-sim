// Перенос интегралов сохранённых реакций к шагу лодки; ткань заново не считается.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {SupportImpulseLedger} from '../tests/lib/cloth-support-impulse.mjs';
import {IMPLICIT_TOLERANCES} from '../tests/lib/cloth-implicit-motion.mjs';

const args=process.argv.slice(2),option=args.filter(a=>a.startsWith('--'));
assert(option.length<=1 && option.every(a=>/^--boat-hz=(30|60)$/.test(a)),'Допустим только --boat-hz=30/60');
const [output,...paths]=args.filter(a=>!a.startsWith('--')),boatHz=option.length?Number(option[0].split('=')[1]):30;
assert(output && paths.length,'Нужны новый путь сводки и сохранённые полные опыты');
assert(!existsSync(output),'Сохранённую сводку нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'),cache=new Map();
// Уже назначенный допуск арифметического суммирования из совместного протокола.
const arithmeticRelative=1e-9;
const verify=(actual,expected,label,lowerScale=1)=>actual.forEach((v,d)=>assert(Number.isFinite(v) &&
  Math.abs(v-expected[d])<=arithmeticRelative*Math.max(lowerScale,Math.abs(expected[d])),label));
const norm=v=>Math.hypot(...v),difference=(a,b)=>norm(a.map((v,d)=>v-b[d]));
const add=(a,b)=>a.forEach((v,d)=>a[d]+=b[d]);

// Прямая формула по исходным скалярам, без накопителя или общего wrenchOf.
function directLoad(s,phi,origin) {
  const c=Math.cos(phi),q=Math.sin(phi),forceN=[0,0,0],momentNm=[0,0,0];
  for(let k=0;k<s.positionsM.length;k+=3) {
    const x=s.positionsM[k]-origin[0],y=c*s.positionsM[k+1]-q*s.positionsM[k+2]-origin[1],
      z=q*s.positionsM[k+1]+c*s.positionsM[k+2]-origin[2];
    const fx=-s.supportForceN[k],fy=-c*s.supportForceN[k+1]+q*s.supportForceN[k+2],
      fz=-q*s.supportForceN[k+1]-c*s.supportForceN[k+2];
    forceN[0]+=fx;forceN[1]+=fy;forceN[2]+=fz;
    momentNm[0]+=y*fz-z*fy;momentNm[1]+=z*fx-x*fz;momentNm[2]+=x*fy-y*fx;
  }
  const v=s.balance.supportN;
  verify(forceN,[-v[0],-c*v[1]+q*v[2],-q*v[1]-c*v[2]],'Реакция не совпадает с независимым балансом исходной записи');
  return {forceN,momentNm};
}
const series=paths.map(path=>{
  const bytes=readFileSync(path),r=JSON.parse(bytes);
  assert.equal(r.phase,'complete');assert.equal(r.dirty,false);assert.equal(r.config.profile,'sin4');
  for(const [p,sha] of Object.entries(r.sourceSha256)) {
    const key=`${r.revision}:${p}`;
    if(!cache.has(key))cache.set(key,hash(execFileSync('git',['show',key],{maxBuffer:16*1024*1024})));
    assert.equal(cache.get(key),sha,'Источник не соответствует сохранённой ревизии');
  }
  for(const [p,sha] of [[r.input.path,r.input.sha256],[r.wasm.path,r.wasm.sha256],['out/export/physics.json',r.physicsSha256]])
    assert.equal(hash(readFileSync(p)),sha,'Изменился сохранённый вход');
  assert.equal(r.steps.length,Math.round((r.config.durationS+r.config.holdS)/r.config.hS));
  const cg=r.recipe.boat.p.mass.cg_m,originM=[cg[0],0,cg[2]],phi=r.recipe.boat.phi;
  const ledger=new SupportImpulseLedger({clothHS:r.config.hS,boatHS:1/boatHz,originM,phi});
  const packets=[],expectedImpulse=[0,0,0],expectedAngular=[0,0,0],fullImpulse=[0,0,0],fullAngular=[0,0,0];
  const lastImpulse=[0,0,0],lastAngular=[0,0,0];
  let maxPacketImpulseErrorNs=0,maxPacketAngularErrorNms=0,maxLastImpulseErrorNs=0,maxLastAngularErrorNms=0;
  for(const [index,s] of r.steps.entries()) {
    assert.equal(s.timeS,(index+1)*r.config.hS);
    assert.equal(s.audit.solver.converged,true);assert.deepEqual(r.config.tolerances,IMPLICIT_TOLERANCES);
    for(const [k,v] of Object.entries(IMPLICIT_TOLERANCES))assert.equal(s.audit.solver[k],v);
    for(const [v,limit] of [[s.audit.maxPhysicalResidualN,IMPLICIT_TOLERANCES.forceToleranceN],
      [s.audit.maxHardViolationM,IMPLICIT_TOLERANCES.lengthToleranceM],
      [s.dualViolationN,IMPLICIT_TOLERANCES.dualToleranceN],[s.audit.solver.complementarityJ,IMPLICIT_TOLERANCES.complementarityToleranceJ]])
      assert(Number.isFinite(v) && v>=0 && v<=limit,'Исходный физический шаг не принят');
    const load=directLoad(s,phi,originM),impulse=load.forceN.map(v=>v*r.config.hS),angular=load.momentNm.map(v=>v*r.config.hS);
    add(expectedImpulse,impulse);add(expectedAngular,angular);add(fullImpulse,impulse);add(fullAngular,angular);
    const packet=ledger.push({index,positionsM:s.positionsM,supportForceN:s.supportForceN});
    if(packet) {
      assert.equal(packet.endTimeS,s.timeS);
      verify(packet.impulseNs,expectedImpulse,'Потерян импульс окна',packet.durationS);
      verify(packet.angularImpulseNms,expectedAngular,'Потерян момент окна',packet.durationS);
      verify(packet.averageForceN.map(v=>v*packet.durationS),expectedImpulse,'Средняя сила не сохраняет импульс',packet.durationS);
      verify(packet.averageMomentNm.map(v=>v*packet.durationS),expectedAngular,'Средний момент не сохраняет интеграл',packet.durationS);
      maxPacketImpulseErrorNs=Math.max(maxPacketImpulseErrorNs,difference(packet.impulseNs,expectedImpulse));
      maxPacketAngularErrorNms=Math.max(maxPacketAngularErrorNms,difference(packet.angularImpulseNms,expectedAngular));
      add(lastImpulse,load.forceN.map(v=>v/boatHz));add(lastAngular,load.momentNm.map(v=>v/boatHz));
      maxLastImpulseErrorNs=Math.max(maxLastImpulseErrorNs,difference(lastImpulse,fullImpulse));
      maxLastAngularErrorNms=Math.max(maxLastAngularErrorNms,difference(lastAngular,fullAngular));
      packets.push(packet);expectedImpulse.fill(0);expectedAngular.fill(0);
    }
  }
  const total=ledger.finish(),packetImpulse=[0,0,0],packetAngular=[0,0,0];
  for(const p of packets){add(packetImpulse,p.impulseNs);add(packetAngular,p.angularImpulseNms);}
  verify(total.impulseNs,fullImpulse,'Потерян общий импульс',total.durationS);
  verify(total.angularImpulseNms,fullAngular,'Потерян общий момент',total.durationS);
  verify(packetImpulse,fullImpulse,'Переданные окна потеряли импульс',total.durationS);
  verify(packetAngular,fullAngular,'Переданные окна потеряли момент',total.durationS);
  return {path,sha256:hash(bytes),revision:r.revision,config:r.config,clothHz:Math.round(1/r.config.hS),
    boatHz,phi,originM,sourceIdentity:{sourceSha256:r.sourceSha256,input:r.input,wasm:r.wasm,physicsSha256:r.physicsSha256,recipe:r.recipe,initial:r.initial,command:r.command},
    verification:{maxPacketImpulseErrorNs,maxPacketAngularErrorNms,
      totalImpulseErrorNs:difference(packetImpulse,fullImpulse),totalAngularErrorNms:difference(packetAngular,fullAngular)},
    lastSampleControl:{maxCumulativeImpulseErrorNs:maxLastImpulseErrorNs,maxCumulativeAngularErrorNms:maxLastAngularErrorNms},
    total,packets};
});

function compare(a,b) {
  assert.deepEqual(a.sourceIdentity,b.sourceIdentity);assert.equal(a.packets.length,b.packets.length);
  const ia=[0,0,0],ib=[0,0,0],ma=[0,0,0],mb=[0,0,0];
  const result={fromHz:a.clothHz,toHz:b.clothHz,maxPacketImpulseDifferenceNs:0,maxPacketAngularDifferenceNms:0,
    maxCumulativeImpulseDifferenceNs:0,maxCumulativeAngularDifferenceNms:0};
  for(let i=0;i<a.packets.length;i++) {
    const x=a.packets[i],y=b.packets[i];assert.equal(x.endTimeS,y.endTimeS);
    add(ia,x.impulseNs);add(ib,y.impulseNs);add(ma,x.angularImpulseNms);add(mb,y.angularImpulseNms);
    result.maxPacketImpulseDifferenceNs=Math.max(result.maxPacketImpulseDifferenceNs,difference(x.impulseNs,y.impulseNs));
    result.maxPacketAngularDifferenceNms=Math.max(result.maxPacketAngularDifferenceNms,difference(x.angularImpulseNms,y.angularImpulseNms));
    result.maxCumulativeImpulseDifferenceNs=Math.max(result.maxCumulativeImpulseDifferenceNs,difference(ia,ib));
    result.maxCumulativeAngularDifferenceNms=Math.max(result.maxCumulativeAngularDifferenceNms,difference(ma,mb));
  }
  return result;
}
const groups=new Map();
for(const r of series) {
  const {hS,...condition}=r.config,key=JSON.stringify(condition);
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
}
const refinement=Array.from(groups.values()).map(rows=>{
  rows.sort((a,b)=>a.clothHz-b.clothHz);assert(new Set(rows.map(r=>r.clothHz)).size===rows.length,'Повтор одного разрешения');
  return {tack:rows[0].config.tack,strokeM:rows[0].config.strokeM,
    adjacent:rows.slice(1).map((r,i)=>compare(rows[i],r))};
});
const result={schema:1,createdAt:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  toolSha256:hash(readFileSync(new URL(import.meta.url))),ledgerSha256:hash(readFileSync('tests/lib/cloth-support-impulse.mjs')),
  arithmeticRelative,scope:'Сохранённые реакции на неподвижных лодке/начале моментов; интегралы в горизонтных связанных осях. Это проверка передачи, не новый расчёт ткани, живая лодка или приёмка G4.',
  boatHz,series:series.map(({sourceIdentity,...r})=>r),refinement};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,boatHz,series:series.length,steps:series.reduce((n,r)=>n+r.total.steps,0),
  maxImpulseErrorNs:Math.max(...series.map(r=>r.verification.totalImpulseErrorNs)),
  maxAngularErrorNms:Math.max(...series.map(r=>r.verification.totalAngularErrorNms)),refinement},null,2));
