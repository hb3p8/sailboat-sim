// Плавучесть по объёму против диаграммы остойчивости.
//
// Смысл батареи один: доказать, что динамический расчёт даёт ТУ ЖЕ
// остойчивость, что и таблица GZ, посчитанная при сборке независимым кодом на
// Python. Совпадение здесь — не удобство, а единственная защита от тихой
// ошибки в знаке или в осях: неверный знак крена, перепутанный борт или
// сползшая на полметра ватерлиния дадут правдоподобно выглядящую лодку,
// которая ведёт себя не так, как её же паспорт.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buoyancy } from '../sim/buoyancy.js';

const PACK = JSON.parse(readFileSync(new URL('../out/export/physics.json', import.meta.url)));
const RHO = PACK.environment.rho_water, G = PACK.environment.g;
const M = PACK.mass.total_kg, CGZ = PACK.mass.cg_m[2], CGX = PACK.mass.cg_m[0];
const V0 = M / RHO;
const b = new Buoyancy(PACK);

const near = (a, c, tol, what) =>
  assert.ok(Math.abs(a - c) <= tol, `${what}: ${a} против ${c}, допуск ${tol}`);

console.log('\nОбъём и посадка на ровном киле\n');

assert.ok(b.ready, 'шпангоуты должны быть в пакете');
const z0 = b.floatAt(V0, 0, 0);
const h0 = b.at(z0, 0, 0);
near(h0.volume, V0, 1e-5, 'объём на рабочей ватерлинии');
near(z0, 0, 0.005, 'лодка садится на свою ватерлинию');
near(h0.awp, PACK.hydrostatics.table.find(r => r.wl_mm === 0).awp_m2, 0.09,
     'площадь ватерлинии');
near(h0.cbx, PACK.hydrostatics.table.find(r => r.wl_mm === 0).lcb_mm / 1000, 0.02,
     'центр величины по длине');
near(h0.cbz, PACK.hydrostatics.table.find(r => r.wl_mm === 0).vcb_mm / 1000, 0.005,
     'центр величины по высоте');
console.log('  ok    посадка %s мм, объём %s м³, ЦВ x %s м',
            (z0 * 1000).toFixed(1), h0.volume.toFixed(4), h0.cbx.toFixed(3));

console.log('\nGZ из объёма против таблицы сборки\n');

// Плечо восстанавливающего момента из динамического расчёта: момент вокруг ЦТ,
// делённый на вес. Знак тот же, что у таблицы, — плюс выпрямляет.
function gzOf(phiDeg) {
  const phi = phiDeg * Math.PI / 180;
  const z = b.floatAt(V0, phi, 0);
  const h = b.at(z, phi, 0);
  const c = Math.cos(phi), s = Math.sin(phi);
  // Горизонталь в осях лодки перпендикулярна вертикали мира.
  const yCb = h.cby * c - h.cbz * s;
  const yCg = -CGZ * s;
  return yCg - yCb;
}

let worst = 0, worstAt = 0;
for (const row of PACK.righting.gz) {
  if (row.heel_deg > 60) break;              // за палубой контур уже неполон
  const mine = gzOf(row.heel_deg);
  const d = Math.abs(mine - row.gz_m);
  if (d > worst) { worst = d; worstAt = row.heel_deg; }
}
console.log('  наибольшее расхождение %s мм на %s°',
            (worst * 1000).toFixed(1), worstAt.toFixed(0));
assert.ok(worst < 0.012,
  `GZ расходится с таблицей на ${(worst * 1000).toFixed(1)} мм при ${worstAt}°`);
console.log('  ok    диаграмма остойчивости воспроизводится из объёма');

// Знак — отдельно и явно: перепутанный борт не поймается по модулю.
assert.ok(gzOf(10) > 0, 'крен на правый борт должен выпрямляться');
assert.ok(gzOf(-10) < 0, 'крен на левый борт должен выпрямляться в другую сторону');
near(gzOf(-10), -gzOf(10), 1e-9, 'симметрия по бортам');
console.log('  ok    знак и симметрия по бортам');

console.log('\nДифферент\n');

// Нос кверху должен уводить центр величины в корму, и наоборот. Это тот же
// признак, по которому дифферент вообще является восстанавливающимся.
const up = b.at(b.floatAt(V0, 0, 3 * Math.PI / 180), 0, 3 * Math.PI / 180);
const down = b.at(b.floatAt(V0, 0, -3 * Math.PI / 180), 0, -3 * Math.PI / 180);
assert.ok(up.cbx < h0.cbx, 'при носе кверху ЦВ уходит в корму');
assert.ok(down.cbx > h0.cbx, 'при носе книзу ЦВ уходит в нос');
near(up.volume, V0, 1e-5, 'объём при дифференте держится');
console.log('  ok    ЦВ ходит навстречу дифференту: %s → %s → %s м',
            up.cbx.toFixed(3), h0.cbx.toFixed(3), down.cbx.toFixed(3));

// Продольная остойчивость: момент на градус дифферента. Проверяется не число,
// а порядок — тысячи ньютон-метров на градус, иначе лодка либо не всплывёт,
// либо будет стоять колом.
const dth = 1 * Math.PI / 180;
const hu = b.at(b.floatAt(V0, 0, dth), 0, dth);
const mom = RHO * G * hu.volume * (hu.cbx - CGX);
assert.ok(Math.abs(mom) > 300 && Math.abs(mom) < 20000,
  `продольный момент на градус вне разумного: ${mom.toFixed(0)} Н·м`);
console.log('  ok    продольная остойчивость %s Н·м на градус', Math.abs(mom).toFixed(0));

console.log('\nВсплытие\n');

// Осадка от нагрузки: сто килограммов на площадь ватерлинии.
const zLoad = b.floatAt((M + 100) / RHO, 0, 0);
const sink = (z0 - zLoad) * 1000;
const expect = 100 / (RHO * h0.awp) * 1000;
near(sink, expect, 1.5, 'осадка от ста килограммов');
console.log('  ok    сто килограммов сажают на %s мм', sink.toFixed(1));

console.log('\nВсе проверки плавучести пройдены.\n');
