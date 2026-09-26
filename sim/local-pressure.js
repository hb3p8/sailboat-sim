// Экспериментальная локальная раскладка нормальной силы. При normalForce=null
// интеграл не навязывается: это отдельный диагностический потенциальный лист.
// Двумерный тонкий вихревой лист: непротекание в 3/4 каждой панели,
// связанный вихрь в 1/4. Дополнительная неизвестная — равномерная поправка
// нормального потока; дополнительное уравнение задаёт интеграл силы из поляры.
// Это квазистационарное замыкание, НЕ модель отрыва и не новый источник Γ
// для общей пелены. Бернулли линеаризован по заданной касательной скорости.
// Область применимости и отрицательные пробы: docs/local-pressure.md.

function solve(a, rhs) {
  const n = rhs.length, x = new Float64Array(rhs);
  const m = a.map(row => new Float64Array(row));
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++)
      if (Math.abs(m[i][k]) > Math.abs(m[pivot][k])) pivot = i;
    if (Math.abs(m[pivot][k]) < 1e-12) return null;
    [m[k], m[pivot]] = [m[pivot], m[k]];
    [x[k], x[pivot]] = [x[pivot], x[k]];
    for (let i = k + 1; i < n; i++) {
      const f = m[i][k] / m[k][k];
      for (let j = k + 1; j < n; j++) m[i][j] -= f * m[k][j];
      x[i] -= f * x[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) x[i] -= m[i][j] * x[j];
    x[i] /= m[i][i];
  }
  return x;
}

// points: равномерные материальные станции [x,z] строки, в её плоскости.
// Начало хорды (0,0), конец (chord,0), +z вдоль нормали нагрузки ткани.
// flow — скорость воздуха относительно рига; движение ткани уже входит в
// существующее демпфирование Cloth.advance и здесь повторно не учитывается.
export function localPressure({ points, flow, rho, span, normalForce, panels = 16 }) {
  if (!Number.isInteger(panels) || panels < 4 || panels > 128)
    throw new Error('Локальное давление: число панелей должно быть 4…128');
  const forceMatched = normalForce !== null;
  if (points.length < 2 || !points.every(p => p.length === 2 && p.every(Number.isFinite)) ||
      flow.length !== 2 || !flow.every(Number.isFinite) ||
      (forceMatched && !Number.isFinite(normalForce)) ||
      !Number.isFinite(rho) || !Number.isFinite(span) || !(rho > 0) || !(span > 0))
    throw new Error('Локальное давление: некорректный вход');
  const chord = points.at(-1)[0] - points[0][0], speed = Math.hypot(...flow);
  if (!(chord > 1e-8) || !(speed > 1e-8)) return { ok: false, reason: 'degenerate' };
  // Условие Кутты этой дискретизации относится к задней кромке. При обратном
  // обтекании его нельзя молча оставлять на прежнем конце.
  if (!(flow[0] > 0)) return { ok: false, reason: 'reverse-flow' };
  const sample = u => {
    const v = u * (points.length - 1), i = Math.min(points.length - 2, Math.floor(v)), t = v - i;
    return [(points[i][0] * (1 - t) + points[i + 1][0] * t - points[0][0]) / chord,
            (points[i][1] * (1 - t) + points[i + 1][1] * t - points[0][1]) / chord];
  };
  const u = Array.from({ length: panels + 1 }, (_, i) => (1 - Math.cos(Math.PI * i / panels)) / 2);
  const edges = u.map(sample), bound = [], control = [], tangent = [], lengths = [];
  for (let i = 0; i < panels; i++) {
    const a = edges[i], b = edges[i + 1], dx = b[0] - a[0], dz = b[1] - a[1];
    const ds = Math.hypot(dx, dz);
    if (!(ds > 1e-10)) return { ok: false, reason: 'degenerate-panel' };
    bound.push([a[0] + 0.25 * dx, a[1] + 0.25 * dz]);
    control.push([a[0] + 0.75 * dx, a[1] + 0.75 * dz]);
    tangent.push([dx / ds, dz / ds]); lengths.push(ds);
  }
  const U = flow.map(v => v / speed), n = panels + Number(forceMatched);
  const a = Array.from({ length: n }, () => new Float64Array(n)), rhs = new Float64Array(n);
  const ut = tangent.map(t => U[0] * t[0] + U[1] * t[1]);
  for (let i = 0; i < panels; i++) {
    const [tx, tz] = tangent[i], nx = -tz, nz = tx;
    for (let j = 0; j < panels; j++) {
      const dx = control[i][0] - bound[j][0], dz = control[i][1] - bound[j][1];
      const r2 = dx * dx + dz * dz;
      if (r2 < 1e-20) return { ok: false, reason: 'intersecting-panels' };
      a[i][j] = (-dz * nx + dx * nz) / (2 * Math.PI * r2);
    }
    if (forceMatched) a[i][panels] = nz;
    rhs[i] = -(U[0] * nx + U[1] * nz);
    // Проекция силы Бернулли на +z строки, а не сумма |давлений|.
    if (forceMatched) a[panels][i] = -ut[i] * nz;
  }
  if (forceMatched)
    rhs[panels] = normalForce / (rho * speed * speed * chord * span);
  const x = solve(a, rhs);
  if (!x || !x.every(Number.isFinite)) return { ok: false, reason: 'singular' };
  let residual = 0;
  for (let i = 0; i < n; i++) {
    let ax = 0, norm = Math.abs(rhs[i]);
    for (let j = 0; j < n; j++) { ax += a[i][j] * x[j]; norm += Math.abs(a[i][j] * x[j]); }
    residual = Math.max(residual, Math.abs(ax - rhs[i]) / Math.max(1, norm));
  }
  if (residual > 1e-8) return { ok: false, reason: 'residual', residual };
  const pressure = [], forces = [], at = [], atChord = [];
  for (let i = 0; i < panels; i++) {
    const dp = -rho * speed * speed * ut[i] * x[i] / lengths[i];
    pressure.push(dp);
    forces.push(dp * lengths[i] * chord * span * tangent[i][0]);
    at.push((u[i] + u[i + 1]) / 2);
    atChord.push((edges[i][0] + edges[i + 1][0]) / 2);
  }
  return { ok: true, pressure, forces, at, atChord, edges: u,
           edgesChord: edges.map(p => p[0]), residual,
           downwash: forceMatched ? x[panels] * speed : 0,
           circulation: x.slice(0, panels).reduce((s, v) => s + v, 0) * speed * chord };
}

