// Отладочные виды: то, что показывают не рулевому, а тому, кто правит модель.
//
// Вынесено из `main.js` целиком: полтысячи строк, которые работают только по
// клавише G и в обычном ходу не участвуют вовсе. Здесь центры сил, линии тока,
// поле ветра стрелками, хорды полосок, пробы воды, вид сверху на струи,
// ортогональные виды и карточки с числами.
//
// Файл вклеивается ПОСЛЕ main.js и живёт в общей с ним области видимости — как
// и сам main.js живёт в общей области с three и физикой. Порядок здесь не
// прихоть: всё, что ниже, строит объекты вокруг `scene`, `boat` и `renderer`, а
// они создаются в main.js. Обратная сторона того же порядка: main.js зовёт
// отсюда только ОБЪЯВЛЕННЫЕ ФУНКЦИИИ (они всплывают на верх общей области и
// потому видны раньше), но не константы — те лежат по месту и до вклейки этого
// файла не существуют. По этой причине начальное `setDebug(0)` стоит в конце
// этого файла, а не в конце main.js, где стояло раньше.

// --- баланс: центры и приложенные к ним силы -----------------------------------
//
// Вид с картинки из учебника: центр парусности, центр бокового сопротивления,
// центр тяжести и центр величины, и в каждом — сила, которая там приложена.
//
// Смысл его не в красоте, а в том, что ни одной из этих точек в расчёте нет.
// Моменты собираются по полоскам паруса и по полоскам корпуса, у каждой своё
// плечо; общий центр не нужен и не назначается. Здесь он восстановлен обратно
// из силы и момента — и потому это ещё и проверка: если точка уехала в нос
// сильнее, чем можно объяснить твистом и заполаскиванием, значит разъехалось
// что-то в сборке моментов.
//
// Стрелки в масштабе, кроме веса и плавучести: пятьсот восемьдесят килограммов
// в том же масштабе давали бы стрелку в тридцать метров, а сказать им нечего —
// они всегда равны друг другу. Всё содержание в их РАСХОЖДЕНИИ, то есть в
// плече GZ, и оно нарисовано как есть.

const BAL_NM = 400;                  // ньютонов на метр стрелки
const BAL_PAIR = 1.1;                // длина стрелок веса и плавучести, м
const balGroup = new Group();
boatGroup.add(balGroup);
balGroup.visible = false;

// Стрелка из цилиндра с конусом, а не линия: линия в WebGL толщиной в пиксель,
// и на воде под острым углом её не видно вовсе.
function balArrow(colour, r) {
  const mat = new MeshBasicMaterial({ color: colour, depthTest: false,
                                      transparent: true, opacity: 0.95 });
  const shaft = new Mesh(new CylinderGeometry(r, r, 1, 8), mat);
  const head = new Mesh(new ConeGeometry(r * 2.6, r * 7, 12), mat);
  const g = new Group();
  g.add(shaft, head);
  g.renderOrder = 6;
  balGroup.add(g);
  return { g: g, shaft: shaft, head: head, r: r };
}

const BAL_UP = new Vector3(0, 1, 0);
const balDir = new Vector3(), balAt = new Vector3();

// Поставить стрелку: начало, направление и длина — всё в осях модели.
function balSet(a, x, y, z, dx, dy, dz, len) {
  const m = Math.hypot(dx, dy, dz);
  const hide = !(m > 1e-6) || !(len > 0.05);
  a.g.visible = !hide;
  if (hide) return;
  a.g.position.set(x, y, z);
  balDir.set(dx / m, dy / m, dz / m);
  a.g.quaternion.setFromUnitVectors(BAL_UP, balDir);
  const hl = Math.min(a.r * 7, len * 0.4);
  a.shaft.scale.y = len - hl;
  a.shaft.position.y = (len - hl) / 2;
  a.head.position.y = len - hl / 2;
}

function balMark(colour) {
  const m = new Mesh(new SphereGeometry(0.075, 12, 8),
                     new MeshBasicMaterial({ color: colour, depthTest: false }));
  m.renderOrder = 7;
  balGroup.add(m);
  return m;
}

// Цвета взяты по смыслу и повторены в подписи карточки: красное — воздух,
// синее — вода, белое — вес, оранжевое — плавучесть.
const BAL_C = { aero: 0xe8443a, drive: 0x2fb26a, side: 0xff8fa0,
                hydro: 0x2f4f9e, hside: 0x8f9fd8, drag: 0xd8dee6,
                cg: 0xffffff, buoy: 0xf0a03c, crew: 0xf4d35e };
const balCe = balMark(BAL_C.aero), balClr = balMark(BAL_C.hydro);
const balCg = balMark(BAL_C.cg), balB = balMark(BAL_C.buoy);
const balCrewM = balMark(BAL_C.crew);
const balAero = balArrow(BAL_C.aero, 0.05), balDrive = balArrow(BAL_C.drive, 0.03);
const balSide = balArrow(BAL_C.side, 0.03), balHydro = balArrow(BAL_C.hydro, 0.05);
const balHside = balArrow(BAL_C.hside, 0.03), balDrag = balArrow(BAL_C.drag, 0.03);
const balW = balArrow(BAL_C.cg, 0.035), balO = balArrow(BAL_C.buoy, 0.035);
const balCrew = balArrow(BAL_C.crew, 0.035);
const balTab = document.getElementById('baltab');
const balNote = document.getElementById('balnote');

