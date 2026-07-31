// Симулятор управления SV20: сцена, ввод, цикл.
//
// Физика идёт фиксированным шагом 1/30 с и не зависит от частоты кадров;
// отрисовка интерполирует между шагами. Так поведение лодки одинаково и на
// шестидесяти герцах, и на просевших тридцати.
//
// Мировая система здесь — трёхмерная система three (Y вверх). Физика живёт в
// судостроительной: X в нос, Y на правый борт, Z вверх. Перевод только на
// границе, и он такой: three = (x, z, y).
//
// Тройка (нос, правый борт, вверх) левая, а у three правая, поэтому перевод
// обязан менять ориентацию — отсюда Z берётся с плюсом, а все углы поворота
// с минусом. Прежний перевод (x, z, −y) ориентацию сохранял, и вся сцена
// выходила зеркальной: правый борт рисовался слева. Само по себе это
// незаметно, зеркальная яхта ходит точно так же, и крен с парусом были
// зеркальны согласованно. Но роза ветров рисуется в обычной условности и
// потому спорила с трёхмерной картинкой, а порывы на воде спорили бы с обеими.
//
// Проверяется это за минуту: поставить в boatGroup столбик на (0, 3, +6) —
// это правый борт — и посмотреть, с какой стороны экрана он окажется в
// камере погони. Должен быть справа.
//
// Отдельная забота сцены — сделать поведение читаемым. По голым числам крен,
// дрейф и потерю хода на повороте не оценить, поэтому здесь есть бурун за
// кормой, дорожка пройденного пути, знаки на воде для привязки взгляда и
// роза ветров с положением паруса.

const D = Math.PI / 180;
const HZ = 30;
const DT = 1 / HZ;

const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const rose = document.getElementById('rose');

const scene = new Scene();
const SKY = new Color(0xa8c4d8);
scene.fog = new Fog(SKY, 45, 260);
const camera = new PerspectiveCamera(52, 1, 0.15, 2000);
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(SKY);
stage.appendChild(renderer.domElement);

scene.add(new HemisphereLight(0xe8f4ff, 0x2b4a63, 2.4));
const sun = new DirectionalLight(0xfff2dc, 2.6);
sun.position.set(-70, 80, 50);
scene.add(sun);

// ------------------------------------------------------------------- вода
//
// Плоскость небольшая и частая: волны должны читаться рядом с лодкой, а даль
// съедает туман. Сетка ездит за лодкой шагами по ячейке, чтобы не строить
// бесконечное море.

const SEA = 220, SEG = 150;
const seaGeo = new PlaneGeometry(SEA, SEA, SEG, SEG);
seaGeo.rotateX(-Math.PI / 2);
seaGeo.setAttribute('color', new Float32BufferAttribute(
  new Float32Array(seaGeo.attributes.position.count * 3).fill(1), 3));
const sea = new Mesh(seaGeo, new MeshStandardMaterial({
  color: 0x2c5c7d, roughness: 0.28, metalness: 0.12, vertexColors: true,
}));
scene.add(sea);
const seaBase = seaGeo.attributes.position.array.slice();
const CELL = SEA / SEG;

// Рябь от порывов. На воде усиление ветра видно раньше, чем оно доходит до
// парусов, — тёмными языками, ползущими по ветру. Это не украшение: без них
// порыв приходит из ниоткуда, и понять, что произошло, невозможно. Заодно это
// и есть отладочный вид поля ветра — то самое поле, по которому считаются
// силы, а не отдельная картинка рядом.
function paintSea(t) {
  const wind = boat.wind;
  const col = seaGeo.attributes.color.array;
  const amp = wind.o.gust;
  for (let i = 0, v = 0; i < col.length; i += 3, v++) {
    let k = 1;
    if (amp > 0.001) {
      const x = seaBase[v * 3] + sea.position.x;
      const z = seaBase[v * 3 + 2] + sea.position.z;
      k = 1 - 0.95 * amp * wind.gust(x, z, t);    // порыв темнее, дыра светлее
    }
    col[i] = k; col[i + 1] = k; col[i + 2] = k;
  }
  seaGeo.attributes.color.needsUpdate = true;
}

function waveHeight(x, z, t, dx, dz, amp) {
  const a = Math.sin((x * dx + z * dz) * 0.28 + t * 1.35);
  const b = Math.sin((x * dz - z * dx) * 0.17 - t * 0.85);
  const c = Math.sin((x * dx + z * dz) * 0.72 + t * 2.6);
  const d = Math.sin((x * 0.9 - z * 0.4) * 1.35 - t * 3.4);
  return amp * (0.5 * a + 0.28 * b + 0.14 * c + 0.08 * d);
}

