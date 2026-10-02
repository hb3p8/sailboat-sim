// Известный ответ скорости на один пакет, при замороженных осях и ЦТ.
// Это проверка передачи нагрузки, без интегрирования положения или воздуха.
const bodyVector = (a, name) => {
  if (a?.length !== 3 || !Array.from(a).every(Number.isFinite))
    throw new Error(`Нужен конечный вектор: ${name}`);
  return Array.from(a);
};

export function supportBodyResponse(body, packet) {
  const mass = body.massKg, inertia = bodyVector(body.inertiaKgM2, 'инерция');
  if (!Number.isFinite(mass) || mass <= 0 || inertia.some(x => x <= 0))
    throw new Error('Масса и главные моменты инерции должны быть положительными');
  const origin = bodyVector(body.originM, 'ЦТ тела'), packetOrigin = bodyVector(packet.originM, 'начало пакета');
  if (body.frame !== packet.frame || body.frame !== 'body-horizontal' ||
      !origin.every((v, d) => v === packetOrigin[d]))
    throw new Error('Оси и начало моментов пакета должны совпадать с телом');
  if (!Number.isFinite(packet.durationS) || packet.durationS <= 0)
    throw new Error('Нужна положительная длительность полного пакета');
  const v = bodyVector(body.velocityMS, 'скорость'), w = bodyVector(body.angularVelocityRadS, 'угловая скорость');
  const J = bodyVector(packet.impulseNs, 'импульс'), L = bodyVector(packet.angularImpulseNms, 'интеграл момента');
  const velocityMS = v.map((x, d) => x + J[d] / mass);
  const angularVelocityRadS = w.map((x, d) => x + L[d] / inertia[d]);
  const energy = (a, b) => a.reduce((s, x, d) => s + (mass * x * x + inertia[d] * b[d] * b[d]) / 2, 0);
  const beforeJ = energy(v, w), afterJ = energy(velocityMS, angularVelocityRadS);
  // Работа пакета для этого дискретного изменения скорости. Работа движения
  // реальных креплений ткани имеет собственную историю и здесь не вычисляется.
  const impulseWorkJ = J.reduce((s, x, d) =>
    s + x * (v[d] + velocityMS[d]) / 2 + L[d] * (w[d] + angularVelocityRadS[d]) / 2, 0);
  if (![...velocityMS, ...angularVelocityRadS, beforeJ, afterJ, impulseWorkJ].every(Number.isFinite))
    throw new Error('Переполнение ответа тела');
  return { velocityMS, angularVelocityRadS, beforeJ, afterJ, impulseWorkJ };
}