function updateBalance() {
  const t = boat.telemetry, b = t && t.balance;
  if (!b) return;
  const k = 1 / BAL_NM;
  // Точки: из осей лодки в оси модели, теми же переводами, что и всё остальное.
  const put = (mk, x, y, z) => mk.position.set(
    bodyPointLocalX(x), bodyPointLocalY(z), bodyPointLocalZ(y));
  put(balCe, b.ceX, b.ceY, b.ceZ);
  put(balClr, b.clrX, 0, b.clrZ);
  put(balCg, b.cgX, 0, b.cgZ);
  put(balB, b.bX, b.bY, b.bZ);

  // Аэродинамика в ЦП: равнодействующая и её составляющие — тяга вдоль лодки и
  // кренящая поперёк. Вертикальная составляющая есть, но она мала и картинку
  // только засоряет.
  const cx = bodyPointLocalX(b.ceX), cy = bodyPointLocalY(b.ceZ),
        cz = bodyPointLocalZ(b.ceY);
  const ax = bodyDirLocalX(b.driveN), ay = bodyDirLocalY(0),
        az = bodyDirLocalZ(b.sideN);
  balSet(balAero, cx, cy, cz, ax, ay, az, Math.hypot(b.driveN, b.sideN) * k);
  balSet(balDrive, cx, cy, cz, bodyDirLocalX(1), 0, 0, Math.abs(b.driveN) * k);
  balDrive.g.visible = balDrive.g.visible && b.driveN > 0;
  balSet(balSide, cx, cy, cz, 0, 0, bodyDirLocalZ(b.sideN),
         Math.abs(b.sideN) * k);

  // Гидродинамика в ЦБС: то же самое, только сопротивление направлено назад.
  // На фордевинде боковой силы почти нет, и точки приложения у неё не остаётся
  // — тогда не показывается ничего. Нарисовать её всё равно, подогнав к борту,
  // значило бы придумать место, которого нет.
  const hx = bodyPointLocalX(b.clrX), hy = bodyPointLocalY(b.clrZ), hz = 0;
  balClr.visible = b.clrOk;
  balHydro.g.visible = balHside.g.visible = balDrag.g.visible = false;
  if (b.clrOk) {
    balSet(balHydro, hx, hy, hz, bodyDirLocalX(b.dragN), 0,
           bodyDirLocalZ(b.hydroSideN), Math.hypot(b.dragN, b.hydroSideN) * k);
    balSet(balHside, hx, hy, hz, 0, 0, bodyDirLocalZ(b.hydroSideN),
           Math.abs(b.hydroSideN) * k);
    balSet(balDrag, hx, hy, hz, bodyDirLocalX(b.dragN), 0, 0,
           Math.abs(b.dragN) * k);
  }

  // Вес и плавучесть — по МИРОВОЙ вертикали, а не по палубе: в этом вся суть
  // пары. Верх мира в осях лодки при крене phi есть (0, sin phi, cos phi).
  const sp = Math.sin(boat.phi), cp = Math.cos(boat.phi);
  const ux = 0, uy = bodyDirLocalY(cp), uz = bodyDirLocalZ(sp);
  balSet(balW, bodyPointLocalX(b.cgX), bodyPointLocalY(b.cgZ), 0,
         -ux, -uy, -uz, BAL_PAIR);
  balSet(balO, bodyPointLocalX(b.bX), bodyPointLocalY(b.bZ),
         bodyPointLocalZ(b.bY), ux, uy, uz, BAL_PAIR);

  // Экипаж. Стрелка вниз там, где сидят фигурки: его вес и садит лодку, и
  // создаёт момент откренивания — одно и то же приложенное в одном месте.
  const arm = crewArm(), sh = CREW_SHEER[1];
  const crewX = bodyPointLocalX(CREW_X[1]), crewY = bodyPointLocalY(sh[1]),
        crewZ = bodyPointLocalZ(-arm);
  balCrewM.visible = b.weightCrewN > 0;
  balCrew.g.visible = balCrewM.visible;
  if (balCrewM.visible) {
    balCrewM.position.set(crewX, crewY, crewZ);
    balSet(balCrew, crewX, crewY, crewZ, -ux, -uy, -uz, BAL_PAIR);
  }
}

// Карточка обновляется втрое реже сцены: это цифры, а не движение.
function updateBalCard() {
  const t = boat.telemetry, b = t && t.balance;
  if (!b) return;
  const sw = c => '<i style="background:#' + c.toString(16).padStart(6, '0') + '"></i>';
  const row = (c, name, geom, force) =>
    '<tr><td class="n">' + sw(c) + name + '</td><td>' + geom +
    '</td><td class="v">' + force + '</td></tr>';
  const m1 = v => v.toFixed(2) + ' м';
  const n0 = v => Math.round(v) + ' Н';
  // Плечо ЦП—ЦБС: положительное, когда парус впереди, — это и есть приводящий.
  const lever = b.ceX - b.clrX;
  const leverTxt = !b.clrOk ? 'плечо ЦП−ЦБС не считается'
    : 'плечо ЦП−ЦБС <b>' + lever.toFixed(2) + ' м</b> ' +
      (lever > 0.01 ? 'вперёд, приводит' : lever < -0.01 ? 'назад, уваливает'
                                         : '— нейтрально');
  balTab.innerHTML =
    row(BAL_C.aero, 'ЦП', 'x ' + m1(b.ceX) + ', высота ' + m1(b.ceZ),
        'тяга ' + n0(b.driveN) + ', бок ' + n0(Math.abs(b.sideN))) +
    row(BAL_C.hydro, 'ЦБС',
        b.clrOk ? 'x ' + m1(b.clrX) + ', z ' + m1(b.clrZ)
                : 'нет: боковой силы почти нет',
        'бок ' + n0(Math.abs(b.hydroSideN)) + ', сопр ' +
        Math.round(Math.abs(b.hullN) - Math.abs(b.wavesN)) +
        (b.wavesN > 0.5 ? '+' + Math.round(b.wavesN) : '') + ' Н') +
    row(BAL_C.cg, 'ЦТ', 'x ' + m1(b.cgX) + ', z ' + m1(b.cgZ),
        'вес ' + n0(b.weightN)) +
    row(BAL_C.buoy, 'ЦВ', 'x ' + m1(b.bX) + ', под ветер ' + m1(Math.abs(b.bY)),
        'плавучесть ' + n0(b.buoyN)) +
    row(BAL_C.crew, 'Экипаж', 'плечо ' + m1(Math.abs(crewArm())),
        'вес ' + n0(b.weightCrewN) + ' → ' +
        Math.round(Math.abs(b.hikeNm)) + ' Н·м');
  balNote.innerHTML =
    leverTxt + ' · кренит <b>' + Math.round(Math.abs(b.heelNm)) + '</b>, экипаж <b>' +
    Math.round(Math.abs(b.hikeNm)) + '</b>, корпус <b>' +
    Math.round(b.weightN * b.gzM) + '</b> Н·м<br>' +
    'посадка <b>' + (b.sinkM * 1000).toFixed(0) + ' мм</b>, дифферент <b>' +
    b.trimDeg.toFixed(2) + '°</b>, риг тянет <b>' +
    (b.vertN < 0 ? 'вниз ' : 'вверх ') + Math.round(Math.abs(b.vertN)) +
    ' Н</b> · водоизмещение <b>' + Math.round(b.buoyN / 9.81) + ' кг</b><br>' +
    'второе слагаемое сопротивления — волновое · стрелки <b>1 м = ' +
    BAL_NM + ' Н</b>, кроме вертикальных: у веса, плавучести и экипажа ' +
    'говорит не длина, а плечо';
}

// --- пробы воды под корпусом --------------------------------------------------
//
// Пять точек, по которым плавучесть узнаёт, где вода. Показываются они не для
// красоты: это единственное место, где видно РАСХОЖДЕНИЕ между водой, которую
// нарисовали, и водой, которую чувствует лодка. Пока пробы лежат на
// поверхности, всё в порядке; поехали — значит поехало что-то одно из двух, и
// сразу видно, какое.
//
// Заводится этот вид не впустую: на нём и разбирались скачки. Проба отдавала
// нормаль вместо наклона, то есть наклон наизнанку, а снималась в одной точке —
// и лодка отыгрывала каждую рябь, которой шестиметровый корпус не чувствует.
// Обе ошибки на такой картинке видны с одного взгляда: крест стоит поперёк
// волны и дёргается вчетверо чаще неё.
//
// Крест — подогнанная плоскость: перекладина вдоль корпуса и поперёк. Точки на
// его концах — сами пробы. Расходятся точки с крестом — значит волна под
// корпусом короче корпуса, и её честно усредняет, а не теряет.
const seaProbeGeo = new BufferGeometry();
seaProbeGeo.setAttribute('position',
  new Float32BufferAttribute(
    new Float32Array((2 + OCEAN_PROBE.length) * 2 * 3), 3));
