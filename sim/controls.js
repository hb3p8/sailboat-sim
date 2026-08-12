// Ручные команды и авторулевой.
//
// Отделено от `main.js` по границе «что человек делает с лодкой». Здесь клавиши,
// их разбор, положение органов управления и регулятор, который держит курс, —
// и больше ничего: ни сцены, ни приборов, ни физики.
//
// Файл вклеивается ПОСЛЕ main.js и debug.js и живёт с ними в общей области
// видимости. Порядок нужен потому, что обработчики вешаются на события сразу
// при вклейке и зовут то, что объявлено там: смену камеры, отладочные виды,
// дамп. Обратно main.js зовёт отсюда только `readControls` — объявленную
// функцию, а такие видны из любой точки общей области.

let autopilot = true;
let apHeading = boat.psi;

const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code))
    e.preventDefault();
  // Сброс переехал на X: R с F теперь стаксель-шкот.
  if (e.code === 'KeyX') {
    startAt();
    apHeading = boat.psi;
    wake.clear();
    trackN = 0;
  }
  if (e.code === 'KeyH') { autopilot = !autopilot; apHeading = boat.psi; }
  if (e.code === 'KeyC') cycleCam();
  if (e.code === 'KeyG') setDebug(debugMode + 1);
  // Подсказки прячутся по умолчанию: карточка длинная и закрывала собой
  // ползунки условий, а нужна она один раз — прочитать и убрать.
  if (e.key === '?' || e.key === '/') {
    const n = document.getElementById('note');
    n.hidden = !n.hidden;
    document.body.classList.toggle('hints', !n.hidden);
  }
  // Не D: она занята рулём вместе со стрелкой вправо (WASD), и дамп
  // сохранялся на каждое нажатие при повороте. P далеко от обеих рук.
  if (e.code === 'KeyP') saveDump();
});
addEventListener('keyup', e => { keys[e.code] = false; });

// wrapPi берём из physics.js: оба файла вклеиваются в один блок, и второе
// объявление того же имени — синтаксическая ошибка на весь модуль.

