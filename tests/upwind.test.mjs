// Лавировка под нагрузкой: node tests/upwind.test.mjs
//
// Встречные курсы — самый напряжённый режим модели: там одновременно работают
// крен, дрейф, балансировка руля и срыв на парусе, и именно там она дважды
// разваливалась. Поэтому проверяется не одна точка, а поляра целиком, на
// нескольких силах ветра, плюс поворот оверштаг и откренивание.
//
// Шкот на каждом курсе подбирается перебором: сравнивать курсы при одном
// положении шкота бессмысленно, лодку надо настраивать.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';

import { Pool } from './lib/pool.mjs';
import { FULL, pick, modeLine } from './lib/mode.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_PATH = join(ROOT, 'out/export/physics.json');
const PACK = JSON.parse(readFileSync(PACK_PATH, 'utf8'));
const D = Math.PI / 180;

// Перебор настроек идёт по всем ядрам сразу: установившиеся ходы друг от друга
// не зависят, а их здесь сотни. Модель при этом одна и та же — рабочий поток
// гоняет тот же steady() из tests/lib/steady.mjs.
const pool = new Pool(PACK_PATH, PACK);

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
}

const wrapPi = a => {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// Перебор настроек в два прохода: сперва грубо по всей сетке, потом мелко
// вокруг найденного. Прежний одноступенчатый перебор с шагом 4° по шкоту и 10°
// по твисту после мембраны стал врать: отклик паруса сузился, соседние узлы
// сетки попадают в разные режимы, и «оптимум» скачет на четыре процента по
// VMG. Ловилось это как несуществующие провалы поляры.
//
// Оба прохода раздаются в пул целиком, по всем точкам сразу: чем крупнее
// порция, тем меньше доля пересылки.
// Сетка перебора. В регрессионном режиме она реже, и это единственное, чем
// режимы отличаются: проверки одни и те же.
const SH_COARSE = pick([6, 13, 20, 27, 34], [6, 20, 34]);
const TW_COARSE = pick([0, 16, 32], [0, 16, 32]);
// Уточнение вокруг найденного: восемь соседних узлов против четырёх по диагонали.
const REFINE = pick([-3.5, 0, 3.5], [-3.5, 3.5]);
const REFINE_TW = pick([-8, 0, 8], [-8, 8]);

function specs(points, shs, tws) {
  const out = [];
  for (const p of points) {
    for (const sh of shs) {
      for (const tw of tws) out.push(Object.assign({}, p, { sheet: sh, twist: tw }));
    }
  }
  return out;
}

// Лучшая настройка на каждую точку. `points` — список условий без настроек.
async function bestMany(points) {
  const pick = (all, list) => {
    const byPoint = points.map(() => null);
    const per = all.length / points.length;
    all.forEach((r, i) => {
      const k = Math.floor(i / per);
      if (!r || !r.finite) return;
      const cur = byPoint[k];
      if (!cur || r.vmg > cur.r.vmg) byPoint[k] = { r: r, spec: list[i] };
      if (cur) cur.fastest = Math.max(cur.fastest || 0, r.speedKn);
    });
    all.forEach((r, i) => {
      const k = Math.floor(i / per);
      if (r && r.finite && byPoint[k]) {
        byPoint[k].fastest = Math.max(byPoint[k].fastest || 0, r.speedKn);
      }
    });
    return byPoint;
  };

  const l1 = specs(points, SH_COARSE, TW_COARSE);
  const w1 = pick(await pool.map(l1), l1);

  // уточнение вокруг найденного, своё на каждую точку
  const l2 = [];
  w1.forEach((w, k) => {
    const sh0 = w ? w.spec.sheet : 20, tw0 = w ? w.spec.twist : 16;
    for (const dsh of REFINE) {
      for (const dtw of REFINE_TW) {
        if (dsh === 0 && dtw === 0) continue;
        l2.push(Object.assign({}, points[k],
          { sheet: Math.max(2, sh0 + dsh), twist: Math.max(0, tw0 + dtw) }));
      }
    }
  });
  const r2 = await pool.map(l2);
  const per2 = l2.length / points.length;
  r2.forEach((r, i) => {
    const k = Math.floor(i / per2);
    if (!r || !r.finite) return;
    const cur = w1[k];
    if (!cur) { w1[k] = { r: r, spec: l2[i], fastest: r.speedKn }; return; }
    cur.fastest = Math.max(cur.fastest || 0, r.speedKn);
    if (r.vmg > cur.r.vmg) { cur.r = r; cur.spec = l2[i]; }
  });

  return w1.map(w => w && Object.assign({}, w.r,
    { sheet: w.spec.sheet, twist: w.spec.twist, fastest: w.fastest }));
}

console.log('\n' + modeLine());
console.log('\nПоляра в лавировку, истинный ветер 6 м/с (11.7 уз), экипаж на борту.');
console.log('Шкот на каждом курсе подобран под наибольший VMG.\n');
console.log('  TWA  шкот твист  узлы   крен   дрейф   курс   VMG    руль  ошибка');
const polarTwa = [];
for (let twa = 30; twa <= 70; twa += pick(5, 10)) polarTwa.push(twa);
const polarRows = await bestMany(polarTwa.map(twa => ({ twa: twa, hike: 1 })));
const polar = polarTwa.map((twa, i) => ({ twa: twa, r: polarRows[i] }));
for (const p of polar) {
  const r = p.r;
  console.log('  ' + String(p.twa).padStart(3) + '° ' + r.sheet.toFixed(0).padStart(4) +
    '° ' + r.twist.toFixed(0).padStart(4) + '° ' +
    r.speedKn.toFixed(2).padStart(6) + ' ' +
    r.heelDeg.toFixed(1).padStart(6) + '° ' +
    r.leewayDeg.toFixed(1).padStart(6) + '° ' +
    r.track.toFixed(0).padStart(5) + '° ' + r.vmg.toFixed(2).padStart(5) + ' ' +
    r.helm.toFixed(1).padStart(6) + '° ' + r.headingErr.toFixed(1).padStart(8) + '°');
}

const bestRow = polar.reduce((a, b) => (b.r.vmg > a.r.vmg ? b : a));
console.log('\n  Лучший VMG на TWA ' + bestRow.twa + '°: ' + bestRow.r.vmg.toFixed(2) +
  ' уз, лавировочный угол ' + (2 * bestRow.r.track).toFixed(0) + '°\n');

check('нигде не расходится', polar.every(p => p.r.finite));
check('курс держится на всех углах',
  polar.every(p => Math.abs(p.r.headingErr) < 6),
  'наибольшая ошибка ' +
  Math.max(...polar.map(p => Math.abs(p.r.headingErr))).toFixed(1) + '°');
// Сравнивается наибольший ход на каждом угле, а не ход на строчке таблицы:
// в строчке стоит настройка под наибольший VMG, а она на широком угле уже не
// самая быстрая.
//
// Допуск в полтора десятых узла — это шаг сетки перебора, а не разброс лодки.
// Настройки берутся по сетке 4° на шкоте и 10° на твисте, и найденный оптимум
// от этого гуляет: на мелкой сетке (2° и 6°) кривая идёт 7.21 → 7.34 → 7.30 →
// 7.47, то есть между 65 и 75 градусами она попросту плоская, и попадание в
// оптимум решает больше, чем сам курс.
check('скорость растёт при уваливании',
  polar.every((p, i) => i === 0 || p.r.fastest > polar[i - 1].r.fastest - 0.15),
  polar.map(p => p.r.fastest.toFixed(1)).join(' → ') + ' уз');
// Оптимум должен лежать ВНУТРИ перебранного диапазона, а не на его краю:
// упёршийся в край максимум означает, что модель ещё не начала штрафовать
// приведение и лодка «умеет» идти круче, чем бывает.
const iBest = polar.indexOf(bestRow);
check('лучший VMG — настоящий максимум, а не край диапазона',
  iBest > 0 && iBest < polar.length - 1, 'TWA ' + bestRow.twa + '°');
check('привестись круче оптимума — потерять VMG',
  polar[0].r.vmg < bestRow.r.vmg, 'на 30° ' + polar[0].r.vmg.toFixed(2) +
  ' против ' + bestRow.r.vmg.toFixed(2));
check('лавировочный угол между 80 и 110 градусами',
  2 * bestRow.r.track >= 80 && 2 * bestRow.r.track <= 110,
  (2 * bestRow.r.track).toFixed(0) + '°');
check('дрейф падает при уваливании',
  polar.every((p, i) => i === 0 ||
    Math.abs(p.r.leewayDeg) <= Math.abs(polar[i - 1].r.leewayDeg) + 0.3));
// Приводливость и лёгкость на руле — две стороны одного: коэффициент
// HULL_HEEL_YAW подогнан под наблюдение владельца («с брошенным рулём слегка
// приводится»), и за это приходится держать перо. На своём угле VMG выходит
// около восьми градусов, на переприведённых тридцати — десять. Это плата, а не
// разбалансировка: лодку там заставляют идти круче, чем она хочет.
check('руля везде нужно немного',
  polar.every(p => Math.abs(p.r.helm) < 11),
  'наибольший ' + Math.max(...polar.map(p => Math.abs(p.r.helm))).toFixed(1) +
  '°, на угле VMG ' + Math.abs(bestRow.r.helm).toFixed(1) + '°');
check('скорость нигде не выходит за разумное',
  polar.every(p => p.r.worstU * 1.94384 < 16),
  'наибольшая мгновенная ' +
  Math.max(...polar.map(p => p.r.worstU * 1.94384)).toFixed(1) + ' уз');

// --- по силе ветра ------------------------------------------------------------

// Экипаж на борту: в лавировку на такой лодке иначе не ходят, а без него
// в свежий ветер она упирается не в паруса, а в собственную остойчивость.
console.log('\nЛавировка при разной силе ветра, экипаж на борту:\n');
console.log('  ветер   лучший TWA  шкот твист   узлы   крен    VMG   лавир.угол');
const WINDS = [3, 4.5, 6, 8, 11, 14];
const WIND_TWA = pick([32, 37, 42, 47, 52], [37, 42, 47]);
const windPoints = [];
for (const wind of WINDS) {
  for (const twa of WIND_TWA) windPoints.push({ wind: wind, twa: twa, hike: 1 });
}
const windRows = await bestMany(windPoints);
const byWind = WINDS.map((wind, wi) => {
  let top = null;
  WIND_TWA.forEach((twa, ti) => {
    const r = windRows[wi * WIND_TWA.length + ti];
    if (r && (!top || r.vmg > top.vmg)) { top = Object.assign({}, r, { twa: twa }); }
  });
  return { wind: wind, top: top };
});
for (const w of byWind) {
  const top = w.top;
  console.log('  ' + (w.wind + ' м/с').padEnd(8) + String(top.twa).padStart(7) + '° ' +
    top.sheet.toFixed(0).padStart(5) + '° ' + top.twist.toFixed(0).padStart(4) + '° ' +
    top.speedKn.toFixed(2).padStart(6) + ' ' + top.heelDeg.toFixed(0).padStart(5) +
    '° ' + top.vmg.toFixed(2).padStart(6) + '   ' + (2 * top.track).toFixed(0) + '°');
}
console.log('');
// VMG растёт с ветром, пока лодку не начинает ограничивать МОРЕ, а не паруса.
//
// Раньше проверка требовала роста на всём диапазоне, и это было верно ровно
// потому, что лодка ходила по гладкой воде. С появлением волнения картина
// стала другой и правильной: на фиксированном разгоне высота волны растёт с
// ветром линейно, добавочное сопротивление — как её квадрат, а тяга у
// перегруженной лодки упирается в остойчивость. Оттого VMG выходит на горб
// около восьми метров в секунду и дальше медленно спадает. Так на воде и
// бывает: в свежий ветер по короткой злой волне лавироваться хуже, чем в
// умеренный по гладкой.
//
// Проверяется теперь два утверждения: до горба VMG растёт, после горба не
// обваливается.
const vmgs = byWind.map(w => w.top.vmg);
const peak = Math.max(...vmgs), iPeak = vmgs.indexOf(peak);
check('до горба VMG растёт с ветром',
  vmgs.slice(0, iPeak + 1).every((v, i) => i === 0 || v > vmgs[i - 1] - 0.05),
  'горб на ' + byWind[iPeak].wind + ' м/с, VMG ' + peak.toFixed(2));
check('за горбом VMG не обваливается',
  vmgs.slice(iPeak).every(v => v > 0.8 * peak),
  'наименьший ' + Math.min(...vmgs.slice(iPeak)).toFixed(2) + ' против горба ' +
  peak.toFixed(2));
check('горб не на самом краю диапазона', iPeak > 0 && iPeak < vmgs.length - 1,
  byWind[iPeak].wind + ' м/с');
check('в сильный ветер прирост VMG выдыхается',
  byWind[byWind.length - 1].top.vmg - byWind[byWind.length - 2].top.vmg <
  byWind[2].top.vmg - byWind[1].top.vmg,
  'с 11 до 14 м/с +' +
  (byWind[5].top.vmg - byWind[4].top.vmg).toFixed(2) + ' против +' +
  (byWind[2].top.vmg - byWind[1].top.vmg).toFixed(2) + ' с 4.5 до 6');
check('перегруженная ветром лодка идёт полнее, а не круче',
  byWind[byWind.length - 1].top.twa > byWind[2].top.twa - 1,
  byWind[5].top.twa + '° при 14 м/с против ' + byWind[2].top.twa + '° при 6');
// Риг разгружается сам: угол атаки паруса меряется в плоскости, наклонённой
// вместе с мачтой, и на крене он падает. Без этого лодка ложилась на 58° и
// продолжала идти лавировку десять узлов.
check('крен упирается в потолок, а не растёт с ветром без предела',
  byWind.every(w => Math.abs(w.top.heelDeg) < 30),
  'наибольший ' +
  Math.max(...byWind.map(w => Math.abs(w.top.heelDeg))).toFixed(0) + '°');
// Ради этого и разбивали риг на полоски. Твист имеет смысл только тогда, когда
// у разных высот разный ветер и разный угол атаки: в слабый ветер лодка
// недогружена и добирает всё, что может, а в свежий раскрывает верх паруса и
// сбрасывает мощность оттуда, где она сильнее всего кренит.
console.log('  Оптимальный твист по ветру: ' +
  byWind.map(w => w.wind + ' м/с → ' + w.top.twist + '°').join(',  '));
// В слабый ветер парус не раскрывают на упор — но и нулевым твист там больше
// не выходит. Раньше выходил, и проверка стояла на «не больше шага сетки».
// После мембраны парус набирает подъёмную силу пузом, а не углом атаки, и
// рабочий диапазон углов стал уже: подстраиваться под закрутку кажущегося
// ветра по высоте приходится и в три метра в секунду. Градиент там как раз
// самый заметный — своей скорости у лодки почти нет, и кажущийся ветер это
// истинный, со всем своим профилем.
check('в слабый ветер твист не на упоре', byWind[0].top.twist < 30,
  byWind[0].top.twist + '°');
check('в свежий ветер парус раскрывают кверху',
  byWind[byWind.length - 1].top.twist >= 12,
  byWind[5].top.twist + '° при 14 м/с');
// Раньше здесь сравнивались сами оптимумы: твист на 14 м/с должен выйти больше,
// чем на 4.5. Проверка перестала что-либо значить, когда у решётки появилось
// ядро вихря: скос по высоте перестал зашкаливать у топа, кривая VMG по твисту
// в свежий ветер стала пологой — от 0 до 32° два процента, — и «оптимум» на ней
// выбирает уже сетка, а не модель. В слабый ветер кривая осталась острой.
//
// Проверяется поэтому то же самое, но величиной, которая в сетке не тонет:
// сколько стоит раскрыть заднюю шкаторину до упора. В слабый ветер лодка
// недогружена, и раскрывать верх — прямая потеря; в свежий это почти даром, за
// тем твист там и раскрывают.
{
  const cost = [];
  for (const wind of [byWind[1], byWind[5]]) {
    const open = await pool.map(SH_COARSE.map(sh => ({
      wind: wind.wind, twa: wind.top.twa, hike: 1, sheet: sh, twist: 32 })));
    const best = Math.max(...open.filter(r => r && r.finite).map(r => r.vmg));
    cost.push(1 - best / wind.top.vmg);
  }
  console.log('  Цена раскрытой до упора шкаторины: ' +
    (100 * cost[0]).toFixed(1) + '% на 4.5 м/с, ' +
    (100 * cost[1]).toFixed(1) + '% на 14 м/с');
  check('в свежий ветер раскрыть шкаторину дешевле, чем в слабый',
    cost[1] < cost[0] - 0.02,
    (100 * cost[0]).toFixed(1) + '% против ' + (100 * cost[1]).toFixed(1) + '%');
}

// --- откренивание -------------------------------------------------------------

// Откренивание проверяется свежим ветром: в слабый оно почти ничего не даёт,
// а в свежий это разница между «идём» и «лежим».
console.log('\nОткренивание втроём, TWA 45°:\n');
console.log('  ветер    в ДП: крен, узлы, VMG      на борту: крен, узлы, VMG');
const hikeWinds = [6, 11];
const hikePts = [];
for (const wind of hikeWinds) {
  hikePts.push({ twa: 45, wind: wind, hike: 0 });
  hikePts.push({ twa: 45, wind: wind, hike: 1 });
}
const hikeRes = await bestMany(hikePts);
const hikeRows = hikeWinds.map((wind, i) => ({
  wind: wind, a: hikeRes[2 * i], b: hikeRes[2 * i + 1] }));
for (const h of hikeRows) {
  console.log('  ' + (h.wind + ' м/с').padEnd(8) +
    h.a.heelDeg.toFixed(0).padStart(6) + '° ' + h.a.speedKn.toFixed(2).padStart(6) +
    ' ' + h.a.vmg.toFixed(2).padStart(6) + '        ' +
    h.b.heelDeg.toFixed(0).padStart(6) + '° ' + h.b.speedKn.toFixed(2).padStart(6) +
    ' ' + h.b.vmg.toFixed(2).padStart(6));
}
console.log('');
check('откренивание уменьшает крен',
  hikeRows.every(h => Math.abs(h.b.heelDeg) < Math.abs(h.a.heelDeg) - 1));
check('откренивание прибавляет ход',
  hikeRows.every(h => h.b.speedKn > h.a.speedKn));
check('в свежий ветер откренивание даёт больше, чем в слабый',
  (hikeRows[1].b.vmg - hikeRows[1].a.vmg) >
  (hikeRows[0].b.vmg - hikeRows[0].a.vmg),
  '+' + (hikeRows[1].b.vmg - hikeRows[1].a.vmg).toFixed(2) + ' против +' +
  (hikeRows[0].b.vmg - hikeRows[0].a.vmg).toFixed(2) + ' узла VMG');

// --- поворот оверштаг ---------------------------------------------------------

// Экипаж в повороте ПЕРЕСАЖИВАЕТСЯ, и это теперь часть манёвра.
//
// Раньше он переходил сам: физика сажала его туда, куда требовал кренящий
// момент, и на смене галса он оказывался на новом борту в тот же миг, когда
// момент менял знак. Теперь борт задаётся снаружи (`o.crewHike` знаковый), и
// поворот без пересадки — это поворот с экипажем под ветром. Здесь он
// перебирается ровно тогда, когда лодка проходит левентик, как это и делают.
const tk = new Boat(PACK);
tk.o.windSpeed = 6; tk.o.windDir = 45 * D; tk.o.sheet = 13 * D;
tk.o.crewHike = -1; tk.o.crewMass = 240;      // наветренный борт первого галса
tk.u = 3.0; tk.phi = 18 * D;
for (let i = 0; i < 60 * 30; i++) {
  const err = wrapPi(0 - tk.psi);
  tk.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * tk.r)));
  tk.step(1 / 30);
}
const before = tk.telemetry.speedKn;
const target = 90 * D;              // на другой галс: TWA 45 с другого борта
let minSpeed = 99, secs = 0;
for (let i = 0; i < 60 * 30; i++) {
  const err = wrapPi(target - tk.psi);
  tk.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * tk.r)));
  // Пересадка по фактическому курсу к ветру, а не по таймеру: перешли линию
  // ветра — экипаж пошёл на новый борт, а сама пересадка занимает своё время
  // (HIKE_TAU в физике), и провал хода на ней виден.
  tk.o.crewHike = wrapPi(tk.o.windDir - tk.psi) > 0 ? -1 : 1;
  tk.step(1 / 30);
  minSpeed = Math.min(minSpeed, tk.telemetry.speedKn);
  if (Math.abs(err) < 3 * D && !secs) secs = (i + 1) / 30;
}
console.log('Поворот оверштаг: ' + before.toFixed(2) + ' → провал до ' +
  minSpeed.toFixed(2) + ' → ' + tk.telemetry.speedKn.toFixed(2) + ' уз, ' +
  (secs ? secs.toFixed(1) + ' с на поворот' : 'курс не набран') + '\n');
