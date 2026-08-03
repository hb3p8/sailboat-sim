// Просмотр выгруженной акватории. Сборка three вклеена выше, в тот же модуль,
// поэтому импортировать нечего.
//
// Задача страницы одна: посмотреть глазами, что вообще приехало из открытых
// источников — попадает ли берег на своё место, есть ли острова, читается ли
// рельеф. Ни физики, ни лодки здесь нет и быть не должно: пока не видно, что
// данные годные, встраивать их некуда.
//
// Мир — трёхмерная система three (Y вверх), метры. Данные приходят в плоской
// метрической системе с началом в центре участка: X на восток, Y на север.
// Перевод один и здесь: three = (x, высота, −y). Север, значит, в −Z.

const stage = document.getElementById('stage');
const T = TERRAIN;
const RAD = Math.PI / 180;

// Высоты лежат в дециметрах: диапазон тут сотни метров, а десятая доля метра
// мельче всего, что в этих данных различимо.
function unb64(s, Type) {
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Type(buf.buffer);
}
const H = unb64(T.height_dm_b64, Int16Array);
const WET = unb64(T.water_b64, Uint8Array);

const NX = T.nx, NY = T.ny, STEP = T.step, LEVEL = T.level;
const WIDTH = (NX - 1) * STEP, DEPTH = (NY - 1) * STEP;

// ------------------------------------------------------------------ сцена

const scene = new Scene();
const SKY = new Color(0x9fb6c9);
scene.background = SKY;
scene.fog = new Fog(SKY, 8000, 42000);

// Ближняя плоскость выставляется по режиму, а не задаётся раз навсегда, и это
// не тонкая настройка, а условие того, чтобы картинка вообще была. Разрешение
// буфера глубины падает как квадрат расстояния: при near = 1 на четырнадцати
// километрах оно около двенадцати метров, то есть больше, чем весь надводный
// берег в пойме. Плоскость воды при этом перекрывает сушу, и весь участок
// выглядит сплошной водой — ровно так первая сборка и выглядела. Поднятая
// ближняя плоскость возвращает разрешение к долям метра.
const camera = new PerspectiveCamera(50, 1, 20, 80000);

// WebGPU, как в симуляторе и просмотрщике: сборка three в проекте одна на все
// три страницы. Нет WebGPU — рендерер сам откатится на WebGL2.
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
stage.appendChild(renderer.domElement);

scene.add(new HemisphereLight(0xdcecff, 0x39424a, 1.5));
const sun = new DirectionalLight(0xfff4e2, 2.4);
scene.add(sun);
let sunAz = 315;
function placeSun() {
  const a = sunAz * RAD;
  sun.position.set(Math.sin(a) * 8000, 6000, -Math.cos(a) * 8000);
}
placeSun();

// ------------------------------------------------------------------ рельеф
//
// Ровно та же сетка, что в данных: узел в узел, без пересчёта. Треугольников
// выходит под два миллиона — много, но это разовая статичная геометрия, и
// упрощать её сейчас значит смотреть не на то, что выгрузилось.

const pos = new Float32Array(NX * NY * 3);
const col = new Float32Array(NX * NY * 3);

// Гипсометрическая шкала: от поймы к плато. Отсчёт от уреза, а не от нуля
// высот, — на реке значение имеет высота над водой, а не над Балтикой.
const RAMP = [
  [0.0, 0x4d6b4a], [6.0, 0x6f8352], [18.0, 0x8b9159],
  [40.0, 0xa89a6c], [80.0, 0xc0b189], [140.0, 0xdcd5c0],
];

const c = new Color();
function tint(dh, banded) {
  if (banded) dh = Math.floor(dh / 10) * 10;
  let i = 0;
  while (i < RAMP.length - 2 && dh > RAMP[i + 1][0]) i++;
  const [a, ca] = RAMP[i], [b, cb] = RAMP[i + 1];
  const t = Math.max(0, Math.min(1, (dh - a) / (b - a)));
  return c.setHex(ca).lerp(new Color(cb), t);
}

function paint(banded) {
  for (let iy = 0, k = 0; iy < NY; iy++)
    for (let ix = 0; ix < NX; ix++, k++) {
      const dh = H[k] / 10 - LEVEL;
      // Дно под водой — свой цвет: иначе мель читается как суша, и вся маска
      // берега на просмотре теряет смысл.
      const t = WET[k] > 127 ? c.setHex(0x2f4a52) : tint(dh, banded);
      col[k * 3] = t.r; col[k * 3 + 1] = t.g; col[k * 3 + 2] = t.b;
    }
  landGeo.attributes.color.needsUpdate = true;
}

