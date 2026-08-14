// Игровой интерфейс: то, чем управляют лодкой с телефона.
//
// Отладочная панель и этот интерфейс — не два оформления одного и того же, а
// два разных прибора. На панели двадцать органов и тридцать показаний, и она
// нужна, чтобы настраивать модель: подобрать твист, посмотреть баланс, сверить
// разгон. Здесь пять органов и три показания, и они нужны, чтобы вести лодку.
// Смешивать их незачем: на телефоне панель не помещается, а в отладке игровой
// интерфейс закрывает воду, по которой и смотрят.
//
// ЧТО ЧЕМ УПРАВЛЯЕТ. Органы не выдуманы под макет, а взяты у самой модели, и
// подписаны так, как их зовут на лодке:
//
//   РУМПЕЛЬ    — `o.rudderTarget`, полный борт ±35°. Взялся за него — авторулевой
//                отключается сам, ровно как со стрелками на клавиатуре: иначе он
//                молча перебивает команду, и кажется, что руль не работает;
//   ГРОТ       — `o.sheet`, от 90° (потравлен) до 7° (выбран). Показывается
//                процентом выбранности: так понятнее, чем угол в градусах;
//   СТАКСЕЛЬ   — `o.jibSheet`, свой угол от 90° до нуля;
//   ЭКИПАЖ     — `o.crewHike`, знаковое положение поперёк лодки: −1 левый борт,
//                0 диаметральная, +1 правый.
//
// «Л · Ц · П», как на макете, — и теперь это честно. Раньше здесь стояли ступени
// от диаметральной к борту, потому что экипаж в модели откренивал сам: величина
// была беззнаковая, сторону выбирал крен, и нарисовать два борта значило бы
// обещать то, чего физика не считает. Теперь считает — сажают его явно, и на
// смене галса он остаётся там, где сидел, пока его не пересадят.

// Признак «телефона» — НЕ ширина окна и не строка агента. Ширина врёт на
// разделённом экране планшета и на узком окне ноутбука; строка агента врёт
// всегда. Спрашивается то, что действительно решает: есть ли у указателя
// точность мыши и есть ли клавиатура. Грубый указатель без наведения — это
// палец, а игровой интерфейс сделан под палец.
//
// Поверх этого — `?ui=game` и `?ui=debug`. Без них игровой интерфейс нельзя ни
// посмотреть с ноутбука, ни выключить на планшете, а и то и другое нужно каждый
// раз, когда его правят.
const MOBILE_UI = (() => {
  const want = new URLSearchParams(location.search).get('ui');
  if (want === 'game') return true;
  if (want === 'debug') return false;
  return matchMedia('(pointer: coarse)').matches
    && matchMedia('(hover: none)').matches;
})();

if (MOBILE_UI) document.body.classList.add('game');

// --- органы --------------------------------------------------------------
//
// Ползунки свои, а не `<input type=range>`: у того на телефоне своя область
// касания, свои правила прокрутки и своя высота, и подчинить его макету дороже,
// чем написать перетаскивание. Здесь оно в пятнадцать строк и одинаково для
// вертикальных и горизонтальных.

