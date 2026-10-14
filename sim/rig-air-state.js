// Точный снимок воздуха между шагами. Старый компактный дамп не заменяется:
// здесь сохраняются также удержанные скорости и память выбора постановки.
import {Lattice, FreeWake} from './vlm.js';

const RIG_AIR_SCHEMA = 'rig-air-state-v1';
const RIG_AIR_REQUIRED = ['alphaLag','fPrev','fWas','fRamp','mirK','latQ','latSlope',
  'shedLo','shedHi','surf','latDelta','latCam','alphaInd','latRhs','latRebuild',
  'stripCalc','stripState','sailOut'];
const RIG_AIR_OPTIONAL = ['stripGamma','latOn','latCool','latWarm','fuseHold','fuseClean',
  'fuseTrips','lvx','lvy','lvz','latNoTail','twistEff','twistEffJib','twistEffGen'];
// Только рабочие буферы и кэши, заново целиком заполняемые перед чтением.
const RIG_AIR_SCRATCH = ['shade','sheetOf','twistOf','wakeStrip','_wakeG','_wakeRing',
  '_wakeSeed','wakeSail','lqx','lqy','lqz','ltx','lty','ltz','_bfade','surfW',
  'blockN','blockD','surfC','_hullV','_hullF','hullX','hullR','_latT','_lmask',
  '_lpre','_tailW','wqx','wqy','wqz','wvx','wvy','wvz','latWn','nearMid'];
const RIG_AIR_WAKE_REQUIRED = ['x','y','z','gr','ring','rc','rcSp','g','tdx','tdy','tdz',
  'n','slice','selN','warm','dirx','diry','dirz','spaceK','ground','hold','core'];
const RIG_AIR_WAKE_OPTIONAL = ['sx','sy','sz','sel','packSpace'];
const RIG_AIR_LATTICE_FIELDS = ['n','k','kw','gamma','aInd','aWake','wExtra','core','panels','bg','nb'];
function rigAirKnown(object,known,path) {
  const names=new Set(known);
  for(const k of Object.keys(object))if(!names.has(k))rigAirFail('не описано поле '+path+'.'+k);
}

function rigAirEncode(value) {
  if(Object.is(value,-0))return '-0';
  if(ArrayBuffer.isView(value)||Array.isArray(value))return Array.from(value,rigAirEncode);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rigAirEncode(v)]));
  return value;
}
function rigAirFail(path){throw new Error('Некорректный снимок воздуха: '+path);}
function rigAirNumber(value,path) {
  if(value==='-0')return -0;
  if(!Number.isFinite(value))rigAirFail(path);return value;
}
function rigAirBool(value,path){if(typeof value!=='boolean')rigAirFail(path);return value;}
function rigAirInteger(low,high) {return (value,path)=>{
  if(!Number.isSafeInteger(value)||value<low||value>high||Object.is(value,-0))rigAirFail(path);return value;
};}
function rigAirVector(n,Type=Array) {return (value,path)=>{
  if(!Array.isArray(value)||value.length!==n)rigAirFail(path);
  const numbers=Array.from(value,(v,i)=>rigAirNumber(v,path+'['+i+']'));
  if(Type!==Array&&Type!==Float64Array) {
    const bounds=Type===Uint8Array?[0,255]:Type===Int8Array?[-128,127]:Type===Int16Array?[-32768,32767]:[-2147483648,2147483647];
    numbers.forEach(v=>rigAirInteger(...bounds)(v,path));
  }
  return Type.from(numbers);
};}
function rigAirList(n,read) {return (value,path)=>{
  if(!Array.isArray(value)||value.length!==n)rigAirFail(path);
  return Array.from(value,(v,i)=>read(v,path+'['+i+']'));
};}
function rigAirFields(value,spec,required,path) {
  if(!value||Array.isArray(value)||typeof value!=='object')rigAirFail(path);
  for(const key of required)if(!Object.hasOwn(value,key))rigAirFail(path+'.'+key);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>{
    if(!Object.hasOwn(spec,k))rigAirFail(path+'.'+k);return [k,spec[k](v,path+'.'+k)];
  }));
}
const rigAirNumericSpec=keys=>Object.fromEntries(keys.split(' ').filter(Boolean).map(k=>[k,rigAirNumber]));
function rigAirRecord(required,optional='',extra={}) {
  const spec={...rigAirNumericSpec(required),...(optional?rigAirNumericSpec(optional):{}),...extra};
  return (value,path)=>rigAirFields(value,spec,[...required.split(' ').filter(Boolean),...Object.keys(extra)],path);
}
function rigAirPick(object,keys){return Object.fromEntries(keys.filter(k=>Object.hasOwn(object,k)).map(k=>[k,object[k]]));}
function rigAirConfiguration(rig,wakeLength,oldSail) {
  return JSON.stringify({pack:rig.p,gennakerUp:rig.gennakerUp,sails:rig.sails,strips:rig.strips,wakeLength,oldSail});
}

