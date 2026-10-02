// Независимый общий баланс из физических масс, истории, приложенных сил
// и реакций. Внутренние силы материала/кромок сюда не подмешиваются.
export function supportBalance({ positions, previous, prior, priorDt, hS, mass,
  fixed, board, dampingHz, appliedForceN, supportForceN, forceToleranceN }) {
  const origin = positions.slice(3*fixed[0],3*fixed[0]+3);
  const forceN=[0,0,0], momentNm=[0,0,0], appliedN=[0,0,0], supportN=[0,0,0];
  const dampingN=[0,0,0], inertiaN=[0,0,0], momentLimit=[0,0,0];
  let workJ=0, workMagnitudeJ=0, forceMagnitudeN=0, momentMagnitudeNm=0, displacementSumM=0, freeNodes=0;
  const excluded=new Set(board?.nodes.filter(i=>i!==board.end) ?? []), pinned=new Set(fixed);
  const decay=Math.exp(-dampingHz*hS), dt=priorDt || hS;
  for (let i=0;i<mass.length;i++) {
    const k=3*i, radius=[0,1,2].map(d=>positions[k+d]-origin[d]), residual=[0,0,0];
    for (let d=0;d<3;d++) {
      const displacement=positions[k+d]-previous[k+d], v=displacement/hS, v0=(previous[k+d]-prior[k+d])/dt;
      const inertial=mass[i]*(v-v0)/hS, damping=mass[i]*(decay-1)*v0/hS;
      const external=appliedForceN[k+d], support=supportForceN[k+d];
      residual[d]=inertial-external-damping-support;
      forceN[d]+=residual[d]; inertiaN[d]+=inertial; appliedN[d]+=external; dampingN[d]+=damping; supportN[d]+=support;
      const magnitude=Math.abs(inertial)+Math.abs(external)+Math.abs(damping)+Math.abs(support);
      forceMagnitudeN+=magnitude; momentMagnitudeNm+=magnitude*(Math.abs(radius[(d+1)%3])+Math.abs(radius[(d+2)%3]));
      workJ+=support*displacement; workMagnitudeJ+=Math.abs(support*displacement);
      if (!pinned.has(i) && !excluded.has(i)) displacementSumM+=Math.abs(displacement);
    }
    for (let d=0;d<3;d++) momentNm[d]+=radius[(d+1)%3]*residual[(d+2)%3]-radius[(d+2)%3]*residual[(d+1)%3];
    if (!pinned.has(i) && !excluded.has(i)) {
      freeNodes++;
      for (let d=0;d<3;d++) momentLimit[d]+=forceToleranceN*(Math.abs(radius[(d+1)%3])+Math.abs(radius[(d+2)%3]));
    }
  }
  // Сумма остатков свободных координат ограничена исходным допуском.
  // Добавка на округление определяется числом суммирований и их масштабом.
  const rounding=16*positions.length*Number.EPSILON;
  return {forceN,momentNm,appliedN,supportN,dampingN,inertiaN,supportWorkJ:workJ,
    forceLimitN:freeNodes*forceToleranceN+rounding*forceMagnitudeN,
    momentLimitNm:momentLimit.map(v=>v+rounding*momentMagnitudeNm),
    energyLimitJ:forceToleranceN*displacementSumM,
    workRoundingJ:rounding*workMagnitudeJ};
}
