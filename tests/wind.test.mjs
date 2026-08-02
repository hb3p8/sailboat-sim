// Поле ветра и полоски рига: node tests/wind.test.mjs
//
// Здесь проверяется не поведение лодки, а сама механика ветра: профиль по
// высоте, порывы, разбивка парусов. Это отдельно от physics.test.mjs нарочно —
// если лодка вдруг поедет не так, надо сразу знать, ветер виноват или лодка.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WindField, gustAt, gustTexture, GUST_PERIOD } from '../sim/wind.js';
import { Boat } from '../sim/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
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
const area = b.strips.reduce((s, x) => s + x.area, 0);
const ceZ = b.strips.reduce((s, x) => s + x.area * x.h, 0) / area;
// Центр площади, а не центр давления: именно так он посчитан в пакете, по
// центрам тяжести парусных треугольников.
const ceX = b.strips.reduce((s, x) => s + x.area * (x.xLuff - 0.5 * x.chord), 0) / area;
console.log('\nПолоски рига: ' + b.strips.length + ' штук, площадь ' +
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
  b.strips.slice(0, 6).every((s, i, a) => i === 0 || s.chord < a[i - 1].chord));

// Однородный ветер без твиста и качки: все полоски обязаны видеть одно и то же.
// Это проверка самой механики — если она провалится, различия между полосками
// берутся не из ветра, а из ошибки.
{
  const u = new Boat(PACK);
  u.wind.o.gradient = false;
  u.o.windSpeed = 6; u.o.windDir = 60 * D; u.o.sheet = 16 * D; u.o.twist = 0;
  u.u = 5; u.phi = 12 * D;
  u.step(1 / 30);
  const a = u.telemetry.strips;
  const main = a.slice(0, 6), jib = a.slice(6);
  const spread = arr => Math.max(...arr) - Math.min(...arr);
  // Геометрический угол атаки, то есть до скоса. Он обязан быть одинаковым:
  // ветер однородный, твиста нет. А вот эффективный теперь разный, и это не
  // ошибка — вихревая решётка наводит на каждой полоске свой скос.
  check('при однородном ветре у всех полосок один геометрический угол атаки',
    spread(a.map(s => s.alphaDeg + s.indDeg)) < 1e-9,
    'разброс ' + spread(a.map(s => s.alphaDeg + s.indDeg)).toExponential(1) + '°');
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
  p.step(1 / 30);
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
  const at = tw => {
    p.o.twist = tw * D;
    p.step(1 / 30);
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
  const geom = s => s.alphaDeg + s.indDeg;
  check('большой твист уводит верх паруса в заполаскивание',
    geom(open[5]) < 0.5 && geom(open[0]) > 4,
    'низ ' + geom(open[0]).toFixed(1) + '°, верх ' +
    geom(open[5]).toFixed(1) + '°');
  check('заполоскавший верх не даёт подъёмной силы',
    open[5].cl < 0.02, 'cl ' + open[5].cl.toFixed(3));
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
  const q = new Boat(PACK);
  q.o.windSpeed = 8; q.o.windDir = 90 * D; q.o.sheet = 20 * D;
  q.wind.o.gust = 0.35; q.wind.o.shift = 12 * D;
  q.u = 4;
  let lo = 99, hi = -99, wLo = 99, wHi = -99;
  for (let i = 0; i < 300 * 30; i++) {
    const e = wrapPi(0 - q.psi);
    q.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * e - 0.9 * q.r)));
    q.step(1 / 30);
    if (i > 30 * 30) {
      lo = Math.min(lo, q.telemetry.heelDeg); hi = Math.max(hi, q.telemetry.heelDeg);
      wLo = Math.min(wLo, q.telemetry.twsKn); wHi = Math.max(wHi, q.telemetry.twsKn);
    }
  }
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

console.log('\n' + (failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
