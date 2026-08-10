// Свободная пелена: node tests/wake.test.mjs
//
// Первый шаг из трёх (docs/flow-plan.md, III.2.a): пелена строится, сносится и
// рисуется, но В СИЛЫ НЕ ВХОДИТ. Матрица влияния по-прежнему считает прямые
// лучи, сходящие с задней кромки вдоль потока.
//
// Отсюда и главная проверка здесь, и она же самая скучная: с включённой пеленой
// лодка обязана идти ТОЧНО так же, как без неё. Не «примерно», а до последнего
// разряда — иначе пелена уже во что-то вмешалась, и разбираться придётся не
// здесь, а через неделю на пересобранном эталоне.
//
// Остальное — свойства самой пелены: сходит с кромки, уносится по потоку,
// суммарная завихренность паруса равна нулю, сброс её чистит.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
};

function run(wake, steps, drive) {
  const b = new Boat(PACK);
  b.o.freeWake = wake;
  b.o.windSpeed = 8; b.o.windDir = 100 * D; b.psi = 55 * D;
  b.o.sheet = 14 * D; b.o.twist = 8 * D;
  b.o.crewHike = 1; b.o.crewMass = 219.9; b.u = 4;
  b.wind.o.gust = 0.2; b.wind.o.shift = 9 * D;
  for (let i = 0; i < steps; i++) {
    if (drive) drive(b, i / 30);
    b.step(1 / 30);
  }
  return b;
}

// --- пелена не трогает силы ----------------------------------------------------
console.log('\nЛодка с пеленой и без неё, 45 секунд с порывами и перекладкой руля:\n');
{
  const drive = (b, t) => { b.o.rudderTarget = 12 * D * Math.sin(t / 5); };
  const a = run(false, 45 * 30, drive), c = run(true, 45 * 30, drive);
  const F = ['x', 'y', 'psi', 'u', 'v', 'r', 'phi', 'p_', 'zc', 'w', 'th', 'q', 'hike'];
  let worst = 0, who = '';
  for (const k of F) {
    const d = Math.abs(a[k] - c[k]);
    if (d > worst) { worst = d; who = k; }
  }
  console.log('  ход  %s против %s уз', a.telemetry.speedKn.toFixed(9), c.telemetry.speedKn.toFixed(9));
  console.log('  крен %s против %s°', (a.phi / D).toFixed(9), (c.phi / D).toFixed(9));
  console.log('  наибольшее расхождение по состоянию: %s (%s)\n', worst.toExponential(1), who);
  check('пелена не меняет ни одного разряда в состоянии лодки', worst === 0,
    worst === 0 ? 'ровно ноль' : worst.toExponential(1) + ' по ' + who);
  check('и ни одного в показаниях',
    a.telemetry.driveN === c.telemetry.driveN && a.telemetry.sideN === c.telemetry.sideN,
    a.telemetry.driveN.toFixed(9) + ' против ' + c.telemetry.driveN.toFixed(9));
}

// --- свойства самой пелены -----------------------------------------------------
{
  const b = run(true, 20 * 30);
  const w = b.rig.wake;
  const L = w.len;
  console.log('Пелена: %d нитей по %d узлов, сошло %d\n', w.fil, w.len, w.n);
  check('пелена завелась и заполнилась', w && w.n === w.len, w ? String(w.n) : 'нет');

  // Узел тем дальше от кромки, чем он старше: пелена уносится, а не стоит.
  let mono = true, far = 0;
  for (let f = 0; f < w.fil; f++) {
    if (!w.g[f]) continue;
    const bi = f * L;
    let prev = -1;
    for (let i = 0; i < w.n; i++) {
      const dx = w.x[bi + i] - w.x[bi], dy = w.y[bi + i] - w.y[bi];
      const d = Math.hypot(dx, dy);
      if (d < prev - 1e-9) mono = false;
      prev = d; far = Math.max(far, d);
    }
  }
  check('узлы уходят от кромки монотонно с возрастом', mono);
  check('за три секунды пелена уходит на несколько длин лодки', far > 6 && far < 60,
    far.toFixed(1) + ' м');

  // Суммарная сходящая завихренность паруса равна нулю: сколько циркуляции
  // набралось к топу, столько и сошло. Это не подгонка, а тождество — если
  // нарушится, значит нити расставлены не по границам полосок.
  let sum = 0;
  for (let f = 0; f < w.fil; f++) sum += w.g[f];
  check('суммарная сила нитей равна нулю', Math.abs(sum) < 1e-9, sum.toExponential(1));

  // Пелена вся под ветром от паруса и вся ниже топа: если полезла на наветренную
  // сторону или вверх, значит снос считается не тем полем.
  let above = 0, zmin = 1e9;
  for (let f = 0; f < w.fil; f++) {
    for (let i = 0; i < w.n; i++) {
      above = Math.max(above, w.z[f * L + i]);
      zmin = Math.min(zmin, w.z[f * L + i]);
    }
  }
  check('пелена не поднимается выше топа', above < 11, above.toFixed(1) + ' м');
  check('и не уходит под воду', zmin > -0.5, zmin.toFixed(1) + ' м');
}

// --- выключение и сброс --------------------------------------------------------
{
  const b = run(true, 5 * 30);
  b.o.freeWake = false;
  b.step(1 / 30);
  check('выключенная пелена стирается', b.rig.wake.n === 0, String(b.rig.wake.n));
}

console.log(failures ? '\n' + failures + ' проверок провалено' : '\nвсе проверки прошли');
console.log('');
process.exit(failures ? 1 : 0);
