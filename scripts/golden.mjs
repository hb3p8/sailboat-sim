// Отпечаток поведения модели: node scripts/golden.mjs
//
// Нужен ровно для одного — перекладывать код, не меняя физику. Разделение
// большого модуля на несколько это сотни механических правок, и глазом среди
// них ошибку не найти: батареи проверяют свойства («откренивание прибавляет
// ход»), а перестановка знака внутри допуска свойство не нарушит.
//
// Здесь проверяется не свойство, а тождество. Прогоняются несколько сценариев с
// разными курсами, ветром и перекладками, и печатается состояние на контрольных
// секундах — с точностью до девятого знака. Снимок делается ДО правки,
// складывается в файл, и после правки требуется побайтовое совпадение.
//
// Случайного здесь нет: ветер задаётся порывистостью и временем, а не
// генератором, поэтому один и тот же сценарий даёт один и тот же ответ на любой
// машине.
//
//     node scripts/golden.mjs > /tmp/before.txt
//     ... правки ...
//     node scripts/golden.mjs | diff /tmp/before.txt -

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const D = Math.PI / 180;
const HZ = 30;

// Сценарии подобраны так, чтобы задеть все ветви: лавировку с откренивающимся
// экипажем, полный курс с перекладкой гика, левентик с заполаскиванием, волну и
// течение с мелью.
const CASES = [
  {
    name: 'бейдевинд, экипаж на борту',
    setup: b => {
      b.o.windSpeed = 8; b.o.windDir = 100 * D; b.psi = 100 * D - 45 * D;
      b.o.sheet = 16 * D; b.o.crewHike = -1; b.o.crewMass = 219.9; b.u = 4;
      b.wind.o.gust = 0.2; b.wind.o.shift = 9 * D;
    },
  },
  {
    name: 'полный курс с перекладкой',
    setup: b => {
      b.o.windSpeed = 6; b.o.windDir = 0; b.psi = 170 * D;
      b.o.sheet = 70 * D; b.o.crewHike = 0.3; b.o.crewMass = 219.9; b.u = 3;
    },
    drive: (b, t) => { b.o.rudder = 14 * D * Math.sin(t / 4); },
  },
  {
    name: 'левентик, руль брошен',
    setup: b => {
      b.o.windSpeed = 11; b.o.windDir = 0; b.psi = 0;
      b.o.sheet = 20 * D; b.o.crewMass = 0; b.u = 0.5;
    },
  },
  {
    name: 'волна и разгон',
    setup: b => {
      b.o.windSpeed = 12; b.o.windDir = 40 * D; b.psi = 40 * D - 110 * D;
      b.o.sheet = 45 * D; b.o.fetch = 8000; b.o.fetchOverride = true;
      b.o.crewHike = -0.6; b.o.crewMass = 219.9; b.u = 4;   // наветренный борт
      b.wind.o.gust = 0.3; b.wind.o.shift = 13 * D;
    },
    drive: (b, t) => {
      // Поверхность воды под лодкой: качка на длинной волне, заданная руками.
      b.setWater(0.35 * Math.sin(t * 1.1), 0.06 * Math.cos(t * 1.1), 0.02);
    },
  },
  {
    name: 'парусность и твист на ходу',
    setup: b => {
      b.o.windSpeed = 7; b.o.windDir = 200 * D; b.psi = 200 * D - 60 * D;
      b.o.sheet = 22 * D; b.o.crewHike = -1; b.o.crewMass = 219.9; b.u = 4;
    },
    drive: (b, t) => {
      b.o.sailScale = t > 10 ? 1.25 : 0.85;
      b.o.twist = (4 + 14 * Math.max(0, Math.sin(t / 6))) * D;
      b.o.draft = t > 20 ? 0.7 : 1.1;
    },
  },
];

const f = (v, n = 9) => (Number.isFinite(v) ? v.toFixed(n) : String(v));

for (const c of CASES) {
  const b = new Boat(PACK);
  c.setup(b);
  console.log('# ' + c.name);
  for (let i = 1; i <= 45 * HZ; i++) {
    const t = i / HZ;
    if (c.drive) c.drive(b, t);
    b.step(1 / HZ);
    if (i % (5 * HZ)) continue;
    const s = b.telemetry;
    console.log([
      t.toFixed(0).padStart(3),
      f(b.u), f(b.v), f(b.r), f(b.phi), f(b.p_),
      f(b.zc), f(b.w), f(b.th), f(b.q),
      f(b.psi), f(b.x), f(b.y), f(b.hike, 6),
      f(b.rigSide === null ? -9 : b.rigSide),
      f(s.driveN, 6), f(s.sideN, 6), f(s.resistN, 6), f(s.gzM),
      f(s.balance.ceX), f(s.balance.ceZ), f(s.balance.clrX),
      f(s.dispKg, 6), f(s.awsKn, 6), f(s.alphaDeg, 6),
    ].join(' '));
  }
}