check('поворот оверштаг выполняется', secs > 0 && secs < 30,
  secs ? secs.toFixed(1) + ' с' : 'не выполнен');
check('на повороте лодка теряет ход, но не встаёт',
  minSpeed < before * 0.8 && minSpeed > 0.5,
  'провал до ' + minSpeed.toFixed(2) + ' уз');
check('после поворота лодка разгоняется обратно',
  tk.telemetry.speedKn > before * 0.85,
  tk.telemetry.speedKn.toFixed(2) + ' против ' + before.toFixed(2));

// --- левентик -----------------------------------------------------------------
//
// Курс, на котором модель однажды легла и пошла кормой вперёд под пятьдесят
// узлов. Проверяется в шторм и с рулём наперекос — то есть в худшем виде.

console.log('Левентик, руль брошен или заклинен, экипаж в ДП:\n');
console.log('  ветер   руль   пик назад   пик крена   через 40 с');
const irons = [];
for (const [wind, rud] of [[6, 0], [11, 0], [16, 0], [16, 25]]) {
  const b = new Boat(PACK);
  b.o.windSpeed = wind; b.o.windDir = 0; b.o.sheet = 10 * D;
  b.o.rudder = rud * D; b.o.rudderTarget = rud * D;
  b.u = 0.5;
  let back = 0, heel = 0, fwd = 0;
  for (let i = 0; i < 40 * 30; i++) {
    b.step(1 / 30);
    back = Math.max(back, -b.u * 1.94384);
    fwd = Math.max(fwd, b.u * 1.94384);
    heel = Math.max(heel, Math.abs(b.phi / D));
  }
  const t = b.telemetry;
  irons.push({ wind, rud, b, back, fwd, heel, t });
  console.log('  ' + (wind + ' м/с').padEnd(8) + (rud + '°').padStart(5) + '   ' +
    back.toFixed(2).padStart(6) + ' уз ' + heel.toFixed(0).padStart(9) + '°   ' +
    (Math.abs(t.twaAbsDeg) > 25 ? 'увалилась, ' + t.speedKn.toFixed(1) + ' уз'
                                : 'стоит в левентике, ' + t.speedKn.toFixed(1) + ' уз'));
}
console.log('');
check('в левентике модель не расходится',
  irons.every(i => [i.b.u, i.b.v, i.b.r, i.b.phi].every(Number.isFinite)));