const seaProbeMarks = new LineSegments(seaProbeGeo, new LineBasicMaterial({
  color: 0xff9d4a, transparent: true, opacity: 0.9, depthTest: false }));
seaProbeMarks.frustumCulled = false;
seaProbeMarks.renderOrder = 3;
scene.add(seaProbeMarks);

function updateSeaProbes(x, y, psi) {
  const p = seaProbeGeo.attributes.position.array;
  const c = Math.cos(psi), s = Math.sin(psi);
  // Точки берутся ТОЙ ЖЕ функцией, что их раскладывает: вид, который считает
  // положение проб по-своему, показывает не пробы, а свою копию — и врёт ровно
  // тогда, когда на него и смотрят.
  const pts = [];
  for (let i = 0; i < OCEAN_PROBE.length; i++) {
    seaProbeOffset(i, c, s, seaProbeAt);
    pts.push([seaProbeAt.x, seaProbeAt.y, ocean.probeHeight(i)]);
  }
  // Плоскость задана высотой в НАЧАЛЕ КООРДИНАТ лодки, и смещения здесь от него
  // же, так что подставляются как есть.
  const onPlane = (dx, dy) => seaPlane.z + seaPlane.se * dx + seaPlane.sn * dy;
  let k = 0;
  const put = (dx, dy, h) => {
    p[k++] = toSceneX(x + dx); p[k++] = h; p[k++] = toSceneZ(y + dy);
  };
  // две перекладины креста — сама плоскость
  for (const i of [0, 1, 2, 3]) put(pts[i][0], pts[i][1], onPlane(pts[i][0], pts[i][1]));
  // и отвесы до самих проб: их длина и есть то, что плоскость усреднила
  for (const [dx, dy, h] of pts) {
    put(dx, dy, onPlane(dx, dy));
    put(dx, dy, h);
  }
  seaProbeGeo.attributes.position.needsUpdate = true;
}

// --- отладочный вид сверху: струи вокруг лодки --------------------------------
//
// Струи живут вокруг лодки, а видны в перспективе с кормы: половина за спиной,
// половина мимо кадра. Ровно ли они лежат кругом, не отстают ли на полном курсе,
// куда девается плотность — по такому виду не сказать, а по одному снимку тем
// более. Здесь тот же набор сверху и схематично.
//
// Рисуется прямо в осях сцены: X вправо, Z вниз. Это уже карта севером кверху,
// потому что сцена получена из мира переводом (x, y) -> (x, -y); заводить свои
// знаки не нужно и нельзя — ровно ради этого axes.js и существует.
//
// Две стрелки от лодки отвечают на главный вопрос отладки: жёлтая — снос струй,
// зелёная — ход лодки. Разница между ними и есть то движение, которое видно с
// палубы. Когда они сходятся, струи стоят на месте относительно лодки; когда
// зелёная длиннее, лодка обгоняет воздух, и струи обязаны идти назад.

const TOP_PX = 240;         // сторона канваса
const TOP_BOAT = 2;         // лодка нарисована крупнее натуры: иначе точка
const topCv = document.getElementById('top');
const topCtx = topCv.getContext('2d');
{
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  topCv.width = TOP_PX * dpr; topCv.height = TOP_PX * dpr;
  topCtx.scale(dpr, dpr);
}
const topView = { on: false, x: 0, z: 0, dx: 1, dz: 0, v: 0 };
const topNote = document.getElementById('topnote');

function topArrow(c, x, z, dx, dz, len, color) {
  const hx = x + dx * len, hz = z + dz * len;
  c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 1.6;
  c.beginPath(); c.moveTo(x, z); c.lineTo(hx, hz); c.stroke();
  c.beginPath();
  c.moveTo(hx + dx * 5, hz + dz * 5);
  c.lineTo(hx - dx * 3 - dz * 3.2, hz - dz * 3 + dx * 3.2);
  c.lineTo(hx - dx * 3 + dz * 3.2, hz - dz * 3 - dx * 3.2);
  c.fill();
}

// Мини-карта нужна не рулевому, а тому, кто правит сами струи, поэтому она
// спрятана и не привязана к G: включается из консоли вызовом sv20top(). Своим
// переключателем, а не общим, — чтобы смотреть на струи можно было в обычной
// обстановке, без стрелок поля и полупрозрачных парусов, которые как раз их и
// загораживают.
let topShown = false;
window.sv20top = (on = true) => {
  topShown = !!on;
  document.getElementById('topcard').hidden = !topShown;
  return topShown;
};

