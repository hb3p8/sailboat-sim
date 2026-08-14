// Проиграть дамп симулятора без браузера:
//
//     node scripts/replay.mjs дамп.json            — воспроизвести запись
//     node scripts/replay.mjs дамп.json --after 60 — и продолжить на 60 с
//
// Дамп пишет кнопка «Сдампать состояние» в симуляторе (или клавиша P). В нём
// лежит состояние лодки, настройки, поле ветра и запись последних двадцати
// секунд по шагам физики.
//
// Скрипт делает две разные вещи, и обе нужны.
//
// Первая: берёт первый кадр записи, восстанавливает по нему лодку, подаёт
// записанные положения руля и шкота — и сравнивает, что получилось, с тем, что
// было записано. Если расхождение нулевое, случай воспроизводится точно и с ним
// можно работать. Если нет — значит с момента дампа что-то в модели поменялось,
// и это само по себе полезно знать (в дампе есть отметка сборки).
//
// Вторая: продолжает с конца записи, чтобы посмотреть, куда дело шло дальше.
// Жалобы на воде звучат как «понемногу разгоняется» — на это нужны минуты, а не
// двадцать секунд.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { fieldIndex, replayTrace, replayToEnd } from '../sim/trace.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const D = Math.PI / 180;

const args = process.argv.slice(2);
const path = args.find(a => !a.startsWith('--'));
if (!path) {
  console.error('нужен файл дампа: node scripts/replay.mjs дамп.json [--after 60]');
  process.exit(2);
}
const afterIdx = args.indexOf('--after');
const after = afterIdx >= 0 ? parseFloat(args[afterIdx + 1]) : 0;

const dump = JSON.parse(readFileSync(path, 'utf8'));
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));

const b = dump.build || {};
console.log('\nДамп от ' + (dump.saved || '?') + ', сборка ' +
  (b.commit || '?') + (b.dirty ? ' (с несохранёнными правками)' : '') +
  ', ветка ' + (b.branch || '?'));

const tr = dump.trace || {};
const F = fieldIndex(tr.fields);
const frames = tr.frames || [];

function applyOptions(boat) {
  Object.assign(boat.o, dump.controls || {});
  Object.assign(boat.wind.o, dump.wind || {});
  boat.o.rudderTarget = null;          // руль ведём вручную по записи
}

console.log('Условия: ветер ' + (dump.wind ? dump.wind.speed.toFixed(1) : '?') +
  ' м/с от ' + (dump.wind ? (dump.wind.dir / D).toFixed(0) : '?') +
  '°, порывы ' + (dump.wind ? (dump.wind.gust * 100).toFixed(0) : '?') +
  '%, экипаж ' + (dump.controls ? (dump.controls.crewHike * 100).toFixed(0) : '?') +
  '% на борту');

// --- воспроизведение записи ---------------------------------------------------