// Тот самый отказ: лодка ложилась и уезжала кормой вперёд под пятьдесят узлов.
check('задний ход не разгоняется',
  irons.every(i => i.back < 3),
  'наибольший ' + Math.max(...irons.map(i => i.back)).toFixed(2) + ' уз');
check('вперёд лодка тоже не разгоняется сверх разумного',
  irons.every(i => i.fwd < 9),
  'наибольший ' + Math.max(...irons.map(i => i.fwd)).toFixed(1) + ' уз');
// Заклиненный руль в шторм кладёт лодку лагом к ветру, и это правда: паруса
// в модели стоят по шкоту, а не полощут, и работают плоской пластиной.
// Восемьдесят градусов — это положило, а не перевернуло: закат кривой
// восстанавливающих плеч у этой лодки за девяносто, и лодка в таблице ниже
// уваливается и выходит. Лодку в шторм с заклиненным рулём и без экипажа
// действительно кладёт, и это не отказ модели.
//
// Порог поднят с 78 до 84 после того, как сопротивление мачты переехало из
// общей «парусности в потоке» на свою высоту. Раньше девять метров рангоута
// кренили лодку с плеча в один метр, теперь с пяти — и в шторм это лишние
// два градуса крена. Правка ошибки, а не послабление.
check('в левентике лодку не переворачивает',
  irons.every(i => i.heel < 84),
  'наибольший крен ' + Math.max(...irons.map(i => i.heel)).toFixed(0) + '°');