// ------------------------------------------------------------------- лодка

const boatGroup = new Group();
scene.add(boatGroup);

function meshFrom(data, colour, rough, metal) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(data.positions, 3));
  g.setIndex(data.indices);
  g.computeVertexNormals();
  return new Mesh(g, new MeshStandardMaterial({
    color: new Color(colour), roughness: rough == null ? 0.45 : rough,
    metalness: metal == null ? 0.05 : metal, side: DoubleSide,
  }));
}

boatGroup.add(meshFrom(MESH.hull, 0xf4f7fa, 0.32));
boatGroup.add(meshFrom(MESH.keel_fin, 0x5d6873, 0.4));
boatGroup.add(meshFrom(MESH.bulb, 0x8d7340, 0.35, 0.3));
if (MESH.keel_case) boatGroup.add(meshFrom(MESH.keel_case, 0xe4eaee, 0.4));

const rudderMesh = meshFrom(MESH.rudder, 0x5d6873, 0.4);
const rudderPivot = new Group();
const stockX = PACK.foils.rudder.x_m;
rudderMesh.position.set(-stockX, 0, 0);
rudderPivot.position.set(stockX, 0, 0);
rudderPivot.add(rudderMesh);
boatGroup.add(rudderPivot);

const rig = PACK.rig;
const spar = new MeshStandardMaterial({
  color: 0xc3ccd4, roughness: 0.35, metalness: 0.6 });
const mast = new Mesh(
  new CylinderGeometry(0.05, 0.062, rig.mast_height_m, 10), spar);
mast.position.set(rig.mast_x_m, rig.mast_height_m / 2 + 0.62, 0);
boatGroup.add(mast);

const boom = new Mesh(new CylinderGeometry(0.045, 0.045, 2.9, 8), spar);
boom.rotation.z = Math.PI / 2;
boom.position.set(-1.45, 0, 0);
const boomPivot = new Group();
boomPivot.position.set(rig.mast_x_m, 1.0, 0);
boomPivot.add(boom);
boatGroup.add(boomPivot);

// --- паруса -----------------------------------------------------------------

// Паруса строятся по тем же треугольникам и тому же закону твиста, что и
// полоски в физике: сетка станций по высоте, на каждой хорда повёрнута на свой
// угол и выгнута пузом под ветер. Раньше здесь была отдельная приблизительная
// заглушка из пяти точек, и нарисованный парус жил своей жизнью — с твистом
// это стало видно сразу: латы торчали за шкаторину.
const SAIL_ROWS = 7, SAIL_COLS = 5;

function sailMesh(colour) {
  const g = new BufferGeometry();
  g.setAttribute('position',
    new Float32BufferAttribute(new Float32Array(SAIL_ROWS * SAIL_COLS * 3), 3));
  const idx = [];
  for (let r = 0; r < SAIL_ROWS - 1; r++) {
    for (let c = 0; c < SAIL_COLS - 1; c++) {
      const a = r * SAIL_COLS + c;
      idx.push(a, a + 1, a + SAIL_COLS, a + 1, a + SAIL_COLS + 1, a + SAIL_COLS);
    }
  }
  g.setIndex(idx);
  const m = new Mesh(g, new MeshStandardMaterial({
    color: new Color(colour), roughness: 0.9, side: DoubleSide,
  }));
  m.frustumCulled = false;
  return m;
}
const mainSail = sailMesh(0xf7f9fb);
const jibSail = sailMesh(0xeef2f6);
boatGroup.add(mainSail, jibSail);

