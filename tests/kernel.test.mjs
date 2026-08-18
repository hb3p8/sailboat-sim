// Сверка кернела Био — Савара: node tests/kernel.test.mjs
//
// Проверяется НЕ близость, а РАВЕНСТВО. Это не придирка и не роскошь: кернел
// вектеризован по точкам, порядок сложения по рёбрам для каждого выходного
// числа тот же, что в JS, — значит совпасть обязано до последнего разряда, и
// всякое расхождение означает ошибку, а не «другую арифметику».
//
// Порог «в пределах допуска» здесь был бы вреден: он спрятал бы ровно те
// ошибки, ради которых сверка и заводится, — перепутанный порядок умножений,
// слияние в FMA, переассоциацию сложения.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
};

const EPS = 1e-10;
const FOURPI = 4 * Math.PI;

// Образец — выписан из `FreeWake.field` (sim/vlm.js), цикл по рёбрам без
// хвостов. Держится здесь копией нарочно: сверять кернел с тем же кодом, из
// которого его портировали, — единственный способ поймать расхождение, а не
// унаследовать его.
function fieldJS(e, ne, qx, qy, qz, np, ox, oy, oz) {
  for (let j = 0; j < np; j++) { ox[j] = 0; oy[j] = 0; oz[j] = 0; }
  for (let m = 0, k8 = 0; m < ne; m++, k8 += 8) {
    const ax = e[k8], ay = e[k8 + 1], az = e[k8 + 2];
    const r0x = e[k8 + 3], r0y = e[k8 + 4], r0z = e[k8 + 5];
    const g = e[k8 + 6], den = e[k8 + 7];
    for (let j = 0; j < np; j++) {
      const r1x = qx[j] - ax, r1y = qy[j] - ay, r1z = qz[j] - az;
      const r2x = r1x - r0x, r2y = r1y - r0y, r2z = r1z - r0z;
      const cx = r1y * r2z - r1z * r2y;
      const cy = r1z * r2x - r1x * r2z;
      const cz = r1x * r2y - r1y * r2x;
      const c2 = cx * cx + cy * cy + cz * cz;
      if (c2 < EPS) continue;
      const l1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
      const l2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
      if (l1 < EPS || l2 < EPS) continue;
      const fq = (r0x * r1x + r0y * r1y + r0z * r1z) / l1 -
                 (r0x * r2x + r0y * r2y + r0z * r2z) / l2;
      const kk = fq / (FOURPI * Math.max(c2, den));
      ox[j] += g * (cx * kk); oy[j] += g * (cy * kk); oz[j] += g * (cz * kk);
    }
  }
}

// Данные без Math.random: сверка обязана воспроизводиться, иначе разошедшийся
// случай нельзя будет предъявить.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Пелена как она есть: нити висят полосой за кормой, свёрнуты, кое-где узлы
// сходятся вплотную — именно там ограничитель по ядру и работает, и именно там
// расхождение вылезло бы первым.
function makeCase(ne, np, seed) {
  const rnd = lcg(seed);
  const e = new Float64Array(ne * 8);
  for (let m = 0, k = 0; m < ne; m++, k += 8) {
    e[k]     = -2 - rnd() * 30;
    e[k + 1] = (rnd() - 0.5) * 8;
    e[k + 2] = rnd() * 9;
    e[k + 3] = (rnd() - 0.5) * 0.6;
    e[k + 4] = (rnd() - 0.5) * 0.6;
    e[k + 5] = (rnd() - 0.5) * 0.6;
    e[k + 6] = (rnd() - 0.5) * 40;        // сила ребра
    e[k + 7] = 1e-4 + rnd() * 0.05;       // знаменатель ограничителя
  }
  const qx = new Float64Array(np), qy = new Float64Array(np), qz = new Float64Array(np);
  for (let j = 0; j < np; j++) {
    qx[j] = -2 - rnd() * 30; qy[j] = (rnd() - 0.5) * 8; qz[j] = rnd() * 9;
  }
  // Две точки сажаются ТОЧНО на начала рёбер: там c2 обращается в ноль и
  // срабатывает отбраковка. Без этого маска в векторной версии осталась бы
  // непроверенной, а она — единственное место, где ветвление заменено.
  if (np > 4) {
    qx[1] = e[0]; qy[1] = e[1]; qz[1] = e[2];
    qx[2] = e[8]; qy[2] = e[9]; qz[2] = e[10];
  }
  return { e, qx, qy, qz };
}

// --- wasm ----------------------------------------------------------------------

const bytes = readFileSync(join(ROOT, 'kernel/biot.wasm'));
const mod = new WebAssembly.Module(bytes);
const inst = new WebAssembly.Instance(mod, {});
const X = inst.exports;
const mem = () => new Float64Array(X.memory.buffer);

function wasmRunner(ne, np) {
  const pe = X.alloc(ne * 8 * 8);
  const pqx = X.alloc(np * 8), pqy = X.alloc(np * 8), pqz = X.alloc(np * 8);
  const pox = X.alloc(np * 8), poy = X.alloc(np * 8), poz = X.alloc(np * 8);
  const off = (p) => p / 8;
  return {
    run(e, qx, qy, qz, ox, oy, oz) {
      const M = mem();
      M.set(e, off(pe)); M.set(qx, off(pqx)); M.set(qy, off(pqy)); M.set(qz, off(pqz));
      X.field_edges(pe, ne, pqx, pqy, pqz, np, pox, poy, poz);
      const M2 = mem();
      ox.set(M2.subarray(off(pox), off(pox) + np));
      oy.set(M2.subarray(off(poy), off(poy) + np));
      oz.set(M2.subarray(off(poz), off(poz) + np));
    },
  };
}

