// Изолированный свидетель самого проектора Cloth.sweep(): тяжёлая
// нерастяжимая нить между опорами против независимой катенарии.
// Никаких аэродинамики, швов, дощечки и длинных поводков здесь нет.
// node tests/cloth-chain-convergence.mjs
import { Cloth } from '../sim/cloth.js';

const opt = (name, fallback) => process.argv.find(s => s.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const chord = 1, length = Number(opt('length', '1.1'));
const gravity = Number(opt('gravity', '9.81'));
const hz = Number(opt('hz', '60'));
const seconds = Number(opt('seconds', '20'));
const cols = opt('cols', '9,17,33,65').split(',').map(Number);
const passes = opt('passes', '40,160').split(',').map(Number);
const solver = opt('solver', 'sweep');
const velocity = opt('velocity', 'off');
const rho = Number(opt('rho', '1'));
const requireConverged = process.argv.includes('--require-converged');
if (![30, 60, 120].includes(hz) || !(seconds > 0 && seconds <= 60) ||
    !(length > chord && length <= 2 * chord) || !(gravity > 0 && gravity <= 20) ||
    cols.some(n => !Number.isInteger(n) || n < 3 || n % 2 !== 1 || n > 129) ||
    passes.some(n => !Number.isInteger(n) || n < 1 || n > 8192) ||
    !['sweep', 'global', 'admm'].includes(solver) ||
    !['off', 'tangent', 'zero'].includes(velocity) || !(rho > 0 && rho <= 1e4) ||
    (requireConverged && solver !== 'admm'))
  throw new Error('Неверные параметры изолированного стенда');
const ratio = length / chord;
let lo = 1e-9, hi = 5;
for (let i = 0; i < 80; i++) {
  const z = (lo + hi) / 2;
  if (Math.sinh(z) / z < ratio) lo = z; else hi = z;
}
const z = (lo + hi) / 2, a = chord / (2 * z);
const exact = a * (Math.cosh(z) - 1);

// Опытный глобальный проектор только для НИТИ: линеаризованные ограничения
// длины решаются совместно как трёхдиагональная система. Это не замена
// двумерному решателю ткани и не физический коэффициент материала.
function globalSweep(cl, links) {
  const p = cl.pos, w = cl.w, rest = cl.rest;
  const ux = new Float64Array(links), uy = new Float64Array(links);
  const c = new Float64Array(links), active = new Uint8Array(links);
  const diag = new Float64Array(links), upper = new Float64Array(links);
  const lower = new Float64Array(links), rhs = new Float64Array(links);
  const lambda = new Float64Array(links);
  let count = 0, before = 0;
  for (let k = 0; k < links; k++) {
    const i = 3 * k, dx = p[i + 3] - p[i], dy = p[i + 4] - p[i + 1];
    const d = Math.hypot(dx, dy);
    if (d > rest[k] + 1e-12) {
      ux[k] = dx / d; uy[k] = dy / d;
      c[k] = d - rest[k]; active[k] = 1; count++;
      before += c[k] * c[k];
    }
  }
  if (!count) return;
  // Неравенство: отрицательный множитель удаляется из активного набора.
  for (let retry = 0; retry < links && count; retry++) {
    for (let k = 0; k < links; k++) {
      diag[k] = active[k] ? w[k] + w[k + 1] : 1;
      rhs[k] = active[k] ? c[k] : 0;
      upper[k] = active[k] && active[k + 1]
        ? -w[k + 1] * (ux[k] * ux[k + 1] + uy[k] * uy[k + 1]) : 0;
      lower[k] = k && active[k] && active[k - 1]
        ? -w[k] * (ux[k] * ux[k - 1] + uy[k] * uy[k - 1]) : 0;
    }
    for (let k = 1; k < links; k++) {
      if (!(diag[k - 1] > 1e-12)) throw new Error('Вырожденная глобальная система нити');
      const f = lower[k] / diag[k - 1];
      diag[k] -= f * upper[k - 1];
      rhs[k] -= f * rhs[k - 1];
    }
    if (!(diag[links - 1] > 1e-12)) throw new Error('Вырожденная глобальная система нити');
    lambda[links - 1] = rhs[links - 1] / diag[links - 1];
    for (let k = links - 2; k >= 0; k--)
      lambda[k] = (rhs[k] - upper[k] * lambda[k + 1]) / diag[k];
    let dropped = false;
    for (let k = 0; k < links; k++) if (active[k] && lambda[k] < 0) {
      active[k] = 0; count--; dropped = true;
    }
    if (!dropped) break;
  }
  const dx = new Float64Array(links + 1), dy = new Float64Array(links + 1);
  for (let k = 1; k < links; k++) {
    dx[k] = w[k] * (lambda[k] * ux[k] - lambda[k - 1] * ux[k - 1]);
    dy[k] = w[k] * (lambda[k] * uy[k] - lambda[k - 1] * uy[k - 1]);
  }
  for (let scale = 1, tries = 0; tries < 20; tries++, scale *= 0.5) {
    let after = 0;
    for (let k = 0; k < links; k++) {
      const i = 3 * k;
      const d = Math.hypot(p[i + 3] + scale * dx[k + 1] - p[i] - scale * dx[k],
        p[i + 4] + scale * dy[k + 1] - p[i + 1] - scale * dy[k]);
      const excess = Math.max(0, d - rest[k]);
      after += excess * excess;
    }
    if (after < before) {
      for (let k = 1; k < links; k++) {
        p[3 * k] += scale * dx[k];
        p[3 * k + 1] += scale * dy[k];
      }
      break;
    }
  }
}

// Опытное устранение нормальной скорости натянутых связей после проекции
// координат. Реакция связей ищется совместно; касательная скорость сохранена.
function tangentVelocity(cl, links, h) {
  const p = cl.pos, prev = cl.prev, w = cl.w, rest = cl.rest;
  const ux = new Float64Array(links), uy = new Float64Array(links);
  const active = new Uint8Array(links), diag = new Float64Array(links);
  const upper = new Float64Array(links), lower = new Float64Array(links);
  const rhs = new Float64Array(links), impulse = new Float64Array(links);
  const vx = new Float64Array(links + 1), vy = new Float64Array(links + 1);
  for (let i = 0; i <= links; i++) {
    vx[i] = (p[3 * i] - prev[3 * i]) / h;
    vy[i] = (p[3 * i + 1] - prev[3 * i + 1]) / h;
  }
  for (let k = 0; k < links; k++) {
    const i = 3 * k, dx = p[i + 3] - p[i], dy = p[i + 4] - p[i + 1];
    const d = Math.hypot(dx, dy);
    if (d >= rest[k] * (1 - 1e-8)) {
      active[k] = 1; ux[k] = dx / d; uy[k] = dy / d;
      rhs[k] = (vx[k + 1] - vx[k]) * ux[k] +
        (vy[k + 1] - vy[k]) * uy[k];
    }
  }
  for (let k = 0; k < links; k++) {
    diag[k] = active[k] ? w[k] + w[k + 1] : 1;
    upper[k] = active[k] && active[k + 1]
      ? -w[k + 1] * (ux[k] * ux[k + 1] + uy[k] * uy[k + 1]) : 0;
    lower[k] = k && active[k] && active[k - 1]
      ? -w[k] * (ux[k] * ux[k - 1] + uy[k] * uy[k - 1]) : 0;
  }
  for (let k = 1; k < links; k++) {
    if (!(diag[k - 1] > 1e-12)) throw new Error('Вырожденная система скоростей нити');
    const f = lower[k] / diag[k - 1];
    diag[k] -= f * upper[k - 1];
    rhs[k] -= f * rhs[k - 1];
  }
  if (!(diag[links - 1] > 1e-12)) throw new Error('Вырожденная система скоростей нити');
  impulse[links - 1] = rhs[links - 1] / diag[links - 1];
  for (let k = links - 2; k >= 0; k--)
    impulse[k] = (rhs[k] - upper[k] * impulse[k + 1]) / diag[k];
  for (let k = 1; k < links; k++) {
    vx[k] += w[k] * (impulse[k] * ux[k] - impulse[k - 1] * ux[k - 1]);
    vy[k] += w[k] * (impulse[k] * uy[k] - impulse[k - 1] * uy[k - 1]);
    prev[3 * k] = p[3 * k] - h * vx[k];
    prev[3 * k + 1] = p[3 * k + 1] - h * vy[k];
  }
}

// Выпуклая проекция нити: min |x − target|²/2 при |x[k+1]−x[k]| ≤ rest.
// ADMM-звено z=B*x проектируется на круг радиуса rest; x-шаг решается
// трёхдиагонально. rho задаёт скорость итераций, а не конечную физику.
function admmProject(cl, links, maxIter, state) {
  const p = cl.pos, rest = cl.rest, m = links - 1;
  const target = p.slice(), z = state.z, u = state.u;
  const rhs = new Float64Array(m), cp = new Float64Array(m);
  const dp = new Float64Array(m), q = new Float64Array(links);
  let used = 0, primal = Infinity, dual = Infinity;
  for (let it = 0; it < maxIter; it++) {
    used++;
    for (let d = 0; d < 2; d++) {
      for (let k = 0; k < links; k++) q[k] = z[2 * k + d] - u[2 * k + d];
      for (let j = 0; j < m; j++) {
        const i = j + 1;
        rhs[j] = target[3 * i + d] + rho * (q[i - 1] - q[i]);
        if (j === 0) rhs[j] += rho * target[d];
        if (j === m - 1) rhs[j] += rho * target[3 * links + d];
        const denom = 1 + 2 * rho + (j ? rho * cp[j - 1] : 0);
        cp[j] = j === m - 1 ? 0 : -rho / denom;
        dp[j] = (rhs[j] + (j ? rho * dp[j - 1] : 0)) / denom;
      }
      p[3 * m + d] = dp[m - 1];
      for (let j = m - 2; j >= 0; j--)
        p[3 * (j + 1) + d] = dp[j] - cp[j] * p[3 * (j + 2) + d];
    }
    primal = 0; dual = 0;
    for (let k = 0; k < links; k++) {
      const i = 3 * k, v = 2 * k;
      const bx = p[i + 3] - p[i], by = p[i + 4] - p[i + 1];
      const tx = bx + u[v], ty = by + u[v + 1];
      const norm = Math.hypot(tx, ty), scale = Math.min(1, rest[k] / norm);
      const zx = tx * scale, zy = ty * scale;
      primal = Math.max(primal, Math.hypot(bx - zx, by - zy));
      dual = Math.max(dual, rho * Math.hypot(zx - z[v], zy - z[v + 1]));
      z[v] = zx; z[v + 1] = zy;
      u[v] += bx - zx; u[v + 1] += by - zy;
    }
    if (primal < 1e-8 && dual < 1e-8) break;
  }
  state.iterSum += used;
  state.maxUsed = Math.max(state.maxUsed, used);
  state.maxPrimal = Math.max(state.maxPrimal, primal);
  state.maxDual = Math.max(state.maxDual, dual);
  if (primal >= 1e-8 || dual >= 1e-8) state.capHits++;
}

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
  const admm = { z: new Float64Array(2 * links), u: new Float64Array(2 * links),
    iterSum: 0, maxUsed: 0, maxPrimal: 0, maxDual: 0, capHits: 0 };
  for (let k = 0; k < links; k++) admm.z[2 * k] = chord / links;
  const h = 1 / hz, damp = Math.exp(-6 * h);
  let tailMotion = 0, tailLo = Infinity, tailHi = -Infinity;
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
    if (solver === 'admm') admmProject(cl, links, iter, admm);
    else for (let j = 0; j < iter; j++) {
      if (solver === 'sweep') cl.sweep(null, links);
      else globalSweep(cl, links);
    }
    if (velocity === 'tangent') tangentVelocity(cl, links, h);
    if (velocity === 'zero') cl.prev.set(cl.pos);
    if (k >= (seconds - 1) * hz) {
      tailMotion = Math.max(tailMotion, Math.abs(cl.pos[3 * (links / 2) + 1] - oldMid));
      const y = cl.pos[3 * (links / 2) + 1];
      tailLo = Math.min(tailLo, y); tailHi = Math.max(tailHi, y);
    }
  }
  let arc = 0, maxStretch = 0;
  for (let i = 0; i < links; i++) {
    const u = i * 3, v = (i + 1) * 3;
    const d = Math.hypot(cl.pos[v] - cl.pos[u], cl.pos[v + 1] - cl.pos[u + 1]);
    arc += d;
    maxStretch = Math.max(maxStretch, d / rest - 1);
  }
  const sag = -cl.pos[3 * (links / 2) + 1];
  return { sag, error: (sag / exact - 1) * 100, arc: arc / length,
    maxStretch, tailMotion, tailSpan: tailHi - tailLo,
    avgIter: solver === 'admm' ? admm.iterSum / (seconds * hz) : iter,
    capHits: admm.capHits, maxUsed: admm.maxUsed,
    maxPrimal: admm.maxPrimal, maxDual: admm.maxDual,
    msStep: (performance.now() - start) / (seconds * hz) };
}

