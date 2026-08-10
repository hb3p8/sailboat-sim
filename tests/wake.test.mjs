// Свободная пелена: node tests/wake.test.mjs
//
// Первый шаг из трёх (docs/flow-plan.md, III.2.a): пелена строится, сносится и
// рисуется, но В СИЛЫ НЕ ВХОДИТ. Матрица влияния по-прежнему считает прямые
// лучи, сходящие с задней кромки вдоль потока.
//
// Отсюда и главная проверка здесь, и она же самая скучная: с включённой пеленой
// лодка обязана идти ТОЧНО так же, как без неё. Не «примерно», а до последнего
// разряда — иначе пелена уже во что-то вмешалась, и разбираться придётся не
// здесь, а через неделю на пересобранном эталоне.
//
// Остальное — свойства самой пелены: сходит с кромки, уносится по потоку,
// суммарная завихренность паруса равна нулю, сброс её чистит. И три свойства,
// которых тут сперва не было и каждое из которых уже успело оказаться неверным:
// снос не зависит от порядка нитей, нити знают свой парус, а сама пелена висит
// в мире и за лодкой не поворачивается.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { FreeWake } from '../sim/vlm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + name + (detail ? '   ' + detail : ''));
};

function run(wake, steps, drive) {
  const b = new Boat(PACK);
  b.o.freeWake = wake;
  b.o.windSpeed = 8; b.o.windDir = 100 * D; b.psi = 55 * D;
  b.o.sheet = 14 * D; b.o.twist = 8 * D;
  b.o.crewHike = 1; b.o.crewMass = 219.9; b.u = 4;
  b.wind.o.gust = 0.2; b.wind.o.shift = 9 * D;
  for (let i = 0; i < steps; i++) {
    if (drive) drive(b, i / 30);
    b.step(1 / 30);
  }
  return b;
}

// --- пелена не трогает силы ----------------------------------------------------
console.log('\nЛодка с пеленой и без неё, 45 секунд с порывами и перекладкой руля:\n');
{
  const drive = (b, t) => { b.o.rudderTarget = 12 * D * Math.sin(t / 5); };
  const a = run(false, 45 * 30, drive), c = run(true, 45 * 30, drive);
  const F = ['x', 'y', 'psi', 'u', 'v', 'r', 'phi', 'p_', 'zc', 'w', 'th', 'q', 'hike'];
  let worst = 0, who = '';
  for (const k of F) {
    const d = Math.abs(a[k] - c[k]);
    if (d > worst) { worst = d; who = k; }
  }
  console.log('  ход  %s против %s уз', a.telemetry.speedKn.toFixed(9), c.telemetry.speedKn.toFixed(9));
  console.log('  крен %s против %s°', (a.phi / D).toFixed(9), (c.phi / D).toFixed(9));
  console.log('  наибольшее расхождение по состоянию: %s (%s)\n', worst.toExponential(1), who);
  check('пелена не меняет ни одного разряда в состоянии лодки', worst === 0,
    worst === 0 ? 'ровно ноль' : worst.toExponential(1) + ' по ' + who);
  check('и ни одного в показаниях',
    a.telemetry.driveN === c.telemetry.driveN && a.telemetry.sideN === c.telemetry.sideN,
    a.telemetry.driveN.toFixed(9) + ' против ' + c.telemetry.driveN.toFixed(9));
}