// --- сверка ---------------------------------------------------------------------

console.log('\nПобитовая сверка (равенство, не близость):\n');

const SIZES = [[2000, 560], [2001, 561], [7, 3], [1, 2]];
let worst = 0, worstAt = '';
for (const [ne, np] of SIZES) {
  const { e, qx, qy, qz } = makeCase(ne, np, 12345 + ne + np);
  const a = [new Float64Array(np), new Float64Array(np), new Float64Array(np)];
  const b = [new Float64Array(np), new Float64Array(np), new Float64Array(np)];
  fieldJS(e, ne, qx, qy, qz, np, a[0], a[1], a[2]);
  wasmRunner(ne, np).run(e, qx, qy, qz, b[0], b[1], b[2]);

  let bad = 0, first = '';
  for (let c = 0; c < 3; c++) {
    for (let j = 0; j < np; j++) {
      if (!Object.is(a[c][j], b[c][j])) {
        bad++;
        const d = Math.abs(a[c][j] - b[c][j]) / Math.max(1e-300, Math.abs(a[c][j]));
        if (d > worst) { worst = d; worstAt = `ne=${ne} np=${np}`; }
        if (!first) first = `компонента ${c}, точка ${j}: ${a[c][j]} против ${b[c][j]}`;
      }
    }
  }
  check(`ne=${String(ne).padStart(4)}  np=${String(np).padStart(3)}`,
        bad === 0, bad === 0 ? 'все ' + (np * 3) + ' чисел совпали' : bad + ' расхождений — ' + first);
}
if (worst > 0) console.log('\n  худшее относительное расхождение: ' + worst.toExponential(3) + ' при ' + worstAt);

// --- цена -----------------------------------------------------------------------

console.log('\nЦена на рабочем размере (2000 рёбер × 560 точек):\n');
{
  const ne = 2000, np = 560;
  const { e, qx, qy, qz } = makeCase(ne, np, 999);
  const o = [new Float64Array(np), new Float64Array(np), new Float64Array(np)];
  const w = wasmRunner(ne, np);
  const bench = (fn, n) => {
    fn(); fn();                                  // прогрев JIT
    const t = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn();
    return Number(process.hrtime.bigint() - t) / 1e6 / n;
  };
  const tJS = bench(() => fieldJS(e, ne, qx, qy, qz, np, o[0], o[1], o[2]), 20);
  const tW  = bench(() => w.run(e, qx, qy, qz, o[0], o[1], o[2]), 20);
  console.log('    JS    %s мс', tJS.toFixed(2).padStart(6));
  console.log('    wasm  %s мс   ускорение %s×', tW.toFixed(2).padStart(6), (tJS / tW).toFixed(2));
  check('wasm не медленнее JS', tW < tJS, (tJS / tW).toFixed(2) + '×');
}

// --- где сверяется решётка ------------------------------------------------------
//
// У кернела решётки (`kernel/lattice.c`) свидетель СВОЙ и лежит в другом месте —
// `tests/vlm.test.mjs` сверяет собранную матрицу влияния с поточечным
// `Lattice.induced`, который считает то же поле совсем другим кодом и в другом
// порядке. Согласие там 5.2e-18, и проверяется оно каждый прогон.
//
// Второй копии здесь заводить не стали НАРОЧНО. Дубликат, который сверяют, —
// свидетель; дубликат, который не сверяют, — обуза, и разойдётся он молча.
// Свидетель у решётки уже есть, и он независимее любого, который написали бы
// тут: `induced` не переписан с кернела, а существовал до него.

console.log('\nЦена шага физики целиком:\n');
{
  const probe = `
    import { readFileSync } from 'node:fs';
    import { Boat } from '${join(ROOT, 'sim/physics.js')}';
    const PACK = JSON.parse(readFileSync('${join(ROOT, 'out/export/physics.json')}', 'utf8'));
    const D = Math.PI / 180;
    const out = {};
    for (const [twa, gen] of [[45, false], [120, true], [140, false]]) {
      const b = new Boat(PACK);
      if (gen) b.setGennaker(true);
      b.o.windSpeed = 6; b.o.windDir = 100 * D; b.psi = 100 * D - twa * D;
      b.o.sheet = 70 * D; b.o.draft = 1; b.o.twist = 8 * D;
      b.o.crewHike = -1; b.o.crewMass = 219.9; b.u = 4;
      for (let i = 0; i < 100; i++) b.step(1 / 30);
      const t = process.hrtime.bigint();
      for (let i = 0; i < 500; i++) b.step(1 / 30);
      out[twa + '/' + gen] = Number(process.hrtime.bigint() - t) / 1e6 / 500;
    }
    console.log(JSON.stringify(out));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe],
                           { encoding: 'utf8' }).trim().split('\n');
  const ms = JSON.parse(out[out.length - 1]);
  for (const k of Object.keys(ms)) console.log('    %s %s мс', k.padEnd(12), ms[k].toFixed(2).padStart(7));
  // Порог грубый и стоит затем, чтобы заметить обвал, а не чтобы ловить проценты:
  // цена шага зависит от машины, а батарея гоняется на разных.
  check('шаг физики укладывается в бюджет кадра с запасом',
        Math.max(...Object.values(ms)) < 8,
        'худший ' + Math.max(...Object.values(ms)).toFixed(2) + ' мс при 33 мс кадра');
}

console.log('\n' + (failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