export function snapshotRigAir(rig,wakeLength,oldSail) {
  // Новое поле обязано получить явную классификацию: иначе снимок незаметно
  // перестанет быть полным при следующем изменении модели воздуха.
  rigAirKnown(rig,[...RIG_AIR_REQUIRED,...RIG_AIR_OPTIONAL,...RIG_AIR_SCRATCH,
    'p','gennakerUp','sails','strips','cloth','lattice','wake','wakeLen'],'Rig');
  const lat=rig.lattice,w=rig.wake;
  rigAirKnown(lat,[...RIG_AIR_LATTICE_FIELDS,'_v','_t','_mir','_lead','_trail','_pk','_m'],'Lattice');
  if(w)rigAirKnown(w,[...RIG_AIR_WAKE_REQUIRED,...RIG_AIR_WAKE_OPTIONAL,'fil','len','aged','et','es',
    'vx','vy','vz','eg','tg','ne','neReal','qx','qy','qz','tx','ty','tz','_nt','_np'],'Wake');
  const aged=w?w.aged.map(a=>{
    for(const k of ['lvx','lvy','lvz'])if(rig[k]===a)return 'rig.'+k;
    for(const k of ['sx','sy','sz'])if(w[k]===a)return 'wake.'+k;
    rigAirFail('не описан владелец удержанной скорости');
  }):[];
  return rigAirEncode({schema:RIG_AIR_SCHEMA,configuration:rigAirConfiguration(rig,wakeLength,oldSail),
    rig:rigAirPick(rig,[...RIG_AIR_REQUIRED,...RIG_AIR_OPTIONAL]),
    lattice:rigAirPick(lat,RIG_AIR_LATTICE_FIELDS),
    wake:w?{fil:w.fil,len:w.len,...rigAirPick(w,[...RIG_AIR_WAKE_REQUIRED,...RIG_AIR_WAKE_OPTIONAL]),aged}:null});
}

