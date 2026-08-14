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

console.log('\nВолна под корпусом\n');

// Волна входит в модель одним способом: `setWater` поднимает и наклоняет
// поверхность, от которой плавучесть меряет глубину. Проверяется здесь не
// картинка, а то, что от этого действительно возникает качка, — и что без
// волны не меняется НИЧЕГО.
//
// Последнее важнее первого. Поле волны живёт на видеокарте, сюда его не
// дотащить, и вся батарея физики гоняется на гладкой воде; если бы нулевая
// вода что-то смещала, каждая проверка модели поехала бы вместе с ней.
{
  const { Boat } = await import('../sim/physics.js');
  const settle = (boat, n) => { for (let k = 0; k < n; k++) boat.step(1 / 30); };

  const calm = new Boat(PACK);
  calm.o.windSpeed = 0;
  settle(calm, 90);

  const zero = new Boat(PACK);
  zero.o.windSpeed = 0;
  zero.setWater(0, 0, 0);
  settle(zero, 90);
  near(zero.zc, calm.zc, 0, 'нулевая вода не двигает посадку');
  near(zero.th, calm.th, 0, 'нулевая вода не двигает дифферент');
  console.log('  ok    без волны посадка та же до последнего разряда');

  // На гребне в двадцать сантиметров лодка обязана подняться примерно на те же
  // двадцать: она плавает, а не ныряет. Точного равенства нет — гребень поднят
  // мгновенно, и лодка приходит к нему через качку с демпфированием.
  const up = new Boat(PACK);
  up.o.windSpeed = 0;
  settle(up, 60);
  up.setWater(0.20, 0, 0);
  settle(up, 150);
  near(up.zc - calm.zc, 0.20, 0.03, 'подъём на гребне');
  console.log('  ok    гребень в 20 см поднимает лодку на %s см',
              (100 * (up.zc - calm.zc)).toFixed(1));

  // Склон воды лодка отыгрывает дифферентом и креном — смотря куда идёт.
  // Курс ноль это на восток, нос по оси X мира: склон по востоку становится
  // дифферентом, склон по северу — креном.
  const SLOPE = 0.10;
  const pitch = new Boat(PACK);
  pitch.o.windSpeed = 0; pitch.psi = 0;
  settle(pitch, 60);
  pitch.setWater(0, SLOPE, 0);
  settle(pitch, 200);
  assert.ok(pitch.th - calm.th > 0.5 * SLOPE,
    `склон по курсу обязан задирать нос: ${(pitch.th - calm.th).toFixed(3)} рад`);
  console.log('  ok    склон 0.10 задирает нос на %s° (сам склон %s°)',
              ((pitch.th - calm.th) * 180 / Math.PI).toFixed(1),
              (Math.atan(SLOPE) * 180 / Math.PI).toFixed(1));

  const roll = new Boat(PACK);
  roll.o.windSpeed = 0; roll.psi = 0;
  settle(roll, 60);
  roll.setWater(0, 0, SLOPE);
  settle(roll, 200);
  // Плюс крена — правый борт вниз; вода, поднимающаяся на левый борт, кренит
  // именно туда.
  assert.ok(roll.phi > 0.3 * SLOPE,
    `склон поперёк обязан кренить: ${roll.phi.toFixed(3)} рад`);
  console.log('  ok    склон 0.10 поперёк кренит на %s°',
              (roll.phi * 180 / Math.PI).toFixed(1));

  // И то же самое на другом курсе: на север склон по востоку становится креном,
  // а не дифферентом. Это проверка осей, а не поведения.
  const turned = new Boat(PACK);
  turned.o.windSpeed = 0; turned.psi = Math.PI / 2;
  settle(turned, 60);
  turned.setWater(0, SLOPE, 0);
  settle(turned, 200);
  assert.ok(Math.abs(turned.th - calm.th) < 0.3 * SLOPE,
    `на север склон по востоку не должен давать дифферент: ${turned.th.toFixed(3)}`);
  assert.ok(turned.phi < -0.3 * SLOPE,
    `на север склон по востоку обязан кренить на левый борт: ${turned.phi.toFixed(3)}`);
  console.log('  ok    на курсе север тот же склон уходит в крен, а не в дифферент');
}

// Бегущая волна: лодка обязана на ней качаться и НЕ обязана разноситься.
//
// Проверка не на числа, а на устойчивость связки. Волна приходит в модель
// извне и с задержкой в кадр, интегрируется та же связка «объём — жёсткость —
// демпфирование», и попасть в резонанс здесь легче лёгкого: у вертикальной
// качки период около секунды, у здешней волны — три. Если бы качка
// раскачивалась, это было бы видно именно так — крен уходит за борт, всплытие
// за метр.
{
  const { Boat } = await import('../sim/physics.js');
  const DEG = Math.PI / 180;
  const run = (hs, tp, wind) => {
    const b = new Boat(PACK);
    // Экипаж на наветренном борту: TWA положительный, значит на левом (−1).
    b.o.windSpeed = wind; b.o.windDir = 100 * DEG; b.o.crewHike = -1;
    b.u = 2;
    const w = 2 * Math.PI / tp, k = w * w / G, amp = hs / 2;
    const o = { phi: 0, th: 0, zlo: 9, zhi: -9, bad: false };
    for (let i = 0; i < 60 * 30; i++) {
      const t = i / 30, ph = k * b.x - w * t;
      b.setWater(amp * Math.cos(ph), -amp * k * Math.sin(ph), 0);
      b.step(1 / 30);
      if (![b.phi, b.th, b.zc, b.u].every(Number.isFinite)) { o.bad = true; break; }
      if (t < 8) continue;                       // первые секунды — разгон
      o.phi = Math.max(o.phi, Math.abs(b.phi));
      o.th = Math.max(o.th, Math.abs(b.th));
      o.zlo = Math.min(o.zlo, b.zc); o.zhi = Math.max(o.zhi, b.zc);
    }
    return o;
  };
  for (const [hs, tp, wind] of [[0.58, 2.97, 12], [0.90, 3.60, 16], [0.25, 2.30, 8]]) {
    const calm = run(0, tp, wind), wave = run(hs, tp, wind);
    assert.ok(!wave.bad, `на волне hs=${hs} модель разошлась`);
    // Качка появилась: дифферент на волне обязан быть заметно больше, чем на
    // гладкой воде, где он держится тягой и почти постоянен.
    assert.ok(wave.th > calm.th * 1.2,
      `волна hs=${hs} не качает: дифферент ${(wave.th / DEG).toFixed(1)}° против ${(calm.th / DEG).toFixed(1)}°`);
    // И не разнесла: размах всплытия того же порядка, что сама волна, а не
    // втрое больше. Полметра запаса — на то, что лодка ещё и садится от тяги.
    const swing = (wave.zhi - wave.zlo) - (calm.zhi - calm.zlo);
    assert.ok(swing > 0.3 * hs && swing < 2.5 * hs + 0.5,
      `размах всплытия на волне hs=${hs} вне разумного: ${(100 * swing).toFixed(0)} см`);
    console.log('  ok    hs %s м: дифферент %s° против %s° на гладкой, размах всплытия +%s см',
                hs.toFixed(2), (wave.th / DEG).toFixed(1), (calm.th / DEG).toFixed(1),
                (100 * swing).toFixed(0));
  }
}

console.log('\nВсе проверки плавучести пройдены.\n');
