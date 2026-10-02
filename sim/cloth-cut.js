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

// Отдельная гипотеза: две кубические половины с общим максимумом.
// Крайние ручки доходят до половины глубины; одинаковые ручки у максимума
// определяются непрерывностью второй производной, без визуального подбора.
// Все четыре заданных параметра выполняются до согласования с краями полотна.
export function joinedCubicSection(depth, peakAt, entryRad, exitRad) {
  if (!(Number.isFinite(depth) && depth>0 && Number.isFinite(peakAt) && peakAt>0 && peakAt<1 &&
        [entryRad,exitRad].every(a=>Number.isFinite(a)&&a>0&&a<Math.PI)))
    throw new Error('Нужны глубина >0, место максимума между 0 и 1, углы между 0 и π');
  const frontX=.5*depth/Math.tan(entryRad),backX=1-.5*depth/Math.tan(exitRad);
  const frontSpan=peakAt-frontX,backSpan=backX-peakAt;
  const handle=(frontSpan+backSpan)/4;
  if (!(handle>0 && handle<=frontSpan && handle<=backSpan))
    throw new Error('Составной профиль: заданные параметры нарушают порядок внутренних контрольных точек');
  const segments=[[0,0,frontX,.5*depth,peakAt-handle,depth,peakAt,depth],
    [peakAt,depth,peakAt+handle,depth,backX,.5*depth,1,0]];
  const parameterPoint=(t,out)=>{
    const P=segments[t<=.5?0:1],s=t<=.5?2*t:2*t-1,u=1-s;
    const w0=u*u*u,w1=3*u*u*s,w2=3*u*s*s,w3=s*s*s;
    out[0]=w0*P[0]+w1*P[2]+w2*P[4]+w3*P[6];
    out[1]=w0*P[1]+w1*P[3]+w2*P[5]+w3*P[7];
    return out;
  };
  // То же приближение длины, что у прежнего профиля; точка максимума входит
  // в отсчёты. Оно не изменяет точную форму или условия её существования.
  let ratio=0,lastX=0,lastZ=0;const p=[0,0];
  for(let i=1;i<=64;i++) {
    parameterPoint(i/64,p);ratio+=Math.hypot(p[0]-lastX,p[1]-lastZ);lastX=p[0];lastZ=p[1];
  }
  return {segments,parameterPoint,ratio,cam:depth,at:peakAt,
    controlOrderMargin:Math.min(frontSpan,backSpan)-handle};
}