for (let iy = 0, k = 0; iy < NY; iy++)
  for (let ix = 0; ix < NX; ix++, k++) {
    pos[k * 3] = ix * STEP - WIDTH / 2;
    pos[k * 3 + 1] = H[k] / 10;
    pos[k * 3 + 2] = -(iy * STEP - DEPTH / 2);
  }

// Намотка против часовой при взгляде сверху. Проверять это надо на бумаге, а
// не на глаз: ось Z смотрит на юг (север у нас в −Z), от этого «очевидный»
// порядок обхода даёт нормали вниз — и вся суша уходит в отбраковку задних
// граней. Экран при этом показывает пустую воду, а не вывернутый рельеф, и
// искать причину приходится там, где её нет.
const idx = new Uint32Array((NX - 1) * (NY - 1) * 6);
for (let iy = 0, t = 0; iy < NY - 1; iy++)
  for (let ix = 0; ix < NX - 1; ix++) {
    const a = iy * NX + ix, b = a + 1, d = a + NX, e = d + 1;
    idx[t++] = a; idx[t++] = b; idx[t++] = d;
    idx[t++] = b; idx[t++] = e; idx[t++] = d;
  }

const landGeo = new BufferGeometry();
landGeo.setAttribute('position', new BufferAttribute(pos, 3));
landGeo.setAttribute('color', new BufferAttribute(col, 3));
landGeo.setIndex(new BufferAttribute(idx, 1));
paint(false);
landGeo.computeVertexNormals();

const land = new Mesh(landGeo, new MeshStandardMaterial({
  vertexColors: true, roughness: 0.95, metalness: 0.0 }));
scene.add(land);

// -------------------------------------------------------------------- вода
//
// Только по мокрым ячейкам маски, а не плоскостью на весь участок. Плоскостью
// проще, и первая сборка так и делала, — но над поймой она проходит в
// полуметре от суши, а разрешение буфера глубины на пятнадцати километрах как
// раз этого порядка. Вода начинает спорить с землёй, и низкий берег покрывался
// полосатой рябью. Здесь спорить нечему: над сушей воды просто нет, а дно под
// водой лежит минимум на метр с лишним ниже уреза — это гарантирует откос от
// берега, которым дно и рисуется.
//
// Заодно так видно ровно то, что проверяем: поверхность воды и есть маска OSM,
// без посредников.

const wpos = [], widx = [];
{
  const node = new Int32Array(NX * NY).fill(-1);
  const put = (ix, iy) => {
    const k = iy * NX + ix;
    if (node[k] < 0) {
      node[k] = wpos.length / 3;
      wpos.push(ix * STEP - WIDTH / 2, LEVEL, -(iy * STEP - DEPTH / 2));
    }
    return node[k];
  };
  for (let iy = 0; iy < NY - 1; iy++)
    for (let ix = 0; ix < NX - 1; ix++) {
      const a = iy * NX + ix;
      if (WET[a] <= 127 && WET[a + 1] <= 127 &&
          WET[a + NX] <= 127 && WET[a + NX + 1] <= 127) continue;
      const p0 = put(ix, iy), p1 = put(ix + 1, iy),
            p2 = put(ix + 1, iy + 1), p3 = put(ix, iy + 1);
      widx.push(p0, p1, p3, p1, p2, p3);
    }
}
const waterGeo = new BufferGeometry();
waterGeo.setAttribute('position',
  new BufferAttribute(new Float32Array(wpos), 3));
waterGeo.setIndex(widx);
waterGeo.computeVertexNormals();

// Матовее и без металла нарочно. Гладкая блестящая вода на скользящем взгляде
// с высоты глаза отражает небо и становится с ним одного цвета — красиво, но
// смотреть тут надо на границу воды и суши, а она в такой картинке пропадает.
const water = new Mesh(waterGeo, new MeshStandardMaterial({
  color: 0x2c6a8c, roughness: 0.45, metalness: 0.05,
  transparent: true, opacity: 0.9 }));
scene.add(water);

// ------------------------------------------------------------------- сетка
//
// Километровая сетка — линейка, а не часть местности, поэтому рисуется поверх
// рельефа без проверки глубины. Лежи она на урезе с проверкой, её съедал бы
// берег ровно там, где мерить и нужно.

