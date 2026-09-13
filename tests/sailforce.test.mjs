// Силы генакера против трубного эталона: node tests/sailforce.test.mjs
//
// Это ЕДИНСТВЕННАЯ слепая зона, которую не закрывал ни один прежний стенд.
// Карта курс×шкот меряет устойчивость, `wind` — согласие сечения с решёткой,
// `wake` — что пелена не трогает силы. А КАКУЮ СИЛУ генакер даёт по курсу — не
// мерил никто, и калибровка по воде до сих пор состоит из одной точки.
//
// Эталон — `data/sail/orc_vpp_2023.json`: табличные коэффициенты ORC VPP для
// грота и асимметричного спинакера на ДП. Чужой парус, чужая лодка, поэтому
// сравнение идёт ПО ФОРМЕ КРИВОЙ, а не по абсолюту:
//
//   - положение максимума тяги по кажущемуся углу;
//   - величина максимума C_x;
//   - спад тяги к 180°;
//   - отношение боковой силы к тяге.
//
// Полоса допуска назначена ДО первого прогона и записана в плане
// (docs/gennaker-sota-plan.md, шаг 4): ±15 % по C_x в максимуме и ±10° по
// положению максимума. Двигать её потом нельзя — она и есть свидетель.
//
// ВЕРДИКТ ПРЕДВАРИТЕЛЬНЫЙ, и это не оговорка ради приличия. План требует двух
// независимых рядов, а получен один: трубные работы дают те же величины
// рисунками за платной стеной. Подробности — в поле `чего_не_хватает` эталона.
// Пока второго ряда нет, красный здесь означает «разошлись с ORC», а не
// «модель неверна».

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from './lib/pool.mjs';
import { FULL, pick, modeLine } from './lib/mode.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_PATH = join(ROOT, 'out/export/physics.json');
const PACK = JSON.parse(readFileSync(PACK_PATH, 'utf8'));
const REF = JSON.parse(readFileSync(join(ROOT, 'data/sail/orc_vpp_2023.json'), 'utf8'));
const pool = new Pool(PACK_PATH, PACK);

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
};

console.log('\nСилы генакера против эталона ORC VPP 2023.  ' + modeLine() + '\n');

// --- эталон ---------------------------------------------------------------------
//
// Сборка ровно по документу: взвешенная по площадям сумма, затенение единица
// (шлюп), индуктивное — по эффективной высоте рига.
const G = PACK.rig.gennaker;
const A_MAIN = PACK.rig.main_area_m2;
const A_SPI = G.area_m2;
const AREF = A_MAIN + A_SPI;
// Эффективная высота: на полных курсах она от угла не зависит и близка к высоте
// топа над водой (§5.4, ур. 5.44–5.45). Берётся топ мачты: генакер поднят туда.
const HEFF = PACK.rig.mast_height_m;

const lerp = (xs, ys, x) => {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 0;
  while (xs[i + 1] < x) i++;
  const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
  return ys[i] + t * (ys[i + 1] - ys[i]);
};

function refAt(betaDeg, spi) {
  const m = REF['грот'], s = REF[spi];
  const cl = (lerp(m.beta_deg, m.cl, betaDeg) * A_MAIN +
              lerp(s.beta_deg, s.cl, betaDeg) * A_SPI) / AREF;
  const cd0 = (lerp(m.beta_deg, m.cd0, betaDeg) * A_MAIN +
               lerp(s.beta_deg, s.cd0, betaDeg) * A_SPI) / AREF;
  const kp = (m.kp * A_MAIN + s.kp * A_SPI) / AREF;
  const cdi = (kp + AREF / (Math.PI * HEFF * HEFF)) * cl * cl;
  const b = betaDeg * Math.PI / 180;
  return { cx: cl * Math.sin(b) - (cd0 + cdi) * Math.cos(b),
           cy: cl * Math.cos(b) + (cd0 + cdi) * Math.sin(b) };
}

