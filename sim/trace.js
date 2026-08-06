// Запись состояния лодки по шагам физики.
//
// Живёт отдельным модулем нарочно: этой же записью пользуется симулятор,
// проигрыватель (scripts/replay.mjs) и тест на воспроизводимость. Если формат
// разъедется, разъедется молча и обнаружится через неделю на чужом дампе.
//
// В запись идёт ВСЁ, что человек может тронуть по ходу дела, а не только руль
// со шкотом. Первая же проверка на этом и споткнулась: ползунок ветра двигали
// в середине записи, а в дампе лежало только его конечное значение — и
// воспроизведение разъезжалось на четверть по скорости ветра.
//
// Поле ветра собственного состояния не имеет: оно однозначно задаётся
// скоростью, направлением, порывистостью и парой (положение, время). Значит
// восстановления лодки достаточно, чтобы получить тот же самый ветер.

export const TRACE_FIELDS = [
  // состояние лодки — по нему она восстанавливается целиком
  't', 'x', 'y', 'psi', 'u', 'v', 'r', 'phi', 'p_', 'rigSide', 'hike',
  // Всплытие и дифферент с их скоростями: с динамической плавучестью лодка
  // помнит, на сколько она села и как стоит по дифференту, и без этих четырёх
  // чисел запись не воспроизводится.
  'zc', 'w', 'th', 'q',
  // Запаздывающие углы атаки полосок — тоже состояние: парус выходит на
  // новую подъёмную силу не мгновенно. Единственное поле-массив в записи;
  // числом их не сделать, полосок может стать больше или меньше.
  'lag',
  // органы управления и условия — всё, что можно тронуть на ходу
  'rudder', 'sheet', 'jibTrim', 'twist', 'twistEff', 'draft', 'fetch', 'fetchOverride',
  'windSpeed', 'windDir', 'gust', 'shift', 'crewHike', 'crewMass', 'sailScale',
  // показания — для сверки при воспроизведении и для разбора без пересчёта
  'speedKn', 'heelDeg', 'leewayDeg', 'driveN', 'sideN', 'alphaDeg',
  'awaDeg', 'twsKn',
];

// Поля, которые при воспроизведении надо подавать обратно в лодку.
export const TRACE_INPUTS = [
  'rudder', 'sheet', 'jibTrim', 'twist', 'draft', 'fetch', 'fetchOverride',
  'windSpeed', 'windDir',
  'crewHike', 'crewMass', 'sailScale',
];

// Округление разное, и не для красоты.
//
// Состояние и органы управления — то, из чего прогон восстанавливается, —
// пишутся с девятью знаками. После мембраны модель стала заметно чувствительнее:
// парус работает у самого горба кривой сечения, где наклон крутой, и возмущение
// начальной скорости усиливается примерно в триста раз за двадцать пять секунд.
// Прежних четырёх знаков на это уже не хватает — своё же округление вырастает
// до сотых долей узла.
//
// Показания округляются по-прежнему до четвёртого знака: их никуда не подают,
// они только для сверки и разбора, и на них уходит половина объёма файла.
const r9 = v => Math.round((v || 0) * 1e9) / 1e9;
const r4 = v => Math.round((v || 0) * 1e4) / 1e4;

export function traceFrame(boat) {
  const t = boat.telemetry;
  if (!t) return null;
  return [
    r9(boat.t), r9(boat.x), r9(boat.y), r9(boat.psi),
    r9(boat.u), r9(boat.v), r9(boat.r), r9(boat.phi), r9(boat.p_), boat.rigSide,
    // Момент откренивания — тоже состояние: экипаж отзывается с запаздыванием.
    // Без него запись не воспроизводится, и это поймал тест, а не глаз.
    r9(boat.hike),
    r9(boat.zc), r9(boat.w), r9(boat.th), r9(boat.q),
    boat.alphaLag ? Array.from(boat.alphaLag, r9) : null,
    r9(boat.o.rudder), r9(boat.o.sheet), r9(boat.o.jibTrim),
    r9(boat.o.twist), r4(boat.twistEff),
    r9(boat.o.draft), r9(boat.o.fetch), boat.o.fetchOverride ? 1 : 0,
    r9(boat.o.windSpeed), r9(boat.o.windDir),
    r9(boat.wind.o.gust), r9(boat.wind.o.shift),
    r9(boat.o.crewHike), r9(boat.o.crewMass), r9(boat.o.sailScale),
    r4(t.speedKn), r4(t.heelDeg), r4(t.leewayDeg), r4(t.driveN), r4(t.sideN),
    r4(t.alphaDeg), r4(t.awaDeg), r4(t.twsKn),
  ];
}

// Кольцевая запись последних `seconds` секунд.
export class Recorder {
  constructor(seconds, hz) {
    this.hz = hz;
    this.limit = Math.round(seconds * hz);
    this.frames = [];
  }
  push(boat) {
    const f = traceFrame(boat);
    if (!f) return;
    this.frames.push(f);
    if (this.frames.length > this.limit) this.frames.shift();
  }
  dump() {
    return { hz: this.hz, fields: TRACE_FIELDS, frames: this.frames.slice() };
  }
}

// Восстановить лодку по кадру записи. Индексы берутся из полей самого дампа,
// а не из TRACE_FIELDS: старый дамп с другим порядком полей должен читаться.
export function restoreFrom(boat, frame, index) {
  const g = name => (index[name] != null ? frame[index[name]] : undefined);
  boat.x = g('x'); boat.y = g('y'); boat.psi = g('psi');
  boat.u = g('u'); boat.v = g('v'); boat.r = g('r');
  boat.phi = g('phi'); boat.p_ = g('p_'); boat.t = g('t');
  boat.rigSide = g('rigSide');
  if (index.hike != null) boat.hike = g('hike');
  // Старые записи этих полей не знают — тогда посадка остаётся как есть.
  if (index.zc != null) {
    boat.zc = g('zc'); boat.w = g('w'); boat.th = g('th'); boat.q = g('q');
  }
  const lag = g('lag');
  if (lag && boat.alphaLag && lag.length === boat.alphaLag.length) {
    boat.alphaLag.set(lag);
  }
}

// Подать в лодку органы управления и условия из кадра.
export function applyFrom(boat, frame, index) {
  for (const name of TRACE_INPUTS) {
    if (index[name] != null) boat.o[name] = frame[index[name]];
  }
  if (index.gust != null) boat.wind.o.gust = frame[index.gust];
  if (index.shift != null) boat.wind.o.shift = frame[index.shift];
}

export function fieldIndex(fields) {
  const ix = {};
  (fields || TRACE_FIELDS).forEach((name, i) => { ix[name] = i; });
  return ix;
}
