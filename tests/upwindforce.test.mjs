// Силы грота со стакселем против эталона: node tests/upwindforce.test.mjs
//
// Близнец `sailforce.test.mjs`, но для лавировки, и заведён он по конкретному
// упору. Разбор лишней тяги генакера дважды упёрся в одно и то же: снижение
// силы по удлинению в полосе углов 20…35° применяется вполсилы, а применить его
// целиком нельзя — это двигает бейдевинд на 3 % VMG, и сказать, в какую сторону,
// было нечем. Модель там откалибрована по воде и по ощущению владельца, то есть
// свидетеля с числом у неё не было вовсе.
//
// Эталон тот же — `data/sail/orc_vpp_2023.json`, таблицы 5.1 (грот) и 5.4
// (стаксель), низкие наборы: у SV20 ни бакштага, ни регулируемого штага.
//
// ЧТО СРАВНИВАЕТСЯ. Таблицы ORC — это CLmax, наибольшая подъёмная сила на
// данном кажущемся угле. Поэтому трим здесь перебирается до максимума ПОДЪЁМНОЙ
// силы, а не тяги: на лавировке тягу максимизируют не трим, а курс, и сравнение
// по тяге сравнивало бы выбор курса, а не паруса.
//
// ПОДЪЁМНАЯ СИЛА И СОПРОТИВЛЕНИЕ ЗДЕСЬ НЕ РАВНОПРАВНЫ, и это надо держать в
// голове. CL берётся из таблиц напрямую. А в CD входит индуктивная часть, для
// которой ORC на бейдевинде делает эффективную высоту рига ФУНКЦИЕЙ УГЛА
// (множитель от 1.4513 при 20° до 0.80 при 80°), причём со вторым сомножителем,
// который считается из фракционности, перекрытия и серпа. Второго у нас нет.
// Поэтому по CL здесь стоят ворота, а CD печатается без ворот — как справка.
//
// Полоса допуска назначена ДО первого прогона, та же, что у попутного стенда:
// ±15 % по CLmax и ±10° по положению максимума.
//
// Вердикт, как и у попутного стенда, ПРЕДВАРИТЕЛЬНЫЙ: ряд один. Второго
// независимого ряда получить не удалось (см. `чего_не_хватает` в эталоне).

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

console.log('\nСилы грота со стакселем против эталона ORC VPP 2023.  ' + modeLine() + '\n');

const A_MAIN = PACK.rig.main_area_m2;
const A_JIB = PACK.rig.jib_area_m2;
const AREF = A_MAIN + A_JIB;
const HEFF = PACK.rig.mast_height_m;

const lerp = (xs, ys, x) => {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 0;
  while (xs[i + 1] < x) i++;
  return ys[i] + (x - xs[i]) / (xs[i + 1] - xs[i]) * (ys[i + 1] - ys[i]);
};

function refAt(betaDeg) {
  const m = REF['грот'], j = REF['стаксель'];
  const cl = (lerp(m.beta_deg, m.cl, betaDeg) * A_MAIN +
              lerp(j.beta_deg, j.cl, betaDeg) * A_JIB) / AREF;
  const cd0 = (lerp(m.beta_deg, m.cd0, betaDeg) * A_MAIN +
               lerp(j.beta_deg, j.cd0, betaDeg) * A_JIB) / AREF;
  const kp = (m.kp * A_MAIN + j.kp * A_JIB) / AREF;
  const cdi = (kp + AREF / (Math.PI * HEFF * HEFF)) * cl * cl;
  return { cl, cd: cd0 + cdi };
}

// Трим перебирается до максимума подъёмной силы: так снята и сама таблица.
const TWAS = [30, 35, 40, 45, 50, 60, 75, 90];
// Сетка по шкоту идёт от самого добранного до широко потравленного, и обе
// границы поставлены по замеру, а не на глаз.
//
// Снизу: максимум подъёмной силы на острых курсах лежит на тугом триме, и на
// первой сетке (от 8°) он упирался в её край.
//
// Сверху: на галфвинде парус надо травить куда сильнее. На сетке до 28° при
// TWA 90° выходило CL = 0.860 против эталонных 1.288 — провал на треть, который
// выглядел как дефект модели. При шкоте 45° там же выходит 1.330, то есть +3 %.
// Виновата была сетка, а не модель.
const SHEETS = pick([0, 2, 4, 6, 9, 12, 16, 20, 25, 30, 36, 44, 52, 62, 75],
                    [0, 3, 6, 9, 14, 20, 28, 38, 50, 65]);