// --- свойства самой пелены -----------------------------------------------------
{
  const b = run(true, 20 * 30);
  const w = b.rig.wake;
  const L = w.len;
  console.log('Пелена: %d нитей по %d узлов, сошло %d\n', w.fil, w.len, w.n);
  check('пелена завелась и заполнилась', w && w.n === w.len, w ? String(w.n) : 'нет');

  // Узел тем дальше от кромки, чем он старше: пелена уносится, а не стоит.
  let mono = true, far = 0;
  for (let f = 0; f < w.fil; f++) {
    if (!w.g[f]) continue;
    const bi = f * L;
    let prev = -1;
    for (let i = 0; i < w.n; i++) {
      const dx = w.x[bi + i] - w.x[bi], dy = w.y[bi + i] - w.y[bi];
      const d = Math.hypot(dx, dy);
      if (d < prev - 1e-9) mono = false;
      prev = d; far = Math.max(far, d);
    }
  }
  check('узлы уходят от кромки монотонно с возрастом', mono);
  // Сорок узлов при тридцати герцах — это 1.3 секунды, а не три: узел сходит
  // каждый шаг.
  check('за секунду с небольшим пелена уходит на несколько длин лодки',
    far > 6 && far < 60, far.toFixed(1) + ' м');

  // Суммарная сходящая завихренность паруса равна нулю: сколько циркуляции
  // набралось к топу, столько и сошло. Это не подгонка, а тождество — если
  // нарушится, значит нити расставлены не по границам полосок.
  let sum = 0;
  for (let f = 0; f < w.fil; f++) sum += w.g[f];
  check('суммарная сила нитей равна нулю', Math.abs(sum) < 1e-9, sum.toExponential(1));

  // Пелена вся под ветром от паруса и вся ниже топа: если полезла на наветренную
  // сторону или вверх, значит снос считается не тем полем.
  let above = 0, zmin = 1e9;
  for (let f = 0; f < w.fil; f++) {
    for (let i = 0; i < w.n; i++) {
      above = Math.max(above, w.z[f * L + i]);
      zmin = Math.min(zmin, w.z[f * L + i]);
    }
  }
  check('пелена не поднимается выше топа', above < 11, above.toFixed(1) + ' м');
  check('и не уходит под воду', zmin > -0.5, zmin.toFixed(1) + ' м');
}

// --- нити знают свой парус -----------------------------------------------------
//
// Нить сидит на границе полосок, но на стыке грота со стакселем их две подряд:
// конец одного набора и начало другого. С этого места номер нити и номер
// полоски разъезжаются на единицу, и всякий, кто позже полезет от нити к
// полоске, ошибётся — полотно пелены натянется через щель между парусами.
// Поэтому парус пишется при построении нитей, а не восстанавливается по номеру.
{
  const b = run(true, 5 * 30);
  const S = b.rig.wakeSail, w = b.rig.wake;
  let flips = 0, mixed = 0, used = 0;
  for (let f = 0; f < w.fil; f++) {
    if (S[f] < 0) continue;
    used++;
    if (S[f + 1] >= 0 && S[f] !== S[f + 1]) flips++;
  }
  for (let f = 0; f + 1 < w.fil; f++) if (S[f] >= 0 && S[f + 1] >= 0 && S[f] !== S[f + 1]) mixed++;
  // Нитей на одну больше, чем границ полосок: на стыке парусов их две подряд.
  check('парус записан у каждой рабочей нити', used === b.rig.strips.length + 2,
    used + ' из ' + (b.rig.strips.length + 2));
  check('паруса идут двумя сплошными кусками, а не вперемешку', flips === 1,
    String(flips));
  check('через щель между парусами полотно не натягивается', mixed === 1,
    String(mixed));

  // И ровно тот промах, ради которого это записывается: номер нити на стыке уже
  // не равен номеру полоски. Считать парус по `strips[f]` — ошибиться на одну.
  let stripFlip = -1, filFlip = -1;
  for (let i = 0; i + 1 < b.rig.strips.length; i++) {
    if (b.rig.strips[i].jib !== b.rig.strips[i + 1].jib) stripFlip = i;
  }
  for (let f = 0; f + 1 < w.fil; f++) if (S[f] >= 0 && S[f + 1] >= 0 && S[f] !== S[f + 1]) filFlip = f;
  check('стык нитей смещён относительно стыка полосок', filFlip === stripFlip + 1,
    'полоски ' + stripFlip + ', нити ' + filFlip);
}