console.log(`Катенария: хорда ${chord} м, материал ${length} м, точный прогиб ${exact.toFixed(6)} м; ${hz} Гц, ${seconds} с; проектор ${solver}; скорость ${velocity}; rho ${rho}`);
console.log('узлов | лимит / сред. проходов | прогиб м | ошибка от катенарии % | дуга/материал % | max ребро % | ход/размах за последнюю секунду мм | мс/шаг | лимитных шагов / max остаток');
let failed = false;
for (const n of cols) for (const iter of passes) {
  const x = run(n, iter);
  const residual = solver === 'admm'
    ? `${x.capHits}/${seconds * hz} / ${Math.max(x.maxPrimal, x.maxDual).toExponential(1)}` : '—';
  console.log(`${n} | ${iter} / ${x.avgIter.toFixed(1)} | ${x.sag.toFixed(6)} | ${x.error.toFixed(2)} | ${(100 * x.arc).toFixed(3)} | ${(100 * x.maxStretch).toFixed(3)} | ${(1000 * x.tailMotion).toFixed(4)} / ${(1000 * x.tailSpan).toFixed(4)} | ${x.msStep.toFixed(3)} | ${residual}`);
  if (requireConverged && x.capHits) failed = true;
}
if (failed) process.exitCode = 1;
