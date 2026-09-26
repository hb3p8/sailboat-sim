// Только локальный контроль слияния двух материальных приграничных слоёв.
// Уравнения (48)–(50), (52) DeVoria–Mohseni (2019) при v=u;
// не закон вовлечения и не замкнутая динамика свободного слоя.
export function mergeEdgeSheets({ branches, pressureJump = 0 }) {
  if (!Array.isArray(branches) || branches.length !== 2 ||
      !Number.isFinite(pressureJump) ||
      branches.some(branch => !Number.isFinite(branch.massPerLength) ||
        branch.massPerLength < 0 || !Number.isFinite(branch.speed) ||
        branch.speed < 0 || !Array.isArray(branch.tangent) ||
        branch.tangent.length !== 2 ||
        !branch.tangent.every(Number.isFinite) ||
        Math.abs(Math.hypot(...branch.tangent) - 1) > 1e-10))
    throw new Error('Кромка: некорректные материальные потоки');

  const massFlux = branches.reduce((sum, branch) =>
    sum + branch.massPerLength * branch.speed, 0);
  if (massFlux === 0)
    return pressureJump === 0 ? { ok: true, massFlux: 0,
      pressureJump: 0, tangent: null, surfaceMass: 0 } :
      { ok: false, reason: 'no-normal-momentum',
        pressureJump, massFlux: 0 };

  const vector = branches.reduce((sum, branch) => {
    const flux = branch.massPerLength * branch.speed;
    return [sum[0] + flux * branch.tangent[0],
      sum[1] + flux * branch.tangent[1]];
  }, [0, 0]);
  const magnitude = Math.hypot(...vector);
  if (!(magnitude > 0))
    return { ok: false, reason: 'edge-direction-degenerate' };
  const tangent = vector.map(value => value / magnitude);
  const normal = [-tangent[1], tangent[0]];
  const momentum = branches.reduce((sum, branch) => {
    const flux = branch.massPerLength * branch.speed ** 2;
    return [sum[0] + flux * branch.tangent[0],
      sum[1] + flux * branch.tangent[1]];
  }, [0, 0]);
  const along = momentum[0] * tangent[0] + momentum[1] * tangent[1];
  if (!(along > 0))
    return { ok: false, reason: 'edge-momentum-degenerate' };
  const speed = along / massFlux;
  const surfaceMass = massFlux / speed;
  return { ok: true, tangent, normal, massFlux, speed, surfaceMass,
    pressureJump, normalAcceleration: -pressureJump / surfaceMass,
    normalMomentumIn: momentum[0] * normal[0] +
      momentum[1] * normal[1] };
}
