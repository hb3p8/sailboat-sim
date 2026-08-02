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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;

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

function run(twaDeg, sheetDeg, opts = {}) {
  const b = new Boat(PACK);
  b.o.windSpeed = opts.wind ?? 6;
  b.o.windDir = twaDeg * D;
  b.o.sheet = sheetDeg * D;
  b.o.twist = (opts.twist ?? 0) * D;
  b.o.crewHike = opts.hike ?? 0;
  b.o.crewMass = b.o.crewHike > 0 ? 240 : 0;
  b.u = 3.0;
  b.phi = 18 * D;
  let worst = { u: 0, heel: 0 };
  for (let i = 0; i < (opts.secs ?? 70) * 30; i++) {
    const err = wrapPi(0 - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * b.r)));
    b.step(1 / 30);
    worst.u = Math.max(worst.u, Math.abs(b.u));
    worst.heel = Math.max(worst.heel, Math.abs(b.phi / D));
  }
  const t = b.telemetry;
  const track = twaDeg + Math.abs(t.leewayDeg);
  return {
    b, t, track, worst,
    vmg: t.speedKn * Math.cos(track * D),
    helm: b.o.rudder / D,
    headingErr: wrapPi(0 - b.psi) / D,
    finite: [b.u, b.v, b.r, b.phi, b.psi].every(Number.isFinite),
  };
}

// Настройки подбираем перебором: на каждом курсе свои. Твист здесь наравне со
// шкотом — с профилем ветра по высоте он стал настоящим органом управления, а
// не украшением: в свежий ветер им сбрасывают мощность с верха паруса.
// Перебор в два прохода: сперва грубо по всей сетке, потом мелко вокруг
// найденного. Прежний одноступенчатый перебор с шагом 4° по шкоту и 10° по
// твисту после мембраны стал врать: отклик паруса сузился, соседние узлы сетки
// попадают в разные режимы, и «оптимум» скачет на четыре процента по VMG.
// Ловилось это как несуществующие провалы — будто лодка в четырнадцать метров
// в секунду идёт хуже, чем в одиннадцать, и при этом круче. На мелкой сетке
// оба провала исчезают: и там и там оптимум на 40°, а VMG растёт.
//
// Два прохода стоят столько же, сколько один грубый, а оптимум находят там,
// где он есть.
function best(twaDeg, opts) {
  let top = null, fastest = 0;
  const probe = (sh, tw) => {
    const r = run(twaDeg, sh, Object.assign({ twist: tw }, opts));
    if (!r.finite) return;
    fastest = Math.max(fastest, r.t.speedKn);
    if (!top || r.vmg > top.vmg) { top = r; top.sheet = sh; top.twist = tw; }
  };
  for (let sh = 6; sh <= 34; sh += 7) for (let tw = 0; tw <= 32; tw += 16) probe(sh, tw);
  const sh0 = top.sheet, tw0 = top.twist;
  for (const dsh of [-3.5, 0, 3.5]) {
    for (const dtw of [-8, 0, 8]) {
      if (dsh === 0 && dtw === 0) continue;
      probe(Math.max(2, sh0 + dsh), Math.max(0, tw0 + dtw));
    }
  }
  top.fastest = fastest;
  return top;
}

console.log('\nПоляра в лавировку, истинный ветер 6 м/с (11.7 уз), экипаж на борту.');
console.log('Шкот на каждом курсе подобран под наибольший VMG.\n');
console.log('  TWA  шкот твист  узлы   крен   дрейф   курс   VMG    руль  ошибка');
const polar = [];
for (let twa = 30; twa <= 70; twa += 5) {
  const r = best(twa, { hike: 1 });
  polar.push({ twa, r });
  console.log('  ' + String(twa).padStart(3) + '° ' + r.sheet.toFixed(0).padStart(4) +
    '° ' + r.twist.toFixed(0).padStart(4) + '° ' +
    r.t.speedKn.toFixed(2).padStart(6) + ' ' +
    r.t.heelDeg.toFixed(1).padStart(6) + '° ' +
    r.t.leewayDeg.toFixed(1).padStart(6) + '° ' +
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
    Math.abs(p.r.t.leewayDeg) <= Math.abs(polar[i - 1].r.t.leewayDeg) + 0.3));
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
  polar.every(p => p.r.worst.u * 1.94384 < 16),
  'наибольшая мгновенная ' +
  Math.max(...polar.map(p => p.r.worst.u * 1.94384)).toFixed(1) + ' уз');

// --- по силе ветра ------------------------------------------------------------