// Твист — туда же: на сетке до 16° лучший трим выбирал её край на шести курсах
// из восьми, то есть стенд опять не находил оптимума, а упирался.
const TWISTS = pick([0, 4, 8, 12, 16, 20, 25, 30, 36, 42], [0, 8, 16, 24, 32, 40]);
const SECS = pick(60, 40);

const specs = [];
for (const twa of TWAS) for (const sheet of SHEETS) for (const twist of TWISTS)
  specs.push({ run: 'upwindForce', twa, sheet, twist, secs: SECS, wind: 6 });

const out = await pool.map(specs);
pool.close();

const PER = SHEETS.length * TWISTS.length;
const best = [];
for (let i = 0; i < TWAS.length; i++) {
  const row = out.slice(i * PER, (i + 1) * PER);
  let b = null, bcl = -Infinity;
  for (const r of row) {
    const bet = r.awaDeg * Math.PI / 180;
    const cx = r.drive / (r.q * AREF), cy = r.side / (r.q * AREF);
    // Боковая берётся по МОДУЛЮ: её знак говорит, с какого борта ветер, а
    // эталон ORC по построению положителен. Без модуля подъёмная сила и
    // сопротивление перемешиваются, и выходит L/D = 1.6 там, где лодка на
    // таком курсе вообще не пошла бы.
    const cl = cx * Math.sin(bet) + Math.abs(cy) * Math.cos(bet);
    if (cl > bcl) { bcl = cl; b = r; }
  }
  best.push(b);
}

console.log('  курс  шкот  твист   AWA     ход    крен     CL      CD    CL/CD | эталон CL   CD');
const model = [];
for (const r of best) {
  const bet = r.awaDeg * Math.PI / 180;
  const cx = r.drive / (r.q * AREF), cy = r.side / (r.q * AREF);
  const cl = cx * Math.sin(bet) + Math.abs(cy) * Math.cos(bet);
  const cd = -cx * Math.cos(bet) + Math.abs(cy) * Math.sin(bet);
  const e = refAt(r.awaDeg);
  model.push({ twa: r.twa, awa: r.awaDeg, cl, cd, ref: e });
  console.log('  %s°  %s°   %s°  %s°  %s  %s°  %s  %s  %s  | %s  %s',
    String(r.twa).padStart(4), String(r.sheet).padStart(3), String(r.twist).padStart(3),
    r.awaDeg.toFixed(0).padStart(4), r.speedKn.toFixed(2).padStart(6),
    r.heelDeg.toFixed(0).padStart(4),
    cl.toFixed(3).padStart(6), cd.toFixed(3).padStart(6),
    (cl / cd).toFixed(2).padStart(6),
    e.cl.toFixed(3).padStart(7), e.cd.toFixed(3).padStart(6));
}
console.log('');

const pm = model.reduce((p, x) => (x.cl > p.cl ? x : p), model[0]);
const pr = model.reduce((p, x) => (x.ref.cl > p.ref.cl ? x : p), model[0]);

console.log('  максимум подъёмной силы: модель CL = %s на AWA %s°, эталон %s на %s°\n',
  pm.cl.toFixed(3), pm.awa.toFixed(0), pr.ref.cl.toFixed(3), pr.awa.toFixed(0));

check('максимум CL в пределах ±15 % от эталона',
  Math.abs(pm.cl - pr.ref.cl) <= 0.15 * pr.ref.cl,
  (100 * (pm.cl - pr.ref.cl) / pr.ref.cl).toFixed(0) + ' %');
