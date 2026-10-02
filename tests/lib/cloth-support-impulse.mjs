// Нагрузка на лодку противоположна реакции на ткань. Сохраняются интегралы
// силы и всех трёх моментов, а не последний снимок или средняя точка приложения.
import {rollVector,wrenchOf} from './gennaker-observables.mjs';

export class SupportImpulseLedger {
  constructor({clothHS,boatHS,originM,phi=0}) {
    if(!Number.isFinite(clothHS) || clothHS<=0 || !Number.isFinite(boatHS) || boatHS<=0 ||
      !Number.isFinite(phi) || originM?.length!==3 || !Array.from(originM).every(Number.isFinite))
      throw new Error('Нужны положительные шаги, конечные крен и начало моментов');
    const ratio=boatHS/clothHS;
    if(Math.round(ratio)<1 || Math.abs(ratio-Math.round(ratio))>32*Number.EPSILON*Math.max(1,ratio))
      throw new Error('Шаг лодки должен содержать целое число шагов ткани');
    Object.defineProperties(this,{clothHS:{value:clothHS},boatHS:{value:boatHS},
      originM:{value:Object.freeze(Array.from(originM))},phi:{value:phi}});
    this._width=Math.round(ratio);this._next=0;this._size=undefined;this._packets=0;
    this._impulse=[0,0,0];this._angular=[0,0,0];this._totalImpulse=[0,0,0];this._totalAngular=[0,0,0];
  }
  get pendingSteps(){return this._next%this._width;}
  push({index,positionsM,supportForceN}) {
    if(!Number.isInteger(index) || index!==this._next)throw new Error('Пропущен или повторён шаг нагрузки');
    if(!positionsM?.length || positionsM.length%3 || positionsM.length!==supportForceN?.length ||
      (this._size!==undefined && positionsM.length!==this._size))throw new Error('Нет полного снимка реакций и точек');
    const points=[],forces=[];
    for(let k=0;k<positionsM.length;k+=3) {
      const p=Array.from(positionsM.slice(k,k+3)),f=Array.from(supportForceN.slice(k,k+3));
      if(!p.every(Number.isFinite) || !f.every(Number.isFinite))throw new Error('Нечисловая точка или реакция');
      points.push(rollVector(p,this.phi));forces.push(rollVector(f.map(v=>-v),this.phi));
    }
    const load=wrenchOf(points,forces,this.originM);
    if(![...load.forceN,...load.momentNm].every(Number.isFinite))throw new Error('Переполнение суммы нагрузки');
    const impulse=load.forceN.map(v=>v*this.clothHS),angular=load.momentNm.map(v=>v*this.clothHS);
    const sum=(a,b)=>a.map((v,d)=>v+b[d]);
    const nextImpulse=sum(this._impulse,impulse),nextAngular=sum(this._angular,angular);
    const totalImpulse=sum(this._totalImpulse,impulse),totalAngular=sum(this._totalAngular,angular);
    if(![...nextImpulse,...nextAngular,...totalImpulse,...totalAngular].every(Number.isFinite))
      throw new Error('Переполнение накопленной нагрузки');
    this._size=positionsM.length;this._next++;
    this._impulse=nextImpulse;this._angular=nextAngular;this._totalImpulse=totalImpulse;this._totalAngular=totalAngular;
    if(this.pendingSteps)return null;
    const packet={fromStep:this._next-this._width,throughStep:this._next-1,
      startTimeS:(this._next-this._width)*this.clothHS,endTimeS:this._next*this.clothHS,
      durationS:this.boatHS,frame:'body-horizontal',originM:this.originM.slice(),phi:this.phi,
      impulseNs:this._impulse,angularImpulseNms:this._angular,
      averageForceN:this._impulse.map(v=>v/this.boatHS),averageMomentNm:this._angular.map(v=>v/this.boatHS)};
    this._impulse=[0,0,0];this._angular=[0,0,0];this._packets++;
    return packet;
  }
  finish() {
    if(this.pendingSteps)throw new Error('Неполный шаг лодки нельзя дополнить или отбросить');
    return {steps:this._next,packets:this._packets,durationS:this._next*this.clothHS,
      impulseNs:this._totalImpulse.slice(),angularImpulseNms:this._totalAngular.slice()};
  }
}
