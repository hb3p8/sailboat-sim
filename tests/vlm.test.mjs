// Вихревая решётка против теории: node tests/vlm.test.mjs
//
// Решатель проверяется не на лодке, а на плоском прямоугольном крыле, где
// ответ известен из теории несущей линии:
//
//   наклон кривой подъёмной силы   CLα = a0 / (1 + a0/(π·Λ·e)),  a0 = 2π
//   индуктивное сопротивление      CDi = CL² / (π·Λ·e)
//
// Это единственный способ поверить такую вещь. На лодке «похоже на правду»
// ничего не значит: скос потока — величина, которую не с чем сравнить на глаз,
// а ошибка в знаке или в множителе 4π выглядит как просто другая поляра.

import { Lattice } from '../sim/vlm.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

// Плоское крыло: размах по Y, поток по X, нормаль вверх. Присоединённый вихрь
// на четверти хорды, контрольная точка там же, на несущей линии — это метод
// Прандтля, а не Вайссингера.
function wing(AR, alpha, n, chordLen) {
  const c = chordLen == null ? 1 : chordLen;
  const span = AR * c;
  const lat = new Lattice(n);
  for (let i = 0; i < n; i++) {
    const y0 = -span / 2 + span * i / n;
    const y1 = -span / 2 + span * (i + 1) / n;
    const p = lat.panels[i];
    p.a[0] = 0.25 * c; p.a[1] = y0; p.a[2] = 0;
    p.b[0] = 0.25 * c; p.b[1] = y1; p.b[2] = 0;
    p.ta[0] = c; p.ta[1] = y0; p.ta[2] = 0;
    p.tb[0] = c; p.tb[1] = y1; p.tb[2] = 0;
    p.c[0] = 0.25 * c; p.c[1] = (y0 + y1) / 2; p.c[2] = 0;
    p.nrm[0] = 0; p.nrm[1] = 0; p.nrm[2] = 1;
    p.chord = c; p.speed = 1;
  }
  lat.build(1, 0, 0);
  const geom = new Array(n).fill(alpha);
  const ai = lat.solve(geom, a => 2 * Math.PI * a, 4);
  // Подъёмная сила по Жуковскому, индуктивное — подъёмная, наклонённая скосом.
  let L = 0, Di = 0;
  for (let i = 0; i < n; i++) {
    const dy = Math.abs(lat.panels[i].b[1] - lat.panels[i].a[1]);
    const dL = lat.gamma[i] * dy;              // ρ·V = 1
    L += dL;
    Di += dL * Math.sin(ai[i]);
  }
  const S = span * c;
  return { CL: L / (0.5 * S), CDi: Di / (0.5 * S), ai: ai.slice(), lat };
}

const D = Math.PI / 180;

console.log('\nПлоское прямоугольное крыло, угол атаки 5°:\n');
console.log('   Λ    панелей    CLα расчёт   CLα теория   откл.    CDi расчёт   CDi теория');
const rows = [];
for (const AR of [4, 6, 10, 20]) {
  const a = 5 * D;
  const r = wing(AR, a, 24);
  const slope = r.CL / a;
  const theory = 2 * Math.PI / (1 + 2 / AR);          // эллиптическое, e = 1
  const cdiTheory = r.CL * r.CL / (Math.PI * AR);
  rows.push({ AR, slope, theory, CDi: r.CDi, cdiTheory });
  console.log('  ' + String(AR).padStart(3) + '        24 ' +
    slope.toFixed(3).padStart(13) + theory.toFixed(3).padStart(13) +
    ((slope / theory - 1) * 100).toFixed(1).padStart(8) + '%' +
    r.CDi.toFixed(5).padStart(14) + cdiTheory.toFixed(5).padStart(13));
}
console.log('');

// Прямоугольное крыло даёт чуть меньше эллиптического — у него коэффициент
// Освальда около 0.95, — поэтому допуск односторонний и не слишком узкий.
check('наклон кривой подъёмной силы согласуется с теорией несущей линии',
  rows.every(r => r.slope < r.theory * 1.02 && r.slope > r.theory * 0.90),
  'худшее отклонение ' +
  Math.max(...rows.map(r => Math.abs(r.slope / r.theory - 1) * 100)).toFixed(1) + '%');
check('наклон растёт с удлинением и стремится к 2π',
  rows.every((r, i) => i === 0 || r.slope > rows[i - 1].slope) &&
  rows[rows.length - 1].slope < 2 * Math.PI,
  rows[0].slope.toFixed(2) + ' → ' + rows[rows.length - 1].slope.toFixed(2) +
  ' при 2π = ' + (2 * Math.PI).toFixed(2));
check('индуктивное сопротивление согласуется с CL²/(πΛ)',
  rows.every(r => r.CDi > r.cdiTheory * 0.9 && r.CDi < r.cdiTheory * 1.35),
  'худшее отношение ' +
  Math.max(...rows.map(r => r.CDi / r.cdiTheory)).toFixed(2));

// Индуктивное сопротивление обязано расти как квадрат подъёмной силы.
{
  const a = wing(6, 3 * D, 24), b = wing(6, 6 * D, 24);
  const ratio = b.CDi / a.CDi, expect = (b.CL / a.CL) ** 2;
  console.log('При удвоении угла атаки CDi растёт в ' + ratio.toFixed(2) +
    ' раза, CL² — в ' + expect.toFixed(2) + '\n');
  check('индуктивное сопротивление квадратично по подъёмной силе',
    Math.abs(ratio / expect - 1) < 0.05, (ratio / expect).toFixed(3));
}

