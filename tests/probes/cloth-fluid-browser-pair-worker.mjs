// Разные графы кода, один набор чисел и модулей. Таймер шага исключает сверку.
import {requireProbe as check,equalProbe,serialProbe,shaProbe,fetchProbe} from './cloth-sparse-browser-probe.mjs';
const difference=(a,b)=>Object.fromEntries(Object.entries(a).map(([k,x])=>[k,typeof x==='object'?difference(x,b[k]):x-b[k]]));
let used=false;
self.addEventListener('message',async({data})=>{
  if(used){self.postMessage({type:'error',message:'Для новой пары нужен новый Worker'});return;}used=true;
  const started=performance.now();let result;
  try{
    const {input,pair}=data;check([1,2,3].includes(pair),'Неверный номер пары');
    const fixtureBytes=await fetch(input,{cache:'no-store'}).then(r=>{check(r.ok,'Не прочитан вход');return r.arrayBuffer();}),f=JSON.parse(new TextDecoder().decode(fixtureBytes)),graphRoot=new URL('../../',import.meta.url);
    check(f.phase==='complete'&&f.schema==='cloth-fluid-browser-pair-fixture-v1','Неверный вход пары');
    result={schema:'cloth-fluid-browser-pair-v1',phase:'preparing',input:{path:input,sha256:await shaProbe(fixtureBytes)},fixtureRevision:f.revision,fixtureDirty:f.dirty,pair,profile:f.profile,
      graphs:f.graphs,modules:f.modules,preparation:{},records:[],exactPairs:0,
      environment:{userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,crossOriginIsolated:self.crossOriginIsolated},
      rule:'Порядок каждой пары шагов чередуется, первый прежний→новый в 1/3, наоборот в 2. Сверка/сериализация вне таймеров. Время по часам не CPU/FPS; все первые шаги/подготовка сохранены.'};
    const files={...f.sourceSha256};for(const [v,g] of Object.entries(f.graphs))for(const [p,h] of Object.entries(g.sourceSha256))files[v+'/'+p]=h;
    for(const [p,h] of Object.entries(files)){const b=await fetch(new URL(p,graphRoot),{cache:'no-store'}).then(r=>{check(r.ok,'Не прочитан '+p);return r.arrayBuffer();});check(await shaProbe(b)===h,'Изменился исходник '+p);}
    const bytes={};for(const name of ['linear','material','assembly'])bytes[name]=await fetchProbe(f.modules[name]);
    const api={};for(const v of ['baseline','candidate']){
      const url=new URL(v+'/tests/lib/cloth-fluid-sail-motion.mjs',graphRoot);
      api[v]={...await import(url),...await import(new URL('./cloth-sparse-wasm.mjs',url)),...await import(new URL('./cloth-worker-timing.mjs',url)),...await import(new URL('./cloth-fluid-timing.mjs',url)),
        ...await import(new URL('../probes/cloth-material-wasm.mjs',url)),...await import(new URL('../probes/cloth-material-engine-check.mjs',url)),
        ...await import(new URL('../probes/cloth-assembly-wasm.mjs',url)),...await import(new URL('../probes/cloth-assembly-engine-check.mjs',url)),
        ...(f.profile?await import(new URL('./cloth-fluid-schur-direction.mjs',url)):{}),};}
    for(const part of f.inputs){const old=JSON.parse(new TextDecoder().decode(await fetchProbe(part))),recipe=old.fixture,contexts={};
      for(const v of pair%2?['baseline','candidate']:['candidate','baseline']){
        const a=api[v],t=performance.now(),factor=await a.loadSparseFactor(bytes.linear),materialKernel=await a.loadMaterialKernel(bytes.material),assemblyKernel=await a.loadAssemblyKernel(bytes.assembly),compiled=performance.now();
        equalProbe(a.verifyMaterialKernel(materialKernel,recipe.recipe),old.preparation.material.validation);equalProbe(a.verifyAssemblyKernel(assemblyKernel,recipe.recipe),old.preparation.assembly.validation);
        const verified=performance.now(),linear=f.profile?a.observeSparseFactor(factor):undefined,c=a.fluidSailMotion(recipe.recipe,recipe.bodyInput,linear?.factor??factor,{sheet:recipe.sheet,materialKernel,assemblyKernel}),stages=f.profile?a.observeFluidStages(c.motion):undefined;
        contexts[v]={c,factor,linear,stages};result.preparation[part.side+'-'+v]={compileMs:compiled-t,checkMs:verified-compiled,modelMs:performance.now()-verified,setupMs:performance.now()-t};
        equalProbe(JSON.parse(JSON.stringify(serialProbe({positions:c.motion.pos,body:c.motion.body}))),old.initial);}
      for(const s of old.steps){const times={},states={},order=(s.index+pair)%2?['baseline','candidate']:['candidate','baseline'];
        for(const v of order){const {c,factor,linear,stages}=contexts[v],a=api[v],before=stages?.snapshot(),linearBefore=linear?.snapshot(),wasmBefore=factor.statistics(),
            directionBefore=f.profile?a.directionProfile():undefined,sparseBefore=f.profile?a.sparseProfile():undefined;
          const t=performance.now();let audit,loaded;if(f.profile){c.prepareLoad(s.controls);loaded=performance.now();audit=c.solve();}else audit=c.step(s.controls);
          const ended=performance.now();times[v]={stepMs:ended-t,wasm:difference(factor.statistics(),wasmBefore)};
          if(f.profile)times[v].profile={loadMs:loaded-t,physicsMs:ended-loaded,stages:a.stageDifference(stages.snapshot(),before),linear:difference(linear.snapshot(),linearBefore),
            directions:difference(a.directionProfile().phases,directionBefore.phases),sparse:difference(a.sparseProfile(),sparseBefore)};
          states[v]=serialProbe({positions:c.motion.pos,body:c.motion.body,forceN:c.forceN,audit});equalProbe(JSON.parse(JSON.stringify(states[v])),{positions:s.positions,body:s.body,forceN:s.forceN,audit:s.audit},'прежний шаг '+s.index);}
        equalProbe(states.baseline,states.candidate,'строгая пара '+s.index);result.exactPairs++;result.records.push({side:part.side,step:s.index,order,times,states});
        if(s.index%30===0)self.postMessage({type:'progress',message:`${part.side==='plus'?'Первая':'Другая'} сторона: ${s.index}/180; ${result.exactPairs} точных пар.`});}
    }
    result.phase='complete';result.wallMs=performance.now()-started;self.postMessage({type:'result',result});
  }catch(e){if(result){result.phase='failed';result.failure={message:e.message,stack:e.stack};result.wallMs=performance.now()-started;self.postMessage({type:'result',result});}else self.postMessage({type:'error',message:e.message});}
});
