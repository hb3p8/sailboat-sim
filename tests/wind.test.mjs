// Поле ветра и полоски рига: node tests/wind.test.mjs
//
// Здесь проверяется не поведение лодки, а сама механика ветра: профиль по
// высоте, порывы, разбивка парусов. Это отдельно от physics.test.mjs нарочно —
// если лодка вдруг поедет не так, надо сразу знать, ветер виноват или лодка.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WindField, gustAt, gustTexture, GUST_PERIOD } from '../sim/wind.js';
import { windage } from '../sim/aero.js';
import { Boat } from '../sim/physics.js';
import { Pool } from './lib/pool.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
// Долгие прогоны — по всем ядрам: они друг от друга не зависят.
const PACK_PATH = join(ROOT, 'out/export/physics.json');
const pool = new Pool(PACK_PATH, PACK);
const D = Math.PI / 180;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

// --- профиль по высоте --------------------------------------------------------

const w = new WindField({ speed: 6, dir: 0 });
console.log('\nПрофиль ветра, опорные 6 м/с на стандартных 10 м:\n');
console.log('  высота    м/с    доля');
for (const z of [0.5, 1.0, 2.0, 3.33, 5.0, 8.55, 10.0]) {
  console.log('  ' + (z.toFixed(2) + ' м').padStart(7) + ' ' +
    (6 * w.profile(z)).toFixed(2).padStart(6) + ' ' +
    w.profile(z).toFixed(3).padStart(7));
}
console.log('');
check('на опорной высоте ровно опорная скорость',
  Math.abs(w.profile(10) - 1) < 1e-9);
check('профиль растёт с высотой',
  [0.5, 1, 2, 4, 8, 10].every((z, i, a) => i === 0 || w.profile(z) > w.profile(a[i - 1])));
check('профиль нигде не отрицательный и не бесконечный',
  [0, 0.01, 0.1, 1, 50].every(z => w.profile(z) > 0 && isFinite(w.profile(z))));
// Ради этого числа всё и затевалось: разница ветра по мачте — не мелочь.
const ratio = w.profile(8.55) / w.profile(1.0);
console.log('  Топ мачты видит в ' + ratio.toFixed(2) + ' раза больше ветра, чем гик\n');
check('разница между гиком и топом от 1.15 до 1.45',
  ratio > 1.15 && ratio < 1.45, ratio.toFixed(2));
check('профиль можно выключить',
  new WindField({ gradient: false }).profile(1) === 1);

// --- порывы -------------------------------------------------------------------

const g = new WindField({ speed: 6, dir: 45 * D, gust: 0.25, shift: 10 * D });
let lo = 9, hi = -9, sum = 0, n = 0;
for (let i = 0; i < 4000; i++) {
  const v = g.gust((i * 37) % 900 - 450, (i * 91) % 900 - 450, (i % 200) * 0.7);
  lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; n++;
}
console.log('Поле порывов: от ' + lo.toFixed(2) + ' до ' + hi.toFixed(2) +
  ', среднее ' + (sum / n).toFixed(3) + '\n');
check('порывы ограничены', lo > -1.5 && hi < 1.5);
check('в среднем поле нулевое', Math.abs(sum / n) < 0.12, (sum / n).toFixed(3));

// Гладкость: соседние точки в метре друг от друга не должны отличаться в разы,
// иначе лодку будет дёргать, а порыв должен приходить постепенно.
let jump = 0;
for (let i = 0; i < 2000; i++) {
  const x = (i * 13) % 400 - 200, y = (i * 29) % 400 - 200;
  jump = Math.max(jump, Math.abs(g.gust(x + 1, y, 0) - g.gust(x, y, 0)));
}
check('поле гладкое: на метр не больше 0.1 размаха', jump < 0.1, jump.toFixed(3));

// Поле вморожено в поток и едет по ветру. Значит то, что придёт в точку через
// t секунд, сейчас лежит на t·V наветреннее — там его и надо найти.
{
  const t = 8, V = g.o.speed;
  const c = Math.cos(g.o.dir), s = Math.sin(g.o.dir);
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const x = (i * 17) % 300 - 150, y = (i * 53) % 300 - 150;
    const later = g.gust(x, y, t);
    const upwindNow = g.gust(x + V * t * c, y + V * t * s, 0);
    worst = Math.max(worst, Math.abs(later - upwindNow));
  }
  check('порывы едут по ветру, а не мерцают на месте', worst < 1e-9,
    'расхождение ' + worst.toExponential(1));
}