function shapeSails(sheet, side, luffing) {
  boomPivot.rotation.y = sheet * side;
  const twist = boat.o.twist;
  const belly = luffing ? 0.02 : 0.10;      // пузо, доля хорды
  boat.sails.forEach((sail, k) => {
    const mesh = k === 0 ? mainSail : jibSail;
    const a = mesh.geometry.attributes.position.array;
    const zLo = Math.max(sail.tack[1], sail.clew[1]), zHi = sail.head[1];
    const edge = (e, z) => e[0] + (sail.head[0] - e[0]) * (z - e[1]) /
                                  (sail.head[1] - e[1]);
    let i = 0;
    for (let r = 0; r < SAIL_ROWS; r++) {
      const f = r / (SAIL_ROWS - 1);
      const h = zLo + f * (zHi - zLo);
      const xLuff = edge(sail.tack, h), chord = Math.max(0, xLuff - edge(sail.clew, h));
      const sh = sheet + twist * Math.pow(f, 1.3);
      // хорда идёт в корму и под ветер, нормаль к ней смотрит туда же
      const ux = -Math.cos(sh), uy = Math.sin(sh) * side;
      const nx = -uy, ny = ux;
      for (let c = 0; c < SAIL_COLS; c++) {
        const t = c / (SAIL_COLS - 1);
        const bulge = belly * chord * Math.sin(Math.PI * t);
        a[i++] = xLuff + chord * t * ux + bulge * nx;
        a[i++] = h;
        a[i++] = chord * t * uy + bulge * ny;
      }
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  });
}

// --- бурун и дорожка пути -----------------------------------------------------
//
// Без них ход и снос не читаются: вода однородная, глазу не за что зацепиться.
// Бурун показывает скорость, дорожка — куда лодку на самом деле несёт.

const WAKE = 150;
const wakeGeo = new BufferGeometry();
wakeGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(WAKE * 2 * 3), 3));
wakeGeo.setAttribute('color',
  new Float32BufferAttribute(new Float32Array(WAKE * 2 * 3), 3));
const wakeIdx = [];
for (let i = 0; i < WAKE - 1; i++) {
  const a = i * 2;
  wakeIdx.push(a, a + 1, a + 3, a, a + 3, a + 2);
}
wakeGeo.setIndex(wakeIdx);
const wake = new Mesh(wakeGeo, new MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false,
}));
wake.frustumCulled = false;
scene.add(wake);
const wakePts = [];

const TRACK = 1200;
const trackGeo = new BufferGeometry();
trackGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(TRACK * 3), 3));
trackGeo.setDrawRange(0, 0);
const track = new Line(trackGeo, new LineBasicMaterial({
  color: 0xffd97a, transparent: true, opacity: 0.8 }));
track.frustumCulled = false;
scene.add(track);
let trackN = 0;

// --- сетка на воде ------------------------------------------------------------
//
// Однородная вода не даёт ощущения хода: лодка будто висит. Сетка привязана к
// миру, а не к лодке, и переставляется шагами по ячейке — получается
// бесконечное поле, по которому видно и скорость, и снос, и поворот.

const GRID_STEP = 5, GRID_HALF = 11, GRID_SUB = 2;
const gridLines = [];
{
  const n = GRID_HALF * 2, m = n * GRID_SUB;
  for (let i = 0; i <= n; i++) {
    const a = (i - GRID_HALF) * GRID_STEP;
    for (let j = 0; j < m; j++) {
      const b0 = (j / GRID_SUB - GRID_HALF) * GRID_STEP;
      const b1 = ((j + 1) / GRID_SUB - GRID_HALF) * GRID_STEP;
      gridLines.push([a, b0], [a, b1]);          // вдоль Z
      gridLines.push([b0, a], [b1, a]);          // вдоль X
    }
  }
}
const gridGeo = new BufferGeometry();
gridGeo.setAttribute('position',
  new Float32BufferAttribute(new Float32Array(gridLines.length * 3), 3));
gridGeo.setAttribute('color',
  new Float32BufferAttribute(new Float32Array(gridLines.length * 3), 3));
const grid = new LineSegments(gridGeo, new LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false }));
grid.frustumCulled = false;
scene.add(grid);
const GRID_FADE = GRID_HALF * GRID_STEP;

function updateGrid(cx, cz, t, dx, dz, amp) {
  const ox = Math.round(cx / GRID_STEP) * GRID_STEP;
  const oz = Math.round(cz / GRID_STEP) * GRID_STEP;
  const p = gridGeo.attributes.position.array;
  const c = gridGeo.attributes.color.array;
  for (let i = 0; i < gridLines.length; i++) {
    const x = ox + gridLines[i][0], z = oz + gridLines[i][1];
    p[i * 3] = x;
    p[i * 3 + 1] = waveHeight(x, z, t, dx, dz, amp) + 0.03;
    p[i * 3 + 2] = z;
    const d = Math.max(Math.abs(gridLines[i][0]), Math.abs(gridLines[i][1]));
    const f = Math.max(0, 1 - d / GRID_FADE);
    const v = 0.35 + 0.45 * f * f;
    c[i * 3] = v; c[i * 3 + 1] = v * 1.05; c[i * 3 + 2] = v * 1.1;
  }
  gridGeo.attributes.position.needsUpdate = true;
  gridGeo.attributes.color.needsUpdate = true;
}