function updateTop() {
  const c = topCtx, R = TOP_PX / 2;
  const m = R / (STREAK_R * 1.06);       // пикселей на метр, с полем по краю
  const px = x => R + (x - topView.x) * m;
  const pz = z => R + (z - topView.z) * m;
  c.clearRect(0, 0, TOP_PX, TOP_PX);

  // Круг раздачи и половина его: по ним и читается, ровно ли лежит плотность.
  c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = 1;
  c.setLineDash([3, 3]);
  c.beginPath(); c.arc(R, R, STREAK_R * m, 0, 7); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,.10)';
  c.beginPath(); c.arc(R, R, STREAK_R * m / 2, 0, 7); c.stroke();
  c.setLineDash([]);

  let fwd = 0, aft = 0, live = 0;
  if (topView.on) {
    const bx = bowSceneX(boat.psi), bz = bowSceneZ(boat.psi);
    for (const st of streaks) {
      if (!st || !st.pts) continue;
      live++;
      if ((st.x - topView.x) * bx + (st.z - topView.z) * bz > 0) fwd++; else aft++;
      // Прозрачность — та же, с какой струя нарисована в сцене, только поднятая:
      // иначе на отладке не видно как раз того, что и надо разглядеть.
      c.strokeStyle = `rgba(255,255,255,${Math.min(0.9, (st.A || 0) * 2.4)})`;
      c.lineWidth = 1.4;
      c.beginPath();
      for (let k = 0; k < STREAK_ST.length; k++) {
        const x = px(st.pts[k * 2]), z = pz(st.pts[k * 2 + 1]);
        if (k) c.lineTo(x, z); else c.moveTo(x, z);
      }
      c.stroke();
      // Голова — точка, её размер по высоте: так видно, что струи раздаются по
      // всей толще, а не лежат в одной плоскости.
      const h = (st.y - STREAK_LO) / (STREAK_HI - STREAK_LO);
      c.fillStyle = `rgba(255,207,90,${Math.min(0.95, (st.A || 0) * 2.4)})`;
      c.beginPath(); c.arc(px(st.x), pz(st.z), 1 + 2.2 * h, 0, 7); c.fill();
    }
  }

  // Лодка: корпус острым носом, чтобы курс читался без стрелки.
  const L = 6.1 * m * TOP_BOAT / 2, W = 1.1 * m * TOP_BOAT / 2;
  const fx = bowSceneX(boat.psi), fz = bowSceneZ(boat.psi);
  const sx = stbdSceneX(boat.psi), sz = stbdSceneZ(boat.psi);
  const at = (a, b) => [R + fx * a + sx * b, R + fz * a + sz * b];
  c.fillStyle = 'rgba(255,255,255,.85)';
  c.beginPath();
  const hull = [[L, 0], [L * 0.25, W], [-L * 0.8, W * 0.8], [-L, 0],
                [-L * 0.8, -W * 0.8], [L * 0.25, -W]];
  hull.forEach((q, i) => { const [a, b] = at(q[0], q[1]); i ? c.lineTo(a, b) : c.moveTo(a, b); });
  c.closePath(); c.fill();

  // Снос струй и ход лодки. Скорость лодки собирается из осей лодки теми же
  // ортами, что и корпус: продольная по носу, поперечная на левый борт.
  topArrow(c, R, R, topView.dx, topView.dz, 10 + topView.v * 4, 'rgba(255,207,90,.9)');
  const vx = boat.u * fx - boat.v * sx, vz = boat.u * fz - boat.v * sz;
  const vs = Math.hypot(vx, vz) || 1;
  topArrow(c, R, R, vx / vs, vz / vs, 10 + vs * 4, 'rgba(110,231,168,.9)');

  topNote.innerHTML = topView.on
    ? `струй <b>${live}</b> · впереди <b>${fwd}</b> / позади <b>${aft}</b><br>` +
      `снос <b>${topView.v.toFixed(1)}</b> · ход <b>${vs.toFixed(1)}</b> м/с · ` +
      `круг ${STREAK_R} м · лодка ×${TOP_BOAT}`
    : 'струй нет: слишком слабый кажущийся ветер';
}

// --- отладочный слой: поле ветра и полоски рига -------------------------------
//
// Обе новые вещи — профиль ветра по высоте и разбивка парусов на полоски —
// невидимы в числах. Поэтому у каждой есть свой вид.
//
// Стрелки на воде показывают поле ветра там, где оно есть: свою длину и своё
// направление в каждой точке. По ним видно и заход, и то, что порыв приходит
// не сразу на всю акваторию.
//
// Латы на парусе — это хорды полосок, нарисованные каждая под своим углом.
// Твист по ним читается сразу: латы разворачиваются веером. Цвет — угол атаки:
// синий заполаскивает, зелёный работает, красный сорван.

const DBG_STEP = 12, DBG_HALF = 3;             // сетка стрелок ветра, м
const arrowPts = [];
for (let i = -DBG_HALF; i <= DBG_HALF; i++)
  for (let j = -DBG_HALF; j <= DBG_HALF; j++) arrowPts.push([i * DBG_STEP, j * DBG_STEP]);
// Стрелки — плоские фигурки, а не линии: линия в WebGL всегда толщиной в один
// пиксель, и в камере погони, где на воду смотришь под острым углом, она
// пропадает совсем. Три треугольника на стрелку.
const ARR_V = 9;
const fieldGeo = new BufferGeometry();
fieldGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(arrowPts.length * ARR_V * 3), 3));
fieldGeo.setAttribute('color',
  new Float32BufferAttribute(new Float32Array(arrowPts.length * ARR_V * 3), 3));
const field = new Mesh(fieldGeo, new MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.8,
  depthTest: false, side: DoubleSide }));
field.frustumCulled = false;
field.renderOrder = 3;
scene.add(field);

// Второй слой тех же стрелок — течение. Отдельный, а не общий с ветром: это
// разные вещи, и складывать их глазом должен рулевой, а не отрисовка. Лежат они
// ниже ветровых и синие, так что перепутать нечем; на реке ровно из-за угла
// между этими двумя семействами и получается всё интересное.
const curGeo = new BufferGeometry();
curGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(arrowPts.length * ARR_V * 3), 3));
const curField = new Mesh(curGeo, new MeshBasicMaterial({
  color: 0x2f6fd8, transparent: true, opacity: 0.85,
  depthTest: false, side: DoubleSide }));
curField.frustumCulled = false;
curField.renderOrder = 2;
scene.add(curField);

// Одна стрелка в буфер: девять вершин, три треугольника. Вынесено, потому что
// семейств теперь два и расходиться формой им незачем.
function putArrow(p, k, x, z, dx, dz, len, hw, hh, head, y) {
  const px = -dz, pz = dx;
  const bx = x + dx * (len - head), bz = z + dz * (len - head);
  const put = (ax, az) => { p[k] = ax; p[k + 1] = y; p[k + 2] = az; k += 3; };
  put(x + px * hw, z + pz * hw); put(x - px * hw, z - pz * hw);
  put(bx + px * hw, bz + pz * hw);
  put(x - px * hw, z - pz * hw); put(bx - px * hw, bz - pz * hw);
  put(bx + px * hw, bz + pz * hw);
  put(bx + px * hh, bz + pz * hh); put(bx - px * hh, bz - pz * hh);
  put(x + dx * len, z + dz * len);
}