// Порыв и заход связаны: усиление приходит не в одиночку.
{
  let both = 0, total = 0;
  for (let i = 0; i < 3000; i++) {
    const x = (i * 41) % 800 - 400, y = (i * 7) % 800 - 400;
    const v = g.gust(x, y, 0);
    if (Math.abs(v) < 0.15) continue;
    const s = g.sample(x, y, 5, 0);
    const stronger = s.speed > 6 * g.profile(5);
    const veered = s.dir > g.o.dir;
    if (stronger === veered) both++;
    total++;
  }
  check('усиление ветра и заход идут вместе', both / total > 0.7,
    (100 * both / total).toFixed(0) + '% случаев');
}

// --- текстура поля ------------------------------------------------------------
//
// Вода в симуляторе поле не считает: она берёт его из текстуры, построенной
// этим же кодом. Значит проверять надо ровно одно — что выборка из текстуры
// воспроизводит поле. Это единственное звено, на которое опирается шейдер;
// всё остальное там — перевод координат в систему ветра, две строки.
//
// До этого поле существовало в двух экземплярах, и они разошлись: множитель
// сглаживания в шейдерном шуме был переписан с ошибкой, вода пошла полосами, а
// физика считала правильное. Тестами такое не ловится — они до шейдера не
// достают. Теперь ловить нечего, но выборку зафиксировать надо: ошибиться в
// ней (промахнуться на полтексела, перепутать края) по-прежнему можно.

{
  const W = 512, H = 256;
  const tex = gustTexture(W, H);
  const wrap01 = v => v - Math.floor(v);
  // Билинейная выборка ровно так, как её делает видеокарта: значения лежат в
  // центрах текселов, координата в текселах равна uv·размер − 0.5.
  const sample = (along, across) => {
    const fx = wrap01(along / GUST_PERIOD.along) * W - 0.5;
    const fy = wrap01(across / GUST_PERIOD.across) * H - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    const at = (a, b) => tex[((b % H) + H) % H * W + (((a % W) + W) % W)] / 127.5 - 1;
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - ty) +
           (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * ty;
  };

  let worst = 0, at = null;
  for (let k = 0; k < 20000; k++) {
    const along = (k * 13.37) % (3 * GUST_PERIOD.along) - GUST_PERIOD.along;
    const across = (k * 4.61) % (3 * GUST_PERIOD.across) - GUST_PERIOD.across;
    const d = Math.abs(sample(along, across) - gustAt(along, across));
    if (d > worst) { worst = d; at = [along, across]; }
  }
  console.log('\nТекстура поля ' + W + '×' + H + ': наибольшее расхождение с ' +
    'gustAt ' + worst.toFixed(4) + ' (в точке ' + at[0].toFixed(0) + ', ' +
    at[1].toFixed(0) + ' м)\n');
  // Допуск складывается из двух вещей: квантование байтом (1/127.5 ≈ 0.008) и
  // билинейная интерполяция вместо точной между центрами текселов.
  // Точки берутся и за пределами периода, в том числе отрицательные: вода
  // бесконечная, и кроиться текстура обязана во все стороны.
  check('выборка из текстуры воспроизводит поле', worst < 0.02,
    worst.toFixed(4) + ' при размахе поля около 1.5');
}

// --- полоски рига -------------------------------------------------------------

const b = new Boat(PACK);
const area = b.rig.strips.reduce((s, x) => s + x.area, 0);
const ceZ = b.rig.strips.reduce((s, x) => s + x.area * x.h, 0) / area;
// Центр площади, а не центр давления: именно так он посчитан в пакете, по
// центрам тяжести парусных треугольников.
const ceX = b.rig.strips.reduce((s, x) => s + x.area * (x.xLuff - 0.5 * x.chord), 0) / area;
console.log('\nПолоски рига: ' + b.rig.strips.length + ' штук, площадь ' +
  area.toFixed(2) + ' м², центр площади x=' + ceX.toFixed(3) +
  ' z=' + ceZ.toFixed(3) + ' м\n');
check('суммарная площадь полосок равна паспортной',
  Math.abs(area - (PACK.rig.main_area_m2 + PACK.rig.jib_area_m2)) < 1e-6,
  area.toFixed(3) + ' м²');
check('центр площади полосок совпадает с посчитанным в пакете по абсциссе',
  Math.abs(ceX - PACK.rig.ce_x_m) < 0.03,
  ceX.toFixed(3) + ' против ' + PACK.rig.ce_x_m.toFixed(3) + ' м');
