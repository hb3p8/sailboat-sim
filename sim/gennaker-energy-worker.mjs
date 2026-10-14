// Два подшага разделены явным continue; момент отправки выбирает адаптер.
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {selectGennakerMaterial} from './gennaker-material.mjs';
let calculation,job,attempts,profile=false;
self.onmessage=async ({data})=>{
  try {
    if(data.type==='init') {
      const {prescribedGennaker}=await import('./gennaker-energy.mjs');
      const factor=await loadSparseFactor(data.bytes),selected=await selectGennakerMaterial(data.materialBytes,data.fixture.recipe);
      profile=data.profile===true;
      calculation=prescribedGennaker(data.fixture,data.pack,data.pose,factor,selected.kernel,
        profile?{observeAttempt:a=>attempts.push(a)}:{});
      self.postMessage({type:'ready',minLengthM:calculation.minLengthM,maxLengthM:calculation.maxLengthM,material:selected.material});
    } else if(data.type==='step') {
      if(job)throw new Error('Предыдущий шаг ткани ещё не окончен');
      job={...data,parts:[],results:[],attempts:[]};run();
    } else if(data.type==='continue') {
      if(!job)throw new Error('Нет приостановленного шага ткани');run();
    } else throw new Error('Неизвестная команда ткани');
  } catch(error){const details=profile?{attempts:[...(job?.attempts??[]),attempts??[]]}:{};job=undefined;self.postMessage({type:'error',message:error.message,...details});}
};
function run() {
  const start=performance.now(),part=job.results.length,pose=job.poses[part];attempts=[];
  const result=calculation.step({forceN:job.forceN,targetPose:pose,sheetLengthM:job.sheetLengthM});
  job.parts.push(performance.now()-start);job.results.push(result);if(profile)job.attempts.push(attempts);
  if(part===0){self.postMessage({type:'progress'});return;}
  const averaged={...result,forceN:result.forceN.map((v,d)=>(v+job.results[0].forceN[d])/2),
    momentNm:result.momentNm.map((v,d)=>(v+job.results[0].momentNm[d])/2),partsMs:job.parts,
    audits:job.results.flatMap(v=>v.leaves??[v.audit]),...(profile?{attempts:job.attempts}:{})};
  job=undefined;self.postMessage({type:'step',...averaged},[averaged.positions.buffer,averaged.velocity.buffer]);
}
