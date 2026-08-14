// Рабочая область полосок паруса: node scripts/sail_envelope.mjs
//
// Нужен для одного вопроса: какой кусок таблицы поляр (docs/flow-plan.md,
// Часть II) действительно нужен, а какой лежал бы мёртвым грузом. Опытные
// данные редки и достаются по одному, так что знать, за какими именно идти,
// стоит заранее — а не после того, как половина окажется не про нас.
//
// Лодка прогоняется по нескольким установившимся режимам, и по всем полоскам
// обоих парусов собираются три величины: пузо, угол атаки и число Рейнольдса.
// Считаются только несмятые полоски (fill > 0.2): у заполоскавшей ткани поляры
// нет и спрашивать её незачем.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Boat } from '../sim/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = JSON.parse(readFileSync(join(ROOT, 'out/export/physics.json'), 'utf8'));
const NU_AIR = PACK.environment.nu_air;
const D = Math.PI / 180;

// Режимы подобраны по краям обитаемого: слабый и сильный ветер, острый курс и
// полный, крайние положения пуза и твиста.
const CASES = [
  { name: 'слабый бейдевинд', tws: 4, twa: 45, sheet: 14, draft: 1.0, twist: 8 },
  { name: 'рабочий бейдевинд', tws: 8, twa: 45, sheet: 14, draft: 1.0, twist: 8 },
  { name: 'галфвинд', tws: 8, twa: 90, sheet: 35, draft: 1.0, twist: 8 },
  { name: 'бакштаг', tws: 12, twa: 140, sheet: 70, draft: 1.0, twist: 8 },
  { name: 'плоский парус', tws: 8, twa: 60, sheet: 20, draft: 0.6, twist: 4 },
  { name: 'пузатый парус', tws: 8, twa: 60, sheet: 20, draft: 1.4, twist: 16 },
  { name: 'свежий ветер', tws: 14, twa: 50, sheet: 16, draft: 1.0, twist: 8 },
];

const cam = [], alp = [], rey = [];
console.log('\n     режим        полосок   пузо, %      угол атаки       Re');
for (const c of CASES) {
  const b = new Boat(PACK);
  b.o.windSpeed = c.tws; b.o.windDir = 100 * D; b.psi = 100 * D - c.twa * D;
  b.o.sheet = c.sheet * D; b.o.draft = c.draft; b.o.twist = c.twist * D;
  b.o.crewHike = -1; b.o.crewMass = 219.9; b.u = 4;   // наветренный борт
  for (let i = 0; i < 900; i++) b.step(1 / 30);
  const st = b.telemetry.strips;
  const loc = [];
  for (let i = 0; i < st.length; i++) {
    const s = st[i];
    if (!(s.fill > 0.2)) continue;
    const re = s.ve * b.rig.strips[i].chord / NU_AIR;
    cam.push(Math.abs(s.camber)); alp.push(Math.abs(s.alphaDeg)); rey.push(re);
    loc.push([Math.abs(s.camber), Math.abs(s.alphaDeg), re]);
  }
  const m = k => loc.length ? loc.reduce((a, v) => a + v[k], 0) / loc.length : NaN;
  console.log('  %s %s %s %s %s',
    c.name.padEnd(18), String(loc.length).padStart(5),
    (m(0) * 100).toFixed(1).padStart(9), m(1).toFixed(1).padStart(14) + '°',
    m(2).toExponential(1).padStart(10));
}

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
console.log('\nПо всем режимам, ' + cam.length + ' полосок:\n');
// Ширина полей выставляется padStart, а не «%10s»: util.format в node такого
// не понимает и печатает спецификатор буквой.
const row = (name, vals) => console.log('  ' + name.padEnd(6) +
  vals.map(v => v.padStart(11)).join(''));
row('', ['5%', 'медиана', '95%', 'край']);
row('пузо', [0.05, 0.5, 0.95, 1].map(p => (q(cam, p) * 100).toFixed(1) + '%'));
row('угол', [0.05, 0.5, 0.95, 1].map(p => q(alp, p).toFixed(1) + '°'));
row('Re', [0.05, 0.5, 0.95, 1].map(p => q(rey, p).toExponential(1)));

// Главный вывод печатается числом, а не подразумевается: сколько наших полосок
// попадает в тот диапазон пуза, который закрыт опытом Милгрэма (12…18%).
const covered = cam.filter(v => v >= 0.12).length;
console.log('\nВ область опыта Милгрэма (пузо 12% и больше) попадает ' + covered +
  ' из ' + cam.length + ' полосок — ' + Math.round(100 * covered / cam.length) + '%.');
console.log('Остальные лежат ниже, и опыта на них у нас пока нет.\n');
