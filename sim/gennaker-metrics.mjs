// Часы обычной физики: активный темп не выводится из отброшенного acc.
const PHASES=['startup','preparing','running','paused','hidden','failed','complete'];
export class GennakerMetrics {
  constructor({now=()=>performance.now(),profile=false,context={}}={}) {
    Object.assign(this,{now,profile,context});this.reset();
  }
  reset() {
    this.lastMs=this.now();this.operation='startup';this.hidden=false;this.paused=false;
    this.phaseMs=Object.fromEntries(PHASES.map(k=>[k,0]));this.modelS=0;this.activeModelS=0;
    this.excludedModelS=0;this.steps=0;this.records=[];this.frames=[];this.lastFrameMs=undefined;
  }
  get phase(){return this.hidden?'hidden':this.paused?'paused':this.operation;}
  tick(atMs=this.now()) {
    if(!Number.isFinite(atMs)||atMs<this.lastMs)throw new Error('Часы физики должны возрастать');
    this.phaseMs[this.phase]+=atMs-this.lastMs;this.lastMs=atMs;
  }
  state(operation) {
    if(!PHASES.includes(operation))throw new Error('Неизвестная фаза часов физики');
    this.tick();this.operation=operation;
  }
  visibility(hidden){this.tick();if(this.hidden!==!!hidden)this.lastFrameMs=undefined;this.hidden=!!hidden;}
  frame({timestamp=this.now(),paused=false,hidden=false}={}) {
    const active=this.phase==='running';this.tick(timestamp);
    if(this.profile&&active&&!paused&&!hidden&&this.lastFrameMs!==undefined) {
      this.frames.push(timestamp-this.lastFrameMs);if(this.frames.length>600)this.frames.shift();
    }
    this.paused=!!paused;this.hidden=!!hidden;this.lastFrameMs=timestamp;
  }
  accepted(hS,record) {
    if(!Number.isFinite(hS)||hS<=0)throw new Error('Нужен положительный принятый шаг');
    this.tick();this.modelS+=hS;this.steps++;
    if(this.phase==='running')this.activeModelS+=hS;else this.excludedModelS+=hS;
    if(this.profile&&record){this.records.push(record);if(this.records.length>300)this.records.shift();}
  }
  snapshot() {
    this.tick();const activeS=this.phaseMs.running/1000,driftS=activeS-this.activeModelS;
    return {schema:'gennaker-metrics-v1',profile:this.profile,context:{...this.context},phase:this.phase,
      phaseMs:{...this.phaseMs},steps:this.steps,modelS:this.modelS,activeModelS:this.activeModelS,
      excludedModelS:this.excludedModelS,activeS,tempo:activeS>0?this.activeModelS/activeS:null,
      lagS:Math.max(0,driftS),driftS,records:this.records.slice(),frameIntervalsMs:this.frames.slice()};
  }
}