// Тянуть за ползунок — это pointer events с захватом. Без захвата палец,
// съехавший с органа, теряет его, и шкот застревает на полпути.
function dragBar(el, vertical, onMove) {
  let id = null;
  const at = e => {
    const r = el.getBoundingClientRect();
    const t = vertical ? 1 - (e.clientY - r.top) / r.height
                       : (e.clientX - r.left) / r.width;
    onMove(Math.max(0, Math.min(1, t)));
  };
  el.addEventListener('pointerdown', e => {
    id = e.pointerId;
    // Захват в try: браузер отказывает, если указателя с таким номером у него
    // нет, — и необработанный отказ уронил бы весь обработчик, то есть орган
    // просто не сработал бы. Захват тут удобство, а не условие работы.
    try { el.setPointerCapture(id); } catch (err) { /* обойдёмся без захвата */ }
    at(e); e.preventDefault();
  });
  el.addEventListener('pointermove', e => { if (e.pointerId === id) at(e); });
  const up = e => {
    if (e.pointerId !== id) return;
    try { el.releasePointerCapture(id); } catch (err) { /* его и не было */ }
    id = null;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

// Шкоты: ЦЕЛЬ и ФАКТ.
//
// Ползунок задаёт не угол паруса, а то, куда шкот выбирают, — и парус подъезжает
// к этому углу за конечное время. Так оно и есть на лодке: шкот не
// телепортируется, его добирают руками через лебёдку или блок, и это занимает
// секунды. Мгновенная перекладка делала из паруса переключатель: дёрнул ползунок
// — лодка скакнула. Здесь дёрнуть можно, а лодка отзовётся тем, чем отзывается
// настоящая, — не сразу.
//
// ДОБИРАЮТ МЕДЛЕННЕЕ, ЧЕМ ТРАВЯТ, и это не украшение. Выбирать шкот значит тянуть
// против всей силы паруса; травить — отпустить, и его вырывает ветром. На гроте
// разница вдвое, на стакселе она меньше: он и меньше, и тянут его лебёдкой.
//
// Доля: ноль — потравлен до упора, единица — выбран. Углы в модели идут наоборот,
// отсюда и переворот.
const gameSheet = { main: 0, jib: 0 };     // куда тянут
const gameSheetAt = { main: 0, jib: 0 };   // где шкот сейчас
const GAME_HAUL = { main: 0.34, jib: 0.55 };   // долей в секунду, выбирать
const GAME_EASE = { main: 0.75, jib: 0.95 };   // ...и травить

function sheetSet(which, t) {
  gameSheet[which] = t;
}

// Румпель держит положение, а не отскакивает в середину. Это румпель, а не
// джойстик: рулевой кладёт его и держит, и на телефоне отпущенный палец не
// должен означать «руль прямо».
let gameTiller = 0;              // −1 … +1, плюс — нос вправо
const TILLER_MAX = 35;           // полный борт, градусов

// Примагничивание к нулю: у самой середины руль встаёт ровно прямо. Без него
// поставить прямо пальцем нельзя вовсе — попадёшь в градус-другой и будешь
// медленно уходить с курса, не понимая почему. Порог взят такой, чтобы
// «примерно прямо» и «прямо» стали одним и тем же: три градуса руля на этой
// лодке не правят ничем.
// Зона примагничивания и шаг стрелки развязаны нарочно: шаг обязан быть БОЛЬШЕ
// зоны, иначе одно нажатие целиком съедается притяжением к нулю и стрелки не
// двигают руль вовсе. Пять градусов на нажатие против двух с половиной на
// притяжение — разница вдвое, и промахнуться уже нечем.
const TILLER_SNAP = 2.5 / TILLER_MAX;
const TILLER_STEP = 5 / TILLER_MAX;

function tillerSet(v) {
  const t = Math.max(-1, Math.min(1, v));
  gameTiller = Math.abs(t) < TILLER_SNAP ? 0 : t;
  // Взялся за руль — авторулевой отключается сам, как и со стрелками.
  if (gameTiller !== 0) gameAuto(false);
}

let gameCrew = 0;                // −1 … +1, где сидит экипаж поперёк лодки

if (MOBILE_UI) {
  dragBar(document.getElementById('gmain'), true, t => sheetSet('main', t));
  dragBar(document.getElementById('gjib'), true, t => sheetSet('jib', t));
  dragBar(document.getElementById('gtill'), false, t => tillerSet(t * 2 - 1));

  // Стрелки у румпеля: подправить на градус-другой, не сдвигая всю руку.
  for (const [id, step] of [['gtl', -TILLER_STEP], ['gtr', TILLER_STEP]]) {
    const el = document.getElementById(id);
    let timer = null;
    const tick = () => tillerSet(gameTiller + step);
    el.addEventListener('pointerdown', e => {
      // Прежний повтор гасится до нового: без этого потерянный pointerup
      // оставляет таймер жить, и следующее нажатие заводит второй — руль
      // начинает уезжать сам по себе, вдвое быстрее.
      clearInterval(timer);
      tick(); timer = setInterval(tick, 110); e.preventDefault();
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'])
      el.addEventListener(ev, () => { clearInterval(timer); timer = null; });
  }

  document.getElementById('gauto').addEventListener('click', () => {
    gameAuto(!autopilot);
  });

  // Шкала румпеля. Деления через пять градусов, подписи через пятнадцать —
  // столько же, сколько на ленте курса, чтобы два прибора читались одинаково.
  // Нуль отмечен длинной чертой: к нему и примагничивает.
  {
    const t = document.querySelector('#gtill .ticks');
    t.innerHTML = '';
    for (let a = -TILLER_MAX; a <= TILLER_MAX; a += 5) {
      const i = document.createElement('i');
      if (a === 0) i.className = 'mid';
      else if (a % 15 === 0) i.className = 'lab';
      if (a % 15 === 0 && a !== 0) i.dataset.deg = Math.abs(a);
      i.style.left = ((a / TILLER_MAX * 0.5 + 0.5) * 100) + '%';
      t.appendChild(i);
    }
  }

  // Экипаж: пять ступеней от борта до борта. Ступени, а не ползунок, нарочно —
  // на воде экипаж сидит либо в кокпите, либо на борту, а не «на 37 процентах».
  //
  // Середина — диаметральная, и она же начальное положение. Крайние точки
  // крупнее прочих: попасть пальцем на борт нужно быстро и не глядя, а вот
  // «полборта» — положение редкое, ему хватит и мелкой точки.
  const row = document.getElementById('gcrewrow');
  const CREW_STEPS = [-1, -0.5, 0, 0.5, 1];
  const dots = [];
  for (let i = 0; i < CREW_STEPS.length; i++) {
    const d = document.createElement('div');
    d.className = 'dot' + (i === 0 || i === CREW_STEPS.length - 1 ? ' end' : '');
    d.innerHTML = '<span></span>';
    d.addEventListener('pointerdown', () => {
      gameCrew = CREW_STEPS[i];
      for (let k = 0; k < dots.length; k++)
        dots[k].classList.toggle('on', k === i);
    });
    row.appendChild(d);
    dots.push(d);
  }
  dots[CREW_STEPS.indexOf(0)].classList.add('on');

  // Начальное положение органов берётся у лодки, а не назначается: старт уже
  // выставил шкоты под галфвинд, и ползунки обязаны показывать их, а не ноль.
  // Стакселю в физике позволено быть null — «как у грота», — и до первого шага
  // он таким и лежит. Пустое значение здесь дало бы NaN на подписи и намертво,
  // потому что дальше оно только перемножается.
  gameSheet.main = (90 - boat.o.sheet / D) / (90 - 7);
  const jib = boat.o.jibSheet != null ? boat.o.jibSheet : boat.o.sheet;
  gameSheet.jib = 1 - (jib / D) / 90;
  // Факт начинается там же, где цель: старт уже выставил шкоты, и подъезжать к
  // ним с нуля означало бы на первых секундах идти не тем, чем показано.
  gameSheetAt.main = gameSheet.main;
  gameSheetAt.jib = gameSheet.jib;
}

// Авторулевой живёт в controls.js; трогаем его тем же способом, что и клавиша.
function gameAuto(on) {
  if (on === autopilot) return;
  autopilot = on;
  apHeading = boat.psi;
}

// Команды в модель. Зовётся из readControls, ПОСЛЕ клавиатуры: на телефоне
// клавиатуры нет, а на настольной машине с `?ui=game` последнее слово должно
// оставаться за тем органом, которого коснулись.
// Время кадра приходит из readControls: там оно уже посчитано и там же идёт шаг
// физики, а заводить свои часы значило бы разойтись с ней при перемотке и паузе.
let gameDt = 0;

function gameApply(o, dt) {
  if (!MOBILE_UI) return;
  gameDt = dt;
  if (!autopilot) o.rudderTarget = gameTiller * TILLER_MAX * D;
  o.crewHike = gameCrew;
  // Шкоты ставятся ЗДЕСЬ, а не в мгновение касания, и вместе с ползунками
  // отладочной панели. Иначе их затирает она: панель скрыта, но жива, и
  // readControls каждый кадр перечитывает шкоты с её ползунков — ровно так же,
  // как делает это для клавиш. Два источника на одно число мирятся только тем,
  // что последний пишет в оба.
  // Шкот подъезжает к цели, а не прыгает в неё. Шаг берётся по времени кадра:
  // на просевшей частоте шкот обязан выбираться те же секунды, а не то же число
  // кадров.
  for (const k of ['main', 'jib']) {
    const d = gameSheet[k] - gameSheetAt[k];
    const rate = (d > 0 ? GAME_HAUL[k] : GAME_EASE[k]) * gameDt;
    gameSheetAt[k] += Math.abs(d) <= rate ? d : Math.sign(d) * rate;
  }
  o.sheet = (90 - gameSheetAt.main * (90 - 7)) * D;
  o.jibSheet = (1 - gameSheetAt.jib) * 90 * D;
  if (ui.mainsheet) {
    ui.mainsheet.value = (o.sheet / D).toFixed(0);
    ui.jibsheet.value = (o.jibSheet / D).toFixed(0);
    // Экипаж — туда же и по той же причине: переключились на отладочную панель
    // (`?ui=debug`), и её ползунок обязан показывать, где экипаж сидит сейчас,
    // а не пересаживать его обратно тем значением, на котором стоял.
    ui.hike.value = o.crewHike;
  }
}

// --- показания -----------------------------------------------------------

const gameEl = MOBILE_UI ? {
  head: document.getElementById('ghead'),
  speed: document.getElementById('gspeed').querySelector('b'),
  wind: document.getElementById('gwind').querySelector('b'),
  jibv: document.getElementById('gjibv'),
  mainv: document.getElementById('gmainv'),
  auto: document.getElementById('gauto'),
  till: document.getElementById('gtillv'),
  comp: document.getElementById('gcompc'),
} : null;

// Лента курса рисуется на канве, а не набором делений в разметке. Причина одна
// и решающая: курс заворачивается через ноль, и лента из узлов DOM либо
// обрывается на севере, либо требует трёх копий шкалы и склейки. На канве это
// цикл по градусам вокруг текущего курса, и заворот получается сам собой.
// Сколько экранных точек приходится на градус. Это и есть мера ленты: не «сколько
// градусов видно» — тогда на широком экране деления расползались бы, а на узком
// слипались, — а плотность, одинаковая на любом экране. Размах уже получается из
// неё и ширины, и только зажимается по краям, чтобы на планшете лента не стала
// картой полушарий, а на узком телефоне — увеличительным стеклом.
const GAME_PX_DEG = 4.2;
const GAME_SPAN_MIN = 26, GAME_SPAN_MAX = 80;
const GAME_RHUMB = ['N', '', '', 'E', '', '', 'S', '', '', 'W', '', ''];

// Канва под ленту курса. Её размер задан не разметкой, а экраном: у канвы два
// размера — сколько её видно и из скольких точек она состоит, — и если второй
// оставить постоянным, картинка растянется. Первый заход так и сделал: канва в
// 720 точек шириной на любом экране, а на широком её тянуло вдвое, и деления
// расплывались.
let gameCompW = 0, gameCompH = 0;

function gameCompSize() {
  const c = gameEl.comp;
  const dpr = Math.min(3, devicePixelRatio || 1);
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (w === gameCompW && h === gameCompH) return;
  gameCompW = c.width = w;
  gameCompH = c.height = h;
}

function gameCompass(deg) {
  gameCompSize();
  const c = gameEl.comp, g = c.getContext('2d');
  const w = c.width, h = c.height;
  const dpr = Math.min(3, devicePixelRatio || 1);
  g.clearRect(0, 0, w, h);
  // Подложки под лентой нет — она закрывала небо. Читаемость держит тень, та же
  // по смыслу, что у текста в разметке.
  g.shadowColor = 'rgba(0, 8, 18, .85)';
  g.shadowBlur = 6 * dpr;
  g.shadowOffsetY = dpr;

  const span = Math.max(GAME_SPAN_MIN,
    Math.min(GAME_SPAN_MAX, w / dpr / (2 * GAME_PX_DEG)));
  const px = w / (2 * span);             // точек канвы на градус
  g.textAlign = 'center';
  g.font = '700 ' + (13 * dpr).toFixed(0) + 'px ui-sans-serif, -apple-system, sans-serif';
  // Подписи через пятнадцать градусов, но на узком экране они сходятся вплотную
  // — тогда через тридцать. Считается по месту, а не по ширине окна: место
  // занимает надпись, а не окно.
  const step = 15 * px < 38 * dpr ? 30 : 15;
  const from = Math.ceil(deg - span), to = Math.floor(deg + span);
  for (let a = from; a <= to; a++) {
    if (a % 5) continue;
    const x = w / 2 + (a - deg) * px;
    const big = a % step === 0;
    g.strokeStyle = big ? 'rgba(235,242,251,.85)' : 'rgba(235,242,251,.35)';
    g.lineWidth = (big ? 2 : 1) * dpr;
    g.beginPath();
    g.moveTo(x, h - (big ? 14 : 9) * dpr);
    g.lineTo(x, h - 3 * dpr);
    g.stroke();
    if (!big) continue;
    const n = ((a % 360) + 360) % 360;
    const name = n % 90 === 0 ? GAME_RHUMB[n / 30] : null;
    g.fillStyle = name ? '#ffcf5a' : 'rgba(235,242,251,.8)';
    // Базовая линия подписей выше делений и ниже указателя: у ленты всего сорок
    // точек высоты, и три яруса в них помещаются только по счёту, а не на глаз.
    g.fillText(name || String(n).padStart(3, '0'), x, h - 18 * dpr);
  }
  // Указатель курса — треугольник посередине. Он и есть нос.
  g.fillStyle = '#ffcf5a';
  g.beginPath();
  g.moveTo(w / 2, 9 * dpr);
  g.lineTo(w / 2 - 6 * dpr, 0);
  g.lineTo(w / 2 + 6 * dpr, 0);
  g.closePath(); g.fill();
}

function gameHud(t) {
  if (!MOBILE_UI) return;
  // Курс в компасных румбах: физика меряет угол от востока против часовой,
  // компас — от севера по часовой. Перевод здесь, а не в физике: это свойство
  // прибора, а не лодки.
  const deg = ((90 - boat.psi / D) % 360 + 360) % 360;
  gameEl.head.textContent = deg.toFixed(0).padStart(3, '0') + '°';
  gameCompass(deg);
  gameEl.speed.textContent = (t.speedKn || 0).toFixed(1);
  // Ветер — истинный у лодки, тот же, что показывает отладочная панель.
  gameEl.wind.textContent = (t.twsKn || 0).toFixed(0);
  // Цифра показывает ЦЕЛЬ, заливка — ФАКТ. Пока шкот идёт, видно оба: ручка
  // стоит там, куда тянут, а заливка догоняет. Совпали — шкот выбран.
  gameEl.jibv.textContent = (gameSheet.jib * 100).toFixed(0) + '%';
  gameEl.mainv.textContent = (gameSheet.main * 100).toFixed(0) + '%';
  gameEl.till.textContent = gameTiller === 0 ? '0°'
    : (Math.abs(gameTiller) * TILLER_MAX).toFixed(0) + '°'
      + (gameTiller > 0 ? ' пр' : ' лв');
  gameEl.auto.classList.toggle('on', autopilot);
  // Ползунки двигаются и сами: авторулевой руля, старт — шкотов.
  gameBar(document.getElementById('gmain'), gameSheet.main, true, gameSheetAt.main);
  gameBar(document.getElementById('gjib'), gameSheet.jib, true, gameSheetAt.jib);
  gameBar(document.getElementById('gtill'),
          autopilot ? boat.o.rudder / (35 * D) * 0.5 + 0.5
                    : gameTiller * 0.5 + 0.5, false);
}

function gameBar(el, t, vertical, at) {
  const knob = el.querySelector('.knob');
  const fill = el.querySelector('.fill');
  const r = el.getBoundingClientRect();
  if (vertical) {
    const k = knob.offsetHeight || 26;
    knob.style.top = ((1 - t) * (r.height - k)) + 'px';
    if (fill) fill.style.height = Math.max(0, (at != null ? at : t) * (r.height - 4)) + 'px';
  } else {
    knob.style.left = (t * r.width) + 'px';
  }
}

export { MOBILE_UI, gameApply, gameHud };