// Та же проекция летящей строки, что использует Cloth.advance. Функция
// отдельно вызывается на замороженном снимке без шага ткани: профиль тогда
// зависит только от формы и уже заданной нормальной нагрузки строки.
export function localPressureForRow({ pos, normals, area, pressureForce,
                                      row, cols, strip, rho, panels = 16,
                                      forceMatched = true }) {
  const first = row * cols * 3, last = (row * cols + cols - 1) * 3;
  const tx = pos[last] - pos[first], ty = pos[last + 1] - pos[first + 1],
        tz = pos[last + 2] - pos[first + 2];
  const chord = Math.hypot(tx, ty, tz);
  if (chord < 1e-8) return { ok: false, reason: 'degenerate-row' };
  const nx = normals[first], ny = normals[first + 1], nz = normals[first + 2];
  const points = [];
  let rowArea = 0, target = 0, arc = 0;
  for (let c = 0; c < cols; c++) {
    const i = row * cols + c, k = i * 3;
    const dx = pos[k] - pos[first], dy = pos[k + 1] - pos[first + 1],
          dz = pos[k + 2] - pos[first + 2];
    points.push([(dx * tx + dy * ty + dz * tz) / chord,
                 dx * nx + dy * ny + dz * nz]);
    rowArea += area[i]; target += pressureForce[i];
    if (c) arc += Math.hypot(points[c][0] - points[c - 1][0],
                             points[c][1] - points[c - 1][1]);
  }
  if (!(rowArea > 0) || !(arc > 0)) return { ok: false, reason: 'degenerate-area' };
  const v = strip.ve / Math.hypot(strip.d1, strip.d2);
  return localPressure({ points,
    flow: [v * (strip.d1 * tx + strip.d2 * ty) / chord,
           v * (strip.d1 * nx + strip.d2 * ny)],
    rho, span: rowArea / arc, normalForce: forceMatched ? target : null, panels });
}

// Консервативный перенос сосредоточенных сил на материальные узлы строки:
// сохраняются сумма и первый момент по материальной координате u.
export function pressureToNodes(profile, count) {
  if (!profile.ok || !Number.isInteger(count) || count < 2)
    throw new Error('Перенос давления требует принятого профиля и минимум двух узлов');
  const out = new Float64Array(count);
  for (let i = 0; i < profile.forces.length; i++) {
    const v = profile.at[i] * (count - 1), lo = Math.min(count - 2, Math.floor(v)), t = v - lo;
    out[lo] += profile.forces[i] * (1 - t); out[lo + 1] += profile.forces[i] * t;
  }
  return out;
}
