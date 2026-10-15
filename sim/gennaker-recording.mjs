// Кольцо состоит из законченных блоков. Удаляем блок вместе с его входами,
// поэтому старейшая оставшаяся команда всегда имеет полный исходный снимок.
import {sessionNumbers,sessionBody,validateSessionInput,sessionDataEqual} from './gennaker-session.mjs';
export const GENNAKER_REPLAY_SCHEMA='gennaker-replay-v1';
export function recordingInput(boat,dt) {
  const controls={...boat.o};
  // При управлении целью угол пера — результат привода, а не новая команда.
  // Он остаётся в полном снимке и проверяется в выходе каждого шага.
  if(controls.rudderTarget!==null)delete controls.rudder;
  return sessionNumbers({timeS:boat.t,dt,controls,wind:boat.wind.o,
    water:[boat.waveZ,boat.waveSE,boat.waveSN]});
}
export function recordingOutput(boat) {
  const body=sessionBody(boat);
  // Последний GPU-ответ меняется во время ожидания ткани. Это внешний вход,
  // а не результат шага; для расчёта уже записана захваченная поверхность.
  for(const k of ['waveZ','waveSE','waveSN'])delete body[k];
  body.rudder=sessionNumbers(boat.o.rudder);
  return body;
}
export function applyRecordingInput(boat,raw) {
  const v=sessionNumbers(raw,true);
  if(!!boat.o.gennakerUp!==v.controls.gennakerUp)boat.setGennaker(v.controls.gennakerUp);
  const rudder=boat.o.rudder;Object.assign(boat.o,v.controls);
  if(v.controls.rudderTarget!==null)boat.o.rudder=rudder;
  boat.wind.o={...v.wind};boat.setWater(...v.water);
}
export class GennakerRecording {
  constructor(capacity=300,stride=30){this.capacity=capacity;this.stride=stride;this.reset();}
  reset(anchor){this.blocks=anchor?[{anchor,inputs:[]}]:[];this.error=undefined;this.checkpoints=0;this.snapshotTotalMs=0;this.snapshotMaxMs=0;}
  async checkpoint(capture) {
    const start=performance.now(),state=await capture(),ms=performance.now()-start;
    this.checkpoints++;this.snapshotTotalMs+=ms;this.snapshotMaxMs=Math.max(this.snapshotMaxMs,ms);return state;
  }
  stats(){return {blocks:this.blocks.length,steps:this.blocks.reduce((n,b)=>n+b.inputs.length,0),
    checkpoints:this.checkpoints,snapshotTotalMs:this.snapshotTotalMs,snapshotMaxMs:this.snapshotMaxMs,error:this.error};}
  async accepted(input,output,capture) {
    if(this.error)return;
    try {
      if(!this.blocks.length){this.blocks.push({anchor:await this.checkpoint(capture),inputs:[]});return;}
      this.blocks.at(-1).inputs.push({...input,output});
      if(this.blocks.at(-1).inputs.length===this.stride)this.blocks.push({anchor:await this.checkpoint(capture),inputs:[]});
      // Храним последние capacity шагов и до stride−1 шагов перед ними:
      // этот короткий префикс доводит расчёт от собственного снимка блока.
      while(this.blocks.reduce((n,b)=>n+b.inputs.length,0)>=this.capacity+this.stride)this.blocks.shift();
    } catch(error){this.blocks=[];this.error=error.message;}
  }
  snapshot(end) {
    if(this.error)throw new Error('История недоступна: '+this.error);
    return structuredClone({schema:GENNAKER_REPLAY_SCHEMA,capacitySteps:this.capacity,checkpointStride:this.stride,
      anchor:this.blocks[0]?.anchor??end,inputs:this.blocks.flatMap(b=>b.inputs),end});
  }
}
export function validateRecording(raw) {
  const r=structuredClone(raw),bad=()=>{throw new Error('Некорректная запись новой ткани');};
  if(r?.schema!==GENNAKER_REPLAY_SCHEMA||r.capacitySteps!==300||r.checkpointStride!==30||
    !Array.isArray(r.inputs)||r.inputs.length>329||!r.anchor||!r.end)bad();
  for(const k of ['schema','runtimeSha256','physicsSha256','engine','environment'])if(!sessionDataEqual(r.anchor[k],r.end[k]))bad();
  let t=r.anchor.model.local.body.t;
  for(const input of r.inputs) {
    const v=sessionNumbers(input,true);
    if(!v.controls||(v.controls.rudderTarget!==null&&Object.hasOwn(v.controls,'rudder')))bad();
    validateSessionInput(v.controls.rudderTarget===null?v.controls:{...v.controls,rudder:0},v.wind);
    if(v.dt!==1/30||v.timeS!==t||!Array.isArray(v.water)||v.water.length!==3||!v.water.every(Number.isFinite)||
      !v.output||v.output.t!==t+v.dt)bad();
    t+=v.dt;
  }
  if(t!==r.end.model.local.body.t)bad();
  return r;
}