// ПОЛОЖЕНИЕ МАКСИМУМА ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ, и это не послабление.
//
// Полоса ±10° по положению максимума была назначена до первого прогона, по
// образцу попутного стенда. Первый прогон показал, что к ЭТОМУ эталону она
// неприменима: у ORC на бейдевинде подъёмная сила выходит на ПЛАТО и стоит на
// нём — 1.379, 1.380, 1.381, 1.382 при кажущихся углах 29, 32, 38 и 46°, то
// есть разброс два десятых процента на семнадцати градусах. Где у такой кривой
// «максимум», решает не физика, а четвёртый знак таблицы, и требовать от модели
// попасть в него — значит требовать попасть в шум.
//
// Взамен — проверка, осмысленная для плато: кривая обязана ДЕРЖАТЬСЯ В ПОЛОСЕ
// на всём остром диапазоне. Полоса та же, ±15 %; сужать её под ответ нельзя, и
// она не сужена.
{
  const band = model.filter(m => m.awa <= 50);
  let worstRel = 0, worstAt = 0;
  for (const m of band) {
    const d = Math.abs(m.cl - m.ref.cl) / m.ref.cl;
    if (d > worstRel) { worstRel = d; worstAt = m.awa; }
  }
  check('CL держится в полосе ±15 % на всём остром диапазоне (AWA до 50°)',
    worstRel <= 0.15,
    'худшее ' + (100 * worstRel).toFixed(0) + ' % на AWA ' + worstAt.toFixed(0) + '°');
}

// То же и на широких углах: там эталон слабее (у ORC грот со стакселем на таком
// угле уже частично сорван), но полоса та же — сужать её незачем.
{
  const wide = model.filter(m => m.awa > 50);
  let worstRel = 0, worstAt = 0;
  for (const m of wide) {
    const d = Math.abs(m.cl - m.ref.cl) / m.ref.cl;
    if (d > worstRel) { worstRel = d; worstAt = m.awa; }
  }
  if (wide.length) check('CL держится в полосе ±15 % и на широких углах (AWA > 50°)',
    worstRel <= 0.15,
    'худшее ' + (100 * worstRel).toFixed(0) + ' % на AWA ' + worstAt.toFixed(0) + '°');
}

// ЛУЧШИЙ ТРИМ НЕ ДОЛЖЕН УПИРАТЬСЯ В КРАЙ СЕТКИ, и это не придирка к
// оформлению. Трижды подряд «дефект модели» оказывался краем перебора: шкот
// грота на попутном стенде, добранный край здесь, потравленный край здесь же.
// Стенд, который сравнивает с ЛУЧШИМ тримом, обязан сам говорить, что лучшего
// он не нашёл, а упёрся.
//
// Проверяется только ВЕРХНИЙ край. Нижний физический: туже диаметральной
// плоскости парус не выбрать, и на острых курсах оптимум там и лежит по делу.
{
  const maxSheet = SHEETS[SHEETS.length - 1], maxTwist = TWISTS[TWISTS.length - 1];
  const atEdge = best.filter(r => r.sheet === maxSheet || r.twist === maxTwist);
  check('лучший трим не упирается в верхний край сетки', atEdge.length === 0,
    atEdge.length ? atEdge.map(r => 'TWA ' + r.twa + '° (шкот ' + r.sheet +
      '°, твист ' + r.twist + '°)').join(', ') : '');
}

// Форма кривой: во сколько раз CL на самом остром курсе ниже максимума. У
// эталона подъёмная сила круто растёт от нуля при 7° к максимуму у 27°, и модель
// обязана иметь тот же подъём, а не быть просто ниже или выше целиком.
const sharp = model[0], sharpRef = model[0].ref;
console.log('  подъём от TWA %s°: модель %s от максимума, эталон %s\n',
  sharp.twa, (sharp.cl / pm.cl).toFixed(2), (sharpRef.cl / pr.ref.cl).toFixed(2));
check('подъём CL от острого курса к максимуму того же порядка, что у эталона',
  Math.abs(sharp.cl / pm.cl - sharpRef.cl / pr.ref.cl) <= 0.25,
  (sharp.cl / pm.cl).toFixed(2) + ' против ' + (sharpRef.cl / pr.ref.cl).toFixed(2));

// Сопротивление — БЕЗ ВОРОТ, справкой: у эталона в него входит индуктивная
// часть, которую нам нечем воспроизвести (см. шапку).
let wd = 0, wdAt = 0;
for (const m of model) {
  const d = Math.abs(m.cd - m.ref.cd) / Math.max(0.01, m.ref.cd);
  if (d > wd) { wd = d; wdAt = m.twa; }
}
console.log('  справка, без ворот: сопротивление расходится с эталоном до %s %% (на TWA %s°)',
  (100 * wd).toFixed(0), wdAt);

console.log(failures ? '\n' + failures + ' проверок провалено' : '\nвсе проверки прошли');
process.exit(failures ? 1 : 0);
