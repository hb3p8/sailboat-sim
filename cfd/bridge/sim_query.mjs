// Мост к realtime-модели: node cfd/bridge/sim_query.mjs < запрос.json
//
// §6 требует, чтобы сравнение звало ТЕ ЖЕ чистые функции, которыми пользуется
// симулятор. Отсюда мост, а не переписывание формул на питоне: переписанная
// формула расходится с оригиналом молча, и расхождение с CFD после этого
// нечему приписать.
//
// Вход — JSON-массив запросов на stdin, выход — JSON-массив ответов на stdout.
// Пакетом, а не по одному вызову: запуск node стоит десятые доли секунды, а
// точек в поляре сотни.
//
//     echo '[{"fn":"hullResistance","u":2.5,"heel_deg":0}]' \
//       | node cfd/bridge/sim_query.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { foilCoeffs, foilForce, hullResistance, hullLateral, hullHeelYaw }
  from '../../sim/hydro.js';
import { polarCoeffs, polarCeiling, polarStallDeg, setSailPolar }
  from '../../sim/polar.js';
import { sailCoeffs } from '../../sim/aero.js';
import { Boat } from '../../sim/physics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK_PATH = join(ROOT, 'out/export/physics.json');
const D = Math.PI / 180;

let PACK;
try {
  PACK = JSON.parse(readFileSync(PACK_PATH, 'utf8'));
} catch {
  process.stderr.write(`нет ${PACK_PATH}: сначала make physics\n`);
  process.exit(2);
}
setSailPolar(PACK.sail_polar || null);

// Сколько кадров дать ригу устаканиться перед снятием сил. Решётка со
// свободной пеленой — не чистая функция от условий: пелена сносится потоком и
// выходит на форму за несколько секунд. Снимать силы на первом же кадре
// значит сравнивать CFD с переходным процессом.
const RIG_SETTLE_S = 12;
const RIG_HZ = 30;

