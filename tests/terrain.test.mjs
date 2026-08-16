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
import { Terrain, fetchFactor, shelterFactor, channelTurn,
         WIND_SHORE_A, WIND_SHORE_L } from '../sim/terrain.js';
import { Boat } from '../sim/physics.js';

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
  // Спрашивается ЗЕМЛЯ, а не верх покрова: покров в страницу больше не
  // вклеивается — рисование переехало в запечённую карту, — и пакет несёт
  // отдельным числом землю под той же точкой. Проверка от этого не ослабла:
  // место то же, единственное на участке, и попасть в него можно только с
  // верными осями.
  const [hx, hy] = pack.high_point;
  const got = t.ground(hx, hy);
  console.log('  высшая точка: пакет %s м земли (верх покрова %s м), выборка %s м',
    pack.high_ground_m.toFixed(1), pack.top_max.toFixed(1), got.toFixed(1));
  check('в высшей точке выборка сходится с пакетом',
    Math.abs(got - pack.high_ground_m) < 1.0,
    (got - pack.high_ground_m).toFixed(2) + ' м');
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

// --- разгон в лавировку -------------------------------------------------------
//
// То, ради чего акватория и заводилась. На бесконечной воде разгон — одно число
// на всю лодку, и лавировка на ней симметрична. На реке он зависит от места, и
// оба галса одного колена оказываются в разных состояниях моря.
//
// Числа ниже сняты с этого участка, а не назначены.
{
  const [ox, oy] = pack.open_water;
  // Ветер вдоль реки: на середине плёса разгон в километрах, у берега его нет.
  const mid = t.fetch(ox, oy, 0);
  const bankN = t.fetch(ox, oy + 600, 0), bankS = t.fetch(ox, oy - 600, 0);
  console.log('  ветер вдоль реки: середина %s м, у северного берега %s м, у южного %s м',
    mid.toFixed(0), bankN.toFixed(0), bankS.toFixed(0));
  check('у берега при ветре вдоль реки волне расти негде',
    bankN < 100 && bankS < 100, bankN.toFixed(0) + ' и ' + bankS.toFixed(0) + ' м');

  // Ветер под углом к реке — и вот тут разница между галсами. Поперёк сечения
  // разгон меняется в разы: один галс уводит на затишную сторону, другой на
  // разогнанную.
  const across = [];
  for (let d = -450; d <= 450; d += 150) across.push(t.fetch(ox, oy + d, 30 * D));
  console.log('  ветер под 30° к реке, разгон поперёк сечения, м: ' +
    across.map(v => v.toFixed(0)).join(' '));
  const hi = Math.max(...across), lo = Math.min(...across);
  check('при косом ветре разгон поперёк сечения меняется в разы',
    hi / Math.max(1, lo) > 3, (hi / Math.max(1, lo)).toFixed(1) + ' раза');

  // Вверх по реке навстречу ветру разгон убывает: воды впереди остаётся меньше.
  const up = [];
  for (let d = 0; d <= 3000; d += 750) up.push(t.fetch(ox + d, oy, 0));
  console.log('  вверх по реке навстречу ветру, м: ' + up.map(v => v.toFixed(0)).join(' ') + '\n');
  check('навстречу ветру разгон убывает монотонно',
    up.every((v, i) => i === 0 || v < up[i - 1]), up[0].toFixed(0) + ' → ' + up[up.length - 1].toFixed(0));
}