// Скос максимален на концах — это и есть картина сходящей пелены.
{
  const r = wing(6, 5 * D, 24);
  const mid = r.ai[12], tip = r.ai[0];
  console.log('Скос потока: в середине ' + (mid / D).toFixed(2) +
    '°, на конце ' + (tip / D).toFixed(2) + '°\n');
  check('скос на конце больше, чем в середине', tip > mid * 1.2,
    (tip / mid).toFixed(2) + ' раза');
  check('скос везде положительный (поток поджимает)', r.ai.every(v => v > 0));

  // Отдельная матрица скоса от пелены — та, по которой наклоняется подъёмная
  // сила и получается индуктивное сопротивление. На прямой несущей линии она
  // обязана совпасть с полным скосом: связанные отрезки соседей лежат на той
  // же прямой и в её точках ничего не наводят. Если разойдётся — значит в
  // матрицу попал лишний отрезок или потерялся нужный.
  const w = r.lat.wakeAngles();
  const off = Math.max(...r.ai.map((v, i) => Math.abs(v - w[i])));
  console.log('Скос от пелены против полного скоса: расхождение ' +
    off.toExponential(1) + ' рад\n');
  check('на прямой несущей линии скос от пелены равен полному', off < 1e-12,
    off.toExponential(1) + ' рад');
}

// Сходимость по числу панелей: ответ не должен зависеть от разбивки.
{
  const s = [8, 16, 32, 64].map(n => wing(6, 5 * D, n).CL);
  console.log('CL при 8/16/32/64 панелях: ' + s.map(v => v.toFixed(4)).join(', ') + '\n');
  check('ответ сходится по числу панелей',
    Math.abs(s[3] - s[2]) < 0.01 * Math.abs(s[3]),
    'разница между 32 и 64: ' +
    (Math.abs(s[3] - s[2]) / Math.abs(s[3]) * 100).toFixed(2) + '%');
}

// Два крыла наводят друг на друга скос — это и есть щелевой эффект.
{
  const pair = (dx, dy) => {
    const n = 12, AR = 6, c = 1, span = AR * c;
    const lat = new Lattice(2 * n);
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < n; i++) {
        const y0 = -span / 2 + span * i / n + w * dy;
        const y1 = -span / 2 + span * (i + 1) / n + w * dy;
        const p = lat.panels[w * n + i];
        p.a[0] = 0.25 * c + w * dx; p.a[1] = y0; p.a[2] = 0;
        p.b[0] = 0.25 * c + w * dx; p.b[1] = y1; p.b[2] = 0;
        p.c[0] = 0.25 * c + w * dx; p.c[1] = (y0 + y1) / 2; p.c[2] = 0;
        p.ta[0] = c + w * dx; p.ta[1] = y0; p.ta[2] = 0;
        p.tb[0] = c + w * dx; p.tb[1] = y1; p.tb[2] = 0;
        p.nrm[2] = 1; p.chord = c; p.speed = 1;
      }
    }
    lat.build(1, 0, 0);
    lat.solve(new Array(2 * n).fill(5 * D), a => 2 * Math.PI * a, 4);
    let front = 0, back = 0;
    for (let i = 0; i < n; i++) { front += lat.gamma[i]; back += lat.gamma[n + i]; }
    return { front: front / n, back: back / n };
  };
  const alone = wing(6, 5 * D, 12);
  let g0 = 0;
  for (let i = 0; i < 12; i++) g0 += alone.lat.gamma[i];
  g0 /= 12;
  const near = pair(1.5, 0), far = pair(40, 0), side = pair(0, 40 * 6);
  console.log('Среднее Γ, одиночное крыло: ' + g0.toFixed(4));
  console.log('  друг за другом, 1.5 хорды: ' + near.front.toFixed(4) +
    ' / ' + near.back.toFixed(4));
  console.log('  друг за другом, 40 хорд:   ' + far.front.toFixed(4) +
    ' / ' + far.back.toFixed(4));
  console.log('  бок о бок, 40 размахов:    ' + side.front.toFixed(4) +
    ' / ' + side.back.toFixed(4) + '\n');

  check('заднее крыло попадает в скос переднего и теряет циркуляцию',
    near.back < near.front * 0.95,
    (near.back / near.front).toFixed(3) + ' от переднего');
  // Пелена уходит на бесконечность, поэтому заднее крыло сидит в ней на любом
  // удалении — это не ошибка, а картина сходящих вихрей. Локальность проверяется
  // по ПЕРЕДНЕМУ крылу: оно про заднее в сорока хордах знать уже не должно.
  check('дальнее заднее крыло всё равно в пелене переднего',
    far.back < far.front * 0.9,
    (far.back / far.front).toFixed(3));
  check('переднее крыло дальнего соседа не замечает',
    Math.abs(far.front / g0 - 1) < 0.02,
    (far.front / g0).toFixed(3) + ' от одиночного');
  check('переднее крыло близкого соседа замечает',
    Math.abs(near.front / g0 - 1) > 0.01,
    (near.front / g0).toFixed(3) + ' от одиночного');
  check('разнесённые вбок крылья друг друга не замечают',
    Math.abs(side.back / g0 - 1) < 0.02 && Math.abs(side.front / g0 - 1) < 0.02,
    (side.front / g0).toFixed(3) + ' и ' + (side.back / g0).toFixed(3));
}

console.log((failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