if (frames.length > 1) {
  const boat = new Boat(PACK);
  applyOptions(boat);

  // Проход по записи — общий с батареей (`sim/trace.js`), а не свой. Он же
  // умеет начинать сверку с опорного кадра, где записана пелена: своим циклом
  // тут выходило сравнение модели С ПАМЯТЬЮ и модели, стартовавшей с пустой
  // пеленой, то есть расхождение сообщалось о том, чего в модели нет.
  let worst = { speed: 0, heel: 0, psi: 0, at: 0 };
  const from = replayTrace(boat, tr, F, (i, b, want) => {
    const t = b.telemetry;
    const d = {
      speed: Math.abs(t.speedKn - want[F.speedKn]),
      heel: Math.abs(t.heelDeg - want[F.heelDeg]),
      psi: Math.abs(b.psi - want[F.psi]) / D,
    };
    if (d.speed + d.heel + d.psi > worst.speed + worst.heel + worst.psi) {
      worst = Object.assign(d, { at: want[F.t] });
    }
  });
  const secs = (frames[frames.length - 1][F.t] - frames[0][F.t]).toFixed(1);
  console.log('\nЗапись: ' + frames.length + ' кадров, ' + secs + ' с');
  console.log(from
    ? 'Сверка с опорного кадра ' + from + ' (' + frames[from][F.t].toFixed(1) +
      ' с): до него пелены в записи нет.'
    : 'Опорных кадров в записи нет — сверка с самого начала, пелена пустая.');
  console.log('Наибольшее расхождение с записью: скорость ' +
    worst.speed.toFixed(3) + ' уз, крен ' + worst.heel.toFixed(3) +
    '°, курс ' + worst.psi.toFixed(3) + '°');
  // Запись округляется до четвёртого знака, причём углы в радианах: четвёртый
  // знак там стоит 0.0057°. Поэтому «точно» — это в пределах округления.
  const exact = worst.speed < 2e-3 && worst.heel < 2e-2 && worst.psi < 2e-2;
  console.log(exact
    ? 'Случай воспроизводится точно.'
    : 'ВНИМАНИЕ: модель отвечает не так, как при записи, — с тех пор она менялась.');

  // Что происходило внутри записи: по этому видно и дрожь, и разгон.
  const col = name => frames.map(f => f[F[name]]);
  const rng = a => [Math.min(...a), Math.max(...a)];
  const alt = a => {
    let c = 0;
    for (let i = 2; i < a.length; i++) {
      const d1 = a[i] - a[i - 1], d0 = a[i - 1] - a[i - 2];
      if (d1 * d0 < 0 && Math.abs(d1) > 1e-6) c++;
    }
    return c;
  };
  const show = (name, unit, k = 1) => {
    const a = col(name).map(v => v * k);
    const [lo, hi] = rng(a);
    console.log('  ' + name.padEnd(9) + lo.toFixed(2).padStart(9) + ' … ' +
      hi.toFixed(2).padStart(8) + ' ' + unit.padEnd(5) +
      ' смен направления: ' + alt(a));
  };
  console.log('\nЧто было в записи:');
  show('speedKn', 'уз');
  show('heelDeg', '°');
  show('psi', '°', 1 / D);
  show('driveN', 'Н');
  show('sideN', 'Н');
  show('twsKn', 'уз');
  // Борт паруса — величина непрерывная: гик переходит за секунду. Считаем
  // смены знака, то есть настоящие перебросы, а не каждый шаг взмаха.
  const sides = col('rigSide').map(v => Math.sign(v || 1));
  let flips = 0;
  for (let i = 1; i < sides.length; i++) if (sides[i] !== sides[i - 1]) flips++;
  console.log('  парус перекидывался ' + flips + ' раз');
}

// --- продолжение с конца ------------------------------------------------------

if (after > 0) {
  const boat = new Boat(PACK);
  applyOptions(boat);
  // Догнать конец записи: от последнего опорного кадра и остаток шагами. Один
  // последний кадр не годится — пелены в нём нет, и продолжение пошло бы с
  // чужим скрытым состоянием.
  let warm = false;
  if (frames.length) warm = replayToEnd(boat, tr, F);
  else Object.assign(boat, dump.boat || {});
  boat.o.rudderTarget = null;

  console.log('\nПродолжение с конца записи, ' + after + ' с, органы не трогаем' +
    (warm ? ' (пелена догнана от опорного кадра):' : ' (опорных кадров нет, пелена пустая):'));
  console.log('   время   узлы   крен    TWA   дрейф   α');
  const n = Math.round(after * 30);
  for (let i = 0; i < n; i++) {
    boat.step(1 / 30);
    if ((i + 1) % Math.max(1, Math.round(n / 10)) === 0) {
      const t = boat.telemetry;
      console.log('  ' + boat.t.toFixed(0).padStart(5) + ' с ' +
        t.speedKn.toFixed(2).padStart(6) + ' ' + t.heelDeg.toFixed(1).padStart(6) +
        '° ' + t.twaAbsDeg.toFixed(0).padStart(5) + '° ' +
        t.leewayDeg.toFixed(1).padStart(6) + '° ' +
        t.alphaDeg.toFixed(0).padStart(4) + '°');
    }
  }
}

console.log('');