// --- знаки на воде ------------------------------------------------------------

function buoy(x, z, colour) {
  const g = new Group();
  const mat = new MeshStandardMaterial({ color: colour, roughness: 0.6 });
  const body = new Mesh(new CylinderGeometry(0.34, 0.42, 1.5, 12), mat);
  body.position.y = 0.55;
  const top = new Mesh(new ConeGeometry(0.34, 0.7, 12), mat);
  top.position.y = 1.6;
  g.add(body, top);
  g.position.set(x, 0, z);
  scene.add(g);
  return g;
}
[[0, -90, 0xe8683c], [0, 90, 0xe8b83c], [70, 0, 0x4a9ad4], [-70, 0, 0x4a9ad4]]
  .forEach(m => buoy(m[0], m[1], m[2]));

// --- указатель ветра над лодкой ----------------------------------------------

const arrow = new Group();
const amat = new MeshBasicMaterial({ color: 0xffcf5a });
const shaft = new Mesh(new CylinderGeometry(0.05, 0.05, 2.2, 8), amat);
shaft.rotation.z = Math.PI / 2;
const tip = new Mesh(new ConeGeometry(0.18, 0.55, 10), amat);
tip.rotation.z = -Math.PI / 2;
tip.position.x = 1.35;
arrow.add(shaft, tip);
scene.add(arrow);

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

function updateField(cx, cz, t) {
  const p = fieldGeo.attributes.position.array;
  const c = fieldGeo.attributes.color.array;
  const ox = Math.round(cx / DBG_STEP) * DBG_STEP;
  const oz = Math.round(cz / DBG_STEP) * DBG_STEP;
  const ref = boat.o.windSpeed || 1;
  for (let i = 0; i < arrowPts.length; i++) {
    const x = ox + arrowPts[i][0], z = oz + arrowPts[i][1];
    const w = boat.wind.sample(x, z, 3.0, t);
    // рисуем туда, КУДА дует: так видно, куда поедет порыв
    const dx = w.x / (w.speed || 1), dz = w.y / (w.speed || 1);
    const px = -dz, pz = dx;                       // поперёк стрелки
    const len = 2.2 + 3.4 * (w.speed / ref);
    const hw = 0.22, head = 1.3, hh = 0.62;        // полширины древка и головки
    const bx = x + dx * (len - head), bz2 = z + dz * (len - head);
    const tx = x + dx * len, tz = z + dz * len;
    let k = i * ARR_V * 3;
    const put = (ax, az) => {
      p[k] = ax; p[k + 1] = 0.36; p[k + 2] = az; k += 3;
    };
    put(x + px * hw, z + pz * hw); put(x - px * hw, z - pz * hw);
    put(bx + px * hw, bz2 + pz * hw);
    put(x - px * hw, z - pz * hw); put(bx - px * hw, bz2 - pz * hw);
    put(bx + px * hw, bz2 + pz * hw);
    put(bx + px * hh, bz2 + pz * hh); put(bx - px * hh, bz2 - pz * hh);
    put(tx, tz);
    // цвет по силе: слабее среднего синеет, сильнее — желтеет
    const s = Math.max(0, Math.min(1, (w.speed / ref - 0.7) / 0.7));
    for (let v = 0; v < ARR_V; v++) {
      const b = (i * ARR_V + v) * 3;
      c[b] = 0.35 + 0.65 * s;
      c[b + 1] = 0.65 + 0.25 * s;
      c[b + 2] = 1.0 - 0.45 * s;
    }
  }
  fieldGeo.attributes.position.needsUpdate = true;
  fieldGeo.attributes.color.needsUpdate = true;
}

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

// Цвет по углу атаки: тот же язык, что у надписи в приборах.
function alphaColour(deg) {
  if (deg < 0) return [0.35, 0.6, 1.0];                       // заполаскивает
  if (deg < 4) return [0.45, 0.85, 0.95];                     // на грани
  if (deg <= 18) return [0.35, 0.95, 0.45];                   // работает
  if (deg <= 26) return [1.0, 0.85, 0.25];                    // на срыве
  return [1.0, 0.35, 0.3];                                    // сорван
}