check('и по высоте',
  Math.abs(ceZ - PACK.rig.ce_height_m) < 0.06,
  ceZ.toFixed(3) + ' против ' + PACK.rig.ce_height_m.toFixed(3) + ' м');
check('хорда убывает к топу',
  b.rig.strips.slice(0, 6).every((s, i, a) => i === 0 || s.chord < a[i - 1].chord));

// Однородный ветер без твиста и качки: все полоски обязаны видеть одно и то же.
// Это проверка самой механики — если она провалится, различия между полосками
// берутся не из ветра, а из ошибки.
{
  const u = new Boat(PACK);
  u.wind.o.gradient = false;
  u.o.windSpeed = 6; u.o.windDir = 60 * D; u.o.sheet = 16 * D; u.o.twist = 0;
  u.u = 5; u.phi = 12 * D;
  // Три секунды на то, чтобы паруса вышли на свою подъёмную силу: после
  // введения запаздывания одного шага мало, и полоски с разной хордой
  // догоняют с разной скоростью. Лодка при этом заморожена — мерить надо
  // механику полосок, а не разгон.
  for (let i = 0; i < 90; i++) {
    u.u = 5; u.v = 0; u.r = 0; u.phi = 12 * D; u.p_ = 0; u.psi = 0;
    u.step(1 / 30);
  }
  const a = u.telemetry.strips;
  const main = a.slice(0, 6), jib = a.slice(6);
  const spread = arr => Math.max(...arr) - Math.min(...arr);
  // Геометрический угол атаки, то есть до скоса. Он обязан быть одинаковым:
  // ветер однородный, твиста нет. А вот эффективный теперь разный, и это не
  // ошибка — вихревая решётка наводит на каждой полоске свой скос.
  check('при однородном ветре у всех полосок один геометрический угол атаки',
    spread(a.map(s => s.geomDeg)) < 1e-9,
    'разброс ' + spread(a.map(s => s.geomDeg)).toExponential(1) + '°');
  check('а эффективный — разный, потому что скос по высоте разный',
    spread(a.map(s => s.alphaDeg)) > 0.5,
    'разброс ' + spread(a.map(s => s.alphaDeg)).toFixed(1) + '°');
  check('и одна скорость ветра',
    spread(a.map(s => s.ws)) < 1e-9);
  check('у грота и стакселя разные удлинения, значит и разные cl',
    Math.abs(main[0].cl - jib[0].cl) > 1e-3,
    main[0].cl.toFixed(3) + ' против ' + jib[0].cl.toFixed(3));
}

