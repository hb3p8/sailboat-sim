// Общие измерители независимых стендов и совместного прогона генакера.
// Это чтение геометрии и уже приложенных сил, без новой модели нагрузки.
// Контракт: docs/reference/gennaker-acceptance.md.
export const SECTION_FRACTIONS = Object.freeze(
  Array.from({ length: 9 }, (_, i) => (i + 1) / 10));
export const LIMITS = Object.freeze({ gamma: 300, jump: 0.05 });

export function sectionsOf(cloth, fractions = SECTION_FRACTIONS) {
  return fractions.map(fraction => {
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
      throw new Error('Доля строки должна быть 0…1');
    const row = fraction * (cloth.rows - 1);
    const shape = cloth.rowShape(row);
    if (!Object.values(shape).every(Number.isFinite))
      throw new Error(`Не-конечная форма строки ${row}`);
    return { fraction, row, ...shape };
  });
}

// Момент — r×F относительно явно заданного начала. Н·м, силы в Н.
export function wrenchOf(points, forces, origin = [0, 0, 0]) {
  if (points.length !== forces.length || origin.length !== 3 ||
      !origin.every(Number.isFinite)) throw new Error('Некорректная постановка нагрузки');
  const forceN = [0, 0, 0], momentNm = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const p = points[i], f = forces[i];
    if (p.length !== 3 || f.length !== 3 || !p.every(Number.isFinite) ||
        !f.every(Number.isFinite)) throw new Error('Не-конечная точка или сила');
    const r = p.map((x, k) => x - origin[k]);
    for (let k = 0; k < 3; k++) forceN[k] += f[k];
    momentNm[0] += r[1] * f[2] - r[2] * f[1];
    momentNm[1] += r[2] * f[0] - r[0] * f[2];
    momentNm[2] += r[0] * f[1] - r[1] * f[0];
  }
  return { forceN, momentNm };
}

export function rollVector(p, phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

// Вызывается непосредственно после forcesAt(), до перемещения узлов.
// Нормали, точки, площади и pressureForce относятся к одной оценке нагрузки.
export function clothPressureOf(cloth, phi = 0, origin = [0, 0, 0], includeNodes = false) {
  if (!cloth.pressureForce || cloth.pressureForce.length !== cloth.n)
    throw new Error('Нет буфера приложенного давления');
  const points = [], forces = [];
  let scalarN = 0, absoluteN = 0, frontAbsoluteN = 0, maxEquivalentPa = 0;
  for (let i = 0; i < cloth.n; i++) {
    const f = cloth.pressureForce[i], k = i * 3;
    const p = Array.from(cloth.pos.slice(k, k + 3));
    const n = Array.from(cloth.nrm.slice(k, k + 3));
    if (!Number.isFinite(f)) throw new Error('Не-конечная нагрузка ткани');
    points.push(rollVector(p, phi));
    forces.push(rollVector(n.map(x => x * f), phi));
    scalarN += f; absoluteN += Math.abs(f);
    if ((i % cloth.cols) / (cloth.cols - 1) <= 0.125) frontAbsoluteN += Math.abs(f);
    const area = cloth._areaNow?.[i];
    if (area > 0) maxEquivalentPa = Math.max(maxEquivalentPa, Math.abs(f / area));
  }
  const profiles = cloth.localPressureProfiles || [];
  const reasons = {};
  for (const p of profiles) if (!p.ok) reasons[p.reason] = (reasons[p.reason] || 0) + 1;
  const result = {
    phase: 'cloth-forces-before-advance',
    frame: 'body-horizontal', originM: [...origin],
    ...wrenchOf(points, forces, origin), scalarN, absoluteN,
    frontAbsoluteShare: absoluteN > 0 ? frontAbsoluteN / absoluteN : null,
    maxEquivalentPa, // Нормальная узловая сила / площадь; не новое измеренное давление.
    localProfiles: { accepted: profiles.filter(p => p.ok).length,
      total: profiles.length, reasons },
  };
  if (includeNodes) result.nodes = {
    rigPositionsM: Array.from(cloth.pos), rigNormals: Array.from(cloth.nrm),
    scalarForceN: Array.from(cloth.pressureForce), areaM2: Array.from(cloth._areaNow || []), phi,
  };
  return result;
}

// Полоски после расчёта воздуха, в тех же горизонтных осях и вокруг того же ЦТ.
export function stripLoadOf(rig, phi, origin, sail = null) {
  const points = [], forces = [];
  for (let i = 0; i < rig.strips.length; i++) {
    if (sail !== null && rig.strips[i].sail !== sail) continue;
    const g = rig.stripCalc[i], d = rig.stripState[i];
    points.push([g.xi, g.yi, g.zi]);
    forces.push(rollVector([d.drive, d.side, 0], phi));
  }
  return { phase: 'aero-after-cloth', frame: 'body-horizontal',
    originM: [...origin], ...wrenchOf(points, forces, origin) };
}

export function sheetGeometryOf(cloth, gen, side, lengthM) {
  const lead = [gen.sheet_lead_m[0], Math.abs(gen.sheet_lead_m[1]) * Math.sign(side || -1),
    gen.sheet_lead_m[2]];
  const clew = Array.from(cloth.pos.slice(cloth.clew * 3, cloth.clew * 3 + 3));
  const distanceM = Math.hypot(...clew.map((x, i) => x - lead[i]));
  return { freeClew: cloth.freeClew, lengthM, distanceM, gapM: lengthM - distanceM,
    tensionN: null }; // Реакция не вычисляется из коррекции положения.
}

export function stabilityOf(samples) {
  const late = samples.filter(s => s.t >= 10);
  if (!late.length) throw new Error('Нет окна после начального перехода');
  let gammaMax = 0, jumpN = 0, referenceN = 1, jumpAtS = null;
  let continuousJumpN = 0, commandJumpN = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (![s.t, s.driveN, s.gammaMax].every(Number.isFinite))
      throw new Error('Не-конечная история силы');
    if (i > 0 && s.t <= samples[i - 1].t) throw new Error('Нарушен порядок временной истории');
    if (s.t < 10) continue;
    gammaMax = Math.max(gammaMax, s.gammaMax);
    referenceN = Math.max(referenceN, Math.abs(s.driveN));
    if (i > 0) {
      const delta = Math.abs(s.driveN - samples[i - 1].driveN);
      if (delta > jumpN) { jumpN = delta; jumpAtS = s.t; }
      if (s.sheetM !== samples[i - 1].sheetM) commandJumpN = Math.max(commandJumpN, delta);
      else continuousJumpN = Math.max(continuousJumpN, delta);
    }
  }
  const jump = jumpN / referenceN;
  return { gammaMax, jumpN, referenceN, jump, jumpAtS,
    continuousJump: continuousJumpN / referenceN, commandJump: commandJumpN / referenceN,
    gammaPass: gammaMax < LIMITS.gamma, jumpPass: jump <= LIMITS.jump,
    continuousJumpPass: continuousJumpN / referenceN <= LIMITS.jump };
}

// Число полных возвращений знака на одной станции. Это геометрический
// свидетель повторения, ещё не доказательство физической периодичности.
export function entryCycles(samples, fraction) {
  let sign = 0, changes = 0;
  for (const s of samples) {
    const row = s.sections.find(r => r.fraction === fraction);
    if (!row || !Number.isFinite(row.entry)) throw new Error('Нет истории станции');
    const next = Math.sign(row.entry);
    if (!next) continue;
    if (sign && next !== sign) changes++;
    sign = next;
  }
  return Math.floor(changes / 2);
}
