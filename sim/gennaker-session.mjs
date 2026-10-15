// Состояние между полными шагами. Сцена и контроллер добавляются адаптером;
// здесь нет DOM, расписания и действующего Worker.
import {energyCloth,gennakerBodyPack,localPoint} from './gennaker-energy.mjs';
import {boatBodyRotation} from './axes.js';
export const GENNAKER_SESSION_SCHEMA='gennaker-session-v1';
export function sessionDataEqual(a,b) {
  if(Object.is(a,b))return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&sessionDataEqual(a[k],b[k]));
}
const BODY_NUMBERS='x y psi u v r phi p_ t zc w th q hike rigRate waveZ waveSE waveSN windK shelter gustK chanRot shoalK sog'.split(' ');
const BODY_VECTORS=['cur','curB','shoreN','chanAxis'];
export function sessionBody(boat) {
  return sessionNumbers(Object.fromEntries([...BODY_NUMBERS,...BODY_VECTORS,'rigSide','shoreM','aground'].map(k=>[k,boat[k]])));
}
export const SESSION_DERIVED=['gustG','planing','fetchField','fetchM','seaHs','wavesN','vertN'];
const CONTROL_BOOL=['fetchOverride','mainUp','jibUp','gennakerUp','freeWake','wakeForces','localPressure'];
const CONTROL_NULL=['jibSheet','jibTwist','jibDraft','rudderTarget'];
const CONTROL_NUMBER='windSpeed windDir shadeD0 shadeK shadeGust current chan sheet twist rudder crewHike crewMass crewX crewZ sailScale genSheetLen draft wakeSlice fetch'.split(' ');
const fail=path=>{throw new Error('Некорректный снимок сессии: '+path);};
export function sessionNumbers(v,read=false) {
  if(read&&v==='-0')return -0;if(!read&&Object.is(v,-0))return '-0';
  if(typeof v==='number'){if(!Number.isFinite(v))fail('не-конечное число');return v;}
  if(Array.isArray(v)||ArrayBuffer.isView(v))return Array.from(v,x=>sessionNumbers(x,read));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sessionNumbers(x,read)]));
  if(v===null||typeof v==='boolean'||typeof v==='string')return v;
  fail('тип данных');
}
function fields(v,keys,path) {
  if(!v||Array.isArray(v)||typeof v!=='object'||Object.keys(v).some(k=>!keys.includes(k)))fail(path);
}
const finite=(v,p)=>{if(!Number.isFinite(v))fail(p);};
const vector=(v,n,p)=>{if(!Array.isArray(v)||v.length!==n||!Array.from(v).every(Number.isFinite))fail(p);};
function pose(v) {
  fields(v,['originM','angles','orientation9'],'поза');vector(v.originM,3,'начало позы');vector(v.angles,3,'углы');vector(v.orientation9,9,'поворот');
  if(v.orientation9.some((x,i)=>x!==boatBodyRotation(...v.angles)[i]))fail('матрица поворота');
}
export function captureSessionModel(boat,adapterSnapshot) {
  const controls=new Set([...CONTROL_BOOL,...CONTROL_NULL,...CONTROL_NUMBER]);
  for(const k of Object.keys(boat.o))if(!controls.has(k))fail('не описано управление '+k);
  if(boat.o.localPressure)fail('опытное местное давление не поддержано');
  const known=new Set([...BODY_NUMBERS,...BODY_VECTORS,...SESSION_DERIVED,'rigSide','shoreM','aground',
    'p','terrain','mass','o','wind','rig','buoy','telemetry','gennakerEnergy']);
  for(const k of Object.keys(boat))if(!known.has(k))fail('не описано поле лодки '+k);
  const body=sessionBody(boat);
  const cl=boat.rig.cloth;
  return {local:sessionNumbers({body,derived:Object.fromEntries(SESSION_DERIVED.filter(k=>Object.hasOwn(boat,k)).map(k=>[k,boat[k]])),controls:boat.o,wind:boat.wind.o,
    cloth:cl?.energyGennaker?{pos:cl.pos,prev:cl.prev,prevDt:cl.prevDt}:null,
    accepted:adapterSnapshot?{positions:adapterSnapshot.positions,targetPose:adapterSnapshot.targetPose,
      velocity:adapterSnapshot.velocity??new Float64Array(297),lengthM:adapterSnapshot.lengthM??boat.o.genSheetLen}:null,
    telemetry:boat.telemetry??null}),air:boat.rig.airSnapshot()};
}
export function prepareSessionModel(boat,originalPack,fixture,model) {
  fields(model,['local','air'],'модель');const v=sessionNumbers(model.local,true);
  fields(v,['body','derived','controls','wind','cloth','accepted','telemetry'],'локальная модель');
  fields(v.derived,SESSION_DERIVED,'результаты шага');
  for(const [k,x] of Object.entries(v.derived)) {
    if(k==='fetchField'){if(typeof x!=='boolean')fail(k);}
    else if(k==='planing') {
      if(x!==null){fields(x,['lift','xcp','tau','w','mods','lambda'],k);for(const p of ['lift','xcp','tau','w','lambda'])finite(x[p],k);
        fields(x.mods,['friction','wave'],k);finite(x.mods.friction,k);finite(x.mods.wave,k);}
    } else finite(x,k);
  }
  fields(v.body,[...BODY_NUMBERS,...BODY_VECTORS,'rigSide','shoreM','aground'],'лодка');
  for(const k of BODY_NUMBERS)finite(v.body[k],k);
  for(const k of BODY_VECTORS){fields(v.body[k],['x','y'],k);finite(v.body[k].x,k);finite(v.body[k].y,k);}
  if(v.body.t<0||typeof v.body.aground!=='boolean')fail('время/берег');
  for(const k of ['rigSide','shoreM'])if(v.body[k]!==null)finite(v.body[k],k);
  const o=v.controls;validateSessionInput(o,v.wind);
  if(o.gennakerUp!==!!fixture)fail('состояние генакера');
  if(fixture) {
    fields(v.cloth,['pos','prev','prevDt'],'ткань');vector(v.cloth.pos,297,'узлы');vector(v.cloth.prev,297,'история узлов');
    if(![1/60,1/30].includes(v.cloth.prevDt))fail('шаг видимой ткани');
    fields(v.accepted,['positions','velocity','targetPose','lengthM'],'принятый ответ');pose(v.accepted.targetPose);
    vector(v.accepted.positions,297,'мировые узлы');vector(v.accepted.velocity,297,'скорости');finite(v.accepted.lengthM,'длина');
    if(v.accepted.lengthM<fixture.sheet.lengthM||v.accepted.lengthM>fixture.sheet.lengthM+.25)fail('длина шкота');
    for(let i=0;i<99;i++)if(localPoint(v.accepted.targetPose,v.accepted.positions.slice(3*i,3*i+3)).some((x,d)=>!Object.is(x,v.cloth.pos[3*i+d])))fail('несогласованная видимая ткань');
  } else if(v.cloth!==null||v.accepted!==null)fail('ткань убранного паруса');
  // Кандидат использует тот же класс Boat, что и сцена: собранный HTML не
  // подменяет её отдельным экземпляром класса из другого графа модулей.
  const candidate=new boat.constructor(originalPack,boat.terrain,o);
  if(fixture){candidate.p=gennakerBodyPack(originalPack,fixture.recipe).pack;candidate.mass=candidate.p.mass.total_kg;candidate.rig.p=candidate.p;}
  Object.assign(candidate,v.body,v.derived);candidate.o={...o};candidate.wind.o={...v.wind};
  candidate.rig.airRestore(model.air);
  if(fixture){candidate.rig.cloth=energyCloth(fixture.recipe,originalPack);candidate.rig.cloth.pos.set(v.cloth.pos);candidate.rig.cloth.prev.set(v.cloth.prev);candidate.rig.cloth.prevDt=v.cloth.prevDt;}
  candidate.telemetry=v.telemetry;
  if(candidate.telemetry)candidate.telemetry.strips=candidate.rig.stripState;
  return {boat:candidate,snapshot:v.accepted};
}
export function validateSessionInput(o,wind) {
  fields(o,[...CONTROL_BOOL,...CONTROL_NULL,...CONTROL_NUMBER],'управление');
  for(const k of CONTROL_NUMBER)finite(o[k],k);
  for(const k of CONTROL_NULL)if(o[k]!==null)finite(o[k],k);
  for(const k of CONTROL_BOOL)if(k!=='localPressure'||Object.hasOwn(o,k))if(typeof o[k]!=='boolean')fail(k);
  if(o.localPressure||!Number.isSafeInteger(o.wakeSlice)||o.wakeSlice<1||o.wakeSlice>3||o.crewMass<0||o.windSpeed<0)fail('режим управления');
  fields(wind,['speed','dir','gust','shift','gradient','z0','zRef'],'ветер');
  for(const k of ['speed','dir','gust','shift','z0','zRef'])finite(wind[k],'ветер '+k);
  if(typeof wind.gradient!=='boolean'||wind.z0<=0||wind.zRef<=wind.z0)fail('профиль ветра');
}
export function verifySessionSolver(model,solver) {
  const v=sessionNumbers(model.local,true),s=sessionNumbers(solver,true);
  if(JSON.stringify(v.accepted.targetPose)!==JSON.stringify(s.lastPose)||v.accepted.lengthM!==s.lengthM||
      v.accepted.positions.some((x,k)=>x!==s.motion.pos[k]+s.frameOriginM[k%3]))fail('разные состояния Worker и сцены');
}
