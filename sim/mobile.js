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
    id = e.pointerId; el.setPointerCapture(id); at(e); e.preventDefault();
  });
  el.addEventListener('pointermove', e => { if (e.pointerId === id) at(e); });
  const up = e => {
    if (e.pointerId !== id) return;
    el.releasePointerCapture(id); id = null;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

// Доля выбранности шкота: ноль — потравлен до упора, единица — выбран.
// Углы в модели идут наоборот, отсюда и переворот.
const gameSheet = { main: 0, jib: 0 };

function sheetSet(which, t) {
  gameSheet[which] = t;
}

// Румпель держит положение, а не отскакивает в середину. Это румпель, а не
// джойстик: рулевой кладёт его и держит, и на телефоне отпущенный палец не
// должен означать «руль прямо».
let gameTiller = 0;              // −1 … +1, плюс — нос вправо

function tillerSet(v) {
  gameTiller = Math.max(-1, Math.min(1, v));
  // Взялся за руль — авторулевой отключается сам, как и со стрелками.
  if (Math.abs(gameTiller) > 0.02) gameAuto(false);
}

let gameCrew = 0;                // −1 … +1, где сидит экипаж поперёк лодки

if (MOBILE_UI) {
  dragBar(document.getElementById('gmain'), true, t => sheetSet('main', t));
  dragBar(document.getElementById('gjib'), true, t => sheetSet('jib', t));
  dragBar(document.getElementById('gtill'), false, t => tillerSet(t * 2 - 1));

  // Стрелки у румпеля: подправить на градус-другой, не сдвигая всю руку.
  for (const [id, step] of [['gtl', -0.08], ['gtr', 0.08]]) {
    const el = document.getElementById(id);
    let timer = null;
    const tick = () => tillerSet(gameTiller + step);
    el.addEventListener('pointerdown', e => {
      tick(); timer = setInterval(tick, 110); e.preventDefault();
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'])
      el.addEventListener(ev, () => { clearInterval(timer); timer = null; });
  }

  document.getElementById('gauto').addEventListener('click', () => {
    gameAuto(!autopilot);
  });

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
function gameApply(o) {
  if (!MOBILE_UI) return;
  if (!autopilot) o.rudderTarget = gameTiller * 35 * D;
  o.crewHike = gameCrew;
  // Шкоты ставятся ЗДЕСЬ, а не в мгновение касания, и вместе с ползунками
  // отладочной панели. Иначе их затирает она: панель скрыта, но жива, и
  // readControls каждый кадр перечитывает шкоты с её ползунков — ровно так же,
  // как делает это для клавиш. Два источника на одно число мирятся только тем,
  // что последний пишет в оба.
  o.sheet = (90 - gameSheet.main * (90 - 7)) * D;
  o.jibSheet = (1 - gameSheet.jib) * 90 * D;
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
  comp: document.getElementById('gcompc'),
} : null;

// Лента курса рисуется на канве, а не набором делений в разметке. Причина одна
// и решающая: курс заворачивается через ноль, и лента из узлов DOM либо
// обрывается на севере, либо требует трёх копий шкалы и склейки. На канве это
// цикл по градусам вокруг текущего курса, и заворот получается сам собой.
const GAME_SPAN = 45;            // сколько градусов видно в ленте по обе стороны
const GAME_RHUMB = ['N', '', '', 'E', '', '', 'S', '', '', 'W', '', ''];

function gameCompass(deg) {
  const c = gameEl.comp, g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  // Подложки под лентой нет — она закрывала небо. Читаемость держит тень, та же
  // по смыслу, что у текста в разметке.
  g.shadowColor = 'rgba(0, 8, 18, .85)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 1;
  const px = w / (2 * GAME_SPAN);          // пикселей на градус
  g.textAlign = 'center';
  g.font = '700 17px ui-sans-serif, -apple-system, sans-serif';
  const from = Math.ceil(deg - GAME_SPAN), to = Math.floor(deg + GAME_SPAN);
  for (let a = from; a <= to; a++) {
    if (a % 5) continue;
    const x = w / 2 + (a - deg) * px;
    const big = a % 15 === 0;
    g.strokeStyle = big ? 'rgba(235,242,251,.85)' : 'rgba(235,242,251,.35)';
    g.lineWidth = big ? 2 : 1;
    g.beginPath();
    g.moveTo(x, h - (big ? 18 : 11));
    g.lineTo(x, h - 4);
    g.stroke();
    if (!big) continue;
    const n = ((a % 360) + 360) % 360;
    const name = GAME_RHUMB[n / 30] || null;
    g.fillStyle = name ? '#ffcf5a' : 'rgba(235,242,251,.8)';
    g.fillText(name && n % 30 === 0 ? name
               : String(n).padStart(3, '0'), x, h - 22);
  }
  // Указатель курса — треугольник посередине. Он и есть нос.
  g.fillStyle = '#ffcf5a';
  g.beginPath();
  g.moveTo(w / 2, 11); g.lineTo(w / 2 - 7, 0); g.lineTo(w / 2 + 7, 0);
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
  gameEl.jibv.textContent = (gameSheet.jib * 100).toFixed(0) + '%';
  gameEl.mainv.textContent = (gameSheet.main * 100).toFixed(0) + '%';
  gameEl.auto.classList.toggle('on', autopilot);
  // Ползунки двигаются и сами: авторулевой руля, старт — шкотов.
  gameBar(document.getElementById('gmain'), gameSheet.main, true);
  gameBar(document.getElementById('gjib'), gameSheet.jib, true);
  gameBar(document.getElementById('gtill'),
          autopilot ? boat.o.rudder / (35 * D) * 0.5 + 0.5
                    : gameTiller * 0.5 + 0.5, false);
}

function gameBar(el, t, vertical) {
  const knob = el.querySelector('.knob');
  const fill = el.querySelector('.fill');
  const r = el.getBoundingClientRect();
  if (vertical) {
    const k = knob.offsetHeight || 40;
    knob.style.top = ((1 - t) * (r.height - k)) + 'px';
    if (fill) fill.style.height = Math.max(0, t * (r.height - 6)) + 'px';
  } else {
    knob.style.left = (t * r.width) + 'px';
  }
}

export { MOBILE_UI, gameApply, gameHud };