// С профилем ветра верх паруса обязан видеть больше ветра и свободнее угол.
{
  const p = new Boat(PACK);
  p.o.windSpeed = 6; p.o.windDir = 45 * D; p.o.sheet = 12 * D; p.o.twist = 0;
  p.u = 5; p.phi = 12 * D;
  for (let i = 0; i < 90; i++) {
    p.u = 5; p.v = 0; p.r = 0; p.phi = 12 * D; p.p_ = 0; p.psi = 0;
    p.step(1 / 30);
  }
  // Копия, а не ссылки: телеметрия отдаёт те же самые объекты полосок, что
  // физика переписывает на следующем шаге. Для отрисовки это удобно, для
  // сравнения «до и после» — ловушка.
  const a = p.telemetry.strips.slice(0, 6).map(s => Object.assign({}, s));
  console.log('  Грот по высоте (профиль включён):');
  console.log('   высота   ветер   AWA     α');
  for (const s of a) {
    console.log('   ' + s.h.toFixed(2).padStart(5) + ' м ' +
      s.ws.toFixed(2).padStart(6) + ' ' + s.awaDeg.toFixed(1).padStart(6) + '° ' +
      s.alphaDeg.toFixed(1).padStart(5) + '°');
  }
  console.log('');
  check('вверху ветер сильнее', a[5].ws > a[0].ws * 1.15,
    a[0].ws.toFixed(2) + ' → ' + a[5].ws.toFixed(2) + ' м/с');
  // Порог сдвинут с двух градусов до полутора после обмера парусов: нижняя
  // полоска грота теперь сидит на 2.2 м, а не на 1.9 — нижняя шкаторина идёт
  // по гику, а гик на чертеже висит на 1.6 м. Чем выше низ паруса, тем меньше
  // ему достаётся от градиента, и разброс по высоте сжимается. Само явление
  // не изменилось, изменилось плечо.
  check('вверху кажущийся ветер свободнее', a[5].awaDeg > a[0].awaDeg + 1.5,
    a[0].awaDeg.toFixed(1) + '° → ' + a[5].awaDeg.toFixed(1) + '°');
  check('значит без твиста вверху угол атаки больше',
    a[5].alphaDeg > a[0].alphaDeg + 2,
    a[0].alphaDeg.toFixed(1) + '° → ' + a[5].alphaDeg.toFixed(1) + '°');

  // Твист под градиент — маленький: профиль добавляет наверху всего пару
  // градусов угла атаки, и чтобы выровнять парус, хватает примерно стольких же.
  const spread = s => Math.abs(s[5].alphaDeg - s[0].alphaDeg);
  // Парус выходит на новую подъёмную силу не мгновенно, и одного шага после
  // перекладки твиста ему теперь мало: пока не сойдёт разгонный вихрь, полоска
  // работает на половине прироста. Поэтому три секунды на устаканивание, а
  // движение лодки при этом заморожено — мерить надо парус, а не разгон.
  const settle = () => {
    for (let i = 0; i < 90; i++) {
      p.u = 5; p.v = 0; p.r = 0; p.phi = 12 * D; p.p_ = 0; p.psi = 0;
      p.step(1 / 30);
    }
  };
  const at = tw => {
    p.o.twist = tw * D;
    settle();
    return p.telemetry.strips.slice(0, 6).map(s => Object.assign({}, s));
  };
  const even = at(3), open = at(20);
  check('небольшой твист выравнивает угол атаки по высоте',
    spread(even) < spread(a),
    'разброс ' + spread(a).toFixed(1) + '° → ' + spread(even).toFixed(1) + '°');
  // А большой твист — это уже не выравнивание, а сброс мощности: верх паруса
  // раскрывается настолько, что уходит по потоку и перестаёт работать вовсе.
  // Отрицательным угол атаки при этом не становится: шкот парус не держит, а
  // только ограничивает, и вытравленное полотно просто встаёт вдоль потока.
  // По геометрическому углу: твист управляет именно им, а скос сверху
  // накладывает уже вихревая решётка и к делу тут отношения не имеет.
  const geom = s => s.geomDeg;
  check('большой твист уводит верх паруса в заполаскивание',
    geom(open[5]) < 0.5 && geom(open[0]) > 4,
    'низ ' + geom(open[0]).toFixed(1) + '°, верх ' +
    geom(open[5]).toFixed(1) + '°');
  check('заполоскавший верх не даёт подъёмной силы',
    open[5].cl < 0.02, 'cl ' + open[5].cl.toFixed(3));
}

// --- на какую сторону выгнут парус ------------------------------------------
//
// Пузо в телеметрии идёт со знаком, и знак этот — не украшение: по нему
// отрисовка кладёт полотно на подветренную сторону. Пока телеметрия отдавала
// модуль, нарисованный парус на одном галсе выгибался на наветренную —
// в ветер. Глазом это видно сразу, а никакой проверкой не ловилось.
//
// Проверяется то, что можно проверить без картинки: знак пуза следует за
// галсом и совпадает со знаком, по которому строит панели сам расчёт.
{
  const [stb, prt] = await pool.map([
    { run: 'tack', twa: 60 }, { run: 'tack', twa: -60 },
  ]);
  console.log('\nНа какую сторону выгнут парус (пузо со знаком):\n');
  console.log('  галс   борт паруса   пузо грота        пузо стакселя');
  for (const [name, r] of [['правый', stb], ['левый', prt]]) {
    console.log('  ' + name.padEnd(7) + r.side.toFixed(2).padStart(9) + '   ' +
      r.strips.slice(0, 3).map(s => s.camber.toFixed(3)).join(' ') + '   ' +
      r.strips.slice(6, 9).map(s => s.camber.toFixed(3)).join(' '));
  }
  console.log('');
  // Сравниваются только полоски, у которых пузо вообще есть: заполоскавшая
  // ткань его не держит, и знака у нуля нет.
  const live = stb.strips.map((s, i) =>
    Math.abs(s.camber) > 1e-4 && Math.abs(prt.strips[i].camber) > 1e-4);
  check('на разных галсах парус выгнут в разные стороны',
    live.some(Boolean) &&
    stb.strips.every((s, i) => !live[i] ||
      Math.sign(s.camber) === -Math.sign(prt.strips[i].camber)),
    live.filter(Boolean).length + ' полосок из ' + live.length + ' с пузом');
  // Знак у пуза один на весь парус, а не свой у каждой полоски, и сверять его
  // надо так же. Раньше здесь стояло сравнение с углом атаки самой полоски, и
  // проверка держалась на случайности: у топовой полоски угол к хорде уходит
  // ровно в ноль, знака у неё нет вовсе, а `Math.sign(0 || 1)` отвечает плюсом
  // независимо от галса. Расчёт же берёт знак у паруса целиком — по углам
  // атаки, взвешенным по площади, — потому что циркуляция отдельной полоски
  // проходит через ноль то и дело.
  const sailSign = (calc, from, to) => {
    let m = 0;
    for (let i = from; i < to; i++) if (calc[i].live) m += calc[i].alpha * calc[i].area;
    return Math.sign(m || 1);
  };
  const agrees = calc => [[0, 6], [6, 12]].every(([a, b]) => {
    const s = sailSign(calc, a, b);
    for (let i = a; i < b; i++) {
      if (Math.abs(calc[i].camber) > 1e-4 && Math.sign(calc[i].camber) !== s) return false;
    }
    return true;
  });
  check('пузо выгнуто в ту сторону, в какую поставлен парус',
    agrees(stb.calc) && agrees(prt.calc));
}