function updateBattens(side) {
  const p = battenGeo.attributes.position.array;
  const c = battenGeo.attributes.color.array;
  const st = boat.telemetry && boat.telemetry.strips;
  for (let i = 0; i < NSTRIP; i++) {
    const s = boat.strips[i], d = st ? st[i] : null;
    const sheet = boat.o.sheet + boat.o.twist * s.twistF;
    const ax = s.xLuff, az = 0;
    const bx = s.xLuff - s.chord * Math.cos(sheet);
    const bz = s.chord * Math.sin(sheet) * side;
    let k = i * BAT_V * 3;
    const put = (x, y, z) => { p[k] = x; p[k + 1] = y; p[k + 2] = z; k += 3; };
    put(ax, s.h - BAT_HALF, az); put(ax, s.h + BAT_HALF, az);
    put(bx, s.h - BAT_HALF, bz);
    put(ax, s.h + BAT_HALF, az); put(bx, s.h + BAT_HALF, bz);
    put(bx, s.h - BAT_HALF, bz);
    const col = alphaColour(d ? d.alphaDeg : 0);
    for (let v = 0; v < BAT_V; v++) {
      const b = (i * BAT_V + v) * 3;
      c[b] = col[0]; c[b + 1] = col[1]; c[b + 2] = col[2];
    }
  }
  battenGeo.attributes.position.needsUpdate = true;
  battenGeo.attributes.color.needsUpdate = true;
}

let debugOn = false;
function setDebug(on) {
  debugOn = on;
  field.visible = on;
  battens.visible = on;
  document.getElementById('rigcard').hidden = !on;
}

// ---------------------------------------------------------------- ввод

// Старт: галфвинд, шкот под него, ход близкий к установившемуся и включённый
// авторулевой. Без этого лодка первым делом уваливается в фордевинд, где
// парус работает одним сопротивлением, — и посмотреть на её поведение
// не получается, пока не возьмёшь руль.
const boat = new Boat(PACK);
const START_TWA = 90 * D;
boat.o.sheet = 24 * D;
boat.psi = boat.o.windDir - START_TWA;
boat.u = 4.0;
let autopilot = true;
let apHeading = boat.psi;

const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code))
    e.preventDefault();
  if (e.code === 'KeyR') {
    boat.reset();
    boat.psi = boat.o.windDir - START_TWA;
    boat.u = 4.0;
    apHeading = boat.psi;
    wakePts.length = 0;
    trackN = 0;
  }
  if (e.code === 'KeyH') { autopilot = !autopilot; apHeading = boat.psi; }
  if (e.code === 'KeyC') cycleCam();
  if (e.code === 'KeyG') setDebug(!debugOn);
});
addEventListener('keyup', e => { keys[e.code] = false; });

const ui = {};
for (const id of ['wind', 'winddir', 'hike', 'sailscale', 'gust', 'twist'])
  ui[id] = document.getElementById(id);

const CAMS = ['погоня', 'сбоку', 'с борта', 'сверху'];
let camMode = 0;
function cycleCam() {
  camMode = (camMode + 1) % CAMS.length;
  document.getElementById('cammode').textContent = CAMS[camMode];
}

// wrapPi берём из physics.js: оба файла вклеиваются в один блок, и второе
// объявление того же имени — синтаксическая ошибка на весь модуль.

function readControls(dt) {
  const o = boat.o;
  let target = 0;
  // Положительный угол пера уводит корму вправо и, значит, нос влево.
  const left = keys.ArrowLeft || keys.KeyA;
  const right = keys.ArrowRight || keys.KeyD;
  // Взялся за руль — авторулевой отключается сам. Иначе он молча перебивает
  // стрелки, и создаётся полное впечатление, что управление не работает.
  if (left || right) autopilot = false;
  if (left) target = 35 * D;
  if (right) target = -35 * D;
  if (autopilot) {
    const err = wrapPi(apHeading - boat.psi);
    target = Math.max(-25 * D, Math.min(25 * D, -(2.2 * err - 0.9 * boat.r)));
  }
  // Скорость перекладки ограничивает сама лодка (physics.js): это её
  // свойство, а не интерфейса.
  o.rudderTarget = (!target && !autopilot) ? 0 : target;

  const sr = 32 * D;
  if (keys.ArrowUp || keys.KeyW) o.sheet -= sr * dt;
  if (keys.ArrowDown || keys.KeyS) o.sheet += sr * dt;
  // Ближе семи градусов шкот не выбирается: мешают ванты и погон.
  o.sheet = Math.max(7 * D, Math.min(90 * D, o.sheet));

  o.windSpeed = parseFloat(ui.wind.value);
  const wd = parseFloat(ui.winddir.value) * D;
  if (autopilot) apHeading += wd - o.windDir;   // ветер повернули — держим TWA
  o.windDir = wd;
  o.crewHike = parseFloat(ui.hike.value);
  o.crewMass = o.crewHike > 0 ? 240 : 0;
  o.sailScale = parseFloat(ui.sailscale.value);
  o.twist = parseFloat(ui.twist.value) * D;
  // Порывистость одним ползунком: сильнее дует — сильнее и заходит. Порознь
  // эти две вещи на воде не встречаются, а два ползунка вместо одного только
  // мешают понять, что происходит.
  const gust = parseFloat(ui.gust.value);
  boat.wind.o.gust = gust;
  boat.wind.o.shift = gust * 45 * D;
}