function updateField(cx, cz, t) {
  const p = fieldGeo.attributes.position.array;
  const c = fieldGeo.attributes.color.array;
  const ox = Math.round(cx / DBG_STEP) * DBG_STEP;
  const oz = Math.round(cz / DBG_STEP) * DBG_STEP;
  const ref = boat.o.windSpeed || 1;
  for (let i = 0; i < arrowPts.length; i++) {
    const x = ox + arrowPts[i][0], z = oz + arrowPts[i][1];
    // Ветер здесь — тот же, что чувствует лодка: с тенью берега и с добавочной
    // рваностью в ней. Под берегом стрелки обязаны сесть, иначе по ним не
    // прочесть того самого, ради чего тень и заводилась.
    const w = windScene(x, z, 3.0, t);
    // рисуем туда, КУДА дует: так видно, куда поедет порыв
    const dx = w.x / (w.speed || 1), dz = w.y / (w.speed || 1);
    putArrow(p, i * ARR_V * 3, x, z, dx, dz,
             2.2 + 3.4 * (w.speed / ref), 0.22, 0.62, 1.3, 0.36);
    // Цвет по силе: слабее среднего зеленеет, сильнее — желтеет. Холодный конец
    // был синим, пока синий не занял течение; двум семействам стрелок делить
    // один цвет нельзя — на воде их и так накладывается друг на друга.
    const s = Math.max(0, Math.min(1, (w.speed / ref - 0.7) / 0.7));
    for (let v = 0; v < ARR_V; v++) {
      const b = (i * ARR_V + v) * 3;
      c[b] = 0.30 + 0.70 * s;
      c[b + 1] = 0.80 - 0.02 * s;
      c[b + 2] = 0.66 - 0.36 * s;
    }
  }
  fieldGeo.attributes.position.needsUpdate = true;
  fieldGeo.attributes.color.needsUpdate = true;

  // Течение. Длина — от той же скорости на стрежне, что стоит на ползунке, так
  // что стрелка в полный рост означает фарватер, а короткая — что здесь уже
  // тише. Именно этот перепад и есть вся речная тактика.
  const q = curGeo.attributes.position.array;
  const cref = boat.o.current || 1;
  for (let i = 0; i < arrowPts.length; i++) {
    const x = ox + arrowPts[i][0], z = oz + arrowPts[i][1];
    terrain.current(toWorldX(x), toWorldY(z), boat.o.current, curProbe);
    const sp = Math.hypot(curProbe.x, curProbe.y);
    // Стоячая вода — не стрелка нулевой длины, а её отсутствие: вырожденный
    // треугольник рисует пиксель мусора там, где показывать нечего.
    if (sp < 1e-4) { q.fill(0, i * ARR_V * 3, (i + 1) * ARR_V * 3); continue; }
    putArrow(q, i * ARR_V * 3, x, z,
             toSceneX(curProbe.x / sp), toSceneZ(curProbe.y / sp),
             1.2 + 2.4 * (sp / cref), 0.13, 0.40, 0.85, 0.16);
  }
  curGeo.attributes.position.needsUpdate = true;
}
const curProbe = { x: 0, y: 0 };

const NSTRIP = 12, BAT_V = 6, BAT_HALF = 0.055;
const battenGeo = new BufferGeometry();
battenGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(NSTRIP * BAT_V * 3), 3));
battenGeo.setAttribute('color',
  new Float32BufferAttribute(new Float32Array(NSTRIP * BAT_V * 3), 3));
const battens = new Mesh(battenGeo, new MeshBasicMaterial({
  vertexColors: true, depthTest: false, side: DoubleSide }));
battens.frustumCulled = false;
battens.renderOrder = 4;
boatGroup.add(battens);

// Цвет по ТЯГЕ полоски, а не по углу атаки.
//
// По углу атаки было честно, но обманчиво: на полных курсах парус работает
// сорванным, потому что там нужна не подъёмная сила, а лобовое сопротивление
// вдоль движения. Шкала «зелёный — поток прилип, красный — сорван» показывала
// в фордевинд сплошной красный ровно там, где лодка едет быстрее всего.
// Тяга отвечает на вопрос прямо и одинаково на всех курсах.
//
// Состояние потока никуда не делось: угол атаки со срывной чертой остался
// вторым столбцом панели рига.
function driveColour(f) {
  if (f < 0) {                       // тормозит: от серого к красному
    const k = Math.min(1, -f);
    return [0.55 + 0.45 * k, 0.55 - 0.25 * k, 0.6 - 0.3 * k];
  }
  const k = Math.min(1, f);          // тянет: от серого к зелёному
  return [0.55 - 0.25 * k, 0.55 + 0.4 * k, 0.6 - 0.25 * k];
}

function updateBattens(side) {
  const p = battenGeo.attributes.position.array;
  const c = battenGeo.attributes.color.array;
  const st = boat.telemetry && boat.telemetry.strips;
  // Нормируем по самой тянущей полоске: важно, кто здесь и сейчас работает,
  // а не абсолютные ньютоны, которые меняются на порядок с силой ветра.
  let peak = 1e-6;
  if (st) for (const d of st) peak = Math.max(peak, Math.abs(d.drive));
  for (let i = 0; i < NSTRIP; i++) {
    const s = boat.rig.strips[i], d = st ? st[i] : null;
    const aw = d ? d.awaDeg * D : Math.PI;
    const held = Math.min(boat.o.sheet, aw);
    const over = Math.min(1, Math.max(0, (boat.o.sheet - s.maxSheet) / (25 * D)));
    const sheet = held + (aw - held) * over +
                  (boat.rig.twistEff || boat.o.twist) * s.twistF;
    const ax = s.xLuff, az = 0;
    const bx = s.xLuff - s.chord * Math.cos(sheet);
    const bz = s.chord * Math.sin(sheet) * side;
    let k = i * BAT_V * 3;
    const put = (x, y, z) => { p[k] = x; p[k + 1] = y; p[k + 2] = z; k += 3; };
    put(ax, s.h - BAT_HALF, az); put(ax, s.h + BAT_HALF, az);
    put(bx, s.h - BAT_HALF, bz);
    put(ax, s.h + BAT_HALF, az); put(bx, s.h + BAT_HALF, bz);
    put(bx, s.h - BAT_HALF, bz);
    const col = driveColour(d ? d.drive / peak : 0);
    for (let v = 0; v < BAT_V; v++) {
      const b = (i * BAT_V + v) * 3;
      c[b] = col[0]; c[b + 1] = col[1]; c[b + 2] = col[2];
    }
  }
  battenGeo.attributes.position.needsUpdate = true;
  battenGeo.attributes.color.needsUpdate = true;
}

// --- линии тока вокруг парусов ------------------------------------------------
//
// То, что в трубе показывают дымом. Вихревая решётка умеет считать наведённую
// скорость в любой точке, а не только на самих панелях, — значит можно взять
// сетку точек с наветра и повести их по потоку. Видно сразу и подпор перед
// парусами, и разгон в щели между гротом и стакселем, и скос за задней
// шкаториной: то есть именно то, ради чего решётка и заводилась и чего по
// числам не понять.
//
// Линии живут в горизонтной системе лодки — той же, в которой считает риг:
// курс есть, крена нет. Поэтому у них своя группа.
// Линия — не отрезок, а трубка.
//
// Отрезок WebGL везде рисует в один пиксель, толщина не задаётся, и на воде
// такие линии не читаются вовсе. Готовые «толстые линии» для three.js
// (Line2/LineMaterial) раздувают отрезок в экранных координатах вершинным
// шейдером; здесь рендерер узловой, и городить свой шейдер ради этого незачем —
// пятигранная трубка даёт то же самое и обходится геометрией.
//
// У трубки есть и второе достоинство, ради которого она и выбрана. Грани
// закрашиваются по своему наклону к условному свету, и у линии сам собой
// появляется тёмный кант. Без него никакая палитра не читается сразу и на
// тёмной воде, и на белом парусе — светлое пропадает на парусе, тёмное на воде.
// Шаг вдвое мельче полного: длина линии та же, звеньев вдвое больше. Дело не
// только в гладкости трубки — этим же шагом линия и интегрируется, и на
// тугих завитках сходящей пелены крупный шаг срезал углы.
const FLOW_LINES = 26, FLOW_STEPS = 48, FLOW_DS = 0.275;
const FLOW_SEED = 4.5;        // насколько выше по потоку начинать, м
const FLOW_SIDES = 5;
const FLOW_R = 0.032;         // радиус трубки, м
const FLOW_PTS = FLOW_STEPS + 1;
const FLOW_LIGHT = [0.35, 0.86, 0.37];   // куда смотрит условный свет