// --- запаздывание паруса --------------------------------------------------
//
// Смена условий не даёт новой подъёмной силы сразу: сначала с задней шкаторины
// должен сойти разгонный вихрь, и пока он рядом, его скос держит циркуляцию.
// Даёт это сама свободная пелена; строгая сверка с функцией Вагнера — в
// `tests/wake.test.mjs`, там для этого ступенька ВЕТРА при неподвижном парусе.
//
// Здесь проверяется то же свойство на том, что делает человек: на перекладке
// шкота. Разница существенная — поворот хорды меняет и геометрию, а не только
// граничное условие, — поэтому здесь не сверка с классикой, а три свойства.
//
// Мерится начиная со ВТОРОЙ ПОЛУХОРДЫ пути, а не с первого шага. Первый отсчёт
// в этой схеме не воспроизводит Вагнера и не может: свежее кольцо несёт новую
// циркуляцию всего на длину одного сноса, тогда как в установившемся состоянии
// она тянется на всю пелену, и стабилизирующий скос на первом шаге
// недопредставлен. Это разрешение схемы по времени, а не ошибка модели, и
// поймано оно тем же измерением, что и всё остальное (docs/wake.md).
//
// Лодка на время замораживается: мерить надо парус, а не разгон корпуса.
{
  const p = new Boat(PACK);
  p.wind.o.gradient = false;
  p.o.windSpeed = 8; p.o.windDir = 60 * D; p.o.sheet = 14 * D; p.o.twist = 0;
  const freeze = () => { p.u = 6; p.v = 0; p.r = 0; p.phi = 0; p.p_ = 0; p.psi = 0; };
  const hold = n => { for (let i = 0; i < n; i++) { freeze(); p.step(1 / 30); } };
  // Мерится подъёмная сила одной полоски, а не тяга всей лодки: тяга — это
  // разность двух больших величин, и на ней ответ теряется.
  const cl = () => p.telemetry.strips[2].cl;
  hold(600);
  const before = cl();
  p.o.sheet = 26 * D;
  const trace = [];
  for (let i = 0; i < 300; i++) { hold(1); trace.push(cl()); }
  hold(900);
  const after = cl();

  const chord = p.rig.strips[2].chord;
  const ve = p.rig.stripCalc[2].ve;
  // Доля пути в полухордах -> отсчёт.
  const at = (s) => {
    const k = Math.round(s * chord / 2 / ve * 30) - 1;
    return k >= 0 && k < trace.length ? (trace[k] - before) / (after - before) : NaN;
  };
  const p2 = at(2), p6 = at(6), p12 = at(12);
  console.log('\nПерекладка шкота 14° -> 26° на замороженной лодке:');
  console.log('  cl третьей полоски грота ' + before.toFixed(3) +
    ' -> установившаяся ' + after.toFixed(3));
  console.log('  доля прироста на второй полухорде ' + p2.toFixed(2) +
    ', на шестой ' + p6.toFixed(2) + ', на двенадцатой ' + p12.toFixed(2) +
    '  (хорда ' + chord.toFixed(2) + ' м, поток ' + ve.toFixed(1) + ' м/с)\n');

  // Первое: запаздывание ЕСТЬ. У прямых сходящих лучей его нет вовсе — они
  // мгновенно перестраиваются под новую циркуляцию, и доля была бы единицей.
  check('на второй полухорде прирост ещё не набран', p2 < 0.95, p2.toFixed(2));
  // Второе: оно не бесконечное — к дюжине полухорд парус на месте.
  check('к дюжине полухорд прирост набран', p12 > 0.9 && p12 < 1.1, p12.toFixed(2));
  // Третье: и набирается монотонно, без раскачки.
  check('и набирается без раскачки', p6 >= p2 - 0.02 && p12 >= p6 - 0.02,
    p2.toFixed(2) + ' -> ' + p6.toFixed(2) + ' -> ' + p12.toFixed(2));

  // Главное свойство: на установившийся ход запаздывание не влияет вовсе.
  // Иначе это была бы не нестационарность, а просто другая поляра.
  const q = new Boat(PACK);
  q.wind.o.gradient = false;
  q.o.windSpeed = 8; q.o.windDir = 60 * D; q.o.sheet = 26 * D; q.o.twist = 0;
  for (let i = 0; i < 600; i++) {
    q.u = 6; q.v = 0; q.r = 0; q.phi = 0; q.p_ = 0; q.psi = 0; q.step(1 / 30);
  }
  check('на установившийся режим запаздывание не влияет',
    Math.abs(q.telemetry.strips[2].cl - after) < 2e-3,
    q.telemetry.strips[2].cl.toFixed(3) + ' против ' + after.toFixed(3));
}