// ---------------------------------------------------------------- цикл

let acc = 0, last = performance.now() / 1000, tick = 0;
const camPos = new Vector3(-14, 5, 0);
const camAim = new Vector3();
const prev = { x: 0, y: 0, psi: 0, phi: 0 };

function resize() {
  const r = stage.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  renderer.setSize(r.width, r.height, true);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
// Одного вызова мало: на момент запуска модуля раскладка ещё может не
// устояться, и холст остаётся размером в угол экрана. ResizeObserver ловит
// это надёжнее, чем окно.
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(stage);
resize();

function frame() {
  const now = performance.now() / 1000;
  const dt = Math.min(0.25, now - last);
  last = now;
  acc += dt;

  let steps = 0;
  while (acc >= DT && steps < 8) {
    prev.x = boat.x; prev.y = boat.y; prev.psi = boat.psi; prev.phi = boat.phi;
    readControls(DT);
    boat.step(DT);
    if (![boat.x, boat.y, boat.psi, boat.phi, boat.u, boat.v].every(Number.isFinite)) {
      boat.reset(); boat.u = 1;
      const box = document.getElementById('crash');
      box.hidden = false;
      box.textContent = 'Физика разошлась, состояние сброшено. Проверьте make test.';
      acc = 0;
      break;
    }
    acc -= DT;
    steps++;
  }
  const a = Math.min(1, acc / DT);
  const ix = prev.x + (boat.x - prev.x) * a;
  const iy = prev.y + (boat.y - prev.y) * a;
  const ipsi = prev.psi + wrapPi(boat.psi - prev.psi) * a;
  const iphi = prev.phi + (boat.phi - prev.phi) * a;
  const t = boat.telemetry || {};

  boatGroup.position.set(ix, 0, iy);
  boatGroup.rotation.order = 'YXZ';
  boatGroup.rotation.y = -ipsi;
  boatGroup.rotation.x = -iphi;
  rudderPivot.rotation.y = -boat.o.rudder;

  const awAngle = boat.apparentWind().angle;
  const side = awAngle > 0 ? 1 : -1;
  shapeSails(boat.o.sheet, side, (t.alphaDeg || 0) < 4);

  const amp = 0.10 + 0.035 * boat.o.windSpeed;
  sea.position.set(Math.round(ix / CELL) * CELL, 0, Math.round(iy / CELL) * CELL);
  const dirX = Math.cos(boat.o.windDir), dirZ = Math.sin(boat.o.windDir);
  const pos = seaGeo.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i + 1] = waveHeight(seaBase[i] + sea.position.x,
                            seaBase[i + 2] + sea.position.z, now, dirX, dirZ, amp);
  }
  seaGeo.attributes.position.needsUpdate = true;
  if ((tick & 1) === 0) seaGeo.computeVertexNormals();
  // Рябь от порывов меняется медленно — по метру между обновлениями, — так что
  // каждый третий кадр её хватает, а перекраска всей воды не бесплатная.
  if ((tick % 3) === 0) paintSea(now);
  updateGrid(ix, iy, now, dirX, dirZ, amp);
  if (debugOn) {
    updateField(ix, iy, now);
    updateBattens(side);
  }

  const spd = t.speed || 0;
  if ((tick % 2) === 0) {
    wakePts.unshift({
      x: ix - 2.9 * Math.cos(ipsi), z: iy - 2.9 * Math.sin(ipsi),
      psi: ipsi, w: 0.30 + 0.07 * spd });
    if (wakePts.length > WAKE) wakePts.length = WAKE;
  }
  const wp = wakeGeo.attributes.position.array;
  const wc = wakeGeo.attributes.color.array;
  for (let i = 0; i < wakePts.length; i++) {
    const p = wakePts[i];
    const f = 1 - i / WAKE;
    const w = p.w * (0.8 + 0.9 * (1 - f));
    const nx = -Math.sin(p.psi), nz = Math.cos(p.psi);
    wp[i * 6] = p.x + nx * w; wp[i * 6 + 1] = 0.05; wp[i * 6 + 2] = p.z + nz * w;
    wp[i * 6 + 3] = p.x - nx * w; wp[i * 6 + 4] = 0.05; wp[i * 6 + 5] = p.z - nz * w;
    const b = f * f * Math.min(1, spd / 3);
    for (let k = 0; k < 6; k++) wc[i * 6 + k] = 0.75 + 0.25 * b;
  }
  // Рисуем только накопленные звенья: иначе хвост схлопывается в одну точку
  // и получается веер поперёк всей акватории.
  wakeGeo.setDrawRange(0, Math.max(0, (wakePts.length - 1) * 6));
  wakeGeo.attributes.position.needsUpdate = true;
  wakeGeo.attributes.color.needsUpdate = true;
  wake.material.opacity = 0.12 + 0.45 * Math.min(1, spd / 4);

  if ((tick % 6) === 0 && trackN < TRACK) {
    const tp = trackGeo.attributes.position.array;
    tp[trackN * 3] = ix; tp[trackN * 3 + 1] = 0.06; tp[trackN * 3 + 2] = iy;
    trackN++;
    trackGeo.setDrawRange(0, trackN);
    trackGeo.attributes.position.needsUpdate = true;
  }

  arrow.position.set(ix + 4 * Math.cos(boat.o.windDir), 6.2,
                     iy + 4 * Math.sin(boat.o.windDir));
  arrow.rotation.y = Math.PI - boat.o.windDir;

  // Орты лодки в сцене: куда смотрит нос и где правый борт. Через них
  // камеры пишутся без тригонометрии в каждой строке и, главное, без шанса
  // случайно поставить камеру не с того борта.
  const bx = ix, bz = iy;
  const fx = Math.cos(ipsi), fz = Math.sin(ipsi);      // в нос
  const sx = -Math.sin(ipsi), sz = Math.cos(ipsi);     // на правый борт
  const at = (fwd, stb, h) =>
    new Vector3(bx + fwd * fx + stb * sx, h, bz + fwd * fz + stb * sz);
  let want;
  if (camMode === 0) want = at(-13, 2.5, 4.6);
  else if (camMode === 1) want = at(-2, 5, 3.0);
  else if (camMode === 2) want = at(-1.2, 1.0, 1.9);
  else want = at(-2, 0, 28);
  camPos.lerp(want, 1 - Math.pow(camMode === 2 ? 1e-7 : 0.004, dt));
  camera.position.copy(camPos);
  camAim.lerp(at(2, 0, camMode === 3 ? 0 : 1.4), 1 - Math.pow(0.004, dt));
  camera.lookAt(camAim);

  renderer.render(scene, camera);
  if ((tick % 3) === 0) { updateHud(t); updateRose(t); if (debugOn) updateRig(t); }
  tick++;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- приборы