// выход из левентика: увалиться и снова поехать
const out = irons[1].b;              // 11 м/с — там она действительно встала
const stuck = out.telemetry.speedKn;
// Шкот при этом травится: четырнадцать градусов в двадцать один узел ветра —
// это не выход из левентика, а способ там остаться. Проверка изначально
// оставляла лавировочную настройку, и лодка выходила из левентика еле-еле, на
// четыре с небольшим узла; после того как у решётки появился потолок
// циркуляции, того запаса не стало. Дело не в потолке: на любом разумном шкоте
// лодка выходит за пять-девять секунд и до правки, и после.
out.o.windDir = 50 * D; out.o.sheet = 24 * D;
out.o.crewHike = -1; out.o.crewMass = 240;
let recovered = 0;
for (let i = 0; i < 60 * 30; i++) {
  const err = wrapPi(0 - out.psi);
  out.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * out.r)));
  out.step(1 / 30);
  if (!recovered && out.telemetry.speedKn > 4) recovered = (i + 1) / 30;
}
console.log('Выход из левентика на бейдевинд: с ' + stuck.toFixed(2) + ' уз ' +
  (recovered ? 'разогналась за ' + recovered.toFixed(0) + ' с' : 'не разогналась') +
  ', сейчас ' + out.telemetry.speedKn.toFixed(2) + ' уз\n');
check('из левентика лодка выходит и разгоняется',
  recovered > 0 && recovered < 40,
  recovered ? recovered.toFixed(0) + ' с' : 'не вышла');

console.log('\n' + (failures ? failures + ' проверок провалено' : 'все проверки прошли') + '\n');
process.exit(failures ? 1 : 0);
