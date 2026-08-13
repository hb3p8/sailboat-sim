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

import { jibSheetOf } from './aero.js';

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
  // Скорость гика: `rigSide` говорит, где он сейчас, но не куда идёт. Посреди
  // переброса этого мало — без скорости он после восстановления замер бы на
  // месте и пошёл заново, уже от нуля.
  'rigRate',
  // органы управления и условия — всё, что можно тронуть на ходу
  'rudder', 'sheet', 'jibSheet', 'twist', 'twistEff', 'draft', 'fetch', 'fetchOverride',
  'windSpeed', 'windDir', 'gust', 'shift', 'crewHike', 'crewMass', 'sailScale',
  // Условия акватории — тоже ползунки, и они тоже меняются на ходу. Их не было,
  // и запись, снятая с поворотом ползунка течения, воспроизводилась с конечным
  // его значением на всю длину.
  'current', 'shadeD0', 'shadeK', 'shadeGust', 'chan', 'crewX', 'crewZ',
  // показания — для сверки при воспроизведении и для разбора без пересчёта
  'speedKn', 'heelDeg', 'leewayDeg', 'driveN', 'sideN', 'alphaDeg',
  'awaDeg', 'twsKn',
  // Дописано в конец нарочно: старые дампы читаются по своему списку полей, а
  // новые поля в середине сдвинули бы все следующие. Здесь у стакселя свои твист
  // и пузо (раньше они были общими на два паруса) и признак «парус поставлен».
  //
  // Режима физики паруса тут НЕТ. Дамп — про то, как лодку вели, и
  // воспроизводится он безусловно на измеренной поляре: иначе одна и та же
  // запись давала бы разный ответ в зависимости от галочки, которую забыли
  // переключить.
  'jibTwist', 'jibDraft', 'mainUp', 'jibUp',
];

// Поля, которые при воспроизведении надо подавать обратно в лодку.
export const TRACE_INPUTS = [
  'rudder', 'sheet', 'jibSheet', 'twist', 'draft', 'fetch', 'fetchOverride',
  'jibTwist', 'jibDraft', 'mainUp', 'jibUp',
  'windSpeed', 'windDir',
  'crewHike', 'crewMass', 'crewX', 'crewZ', 'sailScale',
  'current', 'shadeD0', 'shadeK', 'shadeGust', 'chan',
];

// Поля, которые в записи лежат единицей и нулём, а в лодке обязаны быть
// логическими. Без этого убранный парус восстанавливался нулём, а ноль — не
// `false`, и парус молча оставался стоять.
const TRACE_BOOLS = new Set(['fetchOverride', 'mainUp', 'jibUp']);

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
    boat.rig.alphaLag ? Array.from(boat.rig.alphaLag, r9) : null,
    r9(boat.rigRate),
    r9(boat.o.rudder), r9(boat.o.sheet), r9(jibSheetOf(boat.o)),
    r9(boat.o.twist), r4(boat.rig.twistEff),
    r9(boat.o.draft), r9(boat.o.fetch), boat.o.fetchOverride ? 1 : 0,
    r9(boat.o.windSpeed), r9(boat.o.windDir),
    r9(boat.wind.o.gust), r9(boat.wind.o.shift),
    r9(boat.o.crewHike), r9(boat.o.crewMass), r9(boat.o.sailScale),
    r9(boat.o.current), r9(boat.o.shadeD0), r9(boat.o.shadeK),
    r9(boat.o.shadeGust), r9(boat.o.chan), r9(boat.o.crewX), r9(boat.o.crewZ),
    r4(t.speedKn), r4(t.heelDeg), r4(t.leewayDeg), r4(t.driveN), r4(t.sideN),
    r4(t.alphaDeg), r4(t.awaDeg), r4(t.twsKn),
    r9(boat.o.jibTwist != null ? boat.o.jibTwist : boat.o.twist),
    r9(boat.o.jibDraft != null ? boat.o.jibDraft : boat.o.draft),
    boat.o.mainUp === false ? 0 : 1, boat.o.jibUp === false ? 0 : 1,
  ];
}

// Свободная пелена — тоже состояние, и немаленькое.
//
// Четырнадцать нитей по двадцать четыре узла, у каждого место, ядро и
// циркуляция кольца. В кадр это класть нельзя: полторы тысячи чисел против
// полусотни, и запись раздуется в тридцать раз. Но без него воспроизведение
// стартует с пустой пеленой и расходится — не при заполнении, а дальше, потому
// что пелена растёт вдоль чуть иной траектории.
//
// Поэтому ОПОРНЫЕ КАДРЫ: снимок пелены раз в несколько секунд. В кольцевом
// буфере их живёт один-два, старые выпадают вместе с кадрами, а
// воспроизведение начинает сверку с того места, где снимок есть.
export function wakeSnapshot(boat) {
  const w = boat.rig && boat.rig.wake;
  if (!w || w.n < 2) return null;
  const N = w.fil * w.len;
  const a = new Array(5 * N + 3 * w.len);
  let k = 0;
  for (let i = 0; i < N; i++) a[k++] = r4(w.x[i]);
  for (let i = 0; i < N; i++) a[k++] = r4(w.y[i]);
  for (let i = 0; i < N; i++) a[k++] = r4(w.z[i]);
  for (let i = 0; i < N; i++) a[k++] = r4(w.gr[i]);
  // Ядро — тоже состояние: оно растёт с возрастом узла и по нему не
  // восстанавливается. Без него воспроизведение расходилось вдвое сильнее.
  for (let i = 0; i < N; i++) a[k++] = r4(w.rc[i]);
  for (let i = 0; i < w.len; i++) a[k++] = r4(w.tdx[i]);
  for (let i = 0; i < w.len; i++) a[k++] = r4(w.tdy[i]);
  for (let i = 0; i < w.len; i++) a[k++] = r4(w.tdz[i]);
  return { fil: w.fil, len: w.len, n: w.n, core: w.core, a };
}