// Палитра расходящаяся, и это не украшение, а то же самое решение, что и у
// трубки: показывать надо ОТКЛОНЕНИЕ от набегающего потока, а не саму скорость.
// Поэтому середина шкалы — набегающий поток, и она нейтральная; холодный полюс
// — подпор перед парусом, тёплый — разгон в щели.
//
// Числа не подобраны на глаз. Полюса взяты голубой и янтарный: они
// противоположны по теплу, различимы при любом виде дальтонизма (ΔE 19 при
// нормальном зрении, 8 при дейтеранопии) и оба выше 3:1 на воде. Середина —
// чистый серый и заметно ТЕМНЕЕ полюсов: во-первых, у расходящейся шкалы
// светлота обязана расти к обоим краям, чтобы величина отклонения читалась и
// без цвета; во-вторых, светлая середина сливалась с белым парусом — на
// картинке нельзя было отличить поток от полотна.
const FLOW_SLOW = [0.247, 0.816, 0.910];   // #3fd0e8
const FLOW_MID = [0.561, 0.561, 0.561];    // #8f8f8f
const FLOW_FAST = [0.961, 0.647, 0.141];   // #f5a524
// Размах шкалы: на сколько долей набегающей растянуты полюса. Взят по самому
// полю, а не на глаз. Между пятью и девяноста пятью процентами точек скорость
// лежит в пределах 0.90…1.15 набегающей; при размахе 0.45 в эту вилку попадала
// только середина шкалы, и картинка выходила сплошь серой. При 0.25 обычное
// отклонение красится вполсилы, а полностью — только там, где поток и правда
// стоит или разгоняется вдвое: перед шкаториной и в щели.
const FLOW_SPAN = 0.25;

const flowGroup = new Group();
scene.add(flowGroup);

function flowGeometry() {
  const nv = FLOW_LINES * FLOW_PTS * FLOW_SIDES;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(nv * 3), 3));
  g.setAttribute('color', new Float32BufferAttribute(new Float32Array(nv * 3), 3));
  const idx = [];
  for (let l = 0; l < FLOW_LINES; l++) {
    for (let k = 0; k < FLOW_STEPS; k++) {
      const a = (l * FLOW_PTS + k) * FLOW_SIDES, b = a + FLOW_SIDES;
      for (let s = 0; s < FLOW_SIDES; s++) {
        const s2 = (s + 1) % FLOW_SIDES;
        idx.push(a + s, b + s, b + s2, a + s, b + s2, a + s2);
      }
    }
  }
  g.setIndex(idx);
  return g;
}
const flowGeo = flowGeometry();
// Две прорисовки одной геометрии. Первая — как есть, с тестом глубины: линии
// прячутся за парусами и корпусом, как всякое тело. Вторая — поверх всего и
// еле видная: она и даёт увидеть поток за парусом, не ломая при этом ощущение
// объёма. Приём известный, и он надёжнее полупрозрачных линий, у которых
// порядок отрисовки всё время не тот.
const flow = new Mesh(flowGeo, new MeshBasicMaterial({ vertexColors: true }));
flow.frustumCulled = false;
flowGroup.add(flow);
const flowGhost = new Mesh(flowGeo, new MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.16,
  depthTest: false, depthWrite: false }));
flowGhost.frustumCulled = false;
flowGhost.renderOrder = 6;
flowGroup.add(flowGhost);
const flowV = [0, 0, 0];

function updateFlow() {
  const lat = boat.rig.lattice;
  const aw = boat.apparentWind();
  const V = Math.hypot(aw.x, aw.y);
  const p = flowGeo.attributes.position.array;
  const c = flowGeo.attributes.color.array;
  if (V < 0.3) { flowGeo.setDrawRange(0, 0); return; }
  const ux = aw.x / V, uy = aw.y / V;          // куда дует
  const px = -uy, py = ux;                     // поперёк потока
  const rigX = rig.ce_x_m, rigZ = rig.ce_height_m;
  let at = 0;
  for (let i = 0; i < FLOW_LINES; i++) {
    // Засев: сетка поперёк потока, с наветра от рига. Начинать дальше незачем —
    // до паруса поток идёт прямо, и длинные прямые хвосты только загораживают
    // лодку.
    const row = i % 2, col = (i - row) / 2;
    const lat0 = (col / (FLOW_LINES / 2 - 1) - 0.5) * 6.0;
    const h = row ? rigZ * 0.45 : rigZ * 1.05;
    let x = rigX - ux * FLOW_SEED + px * lat0;
    let y = -uy * FLOW_SEED + py * lat0;
    let z = h;
    for (let k = 0; k <= FLOW_STEPS; k++) {
      lat.induced(x, y, z, ux, uy, 0, true, flowV);
      const vx = aw.x + flowV[0], vy = aw.y + flowV[1], vz = flowV[2];
      const sp = Math.hypot(vx, vy, vz) || 1;
      // Интегрирование остаётся в осях лодки. В локальные оси переводятся лишь
      // касательная трубки и записываемая точка: когда знак адаптера изменится,
      // уже переведённая касательная не должна попасть обратно в координату y.
      const bx0 = vx / sp, by0 = vy / sp, bz0 = vz / sp;
      // Касательная в осях отрисовки: X в нос, Y вверх, Z вправо.
      const tx = bodyDirLocalX(bx0), ty = bodyDirLocalY(bz0),
            tz = bodyDirLocalZ(by0);
      // Поперечный репер. Линии тока почти горизонтальны, так что мировая
      // вертикаль годится за опорную и вырождения не даёт.
      let ax = -tz, ay = 0, az = tx;
      const al = Math.hypot(ax, az) || 1;
      ax /= al; az /= al;
      const bx = ty * az - ay, by = tz * ax - tx * az, bz = -ty * ax;

      const t = Math.max(-1, Math.min(1, (sp / V - 1) / FLOW_SPAN));
      const lo = t < 0 ? FLOW_SLOW : FLOW_FAST;
      const w = Math.abs(t);
      const cr = FLOW_MID[0] + (lo[0] - FLOW_MID[0]) * w;
      const cg = FLOW_MID[1] + (lo[1] - FLOW_MID[1]) * w;
      const cb = FLOW_MID[2] + (lo[2] - FLOW_MID[2]) * w;

      for (let s = 0; s < FLOW_SIDES; s++) {
        const a = 2 * Math.PI * s / FLOW_SIDES;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = ax * ca + bx * sa, ny = ay * ca + by * sa, nz = az * ca + bz * sa;
        const o = at * 3;
        p[o] = bodyPointLocalX(x) + nx * FLOW_R;
        p[o + 1] = bodyPointLocalY(z) + ny * FLOW_R;
        p[o + 2] = bodyPointLocalZ(y) + nz * FLOW_R;
        // Затенение по нормали грани: сверху светлее, снизу темнее. Отсюда и
        // кант, который держит линию читаемой на любом фоне.
        const d = nx * FLOW_LIGHT[0] + ny * FLOW_LIGHT[1] + nz * FLOW_LIGHT[2];
        const sh = 0.52 + 0.48 * (0.5 + 0.5 * d);
        c[o] = cr * sh; c[o + 1] = cg * sh; c[o + 2] = cb * sh;
        at++;
      }
      if (k === FLOW_STEPS) break;
      x += bx0 * FLOW_DS;
      y += by0 * FLOW_DS;
      z = Math.max(0.15, z + bz0 * FLOW_DS);
    }
  }
  flowGeo.attributes.position.needsUpdate = true;
  flowGeo.attributes.color.needsUpdate = true;
}