// --- то же, но лодкой ----------------------------------------------------------
//
// Поле полем, а проверять надо, что оно доехало до физики и там что-то поменяло.
{
  const PACK_P = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
  const [ox, oy] = pack.open_water;
  const run = (x, y, over) => {
    const b = new Boat(PACK_P, t);
    Object.assign(b.o, { windSpeed: 8, windDir: 30 * D, sheet: 14 * D, twist: 8 * D,
                         crewHike: -1, crewMass: 240, fetchOverride: over, fetch: 3000 });
    b.x = x; b.y = y; b.psi = 30 * D - 45 * D; b.u = 3; b.phi = 12 * D;
    for (let i = 0; i < 50 * 30; i++) b.step(1 / 30);
    return b;
  };
  const rough = run(ox, oy - 450, false);      // разогнанная сторона
  const calm = run(ox, oy + 450, false);       // затишная
  console.log('  лодка в бейдевинд, ветер под 30° к реке:');
  console.log('    на разогнанной стороне: разгон %s м, %s уз',
    rough.telemetry.fetchM.toFixed(0), rough.telemetry.speedKn.toFixed(2));
  console.log('    на затишной:            разгон %s м, %s уз',
    calm.telemetry.fetchM.toFixed(0), calm.telemetry.speedKn.toFixed(2));
  check('разгон доехал до физики и он разный',
    rough.telemetry.fetchField && calm.telemetry.fetchField &&
    rough.telemetry.fetchM > 2 * calm.telemetry.fetchM);
  check('на затишной стороне лодка идёт быстрее',
    calm.telemetry.speedKn > rough.telemetry.speedKn + 0.02,
    (calm.telemetry.speedKn - rough.telemetry.speedKn).toFixed(2) + ' узла');

  // Переопределение обязано отменять поле целиком.
  {
    const over = run(ox, oy - 450, true);
    console.log('    с переопределением:     разгон %s м, %s уз\n',
      over.telemetry.fetchM.toFixed(0), over.telemetry.speedKn.toFixed(2));
    check('переопределение отменяет поле',
      !over.telemetry.fetchField && over.telemetry.fetchM === 3000);
  }

  // За краем участка поле молчит, и разгон берётся из опции — то есть лодка
  // ведёт себя ровно так, как если бы акватории не было вовсе.
  {
    const out = run(60000, 60000, false);
    check('за краем участка разгон берётся из опции',
      !out.telemetry.fetchField && out.telemetry.fetchM === 3000);
  }
}

