// Прежняя скорость перекладки Boat: 26 градусов в секунду, не новый параметр.
export function rudderAngleAfter(currentRad,targetRad,dt) {
  if(targetRad==null)return currentRad;
  const d=targetRad-currentRad,lim=(26*(Math.PI/180))*dt;
  return currentRad+Math.max(-lim,Math.min(lim,d));
}