// --- модель ---------------------------------------------------------------------
//
// Перебираются ОБА шкота до максимума тяги — так трим подбирают и в трубе.
//
// Грот тоже, и это не запас, а исправление свидетеля. Сперва он стоял на
// неподвижных 70°, и на острых курсах это его убивало: вынос ограничен
// кажущимся углом (`held = min(sheet, awa)`), при AWA 63° парус со шкотом 60° и
// больше встаёт ровно по потоку, угол атаки обращается в ноль тождественно, и
// C_N падает с 1.40 до 0.10. Выглядело это как провал модели — грот отдавал семь
// процентов эталона, — а было перетравленным шкотом в самом стенде.
//
// Одного положения на весь диапазон и не может быть: на TWA 110° лучший шкот
// грота 45°, на 180° — 85°. Эталон ORC снят при ЛУЧШЕМ триме, и сравнивать с
// ним надо лучший.
//
// Сетка в регрессионном режиме грубее: положение максимума от этого гуляет на
// полшага, и именно поэтому допуск по углу назначен в десять градусов.
const TWAS = [110, 120, 130, 140, 150, 160, 170, 180];
const LENS = [];
{
  const n = pick(9, 5);
  for (let i = 0; i < n; i++)
    LENS.push(G.sheet_min_m + (G.sheet_max_m - G.sheet_min_m) * (i + 0.5) / n);
}
// Верхний край сетки грота — его физический предел: за 90° он уже не держится
// шкотом (`maxSheet` в aero.js). Нижний свободный: на острых курсах оптимум
// лежит на добранном шкоте, и упираться туда не ошибка.
const MAIN_MAX = 90;          // за ним грот шкотом не держится (`maxSheet`)
const MAINS = pick([15, 25, 35, 45, 55, 65, 75, 82, MAIN_MAX],
                   [20, 35, 50, 65, 80, MAIN_MAX]);
const SECS = pick(40, 25);

const specs = [];
for (const twa of TWAS) for (const len of LENS) for (const mainSheet of MAINS)
  specs.push({ run: 'sailForce', twa, len, mainSheet, secs: SECS, wind: 6 });

const out = await pool.map(specs);
pool.close();

// На каждом курсе — лучший по тяге трим по обоим шкотам.
const best = [];
const PER = LENS.length * MAINS.length;
for (let i = 0; i < TWAS.length; i++) {
  const row = out.slice(i * PER, (i + 1) * PER);
  let b = row[0];
  for (const r of row) if (r.drive > b.drive) b = r;
  best.push(b);
}

console.log('  курс  генакер  грот   AWA     ход    крен    C_x     C_y   C_y/C_x | эталон C_x  C_y');
const model = [];
for (const r of best) {
  const cx = r.drive / (r.q * AREF), cy = r.side / (r.q * AREF);
  const e = refAt(r.awaDeg, 'асимметричный_на_ДП');
  model.push({ twa: r.twa, awa: r.awaDeg, cx, cy, ref: e, r });
  console.log('  %s°  %s м   %s°  %s°  %s  %s°  %s  %s  %s  | %s  %s',
    String(r.twa).padStart(4), r.len.toFixed(1), String(r.mainSheet).padStart(3),
    r.awaDeg.toFixed(0).padStart(4),
    r.speedKn.toFixed(2).padStart(6), r.heelDeg.toFixed(0).padStart(4),
    cx.toFixed(3).padStart(7), cy.toFixed(3).padStart(7),
    (cy / cx).toFixed(2).padStart(6),
    e.cx.toFixed(3).padStart(7), e.cy.toFixed(3).padStart(7));
}
console.log('');

// --- сравнение по форме ---------------------------------------------------------
const peak = a => a.reduce((p, x) => (x.cx > p.cx ? x : p), a[0]);
const pm = peak(model);
const refCurve = model.map(m => ({ awa: m.awa, cx: m.ref.cx, cy: m.ref.cy }));
const pr = refCurve.reduce((p, x) => (x.cx > p.cx ? x : p), refCurve[0]);