// Отладочных видов теперь два, и клавиша одна: G крутит их по кругу — выключено,
// поток, баланс. Держать под каждый свою клавишу дороже, чем нажать дважды, а
// одновременно они и не нужны: стрелки поля ветра спорят со стрелками сил.
const DEBUG_MODES = 3;
let debugMode = 0;
let debugOn = false;                 // «хоть какой-то» — им гасится общее
function setDebug(on) {
  debugMode = on === true ? 1 : on === false ? 0 : (on | 0) % DEBUG_MODES;
  debugOn = debugMode > 0;
  // Имена нарочно не `flow` и не `field`: так зовутся сами объекты сцены, и
  // локальная переменная их перекрывает — картинка при этом не ломается, а
  // падает вся отрисовка.
  const isFlow = debugMode === 1, isBal = debugMode === 2;
  const on_ = debugOn;
  // Паруса приспускаются в прозрачность только в отладочном виде: там сквозь
  // них угадывается и поток, и колдунчик с подветренной стороны. В обычном
  // полотно должно быть полотном.
  //
  // `transparent` переключается вместе с прозрачностью, а не остаётся всегда
  // включённым: у прозрачного материала своя очередь отрисовки, с сортировкой
  // по дальности, и держать в ней непрозрачный парус незачем. Смена флага
  // требует пересборки программы — отсюда needsUpdate.
  for (const m of [mainSail.material, jibSail.material]) {
    m.transparent = on_;
    m.opacity = on_ ? 0.9 : 1;
    m.needsUpdate = true;
  }
  grid.visible = on_;
  arrow.visible = on_;
  field.visible = isFlow;
  battens.visible = isFlow;
  flow.visible = isFlow;
  flowGhost.visible = isFlow;
  balGroup.visible = isBal;
  document.getElementById('rigcard').hidden = !isFlow;
  document.getElementById('balcard').hidden = !isBal;
}

// --- отладочные ортогональные виды --------------------------------------------
//
// Ставить что-либо на лодку по перспективному виду нельзя: перспектива врёт о
// симметрии. Стоящее на диаметральной кажется смещённым, равные отступы от неё
// выглядят разными, а с кормы ближний борт крупнее дальнего. Ортогональный вид
// — это чертёж: сзади видно, одинаково ли разнесены предметы по бортам и сидят
// ли они на палубе; сверху — как они расставлены вдоль.
//
// Включается из консоли: sv20ortho('back' | 'top' | 'side'), sv20ortho(false)
// вернуть. Паруса, вода и отладочные слои на время кадра снимаются — они
// закрывают как раз проверяемое, — и сразу ставятся обратно: вид ничего не
// должен оставлять за собой, иначе следующая же правка будет отлаживаться в
// сцене с невидимой водой.
//
// Полкадра по вертикали известно в метрах, а лодка стоит в центре, — значит по
// снимку экрана можно мерить линейкой, а не на глаз.

const ORTHO_DIST = 40;             // относ камеры, м; для ортогональной — лишь порядок
const orthoCam = new OrthographicCamera(-1, 1, 1, -1, -80, 80);
const orthoAim = new Vector3();
let orthoView = null, orthoHalf = 4.2, orthoOff = null, orthoWas = null;
// Второй довод — полкадра в метрах: на палубу смотрят с двух метров, на рангоут
// с пяти, и переключать это должно быть дешевле, чем пересобирать страницу.
window.sv20ortho = (v = 'back', half = 4.2) => {
  orthoView = (v === 'back' || v === 'top' || v === 'side') ? v : null;
  orthoHalf = Math.max(0.3, +half || 4.2);
  return orthoView && orthoView + ', полкадра ' + orthoHalf + ' м';
};

function renderOrtho(bx, bz, fx, fz, sx, sz) {
  const r = stage.getBoundingClientRect();
  const asp = Math.max(0.2, r.width / Math.max(1, r.height));
  orthoCam.top = orthoHalf; orthoCam.bottom = -orthoHalf;
  orthoCam.left = -orthoHalf * asp; orthoCam.right = orthoHalf * asp;
  orthoCam.updateProjectionMatrix();
  // Целить надо в середину лодки, а не в её начало координат: оно у транца, и
  // при взгляде сверху корпус уезжает целиком за край кадра.
  hullMesh.geometry.computeBoundingBox();
  const bb = hullMesh.geometry.boundingBox;
  const mid = (bb.min.x + bb.max.x) / 2;       // локальная X модели — в нос
  orthoAim.set(bx + fx * mid, 0.8, bz + fz * mid);
  if (orthoView === 'top') {
    orthoCam.position.set(bx, ORTHO_DIST, bz);
    orthoCam.up.set(fx, 0, fz);                // нос кверху экрана
  } else if (orthoView === 'side') {
    orthoCam.position.set(bx + sx * ORTHO_DIST, 0.8, bz + sz * ORTHO_DIST);
    orthoCam.up.set(0, 1, 0);
  } else {
    orthoCam.position.set(bx - fx * ORTHO_DIST, 0.8, bz - fz * ORTHO_DIST);
    orthoCam.up.set(0, 1, 0);
  }
  orthoCam.lookAt(orthoAim);

  if (!orthoOff) {
    // Указатель ветра тоже снимается: он висит в четырёх метрах от лодки и в
    // шести над ней, и в чертёжном кадре занимает половину картинки, споря со
    // стрелками сил. Направление ветра и так на розе.
    orthoOff = [mainSail, jibSail, telltales[0], telltales[1], battens, arrow,
                sea, grid, wake, track, mark, streakMesh, field, curField,
                flow, flowGhost].filter(Boolean);
    orthoWas = new Array(orthoOff.length);
  }
  for (let i = 0; i < orthoOff.length; i++) {
    orthoWas[i] = orthoOff[i].visible; orthoOff[i].visible = false;
  }
  const fog = scene.fog;
  scene.fog = null;                            // чертёж не выцветает с дальностью
  renderer.render(scene, orthoCam);
  scene.fog = fog;
  for (let i = 0; i < orthoOff.length; i++) orthoOff[i].visible = orthoWas[i];
}


