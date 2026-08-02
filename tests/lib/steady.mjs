// Один установившийся ход: поставили условия, дали лодке устаканиться, сняли.
//
// Живёт отдельным модулем, потому что этим же прогоном пользуются и батареи в
// главном потоке, и рабочие потоки (tests/lib/pool.mjs). Батареи перебирают
// сотни настроек, и на десяти ядрах это идёт в разы быстрее; но модель обязана
// быть одна и та же, иначе параллельный прогон начнёт отвечать не то, что
// последовательный, и разбираться в этом будет некому.
//
// Отсюда же и правило: здесь только чистая функция от условий. Никакого
// состояния между вызовами, никаких общих буферов — рабочий поток и главный
// должны давать побитово одно и то же.

import { Boat } from '../../sim/physics.js';

const D = Math.PI / 180;

function wrapPi(a) {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Досрочная остановка: лодка выходит на режим задолго до конца отведённого
// времени, и досиживать до него незачем. Проверяется не мгновенная скорость, а
// то, насколько она ушла за последние STEADY_WINDOW секунд: на волнении и в
// порывах мгновенная дрожит, а средняя стоит.
const STEADY_WINDOW = 6;
const STEADY_EPS = 0.004;      // узла за окно
const MIN_SECONDS = 25;

export function steady(pack, spec) {
  const b = new Boat(pack);
  b.o.windSpeed = spec.wind ?? 6;
  b.o.windDir = (spec.twa ?? 45) * D;      // курс ноль, значит истинный = TWA
  b.o.sheet = (spec.sheet ?? 20) * D;
  b.o.twist = (spec.twist ?? 0) * D;
  b.o.crewHike = spec.hike ?? 0;
  b.o.crewMass = b.o.crewHike > 0 ? 240 : 0;
  if (spec.fetch != null) b.o.fetch = spec.fetch;
  if (spec.draft != null) b.o.draft = spec.draft;
  // Старт с ходом и уже с креном: прямостоящая лодка на полном ходу в
  // бейдевинд — состояние, которого на воде не бывает.
  b.u = spec.u ?? 3.0;
  b.phi = (spec.heel ?? 18) * D;

  const secs = spec.secs ?? 70;
  const hz = 30, hold = STEADY_WINDOW * hz;
  const ring = new Float64Array(hold);
  let worstU = 0, worstHeel = 0, n = 0;
  for (let i = 0; i < secs * hz; i++) {
    const err = wrapPi(0 - b.psi);
    b.o.rudderTarget = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * b.r)));
    b.step(1 / hz);
    if (Math.abs(b.u) > worstU) worstU = Math.abs(b.u);
    if (Math.abs(b.phi / D) > worstHeel) worstHeel = Math.abs(b.phi / D);
    const v = b.telemetry.speedKn;
    const old = ring[n % hold];
    ring[n % hold] = v;
    n++;
    if (!spec.noEarlyStop && n > MIN_SECONDS * hz && n > hold &&
        Math.abs(v - old) < STEADY_EPS) break;
  }

  const t = b.telemetry;
  const track = (spec.twa ?? 45) + Math.abs(t.leewayDeg);
  return {
    speedKn: t.speedKn, heelDeg: t.heelDeg, leewayDeg: t.leewayDeg,
    awaDeg: t.awaDeg, driveN: t.driveN, vmg: t.speedKn * Math.cos(track * D),
    // VMG из телеметрии — без учёта дрейфа; в таблицах он и печатается.
    vmgTel: t.vmg, twaAbsDeg: t.twaAbsDeg,
    track: track, helm: b.o.rudder / D, headingErr: wrapPi(0 - b.psi) / D,
    worstU: worstU, worstHeel: worstHeel,
    seconds: n / hz,
    finite: [b.u, b.v, b.r, b.phi, b.psi].every(Number.isFinite),
  };
}
