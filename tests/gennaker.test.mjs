// Генакер: node tests/gennaker.test.mjs
//
// Батарея заведена по ревью (docs/gennaker-planing-plan.md, §4.9): ни одна из
// прежних не считала третий парус, и потому ни полуметровые щели между
// полосками, ни разнос циркуляции на обычном положении шкота они поймать не
// могли. Здесь проверяется то, что относится к самому парусу и к постановке, а
// не к ходовым качествам: их мерить нечем, пока модель не устойчива.
//
// Порядок проверок — от геометрии пакета к устойчивости решения: если врёт
// геометрия, устойчивость мерить бессмысленно.
//
// ЭТА БАТАРЕЯ СЕЙЧАС ВАЛИТСЯ, и нарочно: последняя проверка — та самая полоса
// шкота 5.4…6.6 м, где решение разносится (docs/wake.md, §5.12). Дефект открыт,
// причина установлена не до конца, и свидетель обязан быть красным, пока это
// так. Поэтому батарея НЕ включена в `make test`: набор должен оставаться
// зелёным, иначе он перестаёт что-либо значить для всего остального.
//
// Включить её в Makefile — последним шагом починки, и это же будет признаком,
// что часть I плана закрыта.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { gennakerSetOf } from '../sim/aero.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
};

const G = PACK.rig.gennaker;

// --- геометрия пакета ---------------------------------------------------------
{
  console.log('\nГеометрия пакета:\n');
  // Площадь — единственное, что пришло от конструктора, и обмерная формула
  // обязана её воспроизвести. Всё остальное в парусе выведено из неё.
  const area = (G.luff_m + G.leech_m) / 2 * (G.foot_m + 4 * G.girth_mid_m) / 6;
  check('обмерная площадь сходится с конструкторской 27 м²',
        Math.abs(area - 27) < 0.05, area.toFixed(3) + ' м²');
  check('средняя ширина не ниже порога спинакера (0.75 нижней)',
        G.girth_mid_m >= 0.75 * G.foot_m,
        (G.girth_mid_m / G.foot_m).toFixed(3));
  // Галс на бушприте, впереди форштевня; фал выше хаундов.
  check('галс вынесен вперёд форштевня', G.tack[0] > PACK.rig.forestay.stem[0],
        G.tack[0].toFixed(3) + ' против ' + PACK.rig.forestay.stem[0].toFixed(3));
  check('фаловый угол имеет ширину, а не сходится в точку',
        G.head[0] - G.head_aft[0] > 0.05,
        (G.head[0] - G.head_aft[0]).toFixed(3) + ' м');
  // Длина шкота -> вынос: обязана расти монотонно, иначе ползунок не орган
  // управления, а лотерея.
  let mono = true, prev = -1;
  for (let L = G.sheet_min_m; L <= G.sheet_max_m; L += 0.1) {
    const a = gennakerSetOf({ genSheetLen: L }, G);
    if (a < prev - 1e-9) mono = false;
    prev = a;
  }
  check('вынос растёт с длиной шкота монотонно', mono);
}

// --- топология рига -----------------------------------------------------------
{
  console.log('\nТопология рига:\n');
  const mk = up => {
    const b = new Boat(PACK);
    b.o.freeWake = true; b.o.wakeForces = true;
    if (up) b.setGennaker(true);
    b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = 3;
    b.step(1 / 30);
    return b;
  };
  const a = mk(false), c = mk(true);
  check('без генакера двенадцать полосок', a.rig.strips.length === 12,
        String(a.rig.strips.length));
  check('с генакером восемнадцать', c.rig.strips.length === 18,
        String(c.rig.strips.length));
  // Нитей на стык парусов приходится по лишней: NS + 1 + стыков.
  check('нитей пелены без генакера четырнадцать', a.rig.wake.fil === 14,
        String(a.rig.wake.fil));
  check('с генакером двадцать одна', c.rig.wake.fil === 21, String(c.rig.wake.fil));
  check('подъём убирает стаксель', c.o.jibUp === false);
  // Уборка возвращает риг ровно к прежнему.
  c.setGennaker(false);
  check('уборка возвращает двенадцать полосок и стаксель',
        c.rig.strips.length === 12 && c.o.jibUp === true);
}

// --- непрерывность несущей поверхности ----------------------------------------
//
// ГЛАВНАЯ проверка этой батареи. Боковой вынос передней шкаторины считался один
// раз в середине полоски и подавался на обе её границы — общая граница двух
// соседей получала две разные координаты, и поверхность размахом 8.6 м
// оказывалась разрезана щелями до полуметра. Точки схода пелены рвались на
// столько же. Решётка предполагает общее ребро; на щелях она даёт лишние
// краевые вихри и теряет обусловленность.
//
// Мерка — не ноль, а грот: у него полоски тоже стоят под разным твистом, и
// стык на этом расходится. Генакер обязан быть не хуже своего же рига.
{
  console.log('\nНепрерывность поверхности:\n');
  const b = new Boat(PACK);
  b.o.freeWake = true; b.o.wakeForces = true;
  b.o.crewHike = -1; b.o.crewMass = 219.9;
  b.wind.o.gust = 0; b.wind.o.shift = 0;
  b.setGennaker(true);
  b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = 6.0;
  b.reset();
  b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = 3; b.psi = -40 * D;
  for (let i = 0; i < 60; i++) b.step(1 / 30);

  const S = b.rig.strips, lat = b.rig.lattice, NC = lat.n / S.length;
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const seam = (from, to) => {
    let panel = 0, shed = 0;
    for (let i = from; i < to; i++) {
      for (let k = 0; k < NC; k++) {
        panel = Math.max(panel, dist(lat.panels[i * NC + k].a,
                                     lat.panels[(i + 1) * NC + k].b));
      }
      shed = Math.max(shed, dist(b.rig.shedHi[i], b.rig.shedLo[i + 1]));
    }
    return { panel, shed };
  };
  const main = seam(0, 5), gen = seam(12, 17);
  console.log('    грот:    панели %s м, точки схода %s м',
              main.panel.toFixed(3), main.shed.toFixed(3));
  console.log('    генакер: панели %s м, точки схода %s м\n',
              gen.panel.toFixed(3), gen.shed.toFixed(3));
  // Втрое — с запасом на то, что у генакера хорды вчетверо длиннее гротовых, и
  // тот же угол твиста разводит концы дальше.
  check('щели между полосками генакера того же порядка, что у грота',
        gen.panel < 3 * main.panel && gen.shed < 3 * main.shed,
        'панели ' + (gen.panel / main.panel).toFixed(2) + '×, схода ' +
        (gen.shed / main.shed).toFixed(2) + '×');
}

