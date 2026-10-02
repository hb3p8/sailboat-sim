// Проверка ответа известного тела на сохранённые пакеты; ткань не пересчитывается.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { supportBodyResponse } from '../tests/lib/cloth-support-body.mjs';
import { integrateDensity } from '../tests/lib/cloth-shared-input.mjs';

const [output,...inputs]=process.argv.slice(2);
assert(output && inputs.length,'Нужны новый путь результата и сводки полных пакетов');
assert(!existsSync(output),'Сохранённый результат нельзя перезаписывать');
const hash=b=>createHash('sha256').update(b).digest('hex'),norm=v=>Math.hypot(...v);
const difference=(a,b)=>norm(a.map((v,d)=>v-b[d])),relative=1e-9;
const close=(a,b,scale=1)=>assert(Number.isFinite(a) && Number.isFinite(b) &&
  Math.abs(a-b)<=relative*Math.max(scale,Math.abs(b)),'Не сошёлся независимый ответ тела');
const vector=(a,b,scale=1)=>{assert.equal(a.length,3);a.forEach((v,d)=>close(v,b[d],scale));};
const physicsBytes=readFileSync('out/export/physics.json'),physics=JSON.parse(physicsBytes);
const massKg=10,inertiaKgM2=[20,30,40],velocityMS=[1.2,-.3,.1],angularVelocityRadS=[.1,-.2,.05];
const cache=new Map();
const kinetic=(v,w)=>.5*massKg*(v[0]**2+v[1]**2+v[2]**2)+
  .5*(inertiaKgM2[0]*w[0]**2+inertiaKgM2[1]*w[1]**2+inertiaKgM2[2]*w[2]**2);