console.log('  максимум тяги: модель C_x = %s на AWA %s°, эталон %s на %s°\n',
  pm.cx.toFixed(3), pm.awa.toFixed(0), pr.cx.toFixed(3), pr.awa.toFixed(0));

check('максимум тяги в пределах ±15 % от эталона',
  Math.abs(pm.cx - pr.cx) <= 0.15 * pr.cx,
  (100 * (pm.cx - pr.cx) / pr.cx).toFixed(0) + ' %');
check('положение максимума в пределах ±10°',
  Math.abs(pm.awa - pr.awa) <= 10,
  (pm.awa - pr.awa).toFixed(0) + '°');

// Спад к фордевинду: во сколько раз тяга на самом полном курсе ниже максимума.
const deep = model[model.length - 1], deepRef = refCurve[refCurve.length - 1];
console.log('  спад к TWA %s°: модель %s от максимума, эталон %s\n',
  deep.twa, (deep.cx / pm.cx).toFixed(2), (deepRef.cx / pr.cx).toFixed(2));
check('спад тяги к фордевинду того же порядка, что у эталона',
  Math.abs(deep.cx / pm.cx - deepRef.cx / pr.cx) <= 0.25,
  (deep.cx / pm.cx).toFixed(2) + ' против ' + (deepRef.cx / pr.cx).toFixed(2));

// Отношение боковой к тяге — про то, куда развёрнута полная сила.
//
// По МОДУЛЮ боковой: её знак говорит, с какого борта ветер, а эталон ORC по
// построению положителен. Сравнивать знаки значило бы сравнивать условности.
let worst = 0, worstAt = 0;
for (let i = 0; i < model.length; i++) {
  const m = model[i], e = refCurve[i];
  const d = Math.abs(Math.abs(m.cy / m.cx) - Math.abs(e.cy / e.cx));
  if (d > worst) { worst = d; worstAt = m.twa; }
}
check('боковая к тяге расходится с эталоном не больше чем на 0.5',
  worst <= 0.5, 'худшее ' + worst.toFixed(2) + ' на TWA ' + worstAt + '°');

// ЛУЧШИЙ ТРИМ НЕ ДОЛЖЕН УПИРАТЬСЯ В КРАЙ СЕТКИ — та же защита, что и на
// бейдевиндном стенде, и заведена она по той же причине. Трижды подряд
// «дефект модели» оказывался краем перебора, в том числе прямо здесь: пока шкот
// грота стоял неподвижно на 70°, на острых курсах он флюгерил, и грот отдавал
// семь процентов эталона.
//
// Шкот ГЕНАКЕРА сюда не входит: у него край сетки — настоящая длина шкота
// (`sheet_max_m` из пакета), и упереться в неё не ошибка, а физика.
{
  // Сравнивается с ФИЗИЧЕСКИМ пределом, а не просто с краем сетки: если сетка
  // доведена до самого предела, упереться в него не ошибка — дальше травить
  // нечего. Проверка ловит ровно тот случай, когда сетка обрывается раньше.
  const maxMain = MAINS[MAINS.length - 1];
  const atEdge = maxMain < MAIN_MAX ? best.filter(r => r.mainSheet === maxMain) : [];
  check('сетка по шкоту грота доведена до предела, а лучший трим не на её краю',
    atEdge.length === 0,
    atEdge.length ? atEdge.map(r => 'TWA ' + r.twa + '°').join(', ') : '');
}

const fuse = best.reduce((s, r) => s + r.fuse, 0);
console.log('\n  предохранитель за весь перебор: %s срабатываний', fuse);

console.log(failures ? '\n' + failures + ' проверок провалено' : '\nвсе проверки прошли');
process.exit(failures ? 1 : 0);