function readControls(dt) {
  const o = boat.o;
  let target = 0;
  // Стрелка задаёт направление поворота НОСА, а не движение румпеля:
  // вправо — положительная команда, влево — отрицательная.
  const left = keys.ArrowLeft || keys.KeyA;
  const right = keys.ArrowRight || keys.KeyD;
  // Взялся за руль — авторулевой отключается сам. Иначе он молча перебивает
  // стрелки, и создаётся полное впечатление, что управление не работает.
  if (left || right) autopilot = false;
  if (left) target = -35 * D;
  if (right) target = 35 * D;
  if (autopilot) {
    const err = wrapPi(apHeading - boat.psi);
    target = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * boat.r)));
  }
  // Скорость перекладки ограничивает сама лодка (physics.js): это её
  // свойство, а не интерфейса.
  o.rudderTarget = (!target && !autopilot) ? 0 : target;

  // Шкоты: клавиши и ползунки — одно и то же, и ползунок всегда показывает
  // настоящее положение. Клавиши двигают величину, а ползунок за ней следует;
  // потянули ползунок — величина берётся с него. Кто последний тронул, тот и
  // прав, и никакой борьбы двух источников за одно число не выходит.
  const sr = 32 * D;
  let byKey = false;
  if (keys.ArrowUp || keys.KeyW) { o.sheet -= sr * dt; byKey = true; }
  if (keys.ArrowDown || keys.KeyS) { o.sheet += sr * dt; byKey = true; }
  // Стаксель-шкот в физике живёт поправкой к общему, а на панели — своим
  // углом: два независимых органа понятнее, чем «общий и добавка к нему».
  // Перевод одной строкой, и он же держит связь: потравил грот — стаксель
  // остался там, где стоял.
  if (keys.KeyR) { o.jibSheet -= sr * dt; byKey = true; }
  if (keys.KeyF) { o.jibSheet += sr * dt; byKey = true; }
  if (!byKey && ui.mainsheet) {
    o.sheet = parseFloat(ui.mainsheet.value) * D;
    o.jibSheet = parseFloat(ui.jibsheet.value) * D;
  }
  // Ближе семи градусов шкот не выбирается: мешают ванты и погон. У стакселя
  // свой упор острее диаметральной ставит каретка на погоне (physics.js), и
  // здесь его держать не нужно.
  o.sheet = Math.max(7 * D, Math.min(90 * D, o.sheet));
  o.jibSheet = Math.max(0, Math.min(90 * D, o.jibSheet));
  if (ui.mainsheet) {
    ui.mainsheet.value = (o.sheet / D).toFixed(0);
    ui.jibsheet.value = (o.jibSheet / D).toFixed(0);
    // Подпись ползунка обновляется его же событием `input`, а клавиши такого
    // события не порождают. Поэтому при работе клавишами показ двигаем руками —
    // иначе ползунок едет, а число рядом с ним стоит.
    if (byKey) for (const el of [ui.mainsheet, ui.jibsheet])
      el.dispatchEvent(new Event('input'));
    o.mainUp = ui.mainup.checked;
    o.jibUp = ui.jibup.checked;
    // Переключатель физики паруса живёт не в состоянии лодки, а рядом с
    // моделью: он про то, ЧЕМ считать, а не про то, как лодку ведут. Оттого его
    // нет и в записи прогона.
    if (ui.oldsail.checked !== sailPhysicsIsOld()) setSailPhysics(ui.oldsail.checked);
  }

  o.windSpeed = parseFloat(ui.wind.value);
  const wd = parseFloat(ui.winddir.value) * D;
  if (autopilot) apHeading += wd - o.windDir;   // ветер повернули — держим TWA
  o.windDir = wd;
  o.crewHike = parseFloat(ui.hike.value);
  // Игровой интерфейс говорит последним: на телефоне клавиатуры нет, а на
  // настольной машине с `?ui=game` слово должно оставаться за тем органом,
  // которого коснулись. Без телефона это пустой вызов — см. sim/mobile.js.
  gameApply(o);
  // Экипаж на борту всегда, ползунок задаёт не его наличие, а только предел
  // откренивания. Раньше ноль на ползунке означал «экипажа нет» — и вместе с
  // моментом пропадала его парусность, а на картинке пропадали фигурки. На
  // лодке так не бывает: люди никуда не деваются, просто сидят в кокпите, и
  // подставлять ветру продолжают. Масса считается по числу фигурок и весу
  // одного из пакета — чтобы то, что видно, и то, что считается, было одним
  // и тем же экипажем.
  o.crewMass = CREW_X.length * PACK.rig.windage.crew.mass_each_kg;
  // Где экипаж сидит, физике сообщает картинка, а не наоборот: станции и линия
  // борта уже посчитаны здесь, по ним же стоят фигурки. Так вес приложен ровно
  // туда, где его видно, и разъехаться этим двум нельзя.
  o.crewX = CREW_MID;
  o.crewZ = CREW_SEAT;
  o.sailScale = parseFloat(ui.sailscale.value);
  o.twist = parseFloat(ui.twist.value) * D;
  o.draft = parseFloat(ui.draft.value) / 100;
  o.jibTwist = parseFloat(ui.jibtwist.value) * D;
  o.jibDraft = parseFloat(ui.jibdraft.value) / 100;
  // Разгон: с акваторией его задаёт место, а ползунок становится
  // переопределением. Без акватории галочка не нужна и не показывается — там
  // ползунок и есть единственный источник.
  //
  // Верх ползунка — тридцать километров, и это уже не река: полтора метра
  // волны при шестнадцати метрах в секунду. Стоит он там не потому, что столько
  // бывает, а потому что дальше волна выпадает из каскадов: на ста километрах
  // длина в пике выходит восемьдесят три метра при самой крупной плитке в
  // шестьдесят четыре (ocean.js), и такую волну спектр просто не понесёт.
  // Граница закреплена в tests/ocean.test.mjs — тест перебирает весь размах
  // ползунков и требует, чтобы вся волна помещалась в полосы.
  o.fetch = parseFloat(ui.fetch.value) * 1000;
  o.fetchOverride = !terrain.ready || ui.fetchover.checked;
  ui.fetch.disabled = terrain.ready && !ui.fetchover.checked;
  // Когда разгон задаёт место, подпись показывает его настоящую величину, а не
  // положение отключённого ползунка. Это и есть смысл акватории на панели: на
  // одном галсе полкилометра, на другом три с половиной.
  if (terrain.ready && !ui.fetchover.checked && capFetch) {
    const t = boat.telemetry;
    capFetch.textContent = t && t.fetchField
      ? (t.fetchM / 1000).toFixed(1) + ' км по месту'
      : 'вне участка';
  }
  // Волна: приборы и два органа вида. Высота и длина — из того же состояния
  // моря, по которому идёт добавочное сопротивление, поэтому это не пересчёт, а
  // показ. «Под лодкой» читается с пробы — это уже не оценка волнения вообще, а
  // то, на чём лодка стоит сию секунду, и по нему видно, что качка не
  // подрисована: цифра ходит вместе с корпусом.
  ocean.uChop.value = parseFloat(ui.chop.value);
  seaSsr.value = parseFloat(ui.ssr.value);
  if (capSeaHs) {
    const hs = boat.seaHs || 0;
    const lp = 1.56 * seaState(o.windSpeed, boat.fetchM || 0).tp ** 2;
    capSeaHs.textContent = hs > 0.005 ? (100 * hs).toFixed(0) + ' см' : 'гладко';
    capSeaLp.textContent = hs > 0.005 ? lp.toFixed(1) + ' м' : '—';
    // Показывается не проба, а ПЛОСКОСТЬ — ровно то, что получает плавучесть.
    // Прибор обязан показывать вход модели, а не сырьё для него: разойдись они
    // когда-нибудь, по такому прибору этого не увидеть.
    const z = seaPlane.z;
    const slope = Math.hypot(seaPlane.se, seaPlane.sn);
    capSeaNow.textContent = (z >= 0 ? '+' : '−') + Math.abs(100 * z).toFixed(0) +
      ' см · склон ' + (Math.atan(slope) / D).toFixed(1) + '°';
  }
  // Порывистость одним ползунком: сильнее дует — сильнее и заходит. Порознь
  // эти две вещи на воде не встречаются, а два ползунка вместо одного только
  // мешают понять, что происходит.
  const gust = parseFloat(ui.gust.value);
  boat.wind.o.gust = gust;
  boat.wind.o.shift = gust * 45 * D;

  if (terrain.ready) {
    o.current = parseFloat(ui.cur.value);
    o.shadeD0 = parseFloat(ui.shd0.value);
    o.shadeK = parseFloat(ui.shk.value);
    o.shadeGust = parseFloat(ui.shg.value);
    o.chan = parseFloat(ui.chan.value);
    // Подпись — рабочий прибор подбора, а не украшение: подбирать тень на глаз
    // по картинке можно только зная, какое число этой картинке отвечает.
    const t = boat.telemetry;
    if (t && capShade) {
      capShade.textContent = 'ветер ×' + t.windK.toFixed(2) +
        (t.gustK > 1.01 ? ', рвано ×' + t.gustK.toFixed(1) : '') +
        (Math.abs(t.chanDeg) > 0.5 ?
          ', вдоль долины ' + (t.chanDeg > 0 ? '+' : '') + t.chanDeg.toFixed(0) + '°' : '');
    }
  }
}
