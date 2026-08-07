// Море: node tests/ocean.test.mjs
//
// Само поле волны считает видеокарта, и до него отсюда не дотянуться. Но
// проверять здесь нужно не поле, а ВЫБОР ПОЛОС — то единственное в ocean.js,
// что подобрано под конкретную воду и потому может разъехаться с ней молча.
//
// Каскадов три, у каждого своя полоса длин волн, и границы полос заданы
// размерами плиток. Если состояние моря, которое умеет выдать waves.js, уедет
// за края этих полос — волна не пропадёт и не сломается, она просто станет не
// той: основная волна уйдёт в каскад, который её не держит, и вместо волны
// будет рябь. В браузере это выглядит как «что-то не то с водой», и искать
// причину неделю.
//
// Отсюда и три проверки: полосы стыкуются без дыр, вся волна, какую даёт ветер
// с разгоном, попадает внутрь, и плитки не кратны друг другу.

import { seaState } from '../sim/waves.js';
import { oceanBand, oceanPlaneFit, OCEAN_TILES, OCEAN_N, OCEAN_LOOP } from '../sim/ocean.js';

const G = 9.80665;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

// Длина волны в пике по периоду пика: λ = g·T²/(2π).
const peakLength = tp => G * tp * tp / (2 * Math.PI);

// --- полосы каскадов ----------------------------------------------------------

console.log('\nКаскады (плитка, полоса длин волн, ячейка решётки):\n');
for (let i = 0; i < OCEAN_TILES.length; i++) {
  const tile = OCEAN_TILES[i];
  const lo = i + 1 < OCEAN_TILES.length ? OCEAN_TILES[i + 1] : 2 * tile / OCEAN_N;
  console.log('  ' + String(tile).padStart(6) + ' м   от ' + lo.toFixed(2).padStart(6) +
              ' до ' + tile.toFixed(1).padStart(6) + ' м   ' +
              (tile / OCEAN_N).toFixed(3) + ' м/узел');
}
console.log('');

check('плитки идут по убыванию',
  OCEAN_TILES.every((t, i) => i === 0 || t < OCEAN_TILES[i - 1]));

// Полосы обязаны стыковаться: верх каждой — низ предыдущей. Иначе в спектре
// либо дыра (полоса длин, которой нет ни в одном каскаде), либо нахлёст (волна
// посчитана дважды и оттого вдвое выше). Границы берутся у самого ocean.js —
// у той же функции, по которой строится спектр.
const bands = OCEAN_TILES.map((_, i) => oceanBand(i));
check('полосы стыкуются без дыр и нахлёстов',
  bands.every((b, i) => i === 0 || Math.abs(b.kLo - bands[i - 1].kHi) < 1e-9),
  bands.map(b => b.kLo.toFixed(3) + '…' + b.kHi.toFixed(2)).join('  '));
check('у мелкого каскада верх не заходит за Найквист',
  bands[bands.length - 1].kHi < Math.PI * OCEAN_N / OCEAN_TILES[OCEAN_TILES.length - 1]);

// Самая короткая волна, которую вообще держит решётка мелкого каскада.
const finest = 2 * OCEAN_TILES[OCEAN_TILES.length - 1] / OCEAN_N;
check('мелкий каскад достаёт до ряби в единицы сантиметров',
  finest < 0.05, (100 * finest).toFixed(1) + ' см');

// --- вся волна, какую даёт ветер, укладывается в полосы ------------------------

console.log('Длина волны в пике по ветру и разгону (ползунки: ветер 1…16 м/с,');
console.log('разгон 0…12 км), и каскад, которому она достаётся:\n');

const spread = new Array(OCEAN_TILES.length).fill(0);
let worstLow = Infinity, worstHigh = 0, worstAt = '';
for (let u = 1; u <= 16; u += 0.5) {
  for (let f = 500; f <= 12000; f += 500) {
    const s = seaState(u, f);
    const lp = peakLength(s.tp);
    if (lp < worstLow) worstLow = lp;
    if (lp > worstHigh) { worstHigh = lp; worstAt = u + ' м/с, ' + (f / 1000) + ' км'; }
    // в какой каскад попадает пик
    let k = OCEAN_TILES.length - 1;
    for (let i = 0; i < OCEAN_TILES.length; i++) {
      const lo = i + 1 < OCEAN_TILES.length ? OCEAN_TILES[i + 1] : 0;
      if (lp <= OCEAN_TILES[i] && lp > lo) { k = i; break; }
    }
    spread[k]++;
  }
}
for (const [u, f] of [[3, 1000], [6, 3000], [9, 5000], [12, 8000], [16, 12000]]) {
  const s = seaState(u, f);
  const lp = peakLength(s.tp);
  const k = OCEAN_TILES.findIndex((t, i) =>
    lp <= t && lp > (i + 1 < OCEAN_TILES.length ? OCEAN_TILES[i + 1] : 0));
  console.log('  ' + String(u).padStart(4) + ' м/с ' + String(f / 1000).padStart(5) +
              ' км   hs ' + (100 * s.hs).toFixed(0).padStart(3) + ' см   λ ' +
              lp.toFixed(1).padStart(5) + ' м   → каскад ' +
              (k < 0 ? 'НИ ОДИН' : OCEAN_TILES[k] + ' м'));
}
console.log('');

check('самая длинная волна помещается в крупный каскад',
  worstHigh <= OCEAN_TILES[0],
  worstHigh.toFixed(1) + ' м при ' + worstAt + ', плитка ' + OCEAN_TILES[0] + ' м');
