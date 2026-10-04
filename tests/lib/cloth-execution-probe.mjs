// Постоянная независимая работа в том же потоке; она не читает модель паруса.
// Прошедшее время включает остановки выполнения и не является CPU.
export const EXECUTION_PROBE=Object.freeze({schema:'cloth-execution-probe-v1',samples:3,
  dotProducts:2097152,allocatedVectors:65536,dotChecksum:106954752,
  allocationChecksum:85786624,tailChecksum:2680832});

export function createExecutionProbe(now=()=>performance.now()) {
  const a=new Float64Array(2048),b=new Float64Array(2048);
  for(let i=0;i<a.length;i++){a[i]=i%16+1;b[i]=17-a[i];}
  const dot=()=>{
    let sum=0;
    for(let repeat=0;repeat<1024;repeat++)for(let i=0;i<a.length;i++)sum+=a[i]*b[i];
    return sum;
  };
  const allocate=()=>{
    const ring=new Array(2048);let sum=0;
    for(let i=0;i<65536;i++) {
      const x=a[i%a.length],v=[x,2*x,3*x];ring[i%ring.length]=v;
      sum+=v[0]*v[0]+v[1]*v[1]+v[2]*v[2];
    }
    let tail=0;
    for(const v of ring)tail+=v[0]*v[0]+v[1]*v[1]+v[2]*v[2];
    return {sum,tail};
  };
  return ()=>{
    const start=now(),samples=[];
    for(let i=0;i<EXECUTION_PROBE.samples;i++) {
      const dotAt=now(),dotChecksum=dot(),dotMs=now()-dotAt;
      const allocationAt=now(),result=allocate(),allocationMs=now()-allocationAt;
      samples.push({dotMs,allocationMs,dotChecksum,allocationChecksum:result.sum,tailChecksum:result.tail});
    }
    const result={...EXECUTION_PROBE,samples,elapsedMs:now()-start};
    validateExecutionProbe(result);return result;
  };
}

export function validateExecutionProbe(result) {
  const error=()=>{throw new Error('Неверная запись независимой вычислительной пробы');};
  if(!result||!Array.isArray(result.samples)||result.samples.length!==EXECUTION_PROBE.samples)error();
  for(const [key,value] of Object.entries(EXECUTION_PROBE))if(key!=='samples'&&result[key]!==value)error();
  let total=0;
  for(const sample of result.samples) {
    for(const key of ['dotMs','allocationMs'])if(!Number.isFinite(sample[key])||sample[key]<0)error();
    for(const key of ['dotChecksum','allocationChecksum','tailChecksum'])if(sample[key]!==EXECUTION_PROBE[key])error();
    total+=sample.dotMs+sample.allocationMs;
  }
  if(!Number.isFinite(result.elapsedMs)||result.elapsedMs<0||total>result.elapsedMs+1e-6)error();
}
