// Изолированный свидетель самого проектора Cloth.sweep(): тяжёлая
// нерастяжимая нить между опорами против независимой катенарии.
// Никаких аэродинамики, швов, дощечки и длинных поводков здесь нет.
// node tests/cloth-chain-convergence.mjs
import { Cloth } from '../sim/cloth.js';

const chord = 1, length = 1.1, gravity = 9.81;
const opt = (name, fallback) => process.argv.find(s => s.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const hz = Number(opt('hz', '60'));
const seconds = Number(opt('seconds', '20'));
const cols = opt('cols', '9,17,33,65').split(',').map(Number);
const passes = opt('passes', '40,160').split(',').map(Number);
if (![30, 60, 120].includes(hz) || !(seconds > 0 && seconds <= 60) ||
    cols.some(n => !Number.isInteger(n) || n < 3 || n % 2 !== 1 || n > 129) ||
    passes.some(n => !Number.isInteger(n) || n < 1 || n > 4096))
  throw new Error('Неверные параметры изолированного стенда');
const ratio = length / chord;
let lo = 1e-9, hi = 5;
for (let i = 0; i < 80; i++) {
  const z = (lo + hi) / 2;
  if (Math.sinh(z) / z < ratio) lo = z; else hi = z;
}
const z = (lo + hi) / 2, a = chord / (2 * z);
const exact = a * (Math.cosh(z) - 1);

function run(n, iter) {
  const links = n - 1, rest = length / links;
  const cl = Object.create(Cloth.prototype);
  cl.cols = n;
  cl.pos = new Float64Array(n * 3);
  cl.prev = new Float64Array(n * 3);
  cl.w = new Float64Array(n);
  cl.ci = new Int32Array(links);
  cl.cj = new Int32Array(links);
  cl.ck = new Float64Array(links);
  cl.rest = new Float64Array(links);
  cl.board = () => {};
  for (let i = 0; i < n; i++) {
    cl.pos[3 * i] = chord * i / links;
    cl.w[i] = i === 0 || i === links ? 0 : 1;
    if (i < links) {
      cl.ci[i] = i; cl.cj[i] = i + 1; cl.ck[i] = 1; cl.rest[i] = rest;
    }
  }
  cl.prev.set(cl.pos);
  const h = 1 / hz, damp = Math.exp(-6 * h);
  let tailMotion = 0;
  const start = performance.now();
  for (let k = 0; k < seconds * hz; k++) {
    const oldMid = cl.pos[3 * (links / 2) + 1];
    for (let i = 1; i < links; i++) {
      for (let d = 0; d < 3; d++) {
        const j = 3 * i + d, old = cl.pos[j];
        cl.pos[j] += (cl.pos[j] - cl.prev[j]) * damp - (d === 1 ? gravity * h * h : 0);
        cl.prev[j] = old;
      }
    }
    for (let j = 0; j < iter; j++) cl.sweep(null, links);
    if (k >= (seconds - 1) * hz)
      tailMotion = Math.max(tailMotion, Math.abs(cl.pos[3 * (links / 2) + 1] - oldMid));
  }
  let arc = 0;
  for (let i = 0; i < links; i++) {
    const u = i * 3, v = (i + 1) * 3;
    arc += Math.hypot(cl.pos[v] - cl.pos[u], cl.pos[v + 1] - cl.pos[u + 1]);
  }
  const sag = -cl.pos[3 * (links / 2) + 1];
  return { sag, error: (sag / exact - 1) * 100, arc: arc / length,
    tailMotion, msStep: (performance.now() - start) / (seconds * hz) };
}

console.log(`Катенария: хорда ${chord} м, материал ${length} м, точный прогиб ${exact.toFixed(6)} м; ${hz} Гц, ${seconds} с`);
console.log('узлов | проходов | прогиб м | ошибка от катенарии % | дуга/материал % | движение за последний шаг мм | мс/шаг');
for (const n of cols) for (const iter of passes) {
  const x = run(n, iter);
  console.log(`${n} | ${iter} | ${x.sag.toFixed(6)} | ${x.error.toFixed(2)} | ${(100 * x.arc).toFixed(3)} | ${(1000 * x.tailMotion).toFixed(4)} | ${x.msStep.toFixed(3)}`);
}
