// Проиграть дамп симулятора без браузера:
//
//     node scripts/replay.mjs a3f9c2               — по имени с сервера
//     node scripts/replay.mjs дамп.json            — или путём к файлу
//     node scripts/replay.mjs a3f9c2 --after 60    — и продолжить на 60 с
//
// Дамп пишет кнопка «Сдампать состояние» в симуляторе (или клавиша P). Уходит
// он на сервер (`scripts/serve.py`), тот кладёт его в `out/dumps/` и отвечает
// коротким именем — оно видно под кнопкой. Этим именем дамп здесь и зовётся;
// путь к файлу тоже принимается, в том числе к скачанному по старинке.
//
// В дампе лежит состояние лодки, настройки, поле ветра, полотно генакера и
// запись последних двадцати секунд по шагам физики.
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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';
import { fieldIndex, replayTrace, replayToEnd, applyDump } from '../sim/trace.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const D = Math.PI / 180;

const args = process.argv.slice(2);
const asked = args.find(a => !a.startsWith('--'));
if (!asked) {
  console.error('нужен дамп: node scripts/replay.mjs a3f9c2 [--after 60]');
  console.error('имя показано под кнопкой «Сдампать состояние»; можно и путь к файлу');
  process.exit(2);
}

// Имя дампа или путь к файлу. Имя ищется в `out/dumps/`, куда его кладёт
// сервер: файл там зовётся датой и именем, а спрашивают обычно одно имя.
function resolveDump(a) {
  if (existsSync(a)) return a;
  const dir = join(ROOT, 'out', 'dumps');
  if (!existsSync(dir)) return null;
  const want = String(a).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const hit = readdirSync(dir).filter(n => n.endsWith('.json'))
    .sort().reverse()
    .find(n => n.slice(0, -5) === want || n.slice(0, -5).endsWith('-' + want));
  return hit ? join(dir, hit) : null;
}

const path = resolveDump(asked);
if (!path) {
  console.error('дампа «' + asked + '» нет ни файлом, ни в out/dumps/');
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

// Разбор дампа — ОБЩИЙ с симулятором (`sim/trace.js`), а не свой.
//
// Свой был, и на генакере он разошёлся: настройки присваивались скопом, флаг
// `gennakerUp` вставал в лодку, а риг оставался прежним — двенадцать полосок
// вместо восемнадцати. Дамп при этом читался «успешно» и врал молча.
function applyOptions(boat) {
  const gotCloth = applyDump(boat, dump);
  boat.o.rudderTarget = null;          // руль ведём вручную по записи
  return gotCloth;
}

// Какие паруса несёт лодка в дампе. Раньше об этом не говорилось, а генакер
// вовсе не поднимался — и разбор шёл по другому ригу, молча.
{
  const c = dump.controls || {};
  const sails = [c.mainUp !== false ? 'грот' : null,
                 c.jibUp !== false ? 'стаксель' : null,
                 c.gennakerUp ? 'генакер ' + (c.genSheetLen || 0).toFixed(1) + ' м' : null]
    .filter(Boolean).join(', ') || 'без парусов';
  console.log('Паруса: ' + sails +
    (c.gennakerUp ? (dump.cloth ? ', полотно из дампа' : ', ПОЛОТНА В ДАМПЕ НЕТ — сядет на крой') : ''));
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
