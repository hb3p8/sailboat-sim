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

// Снимок телеметрии целиком, простыми значениями. Через границу потоков ходят
// только клонируемые структуры, а телеметрия несёт и ссылки на внутренности.
function snap(b) {
  return JSON.parse(JSON.stringify(b.telemetry));
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

  // Отданные шкоты и брошенный руль. Ход снимается каждые `spec.every` секунд,
  // всего `spec.marks` раз, — по последним двум и видно, разгоняется ли лодка.
  //
  // Длину задаёт батарея: полный прогон десять минут, регрессионный пять. Само
  // утверждение от этого не меняется — «за последний отрезок прибавки нет», —
  // но десять минут ловят медленное сползание, которого за пять не видно.
  looseDrift(pack, spec) {
    const every = spec.every || 150, marks = spec.marks || 4;
    const b = new Boat(pack);
    b.o.windSpeed = 6; b.o.windDir = 90 * D; b.o.sheet = 90 * D; b.o.rudder = 0;
    const at = [];
    for (let i = 0; i < every * marks * 30; i++) {
      b.step(1 / 30);
      if ((i + 1) % (every * 30) === 0) at.push(b.telemetry.speedKn);
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

  // Ход на заданном курсе с волной и без: батарея волн меряет по нему потерю.
  // Восемь независимых прогонов по девяносто секунд — весь её счёт.
  waveLoss(pack, spec) {
    const b = new Boat(pack);
    b.o.windSpeed = 6; b.o.windDir = spec.twa * D; b.o.sheet = spec.sheet * D;
    b.o.twist = spec.twist * D; b.o.crewHike = -1; b.o.crewMass = 240;
    b.o.fetch = spec.fetch; b.u = 3; b.phi = 10 * D;
    for (let i = 0; i < 90 * 30; i++) { hold(b); b.step(1 / 30); }
    return { speedKn: b.telemetry.speedKn };
  },

  // Качка на заданной волне: размах крена, дифферента и всплытия. Волна задаётся
  // снаружи через `setWater` — та же линейная волна, что и в батарее плавучести.
  waveRide(pack, spec) {
    const b = new Boat(pack);
    b.o.windSpeed = spec.wind; b.o.windDir = 100 * D; b.o.crewHike = -1;
    b.u = 2;
    const g = pack.environment.g;
    const w = 2 * Math.PI / spec.tp, k = w * w / g, amp = spec.hs / 2;
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
  },

  // Галс: на какую сторону выгнут парус. Наружу идут пузо полосок и то, что
  // нужно для сверки знака, — из `stripCalc` только числа, сами объекты решётки
  // через границу потоков не ходят.
  tack(pack, spec) {
    const b = new Boat(pack);
    b.o.windSpeed = 6; b.o.windDir = spec.twa * D; b.o.sheet = 24 * D; b.o.twist = 8 * D;
    b.u = 4; b.phi = 8 * D * Math.sign(spec.twa);
    for (let i = 0; i < 60 * 30; i++) b.step(1 / 30);
    return {
      strips: b.telemetry.strips.map(s => ({ camber: s.camber })),
      calc: b.rig.stripCalc.map(g => ({ live: g.live, alpha: g.alpha,
                                        area: g.area, camber: g.camber })),
      side: b.rigSide,
    };
  },

  // Порыв доезжает до лодки и кренит её: размах крена и ветра за пять минут.
  gustHeel(pack) {
    const b = new Boat(pack);
    b.o.windSpeed = 8; b.o.windDir = 90 * D; b.o.sheet = 20 * D;
    b.wind.o.gust = 0.35; b.wind.o.shift = 12 * D;
    b.u = 4;
    let lo = 99, hi = -99, wLo = 99, wHi = -99;
    for (let i = 0; i < 300 * 30; i++) {
      hold(b);
      b.step(1 / 30);
      if (i > 30 * 30) {
        lo = Math.min(lo, b.telemetry.heelDeg); hi = Math.max(hi, b.telemetry.heelDeg);
        wLo = Math.min(wLo, b.telemetry.twsKn); wHi = Math.max(wHi, b.telemetry.twsKn);
      }
    }
    return { lo, hi, wLo, wHi };
  },

  // Решётка против сечения на одной и той же полоске. Отбор годных полосок
  // делается здесь же: он смотрит во внутренности решётки.
  latVsSection(pack, spec) {
    const b = new Boat(pack);
    Object.assign(b.o, { windSpeed: 6, windDir: spec.twa * D, sheet: spec.sheet * D,
                         twist: spec.twist * D, crewHike: -1, crewMass: 240 });
    b.u = 3; b.phi = 12 * D;
    for (let i = 0; i < 60 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * -b.psi - 0.9 * b.r)));
      b.step(1 / 30);
    }
    const st = b.telemetry.strips, calc = b.rig.stripCalc;
    const ratios = [];
    for (let i = 0; i < st.length; i++) {
      const g = calc[i];
      // Полоска годится, если работает: наполнена, до срыва и внутри области,
      // где поправка на скос берётся целиком (за двадцатью градусами к хорде
      // она гасится, и тождество там нарочно не держится).
      if (!g.live || g.fill < 0.8) continue;
      if (Math.abs(st[i].alphaDeg) > 13 || Math.abs(g.alpha) > 20 * D) continue;
      const clLat = Math.abs(2 * g.gamma / (g.ve * g.chord));
      if (clLat < 0.2) continue;
      ratios.push(Math.abs(st[i].cl) / clLat);
    }
    return { ratios };
  },

  // Перебранный грот: что показывают колдунчики на задней шкаторине.
  telltale(pack, spec) {
    const b = new Boat(pack);
    b.o.windSpeed = 6; b.o.windDir = 45 * D; b.o.sheet = spec.sheet * D;
    b.o.twist = 8 * D; b.o.crewHike = -1; b.o.crewMass = 219.9;
    b.u = 3; b.phi = 18 * D;
    for (let i = 0; i < 70 * 30; i++) {
      b.o.rudder = Math.max(-25 * D, Math.min(25 * D, -(2.5 * (0 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    const st = b.telemetry.strips[3];
    return {
      speed: b.telemetry.speedKn, alpha: Math.abs(st.alphaDeg), sep: st.sep,
      // тот же порог, по которому виснет подветренный колдунчик у передней
      droop: Math.max(0, Math.min(1, (3 - (13 - Math.abs(st.alphaDeg))) / 4)),
    };
  },

  // --- акватория. Всем этим сценариям нужна река третьим доводом.

  // Бейдевинд на разогнанной и на затишной стороне плёса.
  fetchSide(pack, spec, t) {
    const b = new Boat(pack, t);
    Object.assign(b.o, { windSpeed: 8, windDir: 30 * D, sheet: 14 * D, twist: 8 * D,
                         crewHike: -1, crewMass: 240, fetchOverride: spec.over,
                         fetch: 3000 });
    b.x = spec.x; b.y = spec.y; b.psi = 30 * D - 45 * D; b.u = 3; b.phi = 12 * D;
    for (let i = 0; i < 50 * 30; i++) b.step(1 / 30);
    return { t: snap(b) };
  },

  // Лодка носом в берег: четыреста секунд упирания. Проверяется, что сквозь
  // урез она не проходит и не оседает внутрь.
  intoShore(pack, spec, t) {
    const b = new Boat(pack, t);
    Object.assign(b.o, { windSpeed: 8, windDir: 90 * D, sheet: 24 * D,
                         crewHike: 0, crewMass: 240 });
    b.x = spec.x; b.y = spec.y; b.psi = -Math.PI / 2; b.u = 4;
    let worst = 1e9;
    for (let i = 0; i < 400 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
        -(2.2 * (-Math.PI / 2 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
      const d = t.shore(b.x, b.y);
      if (d !== null && d < worst) worst = d;
    }
    return { worst, at: t.shore(b.x, b.y) };
  },

  // Ход вдоль берега: у самого берега и на середине плёса.
  alongShore(pack, spec, t) {
    const b = new Boat(pack, t);
    Object.assign(b.o, { windSpeed: 8, windDir: 90 * D, sheet: 24 * D,
                         fetchOverride: true, fetch: 0,
                         crewHike: -1, crewMass: 240 });
    b.x = spec.x; b.y = spec.y; b.psi = 0; b.u = 4;
    for (let i = 0; i < 60 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * (0 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    return { t: snap(b) };
  },

  // Попутный ветер и попутное течение: над грунтом быстрее, через воду медленнее.
  withCurrent(pack, spec, t) {
    const b = new Boat(pack, t);
    Object.assign(b.o, { windSpeed: 8, windDir: 180 * D, sheet: 80 * D,
                         current: spec.cur, crewHike: -1, crewMass: 240 });
    b.x = spec.x; b.y = spec.y; b.psi = 0; b.u = 4;
    for (let i = 0; i < 90 * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * (0 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    return { t: snap(b) };
  },

  // Канализация ветра долиной: с поправкой и без.
  channelWind(pack, spec, t) {
    const b = new Boat(pack, t);
    const twa = ((spec.along + 60) % 360 + 360) % 360;
    Object.assign(b.o, { windSpeed: 8, windDir: (spec.along + 60) * D, sheet: 24 * D,
                         chan: spec.k, current: 0, crewMass: 240,
                         crewHike: twa > 180 ? 1 : -1 });
    b.x = spec.x; b.y = spec.y; b.psi = 0; b.u = 4;
    for (let i = 0; i < 40 * 30; i++) {
      b.o.rudder = Math.max(-25 * D, Math.min(25 * D, -(2.5 * (0 - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
    }
    return { t: snap(b) };
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