const summaries=inputs.map(path=>{
  const bytes=readFileSync(path),summary=JSON.parse(bytes);
  assert.equal(summary.schema,1);assert.equal(summary.dirty,false);assert.equal(summary.arithmeticRelative,relative);
  assert([30,60].includes(summary.boatHz),'Поддержаны сводки лодки 30/60 Гц');
  for (const [source,sha] of [['scripts/cloth_support_impulses.mjs',summary.toolSha256],
    ['tests/lib/cloth-support-impulse.mjs',summary.ledgerSha256]])
    assert.equal(hash(execFileSync('git',['show',`${summary.revision}:${source}`])),sha,'Изменено происхождение сводки');
  const series=summary.series.map(row=>{
    if(!cache.has(row.path)) {
      const bytes=readFileSync(row.path);cache.set(row.path,{sha256:hash(bytes),raw:JSON.parse(bytes)});
    }
    const source=cache.get(row.path),raw=source.raw;
    assert.equal(source.sha256,row.sha256);assert.equal(raw.phase,'complete');assert.equal(raw.dirty,false);
    assert.equal(raw.physicsSha256,hash(physicsBytes));
    assert.equal(raw.config.hS,1/row.clothHz);assert.equal(row.boatHz,summary.boatHz);
    assert.equal(row.phi,raw.recipe.boat.phi);
    assert.deepEqual(row.originM,[raw.recipe.boat.p.mass.cg_m[0],0,raw.recipe.boat.p.mass.cg_m[2]]);
    assert.equal(row.total.steps,raw.steps.length);
    assert(row.packets.length>0);assert.equal(row.total.packets,row.packets.length);
    const body={massKg,inertiaKgM2,originM:row.originM,frame:'body-horizontal',
      velocityMS:velocityMS.slice(),angularVelocityRadS:angularVelocityRadS.slice()};
    const directJ=[0,0,0],directL=[0,0,0],c=Math.cos(row.phi),s=Math.sin(row.phi),o=row.originM;
    let nextStep=0,maxVelocityErrorMS=0,maxAngularVelocityErrorRadS=0,maxEnergyResidualJ=0,totalWorkJ=0;
    for (const packet of row.packets) {
      assert.equal(packet.fromStep,nextStep);assert.equal(packet.throughStep+1-packet.fromStep,row.clothHz/row.boatHz);
      assert.equal(packet.startTimeS,nextStep*raw.config.hS);
      assert.equal(packet.endTimeS,(packet.throughStep+1)*raw.config.hS);assert.equal(packet.durationS,1/row.boatHz);
      assert.equal(packet.phi,row.phi);
      const J=[0,0,0],L=[0,0,0];
      // Прямое суммирование исходных сил и r×F, без накопителя/измерителей рига.
      for(let i=packet.fromStep;i<=packet.throughStep;i++) {
        const step=raw.steps[i],p=step.positionsM,f=step.supportForceN,h=raw.config.hS;
        assert.equal(step.timeS,(i+1)*h);assert.equal(p.length,f.length);
        for(let k=0;k<p.length;k+=3) {
          const x=p[k]-o[0],y=c*p[k+1]-s*p[k+2]-o[1],z=s*p[k+1]+c*p[k+2]-o[2];
          const fx=-f[k],fy=-c*f[k+1]+s*f[k+2],fz=-s*f[k+1]-c*f[k+2];
          J[0]+=h*fx;J[1]+=h*fy;J[2]+=h*fz;
          L[0]+=h*(y*fz-z*fy);L[1]+=h*(z*fx-x*fz);L[2]+=h*(x*fy-y*fx);
        }
      }
      vector(packet.impulseNs,J,packet.durationS);vector(packet.angularImpulseNms,L,packet.durationS);
      const v0=velocityMS.map((v,d)=>v+directJ[d]/massKg);
      const w0=angularVelocityRadS.map((v,d)=>v+directL[d]/inertiaKgM2[d]);
      for(let d=0;d<3;d++){directJ[d]+=J[d];directL[d]+=L[d];}
      const v=velocityMS.map((x,d)=>x+directJ[d]/massKg);
      const w=angularVelocityRadS.map((x,d)=>x+directL[d]/inertiaKgM2[d]);
      // Независимая квадратичная формула вместо средней скорости получателя.
      let work=0;
      for(let d=0;d<3;d++)work+=v0[d]*J[d]+J[d]**2/(2*massKg)+w0[d]*L[d]+L[d]**2/(2*inertiaKgM2[d]);
      const response=supportBodyResponse(body,packet);
      vector(response.velocityMS,v);vector(response.angularVelocityRadS,w);
      close(response.beforeJ,kinetic(v0,w0));close(response.afterJ,kinetic(v,w));close(response.impulseWorkJ,work);
      const residual=response.afterJ-response.beforeJ-response.impulseWorkJ;
      close(residual,0,Math.max(1,response.beforeJ,response.afterJ,Math.abs(work)));
      maxVelocityErrorMS=Math.max(maxVelocityErrorMS,difference(response.velocityMS,v));
      maxAngularVelocityErrorRadS=Math.max(maxAngularVelocityErrorRadS,difference(response.angularVelocityRadS,w));
      maxEnergyResidualJ=Math.max(maxEnergyResidualJ,Math.abs(residual));totalWorkJ+=response.impulseWorkJ;
      body.velocityMS=response.velocityMS;body.angularVelocityRadS=response.angularVelocityRadS;
      nextStep=packet.throughStep+1;
    }
    assert.equal(nextStep,raw.steps.length);
    close(totalWorkJ,kinetic(body.velocityMS,body.angularVelocityRadS)-kinetic(velocityMS,angularVelocityRadS));
    // Вес определяется компонентами известного поля, а не полной инерционной массой.
    const integrated=integrateDensity(raw.recipe.field,raw.recipe.rows,raw.recipe.cols),gravity=[0,0,0];
    for(let i=0;i<raw.recipe.mass.length;i++)for(let d=0;d<3;d++)gravity[d]+=integrated[16*i+3+d];
    const dryMassKg=norm(gravity)/physics.environment.g;
    const inertialMassKg=raw.recipe.mass.reduce((a,b)=>a+b,0);
    vector([gravity[0],c*gravity[1]-s*gravity[2],s*gravity[1]+c*gravity[2]],
      [0,0,-dryMassKg*physics.environment.g]);
    return {source:row.path,sourceSha256:row.sha256,clothHz:row.clothHz,boatHz:row.boatHz,
      packets:row.packets.length,steps:nextStep,originM:o,phi:row.phi,
      maxVelocityErrorMS,maxAngularVelocityErrorRadS,maxEnergyResidualJ,totalWorkJ,
      finalVelocityMS:body.velocityMS,finalAngularVelocityRadS:body.angularVelocityRadS,
      massAudit:{dryMassKg,inertialMassKg,addedAirMassKg:inertialMassKg-dryMassKg,
        gravityForceN:gravity,rigAndSailsBudget:physics.mass.budget.filter(p=>p.name==='Рангоут и паруса')}};
  });
  return {path,sha256:hash(bytes),revision:summary.revision,boatHz:summary.boatHz,series};
});
const result={schema:1,createdAt:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  toolSha256:hash(readFileSync(new URL(import.meta.url))),receiverSha256:hash(readFileSync('tests/lib/cloth-support-body.mjs')),
  fieldIntegratorSha256:hash(readFileSync('tests/lib/cloth-shared-input.mjs')),physicsSha256:hash(physicsBytes),arithmeticRelative:relative,
  scope:'Известная масса и диагональная инерция, замороженные оси и ЦТ. Только ответ скорости и дискретная работа пакета; не движение Boat, работа живых креплений или приёмка G4.',
  body:{massKg,inertiaKgM2,velocityMS,angularVelocityRadS},summaries};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
const rows=summaries.flatMap(s=>s.series);
console.log(JSON.stringify({output,series:rows.length,packets:rows.reduce((n,r)=>n+r.packets,0),
  maxVelocityErrorMS:Math.max(...rows.map(r=>r.maxVelocityErrorMS)),
  maxAngularVelocityErrorRadS:Math.max(...rows.map(r=>r.maxAngularVelocityErrorRadS)),
  maxEnergyResidualJ:Math.max(...rows.map(r=>r.maxEnergyResidualJ)),massAudit:rows[0].massAudit},null,2));