check('самая короткая волна не проваливается за решётку',
  worstLow > finest * 4, worstLow.toFixed(2) + ' м против ' + finest.toFixed(3) + ' м у решётки');
check('на крупный каскад приходится не вся вода и не ничего',
  spread[0] > 0 && spread[0] < spread.reduce((a, b) => a + b, 0),
  spread.join(' / ') + ' случаев по каскадам');
check('каждый каскад бывает основным хоть на каком-то ветре',
  spread.every(n => n > 0), spread.join(' / '));

// --- плитки не кратны друг другу ---------------------------------------------
//
// У кратных плиток совпадают швы, и вся вода начинает повторяться с периодом
// самой крупной. Проверяется отношение соседних: оно обязано быть подальше от
// целого.
console.log('');
for (let i = 1; i < OCEAN_TILES.length; i++) {
  const r = OCEAN_TILES[i - 1] / OCEAN_TILES[i];
  check('плитки ' + OCEAN_TILES[i - 1] + ' и ' + OCEAN_TILES[i] + ' не кратны',
    Math.abs(r - Math.round(r)) > 0.1, 'отношение ' + r.toFixed(2));
}

// --- зацикливание по времени --------------------------------------------------
//
// Частоты округляются до кратных 2π/OCEAN_LOOP — от этого море точно
// повторяется через OCEAN_LOOP секунд, а фаза не теряет точность на длинном
// счёте. Округление искажает частоту, и искажение не должно быть слышно: у
// самой длинной волны период не должен уехать больше чем на процент.
const dOmega = 2 * Math.PI / OCEAN_LOOP;
const wLongest = Math.sqrt(G * 2 * Math.PI / OCEAN_TILES[0]);
check('зацикливание не перевирает частоту длинной волны',
  dOmega / wLongest < 0.01,
  (100 * dOmega / wLongest).toFixed(2) + '% при периоде цикла ' + OCEAN_LOOP + ' с');
check('цикл длиннее любого разумного заезда',
  OCEAN_LOOP >= 300, OCEAN_LOOP + ' с');

// --- плоскость воды по пробам --------------------------------------------------
//
// Пять проб по корпусу превращаются в высоту и два наклона, по востоку и по
// северу. Проверяется здесь одно: НАКЛОНЫ В МИРЕ НЕ ЗАВИСЯТ ОТ КУРСА. Вода
// одна и та же, лодка на ней может стоять как угодно, и если поворот сделан с
// ошибкой в борте или в знаке, то на одних курсах лодка будет крениться
// правильно, а на других наоборот — то есть ошибка окажется тихой и найдётся
// не скоро.
//
// Ровно из этого семейства была ошибка, от которой лодку подбрасывало: проба
// отдавала нормаль поверхности вместо наклона, то есть наклон наизнанку.

console.log('\nПлоскость воды по пробам\n');
{
  const L = 5.47 / 2, B = 1.9 / 2;
  // Известная плоскость: поднята на 0.2 м и наклонена на 0.08 к востоку и
  // на −0.03 к северу.
  const Z0 = 0.2, SE = 0.08, SN = -0.03;
  const h = (dx, dy) => Z0 + SE * dx + SN * dy;
  let worst = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    const psi = deg * Math.PI / 180, c = Math.cos(psi), s = Math.sin(psi);
    // пробы там же, где их кладёт main.js: центр, нос, корма, левый, правый
    const probes = [
      h(0, 0), h(L * c, L * s), h(-L * c, -L * s),
      h(-B * s, B * c), h(B * s, -B * c),
    ];
    const out = oceanPlaneFit(probes, psi, L, B, { z: 0, se: 0, sn: 0 });
    worst = Math.max(worst, Math.abs(out.z - Z0),
                     Math.abs(out.se - SE), Math.abs(out.sn - SN));
  }
  check('наклоны в мире не зависят от курса',
    worst < 1e-12, 'худшая невязка по 24 курсам ' + worst.toExponential(1));

  // И знак: вода, поднимающаяся на восток, при курсе на восток даёт нос кверху.
  const psi = 0;
  const up = oceanPlaneFit([0, 0.1 * L, -0.1 * L, 0, 0], psi, L, B, {});
  check('склон по курсу — это положительный наклон вперёд',
    up.se > 0.09 && up.se < 0.11 && Math.abs(up.sn) < 1e-12,
    'se ' + up.se.toFixed(3) + ', sn ' + up.sn.toFixed(3));
  // Вода, поднимающаяся на левый борт, при том же курсе даёт наклон на север.
  const left = oceanPlaneFit([0, 0, 0, 0.1 * B, -0.1 * B], psi, L, B, {});
  check('склон на левый борт при курсе на восток — это наклон на север',
    left.sn > 0.09 && left.sn < 0.11 && Math.abs(left.se) < 1e-12,
    'se ' + left.se.toFixed(3) + ', sn ' + left.sn.toFixed(3));

  // Короткая волна под корпусом обязана усредняться, а не проходить насквозь:
  // это и есть смысл пяти проб вместо одной.
  const lam = 1.2, k = 2 * Math.PI / lam, amp = 0.1;
  const wave = dx => amp * Math.cos(k * dx);
  const short = oceanPlaneFit(
    [wave(0), wave(L), wave(-L), wave(0), wave(0)], 0, L, B, {});
  check('волна короче корпуса не проходит в наклон целиком',
    Math.abs(short.se) < 0.25 * amp * k,
    'наклон ' + short.se.toFixed(3) + ' против ' + (amp * k).toFixed(3) +
    ' у самой волны');
}

console.log(failures ? '\n' + failures + ' проверок не прошло\n' : '\nвсе проверки прошли\n');
process.exit(failures ? 1 : 0);