const HUD_ROWS = [
  ['vmg', 'VMG', 'уз', 2],
  ['heelDeg', 'Крен', '°', 1],
  ['leewayDeg', 'Дрейф', '°', 1],
  ['twaAbsDeg', 'Истинный ветер', '°', 0],
  ['awaDeg', 'Кажущийся', '°', 0],
  ['awsKn', 'Скорость кажущегося', 'уз', 1],
  ['alphaDeg', 'Угол атаки паруса', '°', 1],
  ['driveN', 'Тяга', 'Н', 0],
  ['resistN', 'Сопротивление', 'Н', 0],
];

function updateHud(t) {
  if (!t) return;
  const rows = HUD_ROWS.map(([k, label, unit, prec]) =>
    '<tr><td>' + label + '</td><td class="v">' +
    (t[k] == null ? '—' : (+t[k]).toFixed(prec)) +
    '</td><td class="u">' + unit + '</td></tr>').join('');
  const al = t.alphaDeg || 0;
  const luff = al < 4 ? ' <em>заполаскивает</em>'
             : (al > 24 ? ' <em>перебрано</em>' : '');
  hud.innerHTML =
    '<div class="big">' + (t.speedKn || 0).toFixed(2) + ' <span>уз</span></div>' +
    '<table>' + rows + '</table>' +
    '<div class="ctl">руль ' + (boat.o.rudder / D).toFixed(0) +
    '°&nbsp;&nbsp;шкот ' + (boat.o.sheet / D).toFixed(0) + '°' + luff +
    (autopilot ? '&nbsp;&nbsp;<b>авторулевой</b>' : '') + '</div>';
}