const gl = [];
for (let x = -WIDTH / 2; x <= WIDTH / 2 + 1; x += 1000)
  gl.push(x, LEVEL, -DEPTH / 2, x, LEVEL, DEPTH / 2);
for (let z = -DEPTH / 2; z <= DEPTH / 2 + 1; z += 1000)
  gl.push(-WIDTH / 2, LEVEL, z, WIDTH / 2, LEVEL, z);
const gridGeo = new BufferGeometry();
gridGeo.setAttribute('position', new BufferAttribute(new Float32Array(gl), 3));
const grid = new LineSegments(gridGeo, new LineBasicMaterial({
  color: 0xffffff, transparent: true, opacity: 0.2, depthTest: false }));
scene.add(grid);

// --------------------------------------------------------------- вертикаль
//
// Участок пятнадцать километров, а перепад полтораста метров: в честном
// масштабе берег выглядит плоским, хотя на воде он совсем не плоский.
// Поэтому подъём высот — орган управления, а не константа, и по умолчанию он
// единица: сначала надо увидеть, как оно есть.

let exag = 1;
function applyExag() {
  // Растяжение вокруг уреза, а не вокруг нуля высот: урез обязан остаться на
  // месте, иначе вода при подъёме уезжает от берега.
  land.scale.y = exag;
  land.position.y = LEVEL * (1 - exag);
}

// ------------------------------------------------------------------- камера
//
// Два режима. Облёт — посмотреть на участок целиком. С воды — глазами с
// лодки: только так и видно, читается ли берег как берег, а не как рельефная
// картинка сверху.

// Взгляд с северо-запада, от низкого берега на высокий: так видно и русло с
// островами, и обрыв правого берега в лицо, а не с изнанки. Солнце в той же
// четверти, поэтому склоны читаются, а не слепят.
const cam = { az: 200 * RAD, el: 25 * RAD, dist: 13000,
              target: new Vector3(0, LEVEL, -600) };
// Глаз ставится на середину самого широкого плёса и разворачивается на высшую
// точку берега — оба места посчитаны при выгрузке. Ближайшая к центру вода не
// годится: попасть можно в протоку шириной в полсотни метров, и весь обзор
// упрётся в ближний берег.
const eye = { x: T.open_water[0], z: -T.open_water[1], h: 1.6,
              az: Math.atan2(T.high_point[0] - T.open_water[0],
                             -(T.high_point[1] - T.open_water[1])),
              el: -1 * RAD };
let mode = 'orbit';
let needsDraw = true;

function place() {
  if (mode === 'orbit') {
    const r = cam.dist * Math.cos(cam.el);
    camera.position.set(
      cam.target.x + r * Math.sin(cam.az),
      cam.target.y + cam.dist * Math.sin(cam.el),
      cam.target.z + r * Math.cos(cam.az));
    camera.lookAt(cam.target);
    const near = Math.max(5, cam.dist / 400);
    if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
  } else {
    camera.position.set(eye.x, LEVEL + eye.h, eye.z);
    camera.lookAt(
      eye.x + Math.sin(eye.az) * Math.cos(eye.el),
      LEVEL + eye.h + Math.sin(eye.el),
      eye.z + Math.cos(eye.az) * Math.cos(eye.el));
    if (camera.near !== 1) { camera.near = 1; camera.updateProjectionMatrix(); }
  }
}

// --------------------------------------------------------------------- ввод

