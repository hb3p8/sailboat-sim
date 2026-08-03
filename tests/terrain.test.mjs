// Акватория: пакет и выборка полей — node tests/terrain.test.mjs
//
// Здесь проверяется не поведение лодки, а то, что участок реки лёг в пакет так,
// как задумано: оси не перепутаны, масштаб тот, поля читаются.
//
// Главное — ОРИЕНТАЦИЯ, и проверяется она числами, а не глазом. Зеркально
// отражённая по Y акватория выглядит совершенно правдоподобно: река на месте,
// берега на месте, и взглядом это не ловится вовсе. Ловится оно только тем, что
// высокий правый берег обязан оказаться на ЮГЕ, а не на севере, — и это ровно
// два сравнения, для которых не нужна ни сцена, ни браузер.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Terrain } from '../sim/terrain.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = join(ROOT, 'out/export/terrain_pack.json');
const D = Math.PI / 180;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

if (!existsSync(PATH)) {
  console.log('\nПакета акватории нет — пропускаем. Собрать: make terrain-pack\n');
  process.exit(0);
}

const pack = JSON.parse(readFileSync(PATH, 'utf8'));
const t = new Terrain(pack);

console.log('\nПакет акватории\n');
console.log('  участок %s × %s км, шаг %s м; поля физики %s × %s по %s м на %d румбов',
  ((pack.nx - 1) * pack.step / 1000).toFixed(1), ((pack.ny - 1) * pack.step / 1000).toFixed(1),
  pack.step, pack.cnx, pack.cny, pack.coarse, pack.rhumbs);
console.log('  урез %s м, земля %s…%s м, с покровом до %s м\n',
  pack.level.toFixed(1), pack.hmin.toFixed(1), pack.hmax.toFixed(1), pack.top_max.toFixed(1));

check('пакет читается и считается готовым', t.ready);

// --- ориентация ---------------------------------------------------------------
//
// Высшая точка участка объявлена в пакете вместе с высотой верха покрова.
// Выборка обязана дать там то же самое: если оси перепутаны, попадём в другое
// место, а другого такого места на участке нет.
{
  const [hx, hy] = pack.high_point;
  const got = t.top(hx, hy);
  console.log('  высшая точка: пакет %s м, выборка %s м',
    pack.top_max.toFixed(1), got.toFixed(1));
  check('в высшей точке выборка сходится с пакетом',
    Math.abs(got - pack.top_max) < 1.0, (got - pack.top_max).toFixed(2) + ' м');
  // Она же обязана лежать в ЮЖНОЙ половине: правый берег Волги здесь высокий,
  // левый — пойма. Ошибка знака по Y забросила бы её в пойму, где двухсотметровых
  // высот нет вовсе.
  check('высшая точка на южной, правобережной стороне', hy < 0,
    'y = ' + hy.toFixed(0) + ' м');
}

// Тот же вопрос, но по полю целиком, а не по одной точке: средняя высота земли
// южнее русла обязана быть заметно больше, чем севернее.
{
  const [ox, oy] = pack.open_water;
  const mean = dy => {
    let s = 0, n = 0;
    for (let dx = -1500; dx <= 1500; dx += 100) {
      const h = t.ground(ox + dx, oy + dy);
      if (h !== null) { s += h; n++; }
    }
    return n ? s / n : NaN;
  };
  const south = mean(-800), north = mean(800);
  console.log('  земля в 800 м от середины плёса: к югу %s м, к северу %s м',
    south.toFixed(1), north.toFixed(1));
  check('южный берег выше северного', south > north + 10,
    (south - north).toFixed(1) + ' м разницы');
}

// --- масштаб и вода -----------------------------------------------------------
{
  const [ox, oy] = pack.open_water;
  const d = t.shore(ox, oy);
  console.log('  середина плёса: до берега %s м, ширина плёса по выгрузке %s м',
    d.toFixed(0), pack.widest_m.toFixed(0));
  check('середина плёса — на воде', d > 0, d.toFixed(0) + ' м');
  // Обрезка на 127 м — не потеря: дальше неё ничего из физики не спрашивает.
  check('до берега не меньше половины ширины плёса, с учётом обрезки',
    d >= Math.min(127, 0.5 * pack.widest_m) - 1,
    d.toFixed(0) + ' против ' + (0.5 * pack.widest_m).toFixed(0));

  // Переход через урез обязан быть монотонным и один раз: расстояние — не
  // маска, оно интерполируется, и нулевая изолиния и есть береговая черта.
  let prev = t.shore(ox, oy), crossings = 0, mono = true;
  for (let s = 20; s <= 3000; s += 20) {
    const v = t.shore(ox, oy - s);
    if (v === null) break;
    if (v > prev + 1e-9) mono = false;
    if (prev > 0 && v <= 0) crossings++;
    prev = v;
  }
  check('к югу от середины плёса расстояние падает монотонно', mono);
  check('урез пересекается ровно один раз', crossings === 1, crossings + '');
}