// --- снос не зависит от порядка нитей ------------------------------------------
//
// Скорость узла зависит от всей пелены, включая соседние нити. Двигай узлы по
// ходу дела — и второй нити достанется поле, в котором первая уже сдвинулась, а
// третья ещё нет. Пелена свернётся в жгут по-разному в зависимости от того, как
// нити пронумерованы, а нумерация не физика. Проверяется прямо: те же нити,
// переставленные местами, обязаны дать тот же ответ.
{
  const FIL = 4, LEN = 12, DT = 1 / 30;
  const gam = [0.9, -0.4, 0.6, -1.1];
  const start = (f, i) => [0.3 * i, 0.8 * f - 1.2, 3 + 0.05 * i * (f - 1.5)];

  const grow = (order) => {
    const w = new FreeWake(FIL, LEN);
    w.core = 0.05;
    const g = order.map((o) => gam[o]);
    const V = [0, 0, 0];
    const vel = (x, y, z, out) => {
      w.induced(x, y, z, true, V);
      out[0] = 6 + V[0]; out[1] = V[1]; out[2] = V[2];
    };
    const seed = (f, out) => {
      const p = start(order[f], 0);
      out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
    };
    for (let s = 0; s < LEN + 6; s++) w.step(DT, seed, vel, g);
    return w;
  };

  const a = grow([0, 1, 2, 3]);
  const c = grow([3, 2, 1, 0]);              // те же нити, порядок обратный
  let worst = 0;
  for (let f = 0; f < FIL; f++) {
    const ia = f * LEN, ic = (FIL - 1 - f) * LEN;
    for (let i = 0; i < a.n; i++) {
      worst = Math.max(worst,
        Math.abs(a.x[ia + i] - c.x[ic + i]),
        Math.abs(a.y[ia + i] - c.y[ic + i]),
        Math.abs(a.z[ia + i] - c.z[ic + i]));
    }
  }
  // Ровного нуля тут не будет и не должно быть: суммы Био — Савара складываются
  // по нитям, а сложение чисел с плавающей точкой неассоциативно. Порог на
  // двенадцати порядках ниже самого сноса, а промах с одним проходом стоил бы
  // сантиметров — разница между тем и другим не в порядке, а в природе.
  console.log('\nПереставленные нити: наибольшее расхождение %s м\n', worst.toExponential(1));
  check('снос не зависит от порядка нитей в массиве', worst < 1e-12,
    worst.toExponential(1) + ' м');
}

// --- пелена висит в мире, а не за кормой ---------------------------------------
//
// Ради этого маршевая схема и берётся: после поворота старая пелена остаётся
// там, где была, и лодка идёт по собственному старому следу. Если хранить узлы
// в связанных с лодкой осях, весь след поворачивается вместе с ней, и попасть в
// него становится невозможно в принципе.
//
// Проверяется грубо и прямо: лодке ВРУЧНУЮ доворачивается курс на сорок
// градусов между шагами. Узел в дюжине метров за кормой, будь он приколочен к
// лодке, проехал бы на этом полдюжины метров вбок. Живущий в воздухе сдвинется
// на снос за шаг, то есть на десяток сантиметров.
{
  const b = run(true, 20 * 30);
  const w = b.rig.wake, L = w.len;
  const X = Float64Array.from(w.x), Y = Float64Array.from(w.y);
  const turn = 40 * D;
  b.psi += turn;
  b.step(1 / 30);
  // Узел стареет на позицию: то, что было i-м, стало (i+1)-м.
  let moved = 0, asIfBody = 0;
  for (let f = 0; f < w.fil; f++) {
    if (!w.g[f]) continue;
    for (let i = 0; i + 1 < w.n; i++) {
      const o = f * L + i;
      moved = Math.max(moved, Math.hypot(w.x[o + 1] - X[o], w.y[o + 1] - Y[o]));
      // Столько тот же узел проехал бы, будь он приколочен к лодке: хорда
      // поворота на том же радиусе.
      const R = Math.hypot(X[o] - b.x, Y[o] - b.y);
      asIfBody = Math.max(asIfBody, 2 * R * Math.sin(turn / 2));
    }
  }
  console.log('Доворот на %d°: узел сдвинулся на %s м, за лодкой уехал бы на %s м\n',
    Math.round(turn / D), moved.toFixed(2), asIfBody.toFixed(2));
  check('поворот лодки утащил бы пелену заметно', asIfBody > 3, asIfBody.toFixed(2) + ' м');
  check('но она остаётся там, где висела', moved < 0.2 * asIfBody,
    moved.toFixed(2) + ' против ' + asIfBody.toFixed(2) + ' м');
}