// --- тень от мачты ----------------------------------------------------------
//
// Мачта портит гроту поток тем сильнее, чем толще она по сравнению с хордой.
// Наверху хорда меньше метра, а мачта сужается всего с 78 до 59 мм — значит
// верх грота теряет заметно больше низа. У стакселя впереди штаг, и терять
// нечего.
{
  const m = new Boat(PACK);
  const main = m.rig.strips.slice(0, 6), jib = m.rig.strips.slice(6);
  console.log('Потеря от мачты по высоте грота: ' +
    main.map(s => (100 * (1 - s.mastFill)).toFixed(0) + '%').join(', ') + '\n');
  check('мачта портит верх грота сильнее низа',
    1 - main[5].mastFill > 2 * (1 - main[0].mastFill),
    (100 * (1 - main[0].mastFill)).toFixed(0) + '% внизу против ' +
    (100 * (1 - main[5].mastFill)).toFixed(0) + '% наверху');
  check('потеря нигде не запредельная',
    main.every(s => s.mastFill > 0.7),
    'наименьшее наполнение ' + Math.min(...main.map(s => s.mastFill)).toFixed(2));
  check('стаксель мачты не видит', jib.every(s => s.mastFill === 1));
}

// Аэродинамическое демпфирование качки: полоски машут по воздуху и тормозят
// крен. Проверяется в штиль по воде — сравнением с ригом, который ветра не
// видит вовсе.
{
  const period = sails => {
    const r = new Boat(PACK);
    r.o.windSpeed = 0; r.o.sheet = 90 * D;
    r.o.sailScale = sails;
    r.phi = 20 * D;
    let peak = 0;
    for (let i = 0; i < 8 * 30; i++) r.step(1 / 30);
    for (let i = 0; i < 8 * 30; i++) { r.step(1 / 30); peak = Math.max(peak, Math.abs(r.phi)); }
    return peak / D;
  };
  const big = period(2.2), tiny = period(0.02);
  console.log('Размах качки на восьмой секунде: под генакером ' +
    big.toFixed(3) + '°, почти без парусов ' + tiny.toFixed(3) + '°\n');
  // Вклад небольшой — качку у килевой лодки гасит вода, а не воздух, — но он
  // берётся из геометрии сам и больше не нуждается в отдельном коэффициенте.
  check('паруса гасят качку', big < tiny * 0.97,
    big.toFixed(3) + '° против ' + tiny.toFixed(3) + '°');
}

// Порыв должен доехать до лодки и накренить её — иначе поле красивое, но ни на
// что не влияет.
{
  const { lo, hi, wLo, wHi } = (await pool.map([{ run: 'gustHeel' }]))[0];
  console.log('За 5 минут в порывистый ветер: ветер у рига ' + wLo.toFixed(1) +
    '…' + wHi.toFixed(1) + ' уз, крен ' + lo.toFixed(1) + '…' + hi.toFixed(1) + '°\n');
  check('порывы доезжают до лодки', wHi - wLo > 2,
    'размах ' + (wHi - wLo).toFixed(1) + ' уз');
  check('и раскачивают крен', hi - lo > 3, 'размах ' + (hi - lo).toFixed(1) + '°');
  check('но не опрокидывают', Math.abs(hi) < 45 && Math.abs(lo) < 45);
}