// Панель рига: что происходит по высоте паруса.
//
// Четыре столбца с общей вертикальной осью — высотой над водой. Первый
// показывает профиль ветра, второй угол атаки каждой полоски, третий её вклад
// в боковую силу. Вместе они отвечают на вопрос, ради которого всё это и
// делалось: почему верх паруса работает не так, как низ, и что с этим делает
// твист.
//
// Четвёртый — посчитанное мембраной пузо. Оно тут не для красоты: пузо
// показывает, где парус ещё держит форму, а где ткань смялась и он превратился
// в плоскую тряпку. Ноль в этом столбце и есть заполаскивание.
const rigSvg = document.getElementById('rig');
const RIG_W = 96, RIG_H = 132, RIG_PAD = 16;

function updateRig(t) {
  const st = t && t.strips;
  if (!st) return;
  const H = rig.mast_height_m;
  const y = h => RIG_H - RIG_PAD - (h / H) * (RIG_H - 2 * RIG_PAD);
  const main = st.slice(0, 6), jib = st.slice(6);
  let peakDrive = 1e-6;
  for (const s of st) peakDrive = Math.max(peakDrive, Math.abs(s.drive));

  const axis = (col, label, ticks) => {
    let g = '<g transform="translate(' + col * RIG_W + ',0)">' +
      '<text class="cap" x="' + (RIG_W / 2) + '" y="10">' + label + '</text>' +
      '<line class="ax" x1="6" y1="' + y(0) + '" x2="' + (RIG_W - 6) +
      '" y2="' + y(0) + '"/>';
    for (const [tx, tl] of ticks)
      g += '<text class="tick" x="' + tx + '" y="' + (RIG_H - 3) + '">' + tl + '</text>';
    return g;
  };
  const poly = (pts, cls) => '<polyline class="' + cls + '" points="' +
    pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>';

  // --- ветер по высоте
  const wMax = Math.max(1, ...st.map(s => s.ws)) * 1.15;
  const xw = v => 8 + (v / wMax) * (RIG_W - 20);
  let svg = axis(0, 'ветер, м/с', [[8, '0'], [RIG_W - 26, wMax.toFixed(0)]]);
  svg += poly(main.map(s => [xw(s.ws), y(s.z)]), 'w') + '</g>';

  // --- угол атаки: ноль и срыв отмечены, между ними парус работает
  const aLo = -20, aHi = 34;
  const xa = v => 8 + ((Math.max(aLo, Math.min(aHi, v)) - aLo) / (aHi - aLo)) *
                      (RIG_W - 20);
  svg += axis(1, 'угол атаки', [[xa(0) - 4, '0'], [xa(18) - 8, '18°']]);
  svg += '<line class="zero" x1="' + xa(0) + '" y1="' + y(H) + '" x2="' +
    xa(0) + '" y2="' + y(0) + '"/>';
  svg += '<line class="stall" x1="' + xa(18) + '" y1="' + y(H) + '" x2="' +
    xa(18) + '" y2="' + y(0) + '"/>';
  svg += poly(main.map(s => [xa(s.alphaDeg), y(s.z)]), 'a') +
         poly(jib.map(s => [xa(s.alphaDeg), y(s.z)]), 'aj');
  for (const s of st)
    svg += '<circle cx="' + xa(s.alphaDeg).toFixed(1) + '" cy="' +
      y(s.z).toFixed(1) + '" r="1.8" fill="rgb(' +
      driveColour(s.drive / peakDrive).map(v => Math.round(v * 255)).join(',') +
      ')"/>';
  svg += '</g>';

  // --- тяга и боковая: расходящиеся столбики от общей середины. Сразу видно,
  // где парус везёт, а где только кренит, — и что на полных курсах это одни и
  // те же полоски, а в лавировку разные.
  const fMax = Math.max(1, ...st.map(s => Math.max(Math.abs(s.side), Math.abs(s.drive))));
  const mid = RIG_W / 2, half = RIG_W / 2 - 8;
  svg += axis(2, 'тяга / боковая', [[10, 'бок'], [RIG_W - 26, 'тяга']]);
  svg += '<line class="ax" x1="' + mid + '" y1="' + y(rig.mast_height_m) +
    '" x2="' + mid + '" y2="' + y(0) + '"/>';
  for (const [arr, dim] of [[main, false], [jib, true]]) {
    for (const s of arr) {
      const yy = (y(s.z) - 2.6).toFixed(1);
      const wd = (Math.abs(s.drive) / fMax) * half;
      const ws = (Math.abs(s.side) / fMax) * half;
      svg += '<rect class="' + (dim ? 'bdj' : 'bd') + '" x="' + mid +
        '" y="' + yy + '" width="' + Math.max(0.4, wd).toFixed(1) + '" height="5.2"/>';
      svg += '<rect class="' + (dim ? 'bj' : 'bm') + '" x="' +
        (mid - Math.max(0.4, ws)).toFixed(1) + '" y="' + yy +
        '" width="' + Math.max(0.4, ws).toFixed(1) + '" height="5.2"/>';
    }
  }
  svg += '</g>';

  // --- пузо: сколько его осталось после того, как посчиталась форма
  const cMax = 0.16;
  const xc = v => 8 + (Math.min(cMax, Math.max(0, v)) / cMax) * (RIG_W - 20);
  svg += axis(3, 'пузо, % хорды', [[8, '0'], [RIG_W - 30, (100 * cMax).toFixed(0)]]);
  svg += poly(main.map(s => [xc(Math.abs(s.camber)), y(s.z)]), 'cam') +
         poly(jib.map(s => [xc(Math.abs(s.camber)), y(s.z)]), 'camj') + '</g>';

  rigSvg.innerHTML = svg;
  document.getElementById('rignote').innerHTML =
    'ЦП по нагрузке <b>' + (t.ceHeightM || 0).toFixed(2) + ' м</b>' +
    ' &nbsp;·&nbsp; твист <b>' + ((boat.rig.twistEff || 0) / D).toFixed(0) + '°</b>' +
    (boat.rig.twistEff > boat.o.twist + 1 * D ? ' <span class="slack">шкот провис</span>' : '') +
    ' &nbsp;·&nbsp; ветер у рига <b>' + (t.twsKn || 0).toFixed(1) + '</b> уз';
}

// Начальное состояние. Стоит здесь, а не в конце main.js: setDebug трогает
// объекты, объявленные выше в этом файле, и до его вклейки их ещё нет.
setDebug(0);