// --- полный курс: пелена не должна разносить счёт -------------------------------
//
// Здесь она разносилась, и это была не физика. Ядро вихря стояло на четырёх
// сантиметрах, а нити на полном курсе сходились до семи: внутри ядра Био — Савар
// тем быстрее, чем ближе подошли, явный шаг швыряет узел дальше, тот подходит
// ещё ближе. Узел ехал 2000 м/с при кажущемся ветре 4.5 — в четыреста раз
// быстрее воздуха, который его несёт.
//
// Полный курс попадает под это первым по двум причинам сразу: кажущийся ветер
// там самый слабый, узлы почти не уносит от паруса и они висят в самом сильном
// наведённом поле; а циркуляции за срывом большие и неровные по высоте, и силы
// нитей — их разности — выходят большими и шумными.
//
// Мерится это не «на глаз по картинке», а изломом: углом между соседними
// звеньями нити. У гладкой пелены это единицы градусов, у разнесённой — шесть
// десятков, и она именно так и выглядит — рваной.
{
  const b = new Boat(PACK);
  b.o.freeWake = true;
  b.o.windSpeed = 8; b.o.windDir = 100 * D; b.psi = -75 * D;   // TWA 175°
  b.o.sheet = 80 * D; b.o.jibSheet = 80 * D;
  b.o.crewHike = 1; b.o.crewMass = 219.9; b.u = 3;
  b.wind.o.gust = 0.2; b.wind.o.shift = 9 * D;
  for (let i = 0; i < 20 * 30; i++) b.step(1 / 30);

  const w = b.rig.wake, L = w.len;
  const air = b.apparentWind().speed;
  let sum = 0, cnt = 0, fast = 0, seg = 0;
  for (let f = 0; f < w.fil; f++) {
    if (!w.g[f]) continue;
    for (let k = 1; k < w.n; k++) {
      const a = f * L + k - 1, m = f * L + k;
      const ax = w.x[m] - w.x[a], ay = w.y[m] - w.y[a], az = w.z[m] - w.z[a];
      const la = Math.hypot(ax, ay, az);
      seg++;
      if (la * 30 > 4 * air) fast++;
      if (k + 1 >= w.n || la < 1e-9) continue;
      const c = f * L + k + 1;
      const bx = w.x[c] - w.x[m], by = w.y[c] - w.y[m], bz = w.z[c] - w.z[m];
      const lb = Math.hypot(bx, by, bz);
      if (lb < 1e-9) continue;
      const cs = Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb)));
      sum += Math.acos(cs) / D; cnt++;
    }
  }
  const kink = sum / cnt;
  console.log('\nПолный курс, кажущийся %s м/с: излом %s° на узел, быстрее ' +
              'четверного ветра %d звеньев из %d\n',
              air.toFixed(1), kink.toFixed(1), fast, seg);
  check('на полном курсе пелена гладкая, а не рваная', kink < 6,
    kink.toFixed(1) + '° на узел');
  check('узлы плывут с воздухом, а не летят', fast < 0.02 * seg,
    fast + ' из ' + seg);

  // Оба средства против разноса — на месте и работают.
  let rcYoung = 0, rcOld = 0;
  for (let f = 0; f < w.fil; f++) {
    rcYoung = Math.max(rcYoung, w.rc[f * L]);
    rcOld = Math.max(rcOld, w.rc[f * L + w.n - 1]);
  }
  check('ядро расплывается с возрастом узла', rcOld > 3 * w.core,
    (100 * w.core).toFixed(1) + ' см у свежего, ' + (100 * rcOld).toFixed(0) + ' у старого');
  // Пол по расстоянию до соседа: у каждого узла ядро не меньше половины
  // расстояния до БЛИЖАЙШЕЙ соседней нити того же возраста. Ближайшей, а не
  // любой: пол ставится по тесноте, а тесно бывает с одной стороны.
  let tight = 0;
  for (let f = 0; f < w.fil; f++) {
    if (!w.g[f]) continue;
    for (let k = 0; k < w.n; k++) {
      const a = f * L + k;
      let d = Infinity;
      for (const nf of [f - 1, f + 1]) {
        if (nf < 0 || nf >= w.fil || !w.g[nf]) continue;
        const c = nf * L + k;
        d = Math.min(d, Math.hypot(w.x[c] - w.x[a], w.y[c] - w.y[a], w.z[c] - w.z[a]));
      }
      if (d < Infinity && 2 * w.rc[a] < d - 1e-9) tight++;
    }
  }
  check('ядро не меньше полурасстояния до ближайшей нити', tight === 0, String(tight));
  rcYoung;
}

// --- выключение и сброс --------------------------------------------------------
{
  const b = run(true, 5 * 30);
  b.o.freeWake = false;
  b.step(1 / 30);
  check('выключенная пелена стирается', b.rig.wake.n === 0, String(b.rig.wake.n));
}

console.log(failures ? '\n' + failures + ' проверок провалено' : '\nвсе проверки прошли');
console.log('');
process.exit(failures ? 1 : 0);
