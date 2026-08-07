// Показания: всё, что модель отдаёт наружу, и ничего, что она считает.
//
// Отделено от `physics.js` по границе «что посчитано» и «что показано». Здесь
// нет ни одной силы и ни одного интегрирования — только перевод внутреннего
// состояния в то, на что смотрят: узлы вместо метров в секунду, градусы вместо
// радианов, и восстановленные точки приложения для отладочного вида.
//
// Обе функции берут лодку и «кадр» — набор величин, посчитанных на этом шаге и
// внутрь состояния не попавших. Так видно, что показания не имеют своей памяти:
// они целиком выводятся из того, что уже есть.

import { DEG } from './util.js';

// Насколько далеко от центра тяжести точка приложения боковой силы ещё
// считается точкой. Три метра — это от пера руля до бака, то есть вся лодка:
// уже вне её точке взяться неоткуда. Меньший предел выглядел бы аккуратнее, но
// врал бы: перо руля стоит в 2.86 м от центра тяжести, и когда весь снос держит
// оно одно, точка ТАМ и находится по праву.
const CLR_REACH = 3.0;

// Точки приложения сил и сами силы — для отладочного вида баланса.
//
// Ни одна из этих точек в расчёте не участвует: моменты собираются по
// полоскам паруса и по полоскам корпуса, у каждой своё плечо, и общий центр
// назначать не нужно. Здесь он восстанавливается ОБРАТНО — из силы и момента,
// — потому что человеку смотреть удобнее на пару «точка и стрелка», чем на
// сумму двадцати слагаемых. Восстановление честное: точка выбирается так,
// чтобы одна сила в ней давала тот же момент, что вся сумма.
//
// У пары «вес и плавучесть» точка приложения второй считается из плеча GZ:
// именно оно и есть всё содержание остойчивости, а положение центра величины
// по высоте берётся из гидростатики.
function balanceOf(b, f) {
  const P = b.p, m = P.mass, hs = P.hydrostatics, env = P.environment;
  const cgx = m.cg_m[0], cgz = m.cg_m[2];
  const keel = P.foils.keel, rud = P.foils.rudder;
  // Боковая сила воды и её момент вокруг ЦТ. Точка приложения — там, где
  // одна эта сила дала бы тот же момент.
  const hy = f.keelSide + f.rudSide + f.hull.fy;
  const hmz = f.keelSide * (keel.x_m - cgx) + f.rudSide * (rud.x_m - cgx) + f.hull.mz;
  const hullZ = -0.5 * (f.hull.depth || hs.draft_canoe_m);
  const hmx = f.keelSide * keel.z_centre_m + f.rudSide * rud.z_centre_m +
              f.hull.fy * hullZ;
  // Точка приложения существует, только пока есть сама сила. На фордевинде
  // боковая обращается в ноль, а момент — нет: рыскание и дрейф оставляют
  // киль и руль работать в разные стороны. «Точка, дающая тот же момент»
  // тогда уезжает в бесконечность, и на отладочном виде ЦБС улетал за
  // горизонт — это видно на картинке и это не сбой расчёта, а свойство
  // самого понятия: у пары сил точки приложения нет.
  //
  // Поэтому здесь не подбирается предел по силе, а проверяется то, что
  // проверять и следует: осталась ли точка на лодке. Не осталась — значит
  // её нет, и показывать вместо неё подогнанное к борту число хуже, чем
  // честно сказать «не определён».
  const clrX = cgx + hmz / hy;
  const small = !(Math.abs(hy) > 1e-6) ||
                !(Math.abs(clrX - cgx) < CLR_REACH);
  const W = (b.mass + (b.o.crewMass || 0)) * env.g;
  const sphi = Math.sin(b.phi), cphi = Math.cos(b.phi);
  // Центр величины берётся из расчёта плавучести как есть — это настоящий
  // центр вытесненного объёма, а не восстановленная по плечу точка. Без
  // шпангоутов в пакете он собирается из таблицы и плеча, как раньше.
  let bx, by, bz;
  if (f.hyd) {
    bx = f.hyd.cbx; by = f.hyd.cby; bz = f.hyd.cbz;
  } else {
    const t0 = hs.table && hs.table.length
      ? hs.table.reduce((a, b) => Math.abs(b.wl_mm) < Math.abs(a.wl_mm) ? b : a)
      : null;
    bx = t0 ? t0.lcb_mm / 1000 : cgx;
    bz = t0 ? t0.vcb_mm / 1000 : cgz - 0.05;
    by = Math.abs(cphi) > 1e-3
      ? (-Math.sign(b.phi || 1) * f.gz + (bz - cgz) * sphi) / cphi : 0;
  }
  return {
    ceX: f.sail.ceX, ceY: f.sail.ceY, ceZ: f.sail.ceZ,
    driveN: f.sail.fx, sideN: f.sail.fy, liftN: f.sail.fz,
    windFx: f.wind.fx, windFy: f.wind.fy, windZ: f.wind.z,
    clrX: small ? cgx : clrX,
    clrZ: small ? hullZ : hmx / hy,
    clrOk: !small,
    hydroSideN: hy, dragN: f.hullDrag, hullN: f.rt + f.raw, wavesN: b.wavesN,
    keelN: f.keelSide, rudderN: f.rudSide, hullSideN: f.hull.fy,
    cgX: cgx, cgZ: cgz, bX: bx, bY: by, bZ: bz,
    weightN: W, weightCrewN: b.o.crewMass * env.g,
    crewX: b.o.crewX, crewZ: b.o.crewZ,
    buoyN: f.hyd ? env.rho_water * env.g * f.hyd.volume : W,
    vertN: b.vertN || 0,
    awpM2: f.hyd ? f.hyd.awp : 0, sinkM: b.zc, trimDeg: b.th / DEG,
    gzM: f.gz, hikeNm: b.hike,
    heelNm: f.sail.mx, yawNm: f.sail.mz,
  };
}