function wrapPi(a) {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// --- решётка и сечение об одной и той же полоске ---------------------------------
//
// Самая важная проверка во всей батарее, и появилась она последней.
//
// Подъёмную силу полоски модель получает дважды и по-разному. Вихревая решётка
// даёт циркуляцию, а из неё по Жуковскому cl = 2Γ/(V·b). Двумерное сечение
// считает cl само — по эффективному углу атаки и пузу. Числа обязаны сойтись:
// полоска-то одна и та же.
//
// Не сходились они чудовищно. У решётки не было потолка подъёмной силы: у
// треугольного паруса хорда к топу уходит в ноль, а циркуляция нет, и местное
// cl там доходило до шести. Сечение честно упирало это в свой потолок около
// полутора, и отношение падало до одной десятой. Снаружи всё выглядело прилично
// — силы берутся из сечения, — но поле, которым паруса влияют друг на друга,
// считалось по вдвое перегруженному ригу: грот на добранном шкоте получал от
// стакселя скос больше собственного угла атаки и переставал работать вовсе.
//
// Проверяются только работающие полоски: наполненные и до срыва. Где ткань
// смялась или поток сорвался, сечение и должно расходиться с потенциальным
// течением — за тем оно и стоит. Оттого и курсы здесь острые: на полных парус
// работает сорванным, и сверять там нечего.
console.log('\nРешётка против сечения: подъёмная сила одной и той же полоски\n');
{
  const CASES = [['круто в бейдевинд', 35, 10, 8], ['бейдевинд', 45, 14, 8],
                 ['полный бейдевинд', 50, 17, 8], ['крутой бакштаг', 60, 20, 16]];
  const got = await pool.map(CASES.map(([, twa, sheet, twist]) =>
    ({ run: 'latVsSection', twa, sheet, twist })));
  const rows = [];
  for (let ci = 0; ci < CASES.length; ci++) {
    const name = CASES[ci][0], rr = got[ci].ratios;
    let worst = 1, best = 1, n = 0;
    for (const r of rr) {
      if (n === 0 || r < worst) worst = r;
      if (n === 0 || r > best) best = r;
      n++;
    }
    rows.push({ name, worst, best, n });
    console.log('  ' + name.padEnd(20) + 'полосок ' + String(n).padStart(2) +
      ',  cl сечения / cl решётки  от ' + worst.toFixed(2) + ' до ' + best.toFixed(2));
  }
  console.log('');
  check('на каждом курсе есть работающие полоски', rows.every(r => r.n >= 2),
    rows.map(r => r.n).join('/'));
  check('решётка и сечение считают одну и ту же подъёмную силу',
    rows.every(r => r.worst > 0.7 && r.best < 1.3),
    'худшее ' + Math.min(...rows.map(r => r.worst)).toFixed(2) +
    ', наибольшее ' + Math.max(...rows.map(r => r.best)).toFixed(2));
}

// --- парусность в потоке --------------------------------------------------------
//
// Корпус, стоячий такелаж и экипаж. Долгое время это было одно назначенное
// число на всё — 0.56 кв.м с одним cx и одной высотой, — и оно оказалось
// заниженным вчетверо: только надводный борт даёт полтора квадрата спереди и
// три лагом, да экипаж втроём столько же.
//
// Проверяется не величина (её задаёт геометрия), а то, что модель ведёт себя
// как тело в потоке: тень зависит от курса, сила идёт вдоль кажущегося ветра и
// растёт как его квадрат, экипаж в кокпите закрыт бортом сильнее, чем на борту.
console.log('\nПарусность в потоке\n');
{
  const b = new Boat(PACK);
  b.o.crewHike = 1; b.o.crewMass = 240;
  const at = (x, y) => windage(PACK, b.o, { x: x, y: y, speed: Math.hypot(x, y) });
  // Все замеры на десяти метрах в секунду: F = ½·ρ·cx·A·V², отсюда и cx·A.
  const cda = w => 2 * Math.hypot(w.fx, w.fy) / (PACK.environment.rho_air * 100);
  const bow = at(-10, 0), beam = at(0, -10), close = at(-9.2, -3.9);
  console.log('  в нос      cx·площадь ' + cda(bow).toFixed(2) +
    ' кв.м, высота ' + bow.z.toFixed(2) + ' м');
  console.log('  лагом      cx·площадь ' + cda(beam).toFixed(2) +
    ' кв.м, высота ' + beam.z.toFixed(2) + ' м');
  console.log('  бейдевинд  cx·площадь ' + cda(close).toFixed(2) +
    ' кв.м, высота ' + close.z.toFixed(2) + ' м');
  b.o.crewHike = 0;
  const cockpit = cda(at(0, -10));
  b.o.crewMass = 0;
  const nocrew = cda(at(0, -10));
  console.log('  лагом без экипажа ' + nocrew.toFixed(2) +
    ', экипаж в кокпите ' + cockpit.toFixed(2) +
    ', экипаж на борту ' + cda(beam).toFixed(2) + ' кв.м\n');

  check('лагом парусности больше, чем в нос', cda(beam) > cda(bow) * 1.5,
    cda(beam).toFixed(2) + ' против ' + cda(bow).toFixed(2) + ' кв.м');
  check('в бейдевинд между ними, ближе к носовой',
    cda(close) > cda(bow) && cda(close) < 0.5 * (cda(bow) + cda(beam)),
    cda(close).toFixed(2) + ' кв.м');
  check('экипаж в кокпите закрыт бортом', cockpit > nocrew && cockpit < cda(beam),
    nocrew.toFixed(2) + ' → ' + cockpit.toFixed(2) + ' → ' + cda(beam).toFixed(2));
  // Такелаж висит высоко, корпус низко: центр приложения обязан быть между.
  check('точка приложения выше палубы, но много ниже центра парусности',
    beam.z > 0.4 && beam.z < 0.5 * PACK.rig.ce_height_m,
    beam.z.toFixed(2) + ' м при центре парусности ' +
    PACK.rig.ce_height_m.toFixed(2) + ' м');
  // Сила квадратична по скорости и направлена ровно по кажущемуся ветру.
  {
    const half = windage(PACK, b.o, { x: -5, y: -5, speed: Math.hypot(5, 5) });
    const full = windage(PACK, b.o, { x: -10, y: -10, speed: Math.hypot(10, 10) });
    const ratio = Math.hypot(full.fx, full.fy) / Math.hypot(half.fx, half.fy);
    check('сопротивление растёт как квадрат скорости',
      Math.abs(ratio - 4) < 1e-9, ratio.toFixed(3) + ' при удвоении');
    check('сила направлена по кажущемуся ветру',
      Math.abs(full.fx / full.fy - 1) < 1e-9);
  }
}


// --- колдунчики на задней шкаторине -------------------------------------------
//
// Проверяется не картинка, а ПОРЯДОК СОБЫТИЙ — то единственное, что в отрыве с
// кромки можно утверждать твёрдо. Перебрал шкот: первой сдаёт задняя шкаторина,
// потом виснет подветренный у передней, потом наступает срыв. Если этот порядок
// сломается, колдунчик перестанет быть предупреждением и станет подтверждением
// уже случившегося — то есть бесполезным.
{
  const [tight, good, eased] = await pool.map([
    { run: 'telltale', sheet: 12 }, { run: 'telltale', sheet: 16 },
    { run: 'telltale', sheet: 24 },
  ]);
  console.log('\nПеребранный грот: что показывают колдунчики\n');
  console.log('  шкот   ход     α    отрыв кромки   подветренный у передней');
  for (const [n, r] of [['12°', tight], ['16°', good], ['24°', eased]]) {
    console.log('  ' + n + '   ' + r.speed.toFixed(2) + ' уз  ' +
      r.alpha.toFixed(1).padStart(4) + '°      ' + r.sep.toFixed(2) +
      '           ' + r.droop.toFixed(2));
  }
  console.log('');
  check('перебранный шкот виден по задней шкаторине раньше, чем по передней',
    tight.sep > 0.2 && tight.droop < 0.05,
    'на 12° кромка ' + tight.sep.toFixed(2) + ', передняя ' + tight.droop.toFixed(2));
  check('на правильной настройке стелется всё',
    good.sep < 0.05 && good.droop < 0.05 && good.speed > tight.speed,
    'на 16° ход ' + good.speed.toFixed(2) + ' против ' + tight.speed.toFixed(2) +
    ' на перебранном');
  check('потравленный шкот кромку не срывает',
    eased.sep < 0.05, 'на 24° отрыв ' + eased.sep.toFixed(2));
}


console.log('\n' + (failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
