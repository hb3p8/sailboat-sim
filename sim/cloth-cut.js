// Непрерывное согласование семейства сечений с нижней и верхней границами.
// Это геометрическая гипотеза кроя, а не закон деформации ткани.
// Сечения уже обязаны лежать на передней/задней кромках при u=0/1;
// крайние сечения и заданные границы имеют одни и те же углы.
export function matchedCutSurface(section, bottom, top) {
  const low = [0, 0, 0], high = [0, 0, 0], edge = [0, 0, 0];
  return (u, v, out) => {
    if (v === 0) return bottom(u, out);
    if (v === 1) return top(u, out);
    section(u, v, out);
    if (u === 0 || u === 1) return out;
    section(u, 0, low); section(u, 1, high);
    bottom(u, edge);
    for (let k = 0; k < 3; k++) out[k] += (1 - v) * (edge[k] - low[k]);
    top(u, edge);
    for (let k = 0; k < 3; k++) out[k] += v * (edge[k] - high[k]);
    return out;
  };
}

// Максимальная глубина кубического сечения: концы и корни производной.
// В отличие от выбора из отсчётов, место максимума не привязано к сетке.
export function bezierSectionPeak(P) {
  const a = 3 * (-P[1] + 3 * P[3] - 3 * P[5] + P[7]);
  const b = 6 * (P[1] - 2 * P[3] + P[5]);
  const c = 3 * (P[3] - P[1]);
  const candidates = [0, 1];
  if (a === 0) {
    if (b !== 0) candidates.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      // Устойчивая формула не вычитает два близких числа в одном из корней.
      const q = -.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
      candidates.push(q / a);
      if (q !== 0) candidates.push(c / q);
    }
  }
  let t = 0, cam = P[1], at = P[0];
  for (const s of candidates) {
    if (!(s >= 0 && s <= 1)) continue;
    const u = 1 - s, w = [u*u*u, 3*u*u*s, 3*u*s*s, s*s*s];
    const z = w.reduce((sum,x,k) => sum + x * P[2*k+1], 0);
    if (z > cam) {
      t = s; cam = z; at = w.reduce((sum,x,k) => sum + x * P[2*k], 0);
    }
  }
  return { t, cam, at };
}