const Q = {
  // --- sail-2d --------------------------------------------------------------
  polar({ alpha_deg, camber }) {
    const k = polarCoeffs(alpha_deg * D, camber);
    return {
      cl: k.cl, cd: k.cd,
      ceiling: polarCeiling(camber),
      stall_deg: polarStallDeg(camber),
    };
  },

  // Коэффициенты сечения так, как их видит риг: с заполаскиванием.
  sailSection({ alpha_deg, camber, fill }) {
    const k = sailCoeffs(alpha_deg * D, camber, fill == null ? 1 : fill);
    return { cl: k.cl, cd: k.cd };
  },

  // --- appendages -----------------------------------------------------------
  foil({ alpha_deg, foil, ar, stall_deg, cd0 }) {
    const f = foil ? PACK.foils[foil] : null;
    const k = foilCoeffs(alpha_deg * D,
                         ar != null ? ar : f.effective_ar,
                         stall_deg != null ? stall_deg : f.stall_deg,
                         cd0 != null ? cd0 : 0.008);
    return { cl: k.cl, cd: k.cd };
  },

  // Сила крыла сразу в связанных осях — то, что сравнивается с CFD напрямую.
  foilForce({ foil, speed_ms, leeway_deg, deflect_deg, extra_cd }) {
    const f = PACK.foils[foil];
    const b = leeway_deg * D;
    // Скорость крыла в осях лодки: ux вдоль, vy поперёк. Знак дрейфа тот же,
    // что в cfd/lib/axes.py: положительный сносит на левый борт, то есть в +Y.
    const r = foilForce(PACK.environment, f,
                        speed_ms * Math.cos(b), speed_ms * Math.sin(b),
                        (deflect_deg || 0) * D, extra_cd || 0);
    return { fx: r.fx, fy: r.fy, side: r.side, alpha_deg: r.alpha / D, cl: r.cl,
             area_m2: f.area_m2 };
  },

  // --- hull-resistance ------------------------------------------------------
  hullResistance({ speed_ms, heel_deg }) {
    return { rt_n: hullResistance(PACK, speed_ms, heel_deg || 0) };
  },

  // --- hull-lateral ---------------------------------------------------------
  hullLateral({ speed_ms, heel_deg, leeway_deg, yaw_rate_nd }) {
    const phi = (heel_deg || 0) * D;
    const b = (leeway_deg || 0) * D;
    const L = PACK.hydrostatics.lwl_m;
    const r = ((yaw_rate_nd || 0) * speed_ms) / L;
    const lat = hullLateral(PACK, phi, speed_ms * Math.sin(b), r, 24);
    return {
      fy_n: lat.fy, mz_nm: lat.mz, depth_m: lat.depth,
      heel_yaw_nm: hullHeelYaw(PACK, speed_ms, phi),
    };
  },

  // --- rig-3d ---------------------------------------------------------------
  //
  // Кажущийся ветер задаётся напрямую: лодка ставится стоящей (u = v = 0), и
  // тогда истинный ветер и есть кажущийся. Оговорка, которую обязан помнить
  // отчёт: в симуляторе ветер растёт с высотой, а в CFD-случае набегающий
  // поток обычно однороден. Разница в профиле — не ошибка модели, а разница
  // постановок, и сравнивать с ней надо распределение по высоте, а не только
  // сумму.
  rig({ aws_ms, awa_deg, heel_deg, sheet_deg, twist_deg, gennaker }) {
    const b = new Boat(PACK);
    b.o.windSpeed = aws_ms;
    b.o.windDir = (awa_deg || 0) * D;      // курс ноль, значит AWA = windDir
    b.o.sheet = (sheet_deg || 0) * D;
    b.o.twist = (twist_deg || 0) * D;
    b.o.crewHike = 0;
    b.o.crewMass = 0;
    b.wind.o.gust = 0;                     // порывов нет: сравнивается среднее
    b.wind.o.shift = 0;
    if (gennaker) b.setGennaker(true);
    b.psi = 0;
    b.phi = (heel_deg || 0) * D;
    b.u = 0; b.v = 0; b.r = 0;
    b.rigSide = (awa_deg || 0) > 0 ? 1 : -1;

    const dt = 1 / RIG_HZ;
    let out = null;
    for (let i = 0; i < RIG_SETTLE_S * RIG_HZ; i++) {
      // Состояние лодки держится насильно: интегратор здесь не нужен, нужен
      // только установившийся риг при заданных ветре и крене.
      b.u = 0; b.v = 0; b.r = 0;
      b.phi = (heel_deg || 0) * D;
      b.psi = 0;
      b.t += dt;
      out = b.rig.forces(b, b.apparentWind(), dt);
    }
    return {
      fx_n: out.fx, fy_n: out.fy, fz_n: out.fz,
      mx_nm: out.mx, mz_nm: out.mz,
      ce_x_m: out.ceX, ce_y_m: out.ceY, ce_z_m: out.ceZ,
      area_m2: out.area, alpha_deg: out.alpha / D, cl: out.cl,
      settle_s: RIG_SETTLE_S,
    };
  },

  // --- генакер: состояние полосок в рабочей точке ---------------------------
  //
  // Ставится ровно тот же ход, что в tests/gennaker.test.mjs: свободная пелена,
  // экипаж на борту, руль на курс. Иначе сравнивать было бы не с чем — карта
  // (курс, шкот) снята именно так.
  //
  // Отдаётся состояние КАЖДОЙ полоски: угол атаки, пузо, положение горба,
  // заполнение и то, упёрлась ли она в потолок сечения. Потолок здесь главное:
  // карта по курсу и шкоту покраснела там, где предохранитель звенит десятками
  // раз, а звенит он именно по потолку.
  gennakerStrips({ twa_deg, sheet_m, wind_ms, seconds, sheet_deg, twist_deg }) {
    const b = new Boat(PACK);
    b.o.freeWake = true; b.o.wakeForces = true;
    b.o.crewHike = -1; b.o.crewMass = 219.9;
    b.wind.o.gust = 0; b.wind.o.shift = 0;
    b.setGennaker(true);
    b.o.sheet = (sheet_deg == null ? 70 : sheet_deg) * D;
    b.o.twist = (twist_deg == null ? 8 : twist_deg) * D;
    b.o.genSheetLen = sheet_m;
    b.reset();
    b.o.windSpeed = wind_ms == null ? 6 : wind_ms;
    b.o.windDir = 100 * D;
    b.u = 3;
    const twa = twa_deg;
    b.psi = (100 - twa) * D;
    const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const secs = seconds == null ? 25 : seconds;
    let gmax = 0;
    for (let i = 0; i < secs * 30; i++) {
      b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D,
        -(2.2 * wrap((100 - twa) * D - b.psi) - 0.9 * b.r)));
      b.step(1 / 30);
      const Gs = b.rig.stripGamma;
      if (Gs) for (let k = 0; k < Gs.length; k++) gmax = Math.max(gmax, Math.abs(Gs[k]));
    }
    const out = [];
    b.rig.stripCalc.forEach((g, i) => {
      const st = b.rig.strips[i];
      if (!st.gennaker) return;
      const cam = Math.abs(g.camber) * (g.fill || 0);
      const k = polarCoeffs(g.alpha, cam * Math.sign(g.camber || 1));
      const ceiling = polarCeiling(cam);
      out.push({
        strip: i, alpha_deg: g.alpha / D, camber: g.camber, draft: g.draft,
        slack: g.slack, design: st.design, luff_frac: g.luffFrac,
        fill: g.fill, chord_m: g.chord, ve_ms: g.ve, gamma: g.gamma,
        cl: k.cl, cd: k.cd, ceiling: ceiling,
        // Доля потолка: единица и больше означает, что сечение упёрлось и
        // подъёмную силу дальше ограничивает не физика, а предохранитель.
        at_ceiling: ceiling > 0 ? Math.abs(k.cl) / ceiling : 0,
        stall_deg: polarStallDeg(cam),
      });
    });
    return {
      twa_deg: twa, sheet_m: sheet_m, strips: out,
      gamma_max: gmax, fuse_trips: b.rig.fuseTrips || 0,
      speed_kn: b.telemetry.speedKn,
    };
  },
};

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  const req = JSON.parse(raw);
  const out = req.map(q => {
    const fn = Q[q.fn];
    if (!fn) return { error: `нет запроса ${q.fn}` };
    try {
      return fn(q);
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });
  process.stdout.write(JSON.stringify(out));
});
