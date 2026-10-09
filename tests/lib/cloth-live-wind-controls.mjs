// Одинаковый трёхсекундный опыт CLI/экрана, шаг 1/60 с.
export function liveWindCycleControls(index,side) {
  if(!Number.isInteger(index)||index<0||index>=180||!['plus','minus'].includes(side))throw new Error('Нужны шаг 0–179 и сторона живого цикла');
  const sign=side==='plus'?1:-1;
  return {windSpeedMPS:index>=30&&index<90?7:6,
    windFromDeg:sign*(index>=30&&index<60?130:index>=60&&index<90?160:140),
    sheetRateMPS:index>=30&&index<60?.5:index>=90&&index<120?-.5:0};
}

// Тот же ветер/шкот; после возврата шкота просим 10° на полсекунды и возвращаем.
export function sv20WindCycleControls(index,side) {
  return {...liveWindCycleControls(index,side),rudderDeg:index>=120&&index<150?(side==='plus'?10:-10):0};
}