// --- разгон -------------------------------------------------------------------
//
// Два числа, и обе стороны неравенства известны заранее из выгрузки: поперёк
// плёса шириной километр волне расти негде, вдоль реки — есть где.
{
  const [ox, oy] = pack.open_water;
  const byDir = [];
  for (let k = 0; k < 16; k++) byDir.push(t.fetch(ox, oy, k * 22.5 * D));
  console.log('  разгон на середине плёса по румбам, км: ' +
    byDir.map(v => (v / 1000).toFixed(1)).join(' '));
  const most = Math.max(...byDir), least = Math.min(...byDir);
  console.log('    наибольший %s км, наименьший %s км\n',
    (most / 1000).toFixed(1), (least / 1000).toFixed(1));
  check('вдоль реки разгон в километрах', most > 3000, (most / 1000).toFixed(1) + ' км');
  check('поперёк реки разгона почти нет', least < 600, least.toFixed(0) + ' м');
  check('разница между галсами больше пяти раз', most / Math.max(1, least) > 5,
    (most / Math.max(1, least)).toFixed(1) + ' раза');
}

// --- непрерывность по направлению ---------------------------------------------
//
// Изъян известен (за мысом разгон меняется скачком, а интерполяция сглаживает),
// и проверка не в том, что скачков нет, а в том, что между узлами сетки румбов
// ничего не рвётся: ответ обязан быть непрерывным и совпадать с узлами.
{
  const [ox, oy] = pack.open_water;
  let worst = 0;
  let prev = t.fetch(ox, oy, 0);
  for (let a = 1; a <= 360; a++) {
    const v = t.fetch(ox, oy, a * D);
    worst = Math.max(worst, Math.abs(v - prev));
    prev = v;
  }
  const span = 22.5;   // градусов между румбами
  console.log('  по кругу через градус: наибольший шаг разгона %s м', worst.toFixed(0));
  check('по направлению разгон непрерывен',
    worst < 1.1 * pack.fetch_max_m / span, worst.toFixed(0) + ' м на градус');
  check('через 360° возвращается то же самое',
    Math.abs(t.fetch(ox, oy, 0) - t.fetch(ox, oy, 2 * Math.PI)) < 1e-6);
}

// --- горизонт -----------------------------------------------------------------
{
  const [ox, oy] = pack.open_water;
  const byDir = [];
  for (let k = 0; k < 16; k++) byDir.push(t.skyline(ox, oy, k * 22.5 * D));
  console.log('  высота горизонта там же, тангенс: ' +
    byDir.map(v => v.toFixed(2)).join(' '));
  // Наибольший подъём обязан смотреть на юг — туда, где высокий берег.
  let kmax = 0;
  byDir.forEach((v, k) => { if (v > byDir[kmax]) kmax = k; });
  const dirDeg = kmax * 22.5;
  console.log('    выше всего в направлении %s°, тангенс %s\n',
    dirDeg.toFixed(0), byDir[kmax].toFixed(2));
  check('горизонт выше всего в южной половине',
    Math.sin(dirDeg * D) < 0, dirDeg.toFixed(0) + '°');
  check('на воде горизонт всюду ниже сорока пяти градусов',
    byDir.every(v => v < 1), Math.max(...byDir).toFixed(2));
}

// --- за краем участка ----------------------------------------------------------
//
// Уйти из квадрата можно: 15 × 11 км на пяти узлах — полтора часа. Поведение
// обязано быть определено, а не случиться: за краем полей нет, и выборка обязана
// сказать «не знаю», а не завернуться на другую сторону и не выдать ноль.
{
  const far = 100000;
  check('за краем участка выборки отвечают «не знаю»',
    t.ground(far, far) === null && t.shore(far, far) === null &&
    t.fetch(far, far, 0) === null && t.skyline(far, far, 0) === null);
  check('за краем не заворачивается на другую сторону',
    t.ground(-far, 0) === null && t.ground(0, -far) === null);
}

console.log('\n' + (failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