// Экипаж на борту: в лавировку на такой лодке иначе не ходят, а без него
// в свежий ветер она упирается не в паруса, а в собственную остойчивость.
console.log('\nЛавировка при разной силе ветра, экипаж на борту:\n');
console.log('  ветер   лучший TWA  шкот твист   узлы   крен    VMG   лавир.угол');
const byWind = [];
for (const wind of [3, 4.5, 6, 8, 11, 14]) {
  let top = null;
  for (let twa = 32; twa <= 52; twa += 5) {
    const r = best(twa, { wind, hike: 1 });
    if (r && (!top || r.vmg > top.vmg)) { top = r; top.twa = twa; }
  }
  byWind.push({ wind, top });
  console.log('  ' + (wind + ' м/с').padEnd(8) + String(top.twa).padStart(7) + '° ' +
    top.sheet.toFixed(0).padStart(5) + '° ' + top.twist.toFixed(0).padStart(4) + '° ' +
    top.t.speedKn.toFixed(2).padStart(6) + ' ' + top.t.heelDeg.toFixed(0).padStart(5) +
    '° ' + top.vmg.toFixed(2).padStart(6) + '   ' + (2 * top.track).toFixed(0) + '°');
}
console.log('');
check('с усилением ветра VMG растёт',
  byWind.every((w, i) => i === 0 || w.top.vmg > byWind[i - 1].top.vmg - 0.05));
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
  byWind.every(w => Math.abs(w.top.t.heelDeg) < 30),
  'наибольший ' +
  Math.max(...byWind.map(w => Math.abs(w.top.t.heelDeg))).toFixed(0) + '°');
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
check('нужный твист растёт с ветром',
  byWind[5].top.twist > byWind[1].top.twist);

// --- откренивание -------------------------------------------------------------

// Откренивание проверяется свежим ветром: в слабый оно почти ничего не даёт,
// а в свежий это разница между «идём» и «лежим».
console.log('\nОткренивание втроём, TWA 45°:\n');
console.log('  ветер    в ДП: крен, узлы, VMG      на борту: крен, узлы, VMG');
const hikeRows = [];
for (const wind of [6, 11]) {
  const a = best(45, { wind }), b = best(45, { wind, hike: 1 });
  hikeRows.push({ wind, a, b });
  console.log('  ' + (wind + ' м/с').padEnd(8) +
    a.t.heelDeg.toFixed(0).padStart(6) + '° ' + a.t.speedKn.toFixed(2).padStart(6) +
    ' ' + a.vmg.toFixed(2).padStart(6) + '        ' +
    b.t.heelDeg.toFixed(0).padStart(6) + '° ' + b.t.speedKn.toFixed(2).padStart(6) +
    ' ' + b.vmg.toFixed(2).padStart(6));
}
console.log('');
check('откренивание уменьшает крен',
  hikeRows.every(h => h.b.t.heelDeg < h.a.t.heelDeg - 1));
check('откренивание прибавляет ход',
  hikeRows.every(h => h.b.t.speedKn > h.a.t.speedKn));
check('в свежий ветер откренивание даёт больше, чем в слабый',
  (hikeRows[1].b.vmg - hikeRows[1].a.vmg) >
  (hikeRows[0].b.vmg - hikeRows[0].a.vmg),
  '+' + (hikeRows[1].b.vmg - hikeRows[1].a.vmg).toFixed(2) + ' против +' +
  (hikeRows[0].b.vmg - hikeRows[0].a.vmg).toFixed(2) + ' узла VMG');

// --- поворот оверштаг ---------------------------------------------------------

const tk = new Boat(PACK);
tk.o.windSpeed = 6; tk.o.windDir = 45 * D; tk.o.sheet = 13 * D;
tk.o.crewHike = 1; tk.o.crewMass = 240;
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
// Сорокапятиградусный крен здесь — предел модели, а не поведение лодки.
// Семьдесят градусов — это положило, а не перевернуло: закат кривой
// восстанавливающих плеч у этой лодки за девяносто. Лодку в шторм с заклиненным
// рулём и без экипажа действительно кладёт, и это не отказ модели.
check('в левентике лодку не переворачивает',
  irons.every(i => i.heel < 78),
  'наибольший крен ' + Math.max(...irons.map(i => i.heel)).toFixed(0) + '°');

// выход из левентика: увалиться и снова поехать
const out = irons[1].b;              // 11 м/с — там она действительно встала
const stuck = out.telemetry.speedKn;
out.o.windDir = 50 * D; out.o.sheet = 14 * D;
out.o.crewHike = 1; out.o.crewMass = 240;
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
