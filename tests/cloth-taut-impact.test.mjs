// Известное резкое натяжение нерастяжимой нити: важен импульс, пик растёт 1/h.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ImplicitEnergyMotion} from './lib/cloth-implicit-motion.mjs';
import {distance} from './cloth-compliance.mjs';
import {loadSparseFactor} from './lib/cloth-sparse-wasm.mjs';
const args=process.argv.slice(2),backend=args.find(s=>s.startsWith('--linear-backend='))?.split('=')[1] ?? 'band-js';
const path=args.find(s=>s.startsWith('--wasm='))?.slice(7);
assert(args.every(s=>/^--(linear-backend|wasm)=.+$/.test(s)) && ['band-js','kkt-wasm'].includes(backend));
assert(backend!=='kkt-wasm' || path,'Нужен явный --wasm=модуль');
const factor=path?await loadSparseFactor(readFileSync(path)):undefined;
const close=(a,b)=>assert(Math.abs(a-b)<1e-9*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const results=[];
for (const hz of [60,120,240]) for (const phase of [.25,.5,.75]) {
  const h=1/hz,m=2,v=1,x=1-phase*v*h;
  const motion=new ImplicitEnergyMotion({positions:[0,0,0,x,0,0],mass:[1,m],fixed:[0],
    constraints:[distance(0,1,1,0,true)],dampingHz:0,linearBackend:backend,wasmSparseFactor:factor});
  motion.prev[3]=x-v*h;motion.prevDt=h;
  let impulse=0,peak=0,hardWork=0,inertiaIncrement=0;
  for (let i=0;i<3;i++) {
    const audit=motion.step(new Float64Array(6),h,80,[]);
    const reaction=audit.supportForceN[0];impulse+=reaction*h;peak=Math.max(peak,Math.abs(reaction));
    hardWork+=audit.hardWorkEstimateJ;inertiaIncrement+=audit.inertiaIncrementJ;
    close(audit.supportWorkJ,0);close(audit.discreteBalanceResidualJ,0);
    assert(audit.solver.converged && audit.maxPhysicalResidualN<=1e-6 && audit.maxHardViolationM<=1e-9);
  }
  close(motion.pos[3],1);close(motion.kinetic(),0);
  close(impulse,-m*v);close(peak,m*v*Math.max(phase,1-phase)/h);
  close(hardWork,-m*phase*(1-phase)*v*v);
  close(inertiaIncrement-hardWork,.5*m*v*v);
  results.push({hz,phase,impulseNs:impulse,peakN:peak,kineticLossJ:inertiaIncrement-hardWork});
}
console.log(JSON.stringify({проверка:'импульс резкого натяжения известной нити',способ:backend,results}));