export function telemetryOf(b, f) {
  return {
    speed: f.speed, speedKn: f.speed * 1.94384,
    leewayDeg: f.leeway / DEG, heelDeg: b.phi / DEG,
    awaDeg: f.sail.awa / DEG, awsKn: f.aw.speed * 1.94384,
    awaEffDeg: f.sail.awaEff / DEG,   // что видит парус, а не флюгер
    ceHeightM: f.sail.ceZ,            // центр парусности по нагрузке полосок
    twsKn: f.aw.ws * 1.94384,         // истинный ветер на высоте ЦП
    strips: b.rig.stripState,
    twaDeg: b.trueWindAngle() / DEG,
    alphaDeg: f.sail.alpha / DEG, sailCl: f.sail.cl,
    driveN: f.sail.fx, sideN: f.sail.fy,
    resistN: f.rt, keelLiftN: f.keelSide, rudderLiftN: f.rudSide,
    fetchM: b.fetchM, fetchField: b.fetchField,
    shoreM: b.shoreM, shoalK: b.shoalK || 0, windK: b.windK,
    shelter: b.shelter, gustK: b.gustK, aground: b.aground,
    chanDeg: b.chanRot / DEG,
    chanA: Math.hypot(b.chanAxis.x, b.chanAxis.y),
    // Течение и скорость НАД ГРУНТОМ. Большая цифра в HUD — по-прежнему
    // скорость через воду: её чувствуют корпус, киль и руль, ею меряется
    // лодка. Над грунтом — то, с какой скоростью на самом деле едешь, и на
    // реке эти две расходятся на узел с лишним.
    curX: b.cur.x, curY: b.cur.y,
    curKn: Math.hypot(b.cur.x, b.cur.y) * 1.94384,
    sogKn: b.sog * 1.94384,
    sternway: b.u < -0.15,
    gzM: f.gz, yawRate: b.r / DEG,
    // Посадка и дифферент: их теперь считает плавучесть, и на них видно то,
    // чего в модели не было — как лодка садится под грузом и приседает под
    // тягой. Водоизмещение при этом не константа: в динамике оно ходит вокруг
    // веса, и расхождение — это ровно то, что разгоняет вертикальную качку.
    sinkM: b.zc, trimDeg: b.th / DEG,
    dispKg: f.hyd ? b.p.environment.rho_water * f.hyd.volume : b.mass,
    balance: balanceOf(b, f),
    vmg: f.speed * Math.cos(b.trueWindAngle()) * 1.94384,
    twaAbsDeg: Math.abs(b.trueWindAngle()) / DEG,
  };
}