export function restoreRigAir(rig,state,wakeLength,oldSail) {
  if(state?.schema!==RIG_AIR_SCHEMA||state.configuration!==rigAirConfiguration(rig,wakeLength,oldSail))rigAirFail('версия или постановка');
  rigAirKnown(state,['schema','configuration','rig','lattice','wake'],'снимок');
  const ns=rig.strips.length,np=rig.lattice.n,nc=np/ns,fil=rig.wakeFil(),nw=fil*wakeLength;
  const f=n=>rigAirVector(n,Float64Array),u=n=>rigAirVector(n,Uint8Array),i=n=>rigAirVector(n,Int16Array);
  const stripCalc=rigAirRecord('xi yi zi ve d1 d2 alpha awa zLo zHi chord area slack camber draft fill aWake camPanel gamma luffFrac margin set slackCut sign',
    'chordDir cdWake',{q:f(nc),live:rigAirBool});
  const stripState=rigAirRecord('h z area ws awaDeg alphaDeg cl drive side geomDeg luffFrac slack ve margin camber draft fill','indDeg sep');
  const loadPart=rigAirRecord('', '', {forceN:rigAirVector(3),momentNm:rigAirVector(3)});
  // Аудит новой ткани — диагностика прошлой реакции. Физическое продолжение
  // читает fyMain/setMain и память полосок, а не содержимое этого аудита.
  function diagnostic(v,path,depth=0) {
    if(depth>12)rigAirFail(path);
    if(v===null||typeof v==='boolean'||(typeof v==='string'&&v!=='-0'))return v;
    if(Array.isArray(v))return Array.from(v,(x,i)=>diagnostic(x,path+'['+i+']',depth+1));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,diagnostic(x,path+'.'+k,depth+1)]));
    return rigAirNumber(v,path);
  }
  const sailSpec={...rigAirNumericSpec('fx fy fz mx my mz ceX ceY ceZ fyMain setMain awa awaEff alpha cl area'),
    originM:rigAirVector(3),bySail:rigAirList(rig.sails.length,loadPart),energyGennaker:diagnostic,
    phase:v=>{if(v!=='aero-after-cloth')rigAirFail('фаза сил');return v;},
    frame:v=>{if(v!=='body-horizontal')rigAirFail('оси сил');return v;}};
  const spec={alphaLag:f(ns),fPrev:f(2*ns),fWas:u(ns),fRamp:i(ns),mirK:f(rig.sails.length),
    latQ:f(nc),latSlope:f(np),shedLo:rigAirList(ns,rigAirVector(3)),shedHi:rigAirList(ns,rigAirVector(3)),
    surf:f(ns*2*(nc+1)*3),latDelta:f(ns),latCam:f(ns),alphaInd:f(ns),latRhs:f(np),latRebuild:rigAirBool,
    stripCalc:rigAirList(ns,stripCalc),stripState:rigAirList(ns,stripState),
    sailOut:(v,p)=>rigAirFields(v,sailSpec,Object.keys(sailSpec).filter(k=>k!=='energyGennaker'),p),
    stripGamma:f(ns),latOn:u(ns),latCool:i(ns),latWarm:i(ns),fuseHold:i(ns),fuseClean:i(ns),
    fuseTrips:rigAirInteger(0,Number.MAX_SAFE_INTEGER),lvx:f(nw),lvy:f(nw),lvz:f(nw),
    latNoTail:(v,p)=>v===null?null:rigAirBool(v,p),...rigAirNumericSpec('twistEff twistEffJib twistEffGen')};
  const next=rigAirFields(state.rig,spec,RIG_AIR_REQUIRED,'Rig');
  const panel=rigAirRecord('chord speed','',Object.fromEntries(['a','b','ta','tb','c','nrm'].map(k=>[k,rigAirVector(3)])));
  const ls={n:rigAirInteger(np,np),k:f(np*np),kw:f(np*np),gamma:f(np),aInd:f(np),aWake:f(np),wExtra:f(np),
    core:rigAirNumber,panels:rigAirList(np,panel),bg:f(np*48),nb:rigAirInteger(0,np*6)};
  const lat=Object.assign(new Lattice(np),rigAirFields(state.lattice,ls,Object.keys(ls).filter(k=>!['bg','nb'].includes(k)),'Lattice'));
  let wake=null;
  if(state.wake!==null) {
    const ws={fil:rigAirInteger(fil,fil),len:rigAirInteger(wakeLength,wakeLength),
      x:f(nw),y:f(nw),z:f(nw),gr:f(nw),ring:rigAirVector(fil,Int8Array),rc:f(nw),rcSp:f(nw),g:f(fil),
      tdx:f(wakeLength),tdy:f(wakeLength),tdz:f(wakeLength),n:rigAirInteger(0,wakeLength),
      slice:rigAirInteger(1,2147483647),selN:rigAirInteger(-1,nw),warm:rigAirBool,ground:rigAirBool,hold:rigAirBool,
      ...rigAirNumericSpec('dirx diry dirz spaceK core'),sx:f(nw),sy:f(nw),sz:f(nw),
      sel:rigAirVector(nw,Int32Array),packSpace:rigAirBool,
      aged:(v,p)=>{if(!Array.isArray(v)||new Set(v).size!==v.length||v.some(k=>!['rig.lvx','rig.lvy','rig.lvz','wake.sx','wake.sy','wake.sz'].includes(k)))rigAirFail(p);return v.slice();}};
    const data=rigAirFields(state.wake,ws,['fil','len','aged',...RIG_AIR_WAKE_REQUIRED],'Wake');
    wake=Object.assign(new FreeWake(fil,wakeLength),data);
    if(wake.core<0||wake.spaceK<0||wake.rc.some(v=>v<0)||wake.rcSp.some(v=>v<0)||
      wake.ring.some(v=>v!==0&&v!==1)||wake.sel?.some(v=>v<0||v>=nw)||wake.hold)rigAirFail('параметры следа');
    const expected=Object.keys(next).filter(k=>['lvx','lvy','lvz'].includes(k)).map(k=>'rig.'+k)
      .concat(['sx','sy','sz'].filter(k=>Object.hasOwn(data,k)).map(k=>'wake.'+k));
    if(expected.length!==wake.aged.length||expected.some(k=>!wake.aged.includes(k)))rigAirFail('владельцы скоростей следа');
    wake.aged=wake.aged.map(k=>k.startsWith('rig.')?next[k.slice(4)]:wake[k.slice(5)]);
    // Это только производная упаковка поля; удержанные скорости не сбрасываются.
    wake.edges();wake.pack(data.packSpace??true);
    if(!Object.hasOwn(data,'packSpace'))delete wake.packSpace;
  } else if(['lvx','lvy','lvz'].some(k=>Object.hasOwn(next,k)))rigAirFail('скорости без следа');
  if(lat.core<0)rigAirFail('ядро решётки');
  for(const key of ['fWas','latOn'])if(next[key]?.some(v=>v!==0&&v!==1))rigAirFail('маска '+key);
  for(const key of ['fRamp','latCool','latWarm','fuseHold','fuseClean'])if(next[key]?.some(v=>v<0))rigAirFail('счётчик '+key);
  for(const group of [['lvx','lvy','lvz'],['latOn','latCool','latWarm'],['fuseHold','fuseClean']]) {
    const present=group.filter(k=>Object.hasOwn(next,k)).length;
    if(present!==0&&present!==group.length)rigAirFail('неполная группа '+group.join('/'));
  }
  if(wake&&['sx','sy','sz'].filter(k=>Object.hasOwn(wake,k)).length%3)rigAirFail('неполное собственное поле следа');
  // Эти рабочие буферы в прежнем коде создаются одной группой с удержанными.
  // Восстанавливаем группу целиком, чтобы ближайший шаг не заменил lv* и не
  // зарегистрировал второй набор ссылок aged либо не прочитал отсутствующий q*.
  if(next.lvx)for(const k of ['lqx','lqy','lqz'])next[k]=new Float64Array(nw);
  if(wake?.sx)for(const k of ['qx','qy','qz','tx','ty','tz'])wake[k]=new Float64Array(nw);
  // Единственная точка публикации: до неё исходный Rig и его след не менялись.
  for(const k of [...RIG_AIR_REQUIRED,...RIG_AIR_OPTIONAL,...RIG_AIR_SCRATCH])delete rig[k];
  Object.assign(rig,next,{lattice:lat,wake});
}
