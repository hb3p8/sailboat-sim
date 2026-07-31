// Физика хода яхты: четыре степени свободы, фиксированный шаг 1/30 с.
//
// Система координат судостроительная, та же что во всём проекте:
// X в нос, Y на правый борт, Z вверх. Отрисовка переводит её в свою уже сама.
//
// Что моделируется:
//   продольное движение, дрейф, рыскание и крен — четыре уравнения;
//   всплытие и дифферент — квазистатически по таблице гидростатики, потому
//   что на тридцати герцах их собственные колебания всё равно не разрешить,
//   а на управление они влияют слабо.
//
// Что откуда взято:
//   массы, моменты инерции, GZ, гидростатика, площади и удлинения крыльев —
//   из пакета physics.json, то есть из геометрии;
//   коэффициенты парусов и крыльев — модели здесь, в коде: их настраивают
//   на ходу, и держать их в пакете незачем.

const DEG = Math.PI / 180;

// Коэффициент поперечного обтекания полоски корпуса. Для мелкого широкого
// днища это около единицы; величина одна и общая, а не набор подгоночных.
const HULL_CROSSFLOW_CD = 1.0;

// Приводящий момент от несимметрии накренённого корпуса. Явление настоящее и
// для широкой плоской лодки крупное: на крене подветренная скула сидит глубже,
// и корпус работает как изогнутое крыло, разворачивая нос на ветер. Посчитать
// его честно можно только по обтеканию, поэтому здесь он в форме, принятой в
// VPP, с одним коэффициентом.
//
// Коэффициент откалиброван по наблюдению владельца лодки: с брошенным рулём
// в бейдевинд лодка должна слегка приводиться, а не валиться под ветер.
// Это второе и последнее место в проекте, где число подобрано, а не выведено.
const HULL_HEEL_YAW = 0.28;