export function wakeRestore(boat, snap) {
  const w = boat.rig && boat.rig.wake;
  if (!w || !snap || snap.fil !== w.fil || snap.len !== w.len) return false;
  const N = w.fil * w.len, a = snap.a;
  let k = 0;
  for (let i = 0; i < N; i++) w.x[i] = a[k++];
  for (let i = 0; i < N; i++) w.y[i] = a[k++];
  for (let i = 0; i < N; i++) w.z[i] = a[k++];
  for (let i = 0; i < N; i++) w.gr[i] = a[k++];
  for (let i = 0; i < N; i++) w.rc[i] = a[k++];
  for (let i = 0; i < w.len; i++) w.tdx[i] = a[k++];
  for (let i = 0; i < w.len; i++) w.tdy[i] = a[k++];
  for (let i = 0; i < w.len; i++) w.tdz[i] = a[k++];
  w.n = snap.n;
  w.spaceCore(); w.edges(); w.pack(true);
  return true;
}

// Кольцевая запись последних `seconds` секунд.
export class Recorder {
  // `keySeconds` — как часто снимается пелена. Пять секунд это размен: снимок
  // весит двенадцать килобайт, кадр — сорок байт, и на получасовой записи
  // опорные кадры дают пятую часть объёма. Чаще незачем (воспроизведение и так
  // начинает сверку не позже чем через пять секунд), реже — значит оставить
  // начало записи непроверяемым.
  constructor(seconds, hz, keySeconds = 5) {
    this.hz = hz;
    this.limit = Math.round(seconds * hz);
    this.every = Math.max(1, Math.round(keySeconds * hz));
    this.frames = [];
    this.keys = [];        // опорные кадры: {at, wake}
    this.seen = 0;         // сколько кадров прошло всего
    this.first = 0;        // номер самого старого уцелевшего
  }
  push(boat) {
    const f = traceFrame(boat);
    if (!f) return;
    if (this.seen % this.every === 0) {
      const wake = wakeSnapshot(boat);
      if (wake) this.keys.push({ at: this.seen, wake });
    }
    this.seen++;
    this.frames.push(f);
    if (this.frames.length > this.limit) { this.frames.shift(); this.first++; }
    // Опорные кадры живут ровно столько, сколько кадры, на которые они
    // ссылаются: выпал кадр — выпал и снимок. Держать их все по буферу
    // приходится потому, что заранее неизвестно, когда снимут дамп, а нужен из
    // них самый ранний уцелевший.
    while (this.keys.length > 1 && this.keys[0].at < this.first) this.keys.shift();
  }
  dump() {
    // Номера опорных кадров — от начала выданной записи.
    const keys = this.keys
      .map(k => ({ at: k.at - this.first, wake: k.wake }))
      .filter(k => k.at >= 0 && k.at < this.frames.length);
    return { hz: this.hz, fields: TRACE_FIELDS, frames: this.frames.slice(), keys };
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
  if (index.rigRate != null) boat.rigRate = g('rigRate');
  if (index.hike != null) boat.hike = g('hike');
  // Старые записи этих полей не знают — тогда посадка остаётся как есть.
  if (index.zc != null) {
    boat.zc = g('zc'); boat.w = g('w'); boat.th = g('th'); boat.q = g('q');
  }
  const lag = g('lag');
  if (lag && boat.rig.alphaLag && lag.length === boat.rig.alphaLag.length) {
    boat.rig.alphaLag.set(lag);
  }
}

// Подать в лодку органы управления и условия из кадра.
export function applyFrom(boat, frame, index) {
  for (const name of TRACE_INPUTS) {
    if (index[name] == null) continue;
    const v = frame[index[name]];
    boat.o[name] = TRACE_BOOLS.has(name) ? !!v : v;
  }
  // Старый дамп знает шкот стакселя только поправкой к гроту. Переводим его в
  // свой угол здесь, один раз, а не в каждом месте, где он спрашивается.
  if (index.jibSheet == null && index.jibTrim != null) {
    boat.o.jibSheet = boat.o.sheet + frame[index.jibTrim];
  }
  if (index.gust != null) boat.wind.o.gust = frame[index.gust];
  if (index.shift != null) boat.wind.o.shift = frame[index.shift];
}

export function fieldIndex(fields) {
  const ix = {};
  (fields || TRACE_FIELDS).forEach((name, i) => { ix[name] = i; });
  return ix;
}
