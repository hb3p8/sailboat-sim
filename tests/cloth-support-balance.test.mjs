// Известные общие силы, момент и работа; ошибочная реакция должна быть заметна.
import assert from 'node:assert/strict';
import {supportBalance} from './lib/cloth-support-balance.mjs';
const close=(a,b)=>assert(Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const h=1/60, points=[0,0,0,2,0,0], displacement=.01, mass=[2,3];
const moved=points.map((v,k)=>v+(k%3===1?displacement:0));
const command={positions:moved,previous:points,prior:points,priorDt:h,hS:h,mass,fixed:[0,1],
  dampingHz:6,appliedForceN:new Array(6).fill(0),
  supportForceN:[0,mass[0]*displacement/h**2,0,0,mass[1]*displacement/h**2,0],forceToleranceN:1e-6};
const translated=supportBalance(command);
translated.forceN.forEach(v=>close(v,0)); translated.momentNm.forEach(v=>close(v,0));
close(translated.supportWorkJ,5*displacement**2/h**2);
close(translated.supportN[1],180);
const missing=supportBalance({...command,supportForceN:command.supportForceN.map((v,k)=>k>=3?0:v)});
close(missing.forceN[1],108); close(missing.momentNm[2],216);
assert(missing.forceN[1]>missing.forceLimitN);

// Пара неверных сил сохраняет общую силу, но создаёт известный момент.
const wrong=supportBalance({...command,supportForceN:command.supportForceN.map((v,k)=>v+(k===1?7:k===4?-7:0))});
wrong.forceN.forEach(v=>close(v,0)); close(wrong.momentNm[2],14);
assert(wrong.momentNm[2]>wrong.momentLimitNm[2]);

// Удержание после движения: ускорение и затухание учитывают прежнюю скорость.
const decay=Math.exp(-6*h), heldReaction=[0,1].flatMap(i=>[0,-mass[i]*decay*displacement/h**2,0]);
const held=supportBalance({...command,previous:moved,prior:points,supportForceN:heldReaction});
held.forceN.forEach(v=>close(v,0)); held.momentNm.forEach(v=>close(v,0));close(held.supportWorkJ,0);
close(held.dampingN[1],5*(decay-1)*displacement/h**2);

// Поворот осей и перенос происхождения не уничтожают известный момент.
const rotated=supportBalance({...command,
  positions:[3,-5,2,3,-3,2],previous:[3,-5,2,3,-3,2],prior:[3,-5,2,3,-3,2],
  supportForceN:[0,0,7,0,0,-7]});
rotated.forceN.forEach(v=>close(v,0));close(rotated.momentNm[0],14);
console.log('ок: независимый общий баланс, известные работа/масса/затухание, пропущенная реакция и неверная пара сил');