// --- берег и мель --------------------------------------------------------------
//
// Берег — единственное твёрдое ограничение на всей акватории: он снят с OSM.
// Мель выдумана целиком, и потому ведёт себя мягко: цепляет, но не
// останавливает. Отсюда и проверки разные: берег обязан не пустить, мель —
// затормозить и отпустить.
{
  const PACK_P = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
  const [ox, oy] = pack.open_water;

  // Нормаль берега смотрит В ВОДУ: к югу от середины плёса берег южный, значит
  // нормаль там глядит на север.
  {
    let ys = oy;
    while (t.shore(ox, ys) > 3 && ys > oy - 3000) ys -= 10;
    const n = t.shoreNormal(ox, ys, { x: 0, y: 0 });
    console.log('  у южного берега (y = %s): расстояние %s м, нормаль (%s, %s)',
      ys.toFixed(0), t.shore(ox, ys).toFixed(1), n.x.toFixed(2), n.y.toFixed(2));
    check('нормаль берега смотрит в воду', n.y > 0.5, n.y.toFixed(2));
  }

  // Урез наветренного берега: от него отмеряются обе пробы ниже.
  let ys0 = oy;
  while (t.shore(ox, ys0) > 3 && ys0 < oy + 3000) ys0 += 5;

  // Лодка, направленная в берег, обязана остановиться и не пройти сквозь.
  {
    const b = new Boat(PACK_P, t);
    // Курс к ветру ровно фордевинд: экипаж сидит в лодке, а не на борту.
    Object.assign(b.o, { windSpeed: 8, windDir: 90 * D, sheet: 24 * D,
                         crewHike: 0, crewMass: 240 });
    b.x = ox; b.y = oy; b.psi = -Math.PI / 2; b.u = 4;   // носом на юг, к берегу
    let worst = 1e9;
    for (let i = 0; i < 400 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * (-Math.PI / 2 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
      const d = t.shore(b.x, b.y);
      if (d !== null && d < worst) worst = d;
    }
    console.log('  лодка носом в берег, 400 с: ближе всего подошла на %s м, стоит на %s м',
      worst.toFixed(2), t.shore(b.x, b.y).toFixed(2));
    // Не «где-то около берега», а ровно на урезе: ограничение позиционное, и
    // просочиться сквозь него нельзя даже за четыреста секунд упирания. Гасить
    // одну лишь скорость было мало — у изогнутого берега лодка уползала внутрь
    // по сантиметрам, зато безостановочно.
    check('в берег лодка не проходит', worst > 1.0, worst.toFixed(2) + ' м');
    check('и стоит там же, а не оседает внутрь', t.shore(b.x, b.y) > 1.0);
  }

  // Мель. Профиль её — чистая функция места, и меряется он как функция: глубина
  // кладётся линейной от расстояния до берега, а торможение включается, когда
  // под килём меньше двух осадок. Ни то, ни другое не снято с промеров —
  // промеров у нас нет вовсе, — и потому мель остаётся инструментом, а не
  // моделью: она обязана предупредить, что здесь мелко, и не притворяться, что
  // знает, насколько.
  {
    const probe = d => {
      const b = new Boat(PACK_P, t);
      Object.assign(b.o, { windSpeed: 8, windDir: 90 * D, sheet: 24 * D });
      b.x = ox; b.y = ys0 + d; b.u = 2;
      b.step(1 / 30);
      return { m: b.telemetry.shoreM, k: b.telemetry.shoalK };
    };
    const prof = [-120, -60, -40, -25, -12, 0, 8].map(probe);
    console.log('  мель поперёк отмели, до берега → доля торможения:');
    console.log('    ' + prof.map(q => q.m.toFixed(0) + ' м: ' + q.k.toFixed(2)).join('   '));
    check('на глубине мель не чувствуется вовсе', prof[0].k === 0);
    check('к берегу мель нарастает монотонно',
      prof.every((q, i) => i === 0 || q.k >= prof[i - 1].k - 1e-12));
    check('на суше тормозит в полную силу', prof[prof.length - 1].k === 1);
  }

  // Вдоль берега лодка идёт свободно: гасится только составляющая в сторону
  // суши, и мель не останавливает, а цепляет.
  //
  // Померить одну лишь мель ходовым опытом нельзя, и делать вид, что померена
  // она, было бы неправдой: у берега на лодку разом действуют мель и ветровая
  // тень, и разделить их можно только выключив одну из них. Здесь проверяется
  // то, что и должно: у берега заметно медленнее, но лодка идёт.
  {
    const run = y0 => {
      const b = new Boat(PACK_P, t);
      Object.assign(b.o, { windSpeed: 8, windDir: 90 * D, sheet: 24 * D,
                           fetchOverride: true, fetch: 0,
                           crewHike: -1, crewMass: 240 });
      b.x = ox; b.y = y0; b.psi = 0; b.u = 4;
      for (let i = 0; i < 60 * 30; i++) {
        b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * (0 - b.psi) - 0.9 * b.r)));
        b.step(1 / 30);
      }
      return b;
    };
    // У НАВЕТРЕННОГО берега: у подветренного за минуту дрейф прижмёт лодку к
    // урезу, она упрётся в ограничение и встанет — и померен будет не ход у
    // берега, а берег. Это, кстати, ровно то, чем подветренный берег и опасен.
    const near = run(ys0 - 12), far = run(oy);
    console.log('  вдоль берега 60 с, волнение выключено:');
    console.log('    на середине (%s м до берега): %s уз, ветер ×%s, мель %s',
      far.telemetry.shoreM.toFixed(0), far.telemetry.speedKn.toFixed(2),
      far.telemetry.windK.toFixed(2), far.telemetry.shoalK.toFixed(2));
    console.log('    у берега    (%s м до берега): %s уз, ветер ×%s, мель %s\n',
      near.telemetry.shoreM.toFixed(0), near.telemetry.speedKn.toFixed(2),
      near.telemetry.windK.toFixed(2), near.telemetry.shoalK.toFixed(2));
    check('вдоль берега лодка идёт, а не цепляется',
      near.telemetry.speedKn > 1.5, near.telemetry.speedKn.toFixed(2) + ' уз');
    check('у берега заметно медленнее, чем на середине',
      near.telemetry.speedKn < far.telemetry.speedKn - 0.05,
      (far.telemetry.speedKn - near.telemetry.speedKn).toFixed(2) + ' узла');
  }
}