// Роза: лодка всегда носом вверх, стрелки показывают, откуда дует истинный и
// кажущийся ветер, серая линия — положение паруса. По ней видно, добран шкот
// или вынесен, не заглядывая в цифры.
function updateRose(t) {
  if (!t) return;
  const R = 46;
  // Ноль наверху — нос, положительный угол вправо, то есть на правый борт.
  const pt = (ang, r) => [56 + r * Math.sin(ang), 56 - r * Math.cos(ang)];
  // Ветер справа — вектор кажущегося дует на левый борт, то есть ay < 0.
  const stbd = boat.apparentWind().angle > 0 ? -1 : 1;
  const tw = (t.twaAbsDeg || 0) * D * stbd;
  const aw = (t.awaDeg || 0) * D * stbd;
  const [tx, ty] = pt(tw, R - 3);
  const [ax, ay] = pt(aw, R - 3);
  // Парус вынесен под ветер, то есть на борт, противоположный ветру.
  const [sx, sy] = pt(Math.PI + boat.o.sheet * stbd, R - 16);
  rose.innerHTML =
    '<circle cx="56" cy="56" r="46" class="ring"/>' +
    '<circle cx="56" cy="56" r="30" class="ring2"/>' +
    '<path d="M56 20 L67 76 L56 68 L45 76 Z" class="boat"/>' +
    '<line x1="56" y1="56" x2="' + sx.toFixed(1) + '" y2="' + sy.toFixed(1) +
      '" class="sail"/>' +
    '<line x1="' + tx.toFixed(1) + '" y1="' + ty.toFixed(1) +
      '" x2="56" y2="56" class="tw"/>' +
    '<line x1="' + ax.toFixed(1) + '" y1="' + ay.toFixed(1) +
      '" x2="56" y2="56" class="aw"/>';
}

// Панель рига: что происходит по высоте паруса.
//
// Три столбца с общей вертикальной осью — высотой над водой. Первый показывает
// профиль ветра, второй угол атаки каждой полоски, третий её вклад в боковую
// силу. Вместе они отвечают на вопрос, ради которого всё это и делалось:
// почему верх паруса работает не так, как низ, и что с этим делает твист.
const rigSvg = document.getElementById('rig');
const RIG_W = 96, RIG_H = 132, RIG_PAD = 16;

function updateRig(t) {
  const st = t && t.strips;
  if (!st) return;
  const H = rig.mast_height_m;
  const y = h => RIG_H - RIG_PAD - (h / H) * (RIG_H - 2 * RIG_PAD);
  const main = st.slice(0, 6), jib = st.slice(6);

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
      alphaColour(s.alphaDeg).map(v => Math.round(v * 255)).join(',') + ')"/>';
  svg += '</g>';

  // --- вклад в боковую силу: видно, где парус на самом деле кренит
  const fMax = Math.max(1, ...st.map(s => Math.abs(s.side)));
  svg += axis(2, 'боковая, Н', [[8, '0'], [RIG_W - 34, fMax.toFixed(0)]]);
  for (const [arr, cls] of [[main, 'bm'], [jib, 'bj']]) {
    for (const s of arr) {
      const w = (Math.abs(s.side) / fMax) * (RIG_W - 22);
      svg += '<rect class="' + cls + '" x="8" y="' + (y(s.z) - 2.6).toFixed(1) +
        '" width="' + Math.max(0.4, w).toFixed(1) + '" height="5.2"/>';
    }
  }
  svg += '</g>';

  rigSvg.innerHTML = svg;
  document.getElementById('rignote').innerHTML =
    'ЦП по нагрузке <b>' + (t.ceHeightM || 0).toFixed(2) + ' м</b>' +
    ' &nbsp;·&nbsp; твист <b>' + (boat.o.twist / D).toFixed(0) + '°</b>' +
    ' &nbsp;·&nbsp; ветер у рига <b>' + (t.twsKn || 0).toFixed(1) + '</b> уз';
}

document.getElementById('cammode').textContent = CAMS[camMode];
shapeSails(boat.o.sheet, 1, false);
setDebug(false);
frame();
