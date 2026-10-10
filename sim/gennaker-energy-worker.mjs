// Два подшага ткани разделены сообщением после показанного кадра.
import {loadSparseFactor} from '../tests/lib/cloth-sparse-wasm.mjs';
import {loadMaterialKernel} from '../tests/probes/cloth-material-wasm.mjs';
let calculation,job;
self.onmessage=async ({data})=>{
  try {
    if(data.type==='init') {
      const {prescribedGennaker}=await import('./gennaker-energy.mjs');
      const factor=await loadSparseFactor(data.bytes),material=await loadMaterialKernel(data.materialBytes);
      calculation=prescribedGennaker(data.fixture,data.pack,data.pose,factor,material);
      self.postMessage({type:'ready',minLengthM:calculation.minLengthM,maxLengthM:calculation.maxLengthM});
    } else if(data.type==='step') {
      if(job)throw new Error('Предыдущий шаг ткани ещё не окончен');
      job={...data,parts:[],results:[]};run();
    } else if(data.type==='continue') {
      if(!job)throw new Error('Нет приостановленного шага ткани');run();
    } else throw new Error('Неизвестная команда ткани');
  } catch(error){job=undefined;self.postMessage({type:'error',message:error.message});}
};
function run() {
  const start=performance.now(),part=job.results.length,pose=job.poses[part];
  const result=calculation.step({forceN:job.forceN,targetPose:pose,sheetLengthM:job.sheetLengthM});
  job.parts.push(performance.now()-start);job.results.push(result);
  if(part===0){self.postMessage({type:'progress'});return;}
  const averaged={...result,forceN:result.forceN.map((v,d)=>(v+job.results[0].forceN[d])/2),
    momentNm:result.momentNm.map((v,d)=>(v+job.results[0].momentNm[d])/2),partsMs:job.parts,
    audits:job.results.flatMap(v=>v.leaves??[v.audit])};
  job=undefined;self.postMessage({type:'step',...averaged},[averaged.positions.buffer,averaged.velocity.buffer]);
}