// --- ветер: восстановление после берега ----------------------------------------
//
// Выходя с суши на воду, поток разгоняется не сразу: над водой нарастает
// внутренний пограничный слой. Расстояние здесь то же самое, что для разгона
// волны, — одно поле, два применения.
//
// Проверяется не величина (её задаёт подгоняемый множитель), а форма: профиль
// обязан расти МОНОТОННО от берега к середине, без ям. Яма означала бы ошибку в
// трассировке поля.
{
  const [ox, oy] = pack.open_water;
  const PACK_P = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
  // Проба ставит лодку в точку и делает один шаг: множители считаются раз в шаг
  // и наружу выходят телеметрией, поэтому мерить их надо лодкой, а не формулой.
  const at = (y, dir, opt) => {
    const b = new Boat(PACK_P, t);
    b.o.windSpeed = 6; b.o.windDir = dir;
    Object.assign(b.o, opt || {});
    b.x = ox; b.y = y; b.u = 0.1;
    b.step(1 / 30);
    return b.telemetry;
  };
  // Урезы обоих берегов на поперечнике через середину плёса.
  let yn = oy; while (t.shore(ox, yn) > 3 && yn < oy + 3000) yn += 10;
  let ysh = oy; while (t.shore(ox, ysh) > 3 && ysh > oy - 3000) ysh -= 10;

  // Разгон после берега проверяется отдельно от тени, и вот почему: он обязан
  // расти МОНОТОННО — яма означала бы ошибку в трассировке поля, — а тень не
  // обязана вовсе. Тень считается по наибольшему отношению высоты к дальности, и
  // у настоящего берега оно не монотонно: у самого уреза видна низкая кромка, а
  // с полусотни метров из-за неё выходит бровка. Требовать монотонности от
  // произведения значило бы требовать её от формы берега.
  const prof = [];
  for (let d = 0; d <= 500; d += 50) {
    const q = at(yn - d, 90 * D);
    prof.push({ k: q.windK, sh: q.shelter, f: q.windK / q.shelter });
  }
  console.log('  ветер с севера, от наветренного берега к середине:');
  console.log('    разгон  ' + prof.map(v => v.f.toFixed(3)).join(' '));
  console.log('    тень    ' + prof.map(v => v.sh.toFixed(3)).join(' '));
  console.log('    вместе  ' + prof.map(v => v.k.toFixed(3)).join(' '));
  check('разгон после берега восстанавливается монотонно',
    prof.every((v, i) => i === 0 || v.f >= prof[i - 1].f - 1e-9));
  check('у самого берега ветер заметно слабее',
    prof[0].k < prof[prof.length - 1].k - 0.05,
    ((1 - prof[0].k) * 100).toFixed(0) + '% против ' +
    ((1 - prof[prof.length - 1].k) * 100).toFixed(0) + '%');
  // А вот полного восстановления ПОПЕРЁК реки не наступает вовсе, и это не
  // изъян, а следствие: разгон поперёк ограничен шириной плёса, и множитель на
  // середине упирается в свой километр. Ветер над рекой в поперечном
  // направлении слабее берегового везде — в том числе на фарватере.
  const cross = prof[prof.length - 1].f;
  console.log('    поперёк реки даже на середине остаётся %s%% нехватки\n',
    ((1 - cross) * 100).toFixed(0));
  check('поперёк реки ветер до конца не восстанавливается',
    cross > 0.8 && cross < 0.95, cross.toFixed(3));

  // Восстанавливается он ВДОЛЬ реки, где разгона километры. Это и есть проверка
  // того, что множитель стремится к единице, а не застревает.
  const along = at(oy, 0).windK / at(oy, 0).shelter;
  console.log('    вдоль реки на середине плёса: %s (разгон %s км)\n',
    along.toFixed(3), (t.fetch(ox, oy, 0) / 1000).toFixed(1));
  check('вдоль реки разгон восстанавливается полностью', along > 0.98, along.toFixed(3));

  // --- тень берега -----------------------------------------------------------
  //
  // То, ради чего этап и делался. Правый берег здесь высокий, левый низкий, и
  // это не симметрия, а главное свойство места: под высоким берегом дует хуже и
  // хуже он дует ДАЛЬШЕ. Отсюда и берётся речная привычка ходить одним бортом.
  //
  // Числа D₀ и k подгоняются глазом на воде, поэтому проверяется не их
  // величина, а то, что модель отвечает на форму берега, а не на что попало.
  {
    const bank = (y0, step, dir) => {
      const out = [];
      for (const d of [0, 200, 400, 800, 1200]) out.push(at(y0 - step * d, dir).shelter);
      return out;
    };
    const low = bank(yn, 1, 90 * D);         // ветер с севера, берег низкий
    const high = bank(ysh, -1, -90 * D);     // ветер с юга, берег высокий
    console.log('  укрытие от берега вглубь плёса (0 200 400 800 1200 м):');
    console.log('    низкий левый  ' + low.map(v => v.toFixed(3)).join(' '));
    console.log('    высокий правый ' + high.map(v => v.toFixed(3)).join(' '));
    check('под высоким берегом укрытие сильнее', high[0] < low[0] - 0.05,
      high[0].toFixed(3) + ' против ' + low[0].toFixed(3));
    check('и тянется дальше', high[3] < low[3] - 0.1,
      'на 800 м ' + high[3].toFixed(3) + ' против ' + low[3].toFixed(3));
    check('вглубь плёса тень слабеет', high[4] > high[0] + 0.1);

    // За обрывом поток не просто слабее, он рванее — тем же множителем.
    const q = at(ysh, -90 * D);
    const open = at(oy, 0);
    console.log('  рваность: под высоким берегом ×%s, на середине вдоль реки ×%s\n',
      q.gustK.toFixed(2), open.gustK.toFixed(2));
    check('в тени поток рванее', q.gustK > open.gustK + 0.2);

    // Выключенные ползунки обязаны выключать эффект целиком: без этого ни
    // сравнить с прежним, ни понять, чего стоит сама тень.
    const off = at(ysh, -90 * D, { shadeD0: 0 });
    check('D₀ = 0 отменяет тень полностью',
      off.shelter === 1 && off.gustK === 1, off.shelter.toFixed(3));

    // Карта для отрисовки обязана говорить то же, что силы на лодке. Расходятся
    // такие пары молча: физика считает одно, картинка показывает другое, и
    // подгонка по картинке подгоняет не то. Здесь они сверяются числом.
    const o = { a: WIND_SHORE_A, l: WIND_SHORE_L, d0: 0.5, k: 10 };
    const map = t.windMap(-90 * D, o, new Uint8Array(2 * t.cells));
    // Сверять надо в УЗЛАХ крупной сетки: карта считается по узлам, а выборка
    // интерполирует между ними, и между узлами они законно расходятся.
    let worst = 0, worstSh = 0;
    for (const y of [ysh + 40, ysh + 200, ysh + 500, oy, yn - 200, yn - 40]) {
      const i = Math.round((ox - pack.x0) / pack.coarse);
      const j = Math.round((y - pack.y0) / pack.coarse);
      const c = 2 * (j * pack.cnx + i);
      const nx = pack.x0 + i * pack.coarse, ny = pack.y0 + j * pack.coarse;
      const wantSh = shelterFactor(t.skyline(nx, ny, -90 * D), o.d0, o.k);
      const want = fetchFactor(t.fetch(nx, ny, -90 * D), o.a, o.l) * wantSh;
      worst = Math.max(worst, Math.abs(map[c] / 255 - want));
      worstSh = Math.max(worstSh, Math.abs(map[c + 1] / 255 - wantSh));
    }
    console.log('  карта для отрисовки против выборки: ветер до %s, укрытие до %s\n',
      worst.toFixed(4), worstSh.toFixed(4));
    // Расхождение только от округления до байта — половина деления, 1/510.
    check('карта ветра совпадает с выборкой', worst < 1 / 400 && worstSh < 1 / 400,
      Math.max(worst, worstSh).toFixed(4));
  }
}

