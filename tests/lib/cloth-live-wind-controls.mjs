// Одинаковый трёхсекундный опыт CLI/экрана, шаг 1/60 с.
export function liveWindCycleControls(index,side) {
  if(!Number.isInteger(index)||index<0||index>=180||!['plus','minus'].includes(side))throw new Error('Нужны шаг 0–179 и сторона живого цикла');
  const sign=side==='plus'?1:-1;
  return {windSpeedMPS:index>=30&&index<90?7:6,
    windFromDeg:sign*(index>=30&&index<60?130:index>=60&&index<90?160:140),
    sheetRateMPS:index>=30&&index<60?.5:index>=90&&index<120?-.5:0};
}