// Нормировка угла без цикла: при расходимости `while` по бесконечности вешает
// вкладку намертво, и это не гипотеза — так и было.
function wrapPi(a) {
  if (!isFinite(a)) return 0;
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function clamp(v, lim) {
  if (!isFinite(v)) return 0;
  return v < -lim ? -lim : (v > lim ? lim : v);
}

function lerpTable(rows, key, x, field) {
  const n = rows.length;
  if (x <= rows[0][key]) return rows[0][field];
  if (x >= rows[n - 1][key]) return rows[n - 1][field];
  for (let i = 0; i < n - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (x >= a[key] && x <= b[key]) {
      const u = (x - a[key]) / (b[key] - a[key] || 1);
      return a[field] + u * (b[field] - a[field]);
    }
  }
  return rows[n - 1][field];
}

// Крыло с срывом: до срыва линейный участок, после — плоская пластина.
// Переход сглаженный, иначе руль на больших углах перекладки дёргается.
function foilCoeffs(alphaRad, ar, stallDeg, cd0) {
  const a = Math.abs(alphaRad);
  const stall = stallDeg * DEG;
  const slope = 2 * Math.PI * ar / (ar + 2);        // теория несущей линии
  const clLin = slope * a;
  const clFlat = 2 * Math.sin(a) * Math.cos(a);
  const cdFlat = 2 * Math.sin(a) * Math.sin(a);
  const blend = a <= stall ? 0 : Math.min(1, (a - stall) / (12 * DEG));
  const cl = clLin * (1 - blend) + clFlat * blend;
  const cdi = cl * cl / (Math.PI * ar * 0.9);
  const cd = (cd0 + cdi) * (1 - blend) + cdFlat * blend;
  return { cl: cl * Math.sign(alphaRad), cd: cd };
}

// Парус: то же крыло, но с ненулевым углом нулевой подъёмной силы — он
// выгнутый, — и более ранним срывом.
function sailCoeffs(alphaRad, ar) {
  const a = Math.abs(alphaRad);
  const stall = 18 * DEG;
  const slope = 2 * Math.PI * ar / (ar + 2);
  const clLin = slope * (a + 3 * DEG);
  const clFlat = 2 * Math.sin(a) * Math.cos(a);
  const cdFlat = 1.2 * Math.sin(a) * Math.sin(a) + 0.08;
  const blend = a <= stall ? 0 : Math.min(1, (a - stall) / (25 * DEG));
  let cl = clLin * (1 - blend) + clFlat * blend;
  // заполаскивание: при отрицательном угле атаки парус просто не работает
  if (alphaRad < -2 * DEG) cl = 0.15 * cl;
  const cdi = cl * cl / (Math.PI * ar * 0.85);
  const cd = (0.06 + cdi) * (1 - blend) + cdFlat * blend;
  return { cl: cl * Math.sign(alphaRad || 1), cd: cd };
}

export class Boat {
  constructor(pack, opts) {
    this.p = pack;
    this.o = Object.assign({
      windSpeed: 6.0,          // истинный ветер, м/с
      windDir: 100 * DEG,      // откуда дует, рад, отсчёт от оси X мира
      sheet: 25 * DEG,         // угол выноса паруса от ДП
      rudder: 0.0,             // перекладка руля, рад
      crewHike: 0.0,           // откренивание: 0 — в ДП, 1 — на борту
      crewMass: 0.0,
      sailScale: 1.0,          // 1 — грот со стакселем, больше — с генакером
    }, opts || {});

    const m = pack.mass;
    this.mass = m.total_kg;
    this.reset();
  }

  reset() {
    this.x = 0; this.y = 0;          // положение в мире, м
    this.psi = 0;                    // курс, рад, от оси X мира
    this.u = 0; this.v = 0;          // скорости в связанной системе, м/с
    this.r = 0;                      // угловая скорость рыскания, рад/с
    this.phi = 0; this.p_ = 0;       // крен и его скорость
    this.t = 0;
  }

  // --- ветер ---------------------------------------------------------------

  apparentWind() {
    const o = this.o;
    // истинный ветер в мировой системе (куда дует)
    const wx = -o.windSpeed * Math.cos(o.windDir);
    const wy = -o.windSpeed * Math.sin(o.windDir);
    // скорость лодки в мировой системе
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    const bx = this.u * c - this.v * s;
    const by = this.u * s + this.v * c;
    // кажущийся ветер в связанной системе
    const ax = (wx - bx) * c + (wy - by) * s;
    const ay = -(wx - bx) * s + (wy - by) * c;
    return { x: ax, y: ay, speed: Math.hypot(ax, ay),
             angle: Math.atan2(ay, ax) };
  }

  // Угол считается от носа до направления, ОТКУДА дует, как принято на воде:
  // ноль — в лоб, 180 — точно в корму. Та же условность, что и у кажущегося
  // ветра, иначе один и тот же курс читается двумя разными числами.
  trueWindAngle() {
    return wrapPi(this.o.windDir - this.psi);
  }

  // --- силы ----------------------------------------------------------------

  sailForces(aw) {
    const rig = this.p.rig, env = this.p.environment;
    const area = (rig.main_area_m2 + rig.jib_area_m2) * this.o.sailScale;
    // кажущийся ветер приходит «в нос» при угле π: переводим в угол от носа
    let awa = Math.PI - Math.abs(aw.angle);
    const side = aw.angle > 0 ? 1 : -1;      // с какого борта ветер
    const alpha = awa - this.o.sheet;
    const ar = rig.mast_height_m * rig.mast_height_m / Math.max(1, area);
    const k = sailCoeffs(alpha, Math.max(2.5, ar));

    const q = 0.5 * env.rho_air * area * aw.speed * aw.speed;
    const lift = q * k.cl, drag = q * k.cd;
    // подъёмная сила перпендикулярна кажущемуся ветру, сопротивление вдоль
    const dirX = aw.x / (aw.speed || 1), dirY = aw.y / (aw.speed || 1);
    let fx = drag * dirX - lift * (-dirY) * side;
    let fy = drag * dirY - lift * (dirX) * side;
    // крен убирает часть боковой силы: парус наклоняется вместе с мачтой
    const cphi = Math.cos(this.phi);
    fy *= cphi;
    // Паразитное сопротивление корпуса, рангоута и экипажа в потоке. В
    // лавировку кажущийся ветер силён, и эта добавка заметно ограничивает,
    // насколько круто лодка вообще способна идти.
    const wq = 0.5 * env.rho_air * (rig.windage_area_m2 || 0) *
               (rig.windage_cd || 0.85) * aw.speed * aw.speed;
    fx += wq * dirX;
    fy += wq * dirY * cphi;

    return { fx: fx, fy: fy, z: rig.ce_height_m * cphi,
             x: rig.ce_x_m != null ? rig.ce_x_m : rig.mast_x_m,
             awa: awa, alpha: alpha, cl: k.cl, cd: k.cd, area: area };
  }

  // Поперечная сила корпуса по полоскам. Заменяет два прежних слагаемых —
  // «сопротивление дрейфу» и «демпфирование рыскания», — потому что на самом
  // деле это одно и то же явление: каждая полоска обтекается поперёк со своей
  // местной скоростью v + r·x, и сумма даёт сразу и силу, и момент, и связь
  // между ними. Раздельные подгоняемые коэффициенты для этого не нужны.
  hullLateral(v, r, n) {
    const P = this.p, env = P.environment, hs = P.hydrostatics;
    const xa = hs.lwl_aft_x_m != null ? hs.lwl_aft_x_m : 0.55;
    const xf = hs.lwl_fwd_x_m != null ? hs.lwl_fwd_x_m : 6.02;
    const cgx = P.mass.cg_m[0];
    const steps = n || 12;
    const dx = (xf - xa) / steps;
    // На ровном киле поперёк потока стоит только осадка корпуса — пятнадцать
    // сантиметров. На крене лодка подставляет потоку днище, и высота растёт до
    // половины ширины. Без этого положенная набок лодка ничем не держится
    // и уезжает боком со скоростью, которой на воде не бывает.
    const c = Math.abs(Math.cos(this.phi)), s2 = Math.abs(Math.sin(this.phi));
    const depth = hs.draft_canoe_m * c + 0.5 * hs.bwl_m * s2;
    const q = 0.5 * env.rho_water * HULL_CROSSFLOW_CD * depth * dx;
    let fy = 0, mz = 0;
    for (let i = 0; i < steps; i++) {
      const arm = xa + (i + 0.5) * dx - cgx;
      const vi = v + r * arm;
      const f = -q * Math.abs(vi) * vi;
      fy += f;
      mz += f * arm;
    }
    return { fy: fy, mz: mz };
  }

  foilForce(foil, alpha, speed, extraCd) {
    const env = this.p.environment;
    if (speed < 0.05) return { lift: 0, drag: 0 };
    const k = foilCoeffs(alpha, foil.effective_ar, foil.stall_deg,
                         0.008 + (extraCd || 0));
    const q = 0.5 * env.rho_water * foil.area_m2 * speed * speed;
    return { lift: q * k.cl, drag: q * k.cd, cl: k.cl };
  }

  step(dt) {
    const P = this.p, env = P.environment, m = P.mass;
    const speed = Math.hypot(this.u, this.v);
    const leeway = speed > 0.05 ? Math.atan2(this.v, Math.max(0.05, this.u)) : 0;

    const aw = this.apparentWind();
    const sail = this.sailForces(aw);

    // Крылья видят не скорость центра тяжести, а свою местную: к дрейфу
    // добавляется вращение на собственном плече от ЦТ. Для руля это главное
    // слагаемое, ограничивающее циркуляцию: на развороте набегающий поток
    // подходит к перу под меньшим углом, и момент сам себя гасит. Без этого
    // лодка крутилась радиусом меньше собственной длины.
    const keel = P.foils.keel, rud = P.foils.rudder;
    const cgx0 = P.mass.cg_m[0];
    const cphi = Math.cos(this.phi);
    const uu = Math.max(0.05, this.u);

    const vKeel = this.v + this.r * (keel.x_m - cgx0);
    const aKeel = speed > 0.05 ? Math.atan2(vKeel, uu) : 0;
    const kf = this.foilForce(keel, -aKeel, speed, 0);
    const keelSide = kf.lift * cphi;
    const keelDrag = kf.drag;

    const vRud = this.v + this.r * (rud.x_m - cgx0);
    const aRud = (speed > 0.05 ? Math.atan2(vRud, uu) : 0) - this.o.rudder;
    const rf = this.foilForce(rud, -aRud, speed, 0.004);
    const rudSide = rf.lift * cphi;
    const rudDrag = rf.drag;

    // сопротивление корпуса по таблице
    const rt = lerpTable(P.resistance.curve, 'v_ms', Math.abs(this.u), 'rt_n');
    const hullDrag = -Math.sign(this.u || 1) * rt;
    const hull = this.hullLateral(this.v, this.r);

    // --- уравнения движения
    const mx = this.mass * (1 + m.added_surge);
    const my = this.mass * (1 + m.added_sway);
    const iz = m.izz_kg_m2 * (1 + m.added_yaw);
    const ix = m.ixx_kg_m2 * m.added_roll;

    const fx = sail.fx + hullDrag - keelDrag - rudDrag;
    const fy = sail.fy + keelSide + rudSide + hull.fy;

    const du = fx / mx + this.v * this.r;
    const dv = fy / my - this.u * this.r;

    // Момент рыскания. Плечи меряются от центра тяжести, а не от кормовой
    // оконечности: абсциссы в пакете отсчитаны от транца, и если подставить
    // их напрямую, у киля получается плечо в три метра вместо двадцати пяти
    // сантиметров. Лодка от этого раскручивается за секунды.
    const cgx = m.cg_m[0];
    let mz = keelSide * (keel.x_m - cgx) + rudSide * (rud.x_m - cgx)
             + sail.fy * (sail.x - cgx) + hull.mz;
    // Приводящий момент от крена — главный источник weather helm на реальной
    // лодке, и его тут не было. На крене центр парусности уходит под ветер,
    // а тяга остаётся вдоль корпуса: пара разворачивает нос на ветер. Без
    // этого слагаемого лодка на бейдевинде valится под ветер и требует
    // постоянного руля, чего на воде нет.
    const zce = (P.rig.ce_height_m - m.cg_m[2]);
    mz += zce * Math.sin(this.phi) * sail.fx;
    mz += HULL_HEEL_YAW * 0.5 * env.rho_water * this.u * this.u *
          P.hydrostatics.lwl_m * P.hydrostatics.draft_canoe_m *
          Math.sin(2 * this.phi);
    const dr = mz / iz;

    // крен: кренящий момент паруса минус восстанавливающий и демпфирование
    const heelDeg = Math.abs(this.phi) / DEG;
    const gz = lerpTable(P.righting.gz, 'heel_deg', heelDeg, 'gz_m');
    const righting = -Math.sign(this.phi || 1) * this.mass * env.g * gz;
    const hikeArm = this.o.crewHike * 1.0;
    const hikeMoment = -Math.sign(this.phi || 1) * this.o.crewMass * env.g * hikeArm;
    const sailHeel = -sail.fy * (sail.z - m.cg_m[2]);
    const foilHeel = (keelSide * (keel.z_centre_m - m.cg_m[2])
                      + rudSide * (rud.z_centre_m - m.cg_m[2]));
    // демпфирование качки: доля критического, иначе крен звенит
    const wn = Math.sqrt(this.mass * env.g * Math.max(0.05, P.hydrostatics.gm_m) / ix);
    const damp = -2 * 0.18 * wn * ix * this.p_;
    const dp = (sailHeel + foilHeel + righting + hikeMoment + damp) / ix;

    // --- интегрирование, полунеявная схема Эйлера
    this.u = clamp(this.u + du * dt, 25);
    this.v = clamp(this.v + dv * dt, 12);
    this.r = clamp(this.r + dr * dt, 3);
    this.p_ = clamp(this.p_ + dp * dt, 6);
    this.phi = clamp(this.phi + this.p_ * dt, Math.PI / 2);
    this.psi = wrapPi(this.psi + this.r * dt);
    if (!isFinite(this.x) || !isFinite(this.y)) { this.x = 0; this.y = 0; }

    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    this.x += (this.u * c - this.v * s) * dt;
    this.y += (this.u * s + this.v * c) * dt;
    this.t += dt;

    this.telemetry = {
      speed: speed, speedKn: speed * 1.94384,
      leewayDeg: leeway / DEG, heelDeg: this.phi / DEG,
      awaDeg: sail.awa / DEG, awsKn: aw.speed * 1.94384,
      twaDeg: this.trueWindAngle() / DEG,
      alphaDeg: sail.alpha / DEG, sailCl: sail.cl,
      driveN: sail.fx, sideN: sail.fy,
      resistN: rt, keelLiftN: keelSide, rudderLiftN: rudSide,
      gzM: gz, yawRate: this.r / DEG,
      vmg: speed * Math.cos(this.trueWindAngle()) * 1.94384,
      twaAbsDeg: Math.abs(this.trueWindAngle()) / DEG,
    };
    return this.telemetry;
  }
}

export const helpers = { lerpTable, foilCoeffs, sailCoeffs, DEG };