// --- течение -------------------------------------------------------------------
//
// Данных нет и взять их неоткуда: течение здесь выдумано целиком. Но выдумано
// не правилами, а решением: расход сохраняется, и всё остальное выходит из
// этого само. Поэтому и проверяется здесь не величина — её задаёт ползунок, —
// а те свойства, которые обязаны следовать из сохранения расхода.
{
  const [ox, oy] = pack.open_water;
  const PACK_P = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
  const U = 0.55, v = { x: 0, y: 0 };
  const at = (x, y) => { t.current(x, y, U, v); return Math.hypot(v.x, v.y); };

  // Поперёк плёса: на фарватере полная, у берега заметно тише. Это не
  // затухание, приписанное сверху, а множитель h^(2/3) от того же условного
  // дна, что и у мели, — Маннинг, а не выдумка поверх выдумки.
  const cross = [];
  for (let d = -500; d <= 500; d += 100) cross.push({ d, s: at(ox, oy + d), m: t.shore(ox, oy + d) });
  console.log('  течение поперёк плёса при стрежне %s м/с:', U);
  console.log('    ' + cross.map(q => q.s.toFixed(2)).join(' '));
  const mid = cross.find(q => q.d === 0), edge = cross[cross.length - 1];
  console.log('    на фарватере %s уз, в %s м от берега %s уз\n',
    (mid.s * 1.94384).toFixed(2), edge.m.toFixed(0), (edge.s * 1.94384).toFixed(2));
  check('на фарватере течение около заданного на стрежне',
    Math.abs(mid.s - U) < 0.25 * U, mid.s.toFixed(2) + ' против ' + U);
  check('у берега течение заметно тише', edge.s < 0.6 * mid.s,
    (edge.s / mid.s).toFixed(2) + ' от фарватера');
  check('на суше течения нет вовсе', at(ox, oy - 1200) === 0);
  check('ползунок в ноль отменяет течение точно',
    Object.is(t.current(ox, oy, 0, v).x, 0) && Object.is(v.y, 0));

  // Сохранение расхода — то единственное, на чём всё держится. Считается оно по
  // сечениям поперёк реки: сумма v·h·dy обязана быть одной и той же, а ниже
  // устья притока — больше на его расход.
  const flux = x => {
    let q = 0;
    for (let y = -5000; y <= 5000; y += 20) {
      const d = t.shore(x, y);
      if (d === null || d <= 0) continue;
      t.current(x, y, U, v);
      q += Math.abs(v.x) * Math.min(6, d * 0.06) * 20;
    }
    return q;
  };
  const below = [-2000, 0, 2000, 4000].map(flux);
  const above = flux(-6000);
  console.log('  расход через сечения, м³/с: выше устья %s, ниже %s',
    above.toFixed(0), below.map(q => q.toFixed(0)).join(' '));
  const lo = Math.min(...below), hi = Math.max(...below);
  console.log('    ниже устья разброс %s%%\n', ((hi / lo - 1) * 100).toFixed(0));
  check('ниже устья расход постоянен по длине', hi / lo < 1.15,
    ((hi / lo - 1) * 100).toFixed(0) + '%');
  check('приток добавляет расход', above < 0.85 * lo,
    (above / lo).toFixed(2) + ' от нижнего');

  // И то, ради чего течение вообще заводилось: над грунтом и через воду — не
  // одно и то же. Гидродинамика этого не замечает, аэродинамика и положение —
  // замечают, и на реке между двумя скоростями узел с лишним.
  //
  // Ветер СЗАДИ, и это не мелочь постановки — это условие самого эффекта.
  //
  // Прежде здесь стоял ветер в борт (с севера при курсе на восток) и шкот 24°.
  // Проверка проходила, но мерила не то, что заявляла. Течение здесь идёт под
  // 8°, то есть почти точно по курсу и ПОПЕРЁК борового ветра: убегания от
  // ветра нет вовсе, а кажущийся ветер от прибавки хода над грунтом не падает,
  // а РАСТЁТ — 11.6 против 12.7 узла. Проходила проверка на другом: шкот 24°
  // при кажущемся ветре 85° ставит все двенадцать полосок на 55…61° угла атаки,
  // то есть загоняет весь риг в глубокий срыв, и знак получался оттуда. На
  // нормально настроенном шкоте (50…60°, угол атаки 0…32°) та же проверка на
  // том же коде даёт +1.5 узла — то есть утверждение нарушалось.
  //
  // С ветром сзади всё на своих местах: течение действительно уносит от ветра,
  // кажущийся ветер падает (8.68 -> 7.82 узла), и ход через воду сбавляет на
  // 0.24 узла вместо прежних 0.06. Запас вчетверо больше, а главное — поймать
  // знак срывом больше нельзя: механизм проверяется отдельно, ниже.
  const run = cur => {
    const b = new Boat(PACK_P, t);
    Object.assign(b.o, { windSpeed: 8, windDir: 180 * D, sheet: 80 * D,
                         current: cur, crewHike: -1, crewMass: 240 });
    b.x = ox; b.y = oy; b.psi = 0; b.u = 4;
    for (let i = 0; i < 90 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * (0 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    return b.telemetry;
  };
  const with_ = run(U), without = run(0);
  console.log('  90 с курсом на восток, ветер попутный:');
  console.log('    без течения:  через воду %s уз, над грунтом %s уз, кажущийся %s уз',
    without.speedKn.toFixed(2), without.sogKn.toFixed(2), without.awsKn.toFixed(2));
  console.log('    с течением:   через воду %s уз, над грунтом %s уз, кажущийся %s уз, снос %s уз под %s°\n',
    with_.speedKn.toFixed(2), with_.sogKn.toFixed(2), with_.awsKn.toFixed(2),
    with_.curKn.toFixed(2), (Math.atan2(with_.curY, with_.curX) / D).toFixed(0));
  check('без течения над грунтом и через воду — одно и то же',
    Math.abs(without.sogKn - without.speedKn) < 1e-9);
  check('с течением они расходятся',
    Math.abs(with_.sogKn - with_.speedKn) > 0.5,
    (with_.sogKn - with_.speedKn).toFixed(2) + ' узла');
  // МЕХАНИЗМ, и он проверяется раньше следствия: убегая от ветра вместе с водой,
  // лодка теряет кажущийся ветер. Без этой проверки знак у следствия можно
  // получить откуда угодно — например из срыва, как и получалось.
  check('попутное течение съедает кажущийся ветер',
    with_.awsKn < without.awsKn - 0.5,
    (with_.awsKn - without.awsKn).toFixed(2) + ' узла кажущегося');
  // И следствие: над грунтом быстрее, а через воду МЕДЛЕННЕЕ. Это и есть тот
  // самый эффект, ради которого на реке лавируют не как на озере.
  check('попутное течение сбавляет ход через воду',
    with_.sogKn > without.sogKn && with_.speedKn < without.speedKn,
    (with_.speedKn - without.speedKn).toFixed(2) + ' узла через воду');
}

// --- канализация потока --------------------------------------------------------
//
// Ось берётся из РЕЛЬЕФА, а не из реки: канализацию делает долина, а река в
// широкой пойме может гулять поперёк неё. Поэтому первое, что проверяется, —
// что ось всё-таки сошлась с осью реки там, где стена есть, и разошлась там,
// где её нет. Иначе структурный тензор ловил бы не долину, а что попало.
//
// На этой карте рек две, и сходятся они под большим углом. Это не осложнение, а
// проверка: две долины обязаны иметь две разные оси, и ни одна не должна
// размазаться по другой.
{
  const [ox, oy] = pack.open_water;
  const PACK_P = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
  const ax = { x: 0, y: 0 }, cv = { x: 0, y: 0 };
  const axis = (x, y) => {
    t.channel(x, y, ax);
    const a = Math.hypot(ax.x, ax.y);
    return { a, deg: ((0.5 * Math.atan2(ax.y, ax.x) / D) % 180 + 180) % 180 };
  };
  const river = (x, y) => {
    t.current(x, y, 1, cv);
    if (Math.hypot(cv.x, cv.y) < 0.05) return null;
    return ((Math.atan2(cv.y, cv.x) / D) % 180 + 180) % 180;
  };
  const gap = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };

  const spots = [[ox, oy, 'Волга, середина плёса'], [-2000, 1200, 'Волга выше'],
                 [4000, -1500, 'Волга ниже'], [-4340, -5000, 'Ока, юг'],
                 [-4500, -3000, 'Ока выше устья'], [-4600, -1000, 'Ока у устья']];
  console.log('  ось долины против оси реки:');
  let worst = 0;
  for (const [x, y, name] of spots) {
    const v = axis(x, y), r = river(x, y);
    if (r === null) continue;
    const d = gap(v.deg, r);
    if (v.a > 0.5) worst = Math.max(worst, d);
    console.log('    ' + name.padEnd(22) + ' долина ' + v.deg.toFixed(0).padStart(3) +
      '°, река ' + r.toFixed(0).padStart(3) + '°, расхождение ' + d.toFixed(0).padStart(2) +
      '°, сила ' + v.a.toFixed(2));
  }
  check('там, где долина выражена, её ось совпадает с осью реки', worst < 20,
    'наибольшее расхождение ' + worst.toFixed(0) + '°');

  // Две реки — две оси. Ока здесь течёт почти на север, Волга почти на восток.
  const volga = axis(ox, oy), oka = axis(-4500, -3000);
  console.log('  Волга %s° (сила %s), Ока %s° (сила %s), между ними %s°\n',
    volga.deg.toFixed(0), volga.a.toFixed(2), oka.deg.toFixed(0), oka.a.toFixed(2),
    gap(volga.deg, oka.deg).toFixed(0));
  check('у двух рек две разные оси', gap(volga.deg, oka.deg) > 45,
    gap(volga.deg, oka.deg).toFixed(0) + '°');
  check('обе долины выражены', volga.a > 0.5 && oka.a > 0.5,
    volga.a.toFixed(2) + ' и ' + oka.a.toFixed(2));

  // Поворот ветра. Проверяется форма: вдоль оси не крутит, поперёк крутит
  // сильнее всего, ноль на ползунке отменяет всё.
  const turn = (dirDeg, k) => {
    t.channel(ox, oy, ax);
    return channelTurn(ax.x, ax.y, dirDeg * D, k) / D;
  };
  const along = volga.deg;
  console.log('  поворот ветра на середине плёса при k = 0.5:');
  const rows = [0, 30, 60, 89, 91, 120, 150].map(o => [o, turn(along + o, 0.5)]);
  console.log('    от оси, °: ' + rows.map(q => q[0]).join(' '));
  console.log('    поворот, °: ' + rows.map(q => q[1].toFixed(0)).join(' ') + '\n');
  check('вдоль оси канализация ничего не меняет', Math.abs(turn(along, 0.5)) < 0.5);
  check('поперёк оси поворот наибольший',
    Math.abs(rows[2][1]) > Math.abs(rows[1][1]) && Math.abs(rows[1][1]) > Math.abs(rows[0][1]));
  check('поворот всегда к оси, а не от неё',
    rows.every(q => Math.abs(gap(along + q[0] + q[1], along)) <= Math.abs(gap(along + q[0], along)) + 1e-9));
  check('за перпендикуляром ветер ложится на другой конец оси',
    rows[3][1] > 0 !== rows[4][1] > 0,
    rows[3][1].toFixed(0) + '° против ' + rows[4][1].toFixed(0) + '°');
  check('скачок на перпендикуляре ограничен', Math.abs(rows[3][1] - rows[4][1]) < 60,
    Math.abs(rows[3][1] - rows[4][1]).toFixed(0) + '°');
  check('ползунок в ноль отменяет канализацию', turn(along + 60, 0) === 0);

  // И то же самое лодкой: канализация обязана доходить до паруса, а не только до
  // числа в телеметрии.
  //
  // Курс при этом ДЕРЖИТСЯ рулём. Раньше руль был брошен, и две лодки за сорок
  // секунд просто расходились по курсу: сравнивался не заворот ветра, а то, куда
  // каждую из них увело. Мерилось это соответственно неустойчиво — разница
  // гуляла от пяти градусов до одиннадцати от одной правки сил к другой, хотя
  // сам заворот держится своих девятнадцати.
  const run = k => {
    const b = new Boat(PACK_P, t);
    // Ветер здесь стоит под углом к реке, и наветренный борт зависит от её оси:
    // при TWA больше 180° он меняется на противоположный.
    const twa = ((along + 60) % 360 + 360) % 360;
    Object.assign(b.o, { windSpeed: 8, windDir: (along + 60) * D, sheet: 24 * D,
                         chan: k, current: 0, crewMass: 240,
                         crewHike: twa > 180 ? 1 : -1 });
    b.x = ox; b.y = oy; b.psi = 0; b.u = 4;
    for (let i = 0; i < 40 * 30; i++) {
      b.o.rudder = Math.max(-25 * D, Math.min(25 * D, -(2.5 * (0 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    return b.telemetry;
  };
  const on = run(0.5), off = run(0);
  console.log('  ветер под 60° к долине, 40 с на курсе:');
  console.log('    без канализации: кажущийся %s°, %s уз', off.awaDeg.toFixed(0),
    off.speedKn.toFixed(2));
  console.log('    с канализацией:  кажущийся %s°, %s уз, ветер завернуло на %s°\n',
    on.awaDeg.toFixed(0), on.speedKn.toFixed(2), on.chanDeg.toFixed(0));
  check('канализация разворачивает ветер у лодки',
    Math.abs(on.chanDeg) > 10, on.chanDeg.toFixed(0) + '°');
  check('и это меняет угол кажущегося ветра',
    Math.abs(on.awaDeg - off.awaDeg) > 5,
    (on.awaDeg - off.awaDeg).toFixed(0) + '°');
  check('без акватории канализации нет вовсе',
    new Boat(PACK_P).chanRot === 0);
}

console.log('\n' + (failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
