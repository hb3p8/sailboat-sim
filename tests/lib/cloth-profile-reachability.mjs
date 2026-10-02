// Независимая геометрическая оценка кубического семейства с положительными
// ручками. Полный диапазон включает предел нулевой ручки, не ограничение r=.05… .95.
// При заданной глубине d параметр максимума t лежит в [1/3,2/3].
// Из z(t)=d и z'(t)=0: x(t)=t²(3−2t)+d[(2−3t)cot(in)−(3t−1)cot(out)].
export function cubicPeakRange(depth, entryRad, exitRad) {
  if (!(Number.isFinite(depth) && depth>0 && [entryRad,exitRad].every(a=>Number.isFinite(a)&&a>0&&a<Math.PI)))
    throw new Error('Нужны положительная глубина и углы между 0 и π');
  const frontCot=1/Math.tan(entryRad),backCot=1/Math.tan(exitRad);
  const x=t=>t*t*(3-2*t)+depth*((2-3*t)*frontCot-(3*t-1)*backCot);
  const candidates=[1/3,2/3],discriminant=1-2*depth*(frontCot+backCot);
  if(discriminant>=0)for(const t of [(1-Math.sqrt(discriminant))/2,(1+Math.sqrt(discriminant))/2])
    if(t>1/3 && t<2/3)candidates.push(t);
  const positions=candidates.map(x);
  return {minAt:Math.min(...positions),maxAt:Math.max(...positions),
    minimumDerivative:4/3-3*depth*(frontCot+backCot),extrema:candidates.map((t,i)=>({t,at:positions[i]})),
    interpretation:'замыкание полного семейства при неотрицательных ручках; до согласования с границами'};
}
