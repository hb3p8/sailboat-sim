// Минимальные DOM/сеть для настоящего контроллера и отдельного Node Worker.
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
export function liveHarness({js=false}={}) {
  const elements=new Map(),workers=new Set();let breakNextInit=false;
  const element=id=>{if(!elements.has(id))elements.set(id,{style:{},dataset:{},value:'',checked:false,textContent:'',dispatchEvent(){},append(){}});return elements.get(id);};
  globalThis.document={hidden:false,addEventListener(){},getElementById:element,createElement:()=>({style:{},dataset:{}})};
  globalThis.innerWidth=1000;globalThis.innerHeight=800;
  globalThis.fetch=async url=>{try{const data=readFileSync(new URL('.'+url,new URL('../../',import.meta.url)));return {ok:true,arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)};}catch{return {ok:false};}};
  globalThis.Worker=class {
    constructor(url) {
      const bootstrap=`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};
        parentPort.on('message',data=>self.onmessage({data}));
        ${js?`const actual=Math.hypot;Math.hypot=(...v)=>actual(...v)*(v.length===3&&v[0]===1&&v[1]===2&&v[2]===3?1+Number.EPSILON:1);`:''}
        await import(${JSON.stringify(url.href)});parentPort.postMessage({type:'boot'});`;
      this.worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(bootstrap)),{type:'module'});workers.add(this.worker);this.waiting=[];
      this.worker.on('message',data=>{if(data.type==='boot'){this.ready=true;for(const m of this.waiting)this.worker.postMessage(m);this.waiting=[];}else this.onmessage?.({data});});
      this.worker.on('error',error=>this.onerror?.({message:error.message}));
    }
    postMessage(data){if(breakNextInit&&data.type==='init'){breakNextInit=false;data={...data,bytes:new Uint8Array([1,2,3])};}if(this.ready)this.worker.postMessage(data);else this.waiting.push(data);}
    terminate(){workers.delete(this.worker);return this.worker.terminate();}
  };
  return {ui:()=>Object.fromEntries(['genpressure','wind','winddir','gensheet','genup','jibup','mainup'].map(k=>[k,element(k)])),
    breakNextInit(){breakNextInit=true;},async close(){await Promise.all([...workers].map(w=>w.terminate()));},workers};
}
export async function settled(sim) {
  const start=performance.now();while(sim.busy&&performance.now()-start<10000){sim.frame();await delay(1);}
  if(sim.busy)throw new Error('Контроллер не завершил операцию');
  const failure=sim.performance().failure;if(failure)throw new Error(failure.message);
}