// --- устойчивость решения по всей полосе шкота ---------------------------------
//
// Ползунок шкота — орган управления, и на любом его положении решение обязано
// оставаться решением. Мерка — связанная циркуляция: ход тут не свидетель, он
// ограничен полярой сечения и остаётся правдоподобным даже при Γ порядка 10⁷
// (docs/wake.md, §5.12).
{
  console.log('\nУстойчивость по длине шкота (TWA 140°, ветер 6 м/с):\n');
  const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const run = (len, twa = 140) => {
    const b = new Boat(PACK);
    b.o.freeWake = true; b.o.wakeForces = true;
    b.o.crewHike = -1; b.o.crewMass = 219.9;
    b.wind.o.gust = 0; b.wind.o.shift = 0;
    b.setGennaker(true);
    b.o.sheet = 70 * D; b.o.twist = 8 * D; b.o.genSheetLen = len;
    b.reset();
    b.o.windSpeed = 6; b.o.windDir = 100 * D; b.u = 3;
    b.psi = (100 - twa) * D;
    let gmax = 0;
    for (let i = 0; i < 25 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
        -(2.2 * wrap((100 - twa) * D - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
      const Gs = b.rig.stripGamma;
      if (Gs) for (let k = 0; k < Gs.length; k++) gmax = Math.max(gmax, Math.abs(Gs[k]));
    }
    return { gmax, v: b.telemetry.speedKn, fuse: b.rig.fuseTrips || 0 };
  };
  // Предел: рабочая циркуляция полоски здесь порядка тридцати, сотня — уже с
  // запасом вдвое, а разнос всегда уходит на порядки, а не на проценты.
  const LIMIT = 300;
  let worst = 0, worstAt = 0;
  for (let L = 4.0; L <= 7.01; L += 0.2) {
    const r = run(L);
    if (r.gmax > worst) { worst = r.gmax; worstAt = L; }
    console.log('    шкот %s м:  Γ до %s   ход %s уз   предохранитель %s%s',
      L.toFixed(1), r.gmax.toExponential(1).padStart(9), r.v.toFixed(2),
      String(r.fuse).padStart(3),
      r.gmax > LIMIT ? '   РАЗНОС' : '');
  }
  console.log('');
  check('решение не разносится ни на одном положении шкота', worst < LIMIT,
        'худшее Γ = ' + worst.toExponential(1) + ' при шкоте ' + worstAt.toFixed(1) + ' м');

  // И ТО ЖЕ САМОЕ ПО КУРСУ, потому что одной развёртки мало.
  //
  // Развёртка выше идёт при TWA 140° и однажды уже обманула: по ней объявили,
  // что генакер сделан, а он держался на одном курсе. Двумерная карта показала,
  // что здоровая область — диагональная полоса в (курс, шкот), и середина
  // заявленного диапазона в неё не попадает: при TWA 120° и шкоте 4.5…5.5 м
  // предохранитель звенит по три десятка раз за двадцать пять секунд.
  //
  // Заявленный диапазон назван владельцем лодки: «в основном бакштаг, но бывает
  // близко к фордевинду», то есть TWA 120…180°. Проверка стоит на нём целиком, и
  // пока она красная — генакер не сделан, как бы ни выглядела одна развёртка.
  console.log('\nУстойчивость по курсу и шкоту (ветер 6 м/с), Γmax и срабатывания:\n');
  const TWAS = [120, 135, 150, 165, 180];
  const LENS = [3.5, 4.5, 5.5, 6.5, 7.5];
  let head = '      шкот \\ курс';
  for (const t of TWAS) head += (t + '°').padStart(12);
  console.log(head);
  let bad = 0, badAt = '';
  for (const L of LENS) {
    let line = ('    ' + L.toFixed(1) + ' м').padStart(17);
    for (const t of TWAS) {
      const r = run(L, t);
      const ill = r.gmax > LIMIT || r.fuse > 2;
      if (ill) { bad++; if (!badAt) badAt = 'TWA ' + t + '°, шкот ' + L.toFixed(1) + ' м'; }
      line += ((ill ? '!' : ' ') + r.gmax.toExponential(1) +
               (r.fuse ? '×' + r.fuse : '')).padStart(12);
    }
    console.log(line);
  }
  console.log('');
  check('на всех заявленных курсах решение держится', bad === 0,
        bad ? bad + ' клеток из 25, первая — ' + badAt : '');
}

console.log(failures ? '\n' + failures + ' проверок провалено' : '\nвсе проверки прошли');
process.exit(failures ? 1 : 0);
