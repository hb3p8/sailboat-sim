// Именованные прогоны для пула — то же, чем `steady` был для перебора настроек.
//
// Пул умел одно: установившийся ход по набору условий. Но самое долгое в батарее
// физики — не перебор, а ОДИНОЧНЫЕ длинные прогоны: развёртка по шкоту в
// фордевинд (пять прогонов по сто пятьдесят секунд), перекидывание паруса в
// порывистый ветер (сто восемьдесят) и десять минут с отданными шкотами. На
// одном ядре они идут друг за другом, хотя не зависят друг от друга вовсе.
//
// Отсюда и этот файл: сценарий — чистая функция от условий, возвращающая
// ПРОСТОЙ объект (структуры между потоками пересылаются клонированием, лодку
// туда не передать). Главный поток и рабочий зовут одну и ту же функцию из
// одного файла — иначе параллельный прогон начнёт отвечать не то, что
// последовательный, и разбираться в этом будет некому.
//
// Проверки здесь не живут: сценарий только считает и отдаёт числа, а решает по
// ним батарея. Так число в отчёте остаётся рядом с тем, что оно значит.

import { Boat } from '../../sim/physics.js';

const D = Math.PI / 180;

function wrapPi(a) {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Руль, удерживающий курс ноль: тот же закон, что и в батареях.
function hold(b) {
  const err = wrapPi(0 - b.psi);
  b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * b.r)));
}

// Телеметрия наружу — только то, что нужно проверкам, и только числами.
function tele(b) {
  const t = b.telemetry;
  return {
    speedKn: t.speedKn, driveN: t.driveN, sideN: t.sideN,
    alphaDeg: t.alphaDeg, twaAbsDeg: t.twaAbsDeg, heelDeg: t.heelDeg,
    strips: t.strips.map(s => ({ cl: s.cl })),
  };
}

export const RUNS = {
  // Фордевинд, шкот от добранного до отданного. Пять независимых прогонов.
  downwindSheet(pack, spec) {
    const b = new Boat(pack);
    b.o.windSpeed = 7; b.o.windDir = 180 * D; b.o.sheet = spec.sheet * D; b.u = 3;
    for (let i = 0; i < 150 * 30; i++) { hold(b); b.step(1 / 30); }
    return { sheet: spec.sheet, t: tele(b) };
  },

  // Чистый фордевинд в порывистый ветер: считаются настоящие перебросы паруса
  // (смены ЗНАКА борта, а не каждый взмах) и наибольший скачок боковой силы.
  gybeJolt(pack) {
    const b = new Boat(pack);
    b.o.windSpeed = 7; b.o.windDir = 180 * D; b.o.sheet = 75 * D; b.u = 3;
    b.wind.o.gust = 0.25; b.wind.o.shift = 0.25 * 45 * D;
    let flips = 0, prev = Math.sign(b.rigSide || 1), jolt = 0, prevSide = null;
    for (let i = 0; i < 180 * 30; i++) {
      hold(b);
      b.step(1 / 30);
      if (i < 30 * 30) continue;
      const now = Math.sign(b.rigSide || 1);
      if (now !== prev) flips++;
      prev = now;
      if (prevSide !== null) jolt = Math.max(jolt, Math.abs(b.telemetry.sideN - prevSide));
      prevSide = b.telemetry.sideN;
    }
    return { flips, jolt };
  },

  // Отданные шкоты и брошенный руль, десять минут.
  looseDrift(pack) {
    const b = new Boat(pack);
    b.o.windSpeed = 6; b.o.windDir = 90 * D; b.o.sheet = 90 * D; b.o.rudder = 0;
    const at = [];
    for (let i = 0; i < 600 * 30; i++) {
      b.step(1 / 30);
      if ((i + 1) % (150 * 30) === 0) at.push(b.telemetry.speedKn);
    }
    return { at, t: tele(b) };
  },

  // Балансировка: сколько руля нужно на удержание курса и куда лодка уходит,
  // если руль бросить. Два этапа в одном прогоне — второй продолжает первый.
  balance(pack, spec) {
    const b = new Boat(pack);
    b.o.windSpeed = 6; b.o.windDir = spec.twa * D; b.o.sheet = spec.sheet * D;
    b.u = 3.5;
    for (let i = 0; i < 120 * 30; i++) {
      const err = wrapPi(0 - b.psi);
      b.o.rudderTarget = Math.max(-30 * D, Math.min(30 * D, -(2.2 * err - 0.9 * b.r)));
      b.step(1 / 30);
    }
    const helm = b.o.rudder / D;
    const twa0 = Math.abs(b.trueWindAngle()) / D;
    b.o.rudderTarget = 0;
    for (let i = 0; i < 10 * 30; i++) b.step(1 / 30);
    return { twa: spec.twa, helm, drift: twa0 - Math.abs(b.trueWindAngle()) / D };
  },

  // Один и тот же ход разным шагом интегрирования: размах качки, средний ход и
  // пик скорости крена. Переходный процесс отбрасывается.
  byStep(pack, spec) {
    const hz = spec.hz;
    const b = new Boat(pack);
    b.o.windSpeed = 9; b.o.windDir = 140 * D; b.o.sheet = 72 * D;
    b.o.twist = 8 * D; b.o.crewHike = -1; b.o.crewMass = 240;
    b.wind.o.gust = 0.45; b.wind.o.shift = 0.45 * 45 * D;
    b.u = 3.2; b.o.rudder = 0; b.o.rudderTarget = null;
    let lo = 9e9, hi = -9e9, sum = 0, n = 0, peak = 0;
    for (let i = 0; i < 30 * hz; i++) {
      b.step(1 / hz);
      if (i < 8 * hz) continue;
      const h = b.telemetry.heelDeg;
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      sum += b.telemetry.speedKn; n++;
      peak = Math.max(peak, Math.abs(b.p_ / D));
    }
    return { hz, range: hi - lo, speed: sum / n, peak };
  },
};