let drag = null;
const el = renderer.domElement;
el.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 };
  el.setPointerCapture(e.pointerId);
});
el.addEventListener('pointermove', e => {
  if (!drag) return;
  if (e.buttons === 0) { drag = null; return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (mode === 'eye') {
    eye.az -= dx * 0.004;
    eye.el = Math.max(-40 * RAD, Math.min(40 * RAD, eye.el - dy * 0.004));
  } else if (drag.pan) {
    const k = cam.dist * 2 * Math.tan(camera.fov * RAD / 2) / stage.clientHeight;
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  } else {
    cam.az -= dx * 0.005;
    cam.el = Math.max(1 * RAD, Math.min(89 * RAD, cam.el + dy * 0.005));
  }
  needsDraw = true;
});
const stopDrag = () => { drag = null; };
el.addEventListener('pointerup', stopDrag);
el.addEventListener('pointercancel', stopDrag);
el.addEventListener('wheel', e => {
  e.preventDefault();
  if (mode === 'orbit')
    cam.dist = Math.max(200, Math.min(40000,
      cam.dist * Math.exp(e.deltaY * 0.0012)));
  needsDraw = true;
}, { passive: false });

// Ход с воды: WASD и стрелки. Скорость в узлах, чтобы масштаб плёса
// чувствовался тем же способом, каким его чувствуют на воде.
const keys = new Set();
addEventListener('keydown', e => {
  if (e.key === ' ') { setMode(mode === 'orbit' ? 'eye' : 'orbit'); e.preventDefault(); }
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

function walk(dt) {
  if (mode !== 'eye') return;
  const fast = keys.has('shift') ? 6 : 1;
  const v = 3.0 * fast * dt;              // м/с — примерно ход шестёрки
  let f = 0, s = 0;
  if (keys.has('w') || keys.has('arrowup')) f += 1;
  if (keys.has('s') || keys.has('arrowdown')) f -= 1;
  if (keys.has('a') || keys.has('arrowleft')) s -= 1;
  if (keys.has('d') || keys.has('arrowright')) s += 1;
  if (!f && !s) return;
  const sa = Math.sin(eye.az), ca = Math.cos(eye.az);
  eye.x += (sa * f + ca * s) * v * 40;
  eye.z += (ca * f - sa * s) * v * 40;
  eye.x = Math.max(-WIDTH / 2, Math.min(WIDTH / 2, eye.x));
  eye.z = Math.max(-DEPTH / 2, Math.min(DEPTH / 2, eye.z));
  needsDraw = true;
}

// ------------------------------------------------------------------ органы

function setMode(m) {
  mode = m;
  if (m === 'eye') {
    scene.fog.near = 300; scene.fog.far = 16000;
  } else {
    scene.fog.near = 8000; scene.fog.far = 42000;
  }
  document.getElementById('hint').style.display = m === 'eye' ? 'block' : 'none';
  for (const b of document.querySelectorAll('#modes button'))
    b.classList.toggle('on', b.dataset.mode === m);
  needsDraw = true;
}


const bind = (id, fn) => {
  const e = document.getElementById(id);
  const show = () => { fn(+e.value); needsDraw = true; };
  e.addEventListener('input', show);
  show();
};
bind('exag', v => {
  exag = v; applyExag();
  document.getElementById('v-exag').textContent = '×' + v.toFixed(1);
});
bind('sunaz', v => {
  sunAz = v; placeSun();
  document.getElementById('v-sunaz').textContent = v.toFixed(0) + '°';
});
document.getElementById('banded').addEventListener('change', e => {
  paint(e.target.checked); needsDraw = true;
});
document.getElementById('grid').addEventListener('change', e => {
  grid.visible = e.target.checked; needsDraw = true;
});
for (const b of document.querySelectorAll('#modes button'))
  b.addEventListener('click', () => setMode(b.dataset.mode));

// ------------------------------------------------------------------- сводка

document.getElementById('facts').innerHTML = [
  ['Участок', (T.size[0] / 1000).toFixed(2) + ' × ' + (T.size[1] / 1000).toFixed(2) + ' км'],
  ['Сетка', T.nx + ' × ' + T.ny + ', шаг ' + T.step + ' м'],
  ['Урез', T.level.toFixed(1) + ' м'],
  ['Высоты', T.hmin.toFixed(0) + '…' + T.hmax.toFixed(0) + ' м'],
  ['Над водой', (T.hmax - T.level).toFixed(0) + ' м'],
  ['Воды', (100 * T.water_fraction).toFixed(1) + '% площади'],
].map(([k, v]) => '<tr><td>' + k + '</td><td class="v">' + v + '</td></tr>').join('');

// ------------------------------------------------------------------- кадр

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  needsDraw = true;
}
addEventListener('resize', resize);

let last = performance.now();
function frame() {
  const now = performance.now();
  walk(Math.min(0.05, (now - last) / 1000));
  last = now;
  if (needsDraw) {
    place();
    renderer.render(scene, camera);
    needsDraw = false;
  }
  requestAnimationFrame(frame);
}

applyExag();
setMode('orbit');
renderer.init().then(() => { resize(); frame(); }).catch(err => {
  document.getElementById('crash').textContent = 'Рендерер не поднялся: ' + err;
  document.getElementById('crash').style.display = 'block';
});

