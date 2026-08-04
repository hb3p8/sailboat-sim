// Инструменты акватории: поля физики глазами и разметка руками.
//
// Всё, что ниже, работает только когда страница открыта с сервера
// (`make serve`). Причина простая: пакет физики нужно прочитать, а разметку —
// записать, и ни того, ни другого `file://` не позволяет. Без сервера страница
// остаётся ровно тем, чем была, — просмотром выгруженного рельефа, — и говорит
// об этом вслух, а не молчит с пустой панелью.
//
// **Поля физики читаются тем же кодом, что считает силы.** `sim/terrain.js`
// вклеен в эту страницу целиком, и `Terrain`, `fetchFactor`, `shelterFactor`,
// `channelTurn` здесь те самые. Написать «примерно то же самое, но для
// картинки» было бы худшим из возможных решений: расхождение такой пары не
// ловится ничем, а смотрят на неё именно затем, чтобы поверить числам.
//
// Разметка — это то, чего в открытых источниках нет и не будет: где осмысленно
// стартовать, где стоят знаки, где идут суда. Ставится она глазами по этой
// картинке, а живёт в `data/marks.json` рядом с кодом.

const API = '/api/marks';

// Оси: данные приходят в плоской метрической системе (X на восток, Y на север),
// сцена — three (Y вверх, север в −Z). Перевод тот же, что у рельефа выше.
const sx = x => x;
const sz = y => -y;

let PACK = null;         // пакет физики, тот же, что читает симулятор
let TER = null;          // sim/terrain.js поверх него
let MARKS = { starts: [], buoys: [], fairway: [] };
let dirty = false;

// --------------------------------------------------------------- слои

const layers = new Group();
scene.add(layers);

// Поле поверх воды: та же геометрия, что у воды, только раскрашенная и чуть
// приподнятая. Своя геометрия, а не общая: у воды нет цвета по вершинам, и
// добавлять его туда значило бы менять то, ради чего страница и заводилась.
const fieldGeo = new BufferGeometry();
{
  const p = waterGeo.attributes.position.array;
  const q = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    q[i] = p[i]; q[i + 1] = p[i + 1] + 1.0; q[i + 2] = p[i + 2];
  }
  fieldGeo.setAttribute('position', new BufferAttribute(q, 3));
  fieldGeo.setAttribute('color', new BufferAttribute(new Float32Array(p.length), 3));
  fieldGeo.setIndex(waterGeo.index);
}
const fieldMesh = new Mesh(fieldGeo, new MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.85 }));
fieldMesh.visible = false;
layers.add(fieldMesh);

// Стрелки — плоские фигурки из трёх треугольников, как в симуляторе: линия в
// один пиксель на пятнадцати километрах не видна вовсе.
const ARR_V = 9;
function arrowLayer(colour, order) {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
  const m = new Mesh(g, new MeshBasicMaterial({
    color: colour, transparent: true, opacity: 0.9,
    depthTest: false, side: DoubleSide }));
  m.frustumCulled = false;
  m.renderOrder = order;
  m.visible = false;
  layers.add(m);
  return m;
}
const curArrows = arrowLayer(0x2f6fd8, 4);
const windArrows = arrowLayer(0x3fbf9f, 5);
const axisLines = arrowLayer(0xd8a03f, 3);

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

// Узлы выборки: сетка по воде. Шаг и длина стрелок идут за дальностью камеры —
// поле обязано читаться и с пятнадцати километров, и с полукилометра, а
// стометровая стрелка на облёте невидима, тогда как вблизи она в полэкрана.
// Пересчёт редкий: только когда масштаб сменился заметно.
let nodes = [];
function fieldScale() { return Math.max(0.12, Math.min(2, cam.dist / 9000)); }
function buildNodes(stepM) {
  nodes = [];
  const half = stepM / 2;
  for (let y = PACK.y0 + half; y < PACK.y0 + PACK.cny * PACK.coarse; y += stepM)
    for (let x = PACK.x0 + half; x < PACK.x0 + PACK.cnx * PACK.coarse; x += stepM) {
      const d = TER.shore(x, y);
      if (d !== null && d > 0) nodes.push(x, y);
    }
}

// --------------------------------------------------------------- поля

// Шкала последовательная и одноцветная — от светлого к тёмному, как и положено
// величине без середины. Радуга тут была бы ложью: у множителя ветра нет ни
// полюсов, ни нуля посередине, и разноцветные полосы придумали бы ему структуру,
// которой нет.
const RAMPS = {
  cold: [[0.94, 0.97, 1.00], [0.55, 0.78, 0.92], [0.16, 0.45, 0.72], [0.05, 0.18, 0.38]],
  warm: [[1.00, 0.97, 0.88], [0.98, 0.82, 0.48], [0.90, 0.53, 0.22], [0.50, 0.20, 0.10]],
};
function ramp(name, t) {
  const r = RAMPS[name];
  const u = Math.max(0, Math.min(1, t)) * (r.length - 1);
  const i = Math.min(r.length - 2, Math.floor(u)), f = u - i;
  return [r[i][0] + (r[i + 1][0] - r[i][0]) * f,
          r[i][1] + (r[i + 1][1] - r[i][1]) * f,
          r[i][2] + (r[i + 1][2] - r[i][2]) * f];
}

// Каждое поле — своя величина, свои границы и своя подпись. Всё в одном месте:
// добавить поле должно значить дописать строку, а не править четыре функции.
const FIELDS = {
  none: null,
  wind: {
    title: 'Множитель скорости ветра', ramp: 'cold', lo: 0.3, hi: 1.0,
    fmt: v => '×' + v.toFixed(2),
    at: (x, y, o) => fetchFactor(TER.fetch(x, y, o.dir), WIND_SHORE_A, WIND_SHORE_L) *
                     shelterFactor(TER.skyline(x, y, o.dir), o.d0, o.k),
  },
  shelter: {
    title: 'Укрытие берегом', ramp: 'cold', lo: 0.3, hi: 1.0,
    fmt: v => '×' + v.toFixed(2),
    at: (x, y, o) => shelterFactor(TER.skyline(x, y, o.dir), o.d0, o.k),
  },
  fetch: {
    title: 'Разгон волны', ramp: 'warm', lo: 0, hi: 4000,
    fmt: v => v < 1000 ? v.toFixed(0) + ' м' : (v / 1000).toFixed(1) + ' км',
    at: (x, y, o) => TER.fetch(x, y, o.dir),
  },
  current: {
    title: 'Скорость течения', ramp: 'warm', lo: 0, hi: 1.2,
    fmt: v => v.toFixed(2) + ' м/с',
    at: (x, y, o) => { TER.current(x, y, o.cur, tmpV); return Math.hypot(tmpV.x, tmpV.y); },
  },
  chan: {
    title: 'Сила канализации', ramp: 'warm', lo: 0, hi: 1,
    fmt: v => (v * 100).toFixed(0) + '%',
    at: (x, y) => { TER.channel(x, y, tmpV); return Math.hypot(tmpV.x, tmpV.y); },
  },
};
const tmpV = { x: 0, y: 0 };

const opts = { field: 'none', dir: 100 * RAD, d0: 0.5, k: 10, chan: 0.5, cur: 0.55 };

function paintField() {
  const f = FIELDS[opts.field];
  fieldMesh.visible = !!f;
  if (!f) { legend(null); return; }
  const p = fieldGeo.attributes.position.array;
  const c = fieldGeo.attributes.color.array;
  for (let i = 0; i < p.length; i += 3) {
    // Сцена → метрическая система выгрузки: обратно тот же перевод.
    const v = f.at(p[i], -p[i + 2], opts);
    const rgb = ramp(f.ramp, v === null ? 0 : (v - f.lo) / (f.hi - f.lo));
    c[i] = rgb[0]; c[i + 1] = rgb[1]; c[i + 2] = rgb[2];
  }
  fieldGeo.attributes.color.needsUpdate = true;
  legend(f);
}

function legend(f) {
  const box = document.getElementById('legend');
  if (!f) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const stops = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const rgb = ramp(f.ramp, t).map(v => Math.round(v * 255));
    return 'rgb(' + rgb.join(',') + ')';
  });
  box.innerHTML = '<div class="lt">' + f.title + '</div>' +
    '<div class="lbar" style="background:linear-gradient(90deg,' + stops.join(',') + ')"></div>' +
    '<div class="lends"><span>' + f.fmt(f.lo) + '</span><span>' + f.fmt(f.hi) + '</span></div>';
}

function fillArrows(mesh, len, hw, hh, head, y, dirAt) {
  const n = nodes.length / 2;
  let p = mesh.geometry.attributes.position.array;
  if (p.length !== n * ARR_V * 3) {
    p = new Float32Array(n * ARR_V * 3);
    mesh.geometry.setAttribute('position', new BufferAttribute(p, 3));
  }
  for (let i = 0; i < n; i++) {
    const x = nodes[2 * i], yy = nodes[2 * i + 1];
    const d = dirAt(x, yy);
    if (!d) { p.fill(0, i * ARR_V * 3, (i + 1) * ARR_V * 3); continue; }
    putArrow(p, i * ARR_V * 3, sx(x), sz(yy), d.x, -d.y,
             len * d.s, hw * d.s, hh * d.s, head * d.s, y);
  }
  mesh.geometry.attributes.position.needsUpdate = true;
}

function paintArrows() {
  const L = 190 * fieldS;
  if (curArrows.visible) {
    fillArrows(curArrows, L, 0.14 * L, 0.39 * L, 0.42 * L, LEVEL + 4, (x, y) => {
      TER.current(x, y, opts.cur, tmpV);
      const s = Math.hypot(tmpV.x, tmpV.y);
      if (s < 1e-4) return null;
      // Длина от скорости, но не от нуля: совсем короткая стрелка неотличима от
      // мусора, а показать, что тут почти стоячая вода, всё равно надо.
      return { x: tmpV.x / s, y: tmpV.y / s, s: 0.35 + 0.65 * Math.min(1, s / opts.cur) };
    });
  }
  if (windArrows.visible) {
    fillArrows(windArrows, L, 0.14 * L, 0.39 * L, 0.42 * L, LEVEL + 7, (x, y) => {
      const wk = fetchFactor(TER.fetch(x, y, opts.dir), WIND_SHORE_A, WIND_SHORE_L) *
                 shelterFactor(TER.skyline(x, y, opts.dir), opts.d0, opts.k);
      TER.channel(x, y, tmpV);
      const rot = channelTurn(tmpV.x, tmpV.y, opts.dir, opts.chan);
      // Рисуем туда, КУДА дует: направление ветра задаётся «откуда».
      const a = opts.dir + rot + Math.PI;
      return { x: Math.cos(a), y: Math.sin(a), s: 0.35 + 0.65 * wk };
    });
  }
  if (axisLines.visible) {
    fillArrows(axisLines, 0.8 * L, 0.10 * L, 0.10 * L, 1e-3, LEVEL + 2, (x, y) => {
      TER.channel(x, y, tmpV);
      const a = Math.hypot(tmpV.x, tmpV.y);
      if (a < 0.02) return null;
      // Ось без знака, и рисуется она палочкой, а не стрелкой: у направления,
      // которого нет, не должно быть и острия.
      const ang = 0.5 * Math.atan2(tmpV.y, tmpV.x);
      return { x: Math.cos(ang), y: Math.sin(ang), s: a };
    });
  }
}

// --------------------------------------------------------------- разметка

const marksGroup = new Group();
scene.add(marksGroup);

const KINDS = {
  left:    { colour: 0xd8483c, label: 'левый (красный)' },
  right:   { colour: 0x3fa85e, label: 'правый (зелёный)' },
  danger:  { colour: 0xf0c020, label: 'опасность (жёлтый)' },
  fairway: { colour: 0xe8e8e8, label: 'осевой (белый)' },
};

let picked = null;      // {kind:'starts'|'buoys'|'fairway', i}
let drawing = null;     // строящийся судовой ход
let markS = 1;          // размер знаков, идёт за дальностью камеры
let fieldS = 1;         // то же для стрелок поля

function rebuildMarks() {
  for (const c of marksGroup.children.slice()) {
    marksGroup.remove(c);
    c.geometry.dispose();
  }
  // Стартовая точка — плоская стрелка по курсу: место и направление разом.
  MARKS.starts.forEach((s, i) => {
    const g = new BufferGeometry();
    const p = new Float32Array(ARR_V * 3);
    const a = s.heading_deg * RAD;
    putArrow(p, 0, sx(s.x), sz(s.y), Math.cos(a), -Math.sin(a),
             190 * markS, 26 * markS, 74 * markS, 90 * markS, LEVEL + 9);
    g.setAttribute('position', new BufferAttribute(p, 3));
    marksGroup.add(mk(g, sel('starts', i) ? 0xffffff : 0xffcf5a));
  });
  // Буй — треугольная шапка на воде. Круглый был бы честнее, но с километра
  // разницы нет, а треугольник читается на любом фоне.
  MARKS.buoys.forEach((b, i) => {
    const g = new BufferGeometry();
    const p = new Float32Array(9);
    const r = 70 * markS;
    for (let v = 0; v < 3; v++) {
      const a = -Math.PI / 2 + v * 2 * Math.PI / 3;
      p[v * 3] = sx(b.x) + r * Math.cos(a);
      p[v * 3 + 1] = LEVEL + 8;
      p[v * 3 + 2] = sz(b.y) + r * Math.sin(a);
    }
    g.setAttribute('position', new BufferAttribute(p, 3));
    marksGroup.add(mk(g, sel('buoys', i) ? 0xffffff : KINDS[b.kind].colour));
  });
  // Судовой ход — лента, а не линия: линия в WebGL толщиной в пиксель, и на
  // облёте её попросту не видно.
  MARKS.fairway.forEach((f, i) => addRibbon(f.points, sel('fairway', i) ? 0xffffff : 0x9fd8ff));
  if (drawing && drawing.points.length) addRibbon(drawing.points, 0xffffff, true);
  redraw();
}

const sel = (kind, i) => picked && picked.kind === kind && picked.i === i;

function mk(geo, colour) {
  return new Mesh(geo, new MeshBasicMaterial({
    color: colour, depthTest: false, side: DoubleSide }));
}

function addRibbon(pts, colour, open) {
  if (pts.length < (open ? 1 : 2)) return;
  const W = 26 * markS;
  const vp = [], vi = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const m = Math.hypot(dx, dy) || 1;
    dx /= m; dy /= m;
    const nx = -dy * W, ny = dx * W;
    vp.push(sx(pts[i][0] + nx), LEVEL + 6, sz(pts[i][1] + ny),
            sx(pts[i][0] - nx), LEVEL + 6, sz(pts[i][1] - ny));
    if (i) {
      const k = (i - 1) * 2;
      vi.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(vp), 3));
  if (vi.length) g.setIndex(vi);
  marksGroup.add(mk(g, colour));
}

// Знаки — прибор, а не часть местности: с трёх километров они обязаны читаться
// так же, как с тридцати. Поэтому размер идёт за камерой, а не стоит в метрах.
// Не масштабированием группы — оно ездит вокруг начала координат и утащило бы
// знаки с их мест, — а пересборкой, и только когда размер сменился заметно.
function markScale() { return Math.max(0.3, Math.min(3.5, cam.dist / 9000)); }
function checkScale() {
  const m = markScale();
  if (Math.abs(Math.log(m / markS)) > 0.22) { markS = m; rebuildMarks(); }
  const f = fieldScale();
  if (Math.abs(Math.log(f / fieldS)) > 0.22) {
    fieldS = f;
    buildNodes(240 * fieldS);
    paintArrows();
    redraw();
  }
}

// --------------------------------------------------------------- выбор точки

const ray = new Raycaster();
const water0 = new Plane(new Vector3(0, 1, 0), -LEVEL);
const hit = new Vector3();

function pickWater(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  const nd = new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                         -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(nd, camera);
  if (!ray.ray.intersectPlane(water0, hit)) return null;
  const x = hit.x, y = -hit.z;
  const d = TER ? TER.shore(x, y) : null;
  return { x, y, wet: d !== null && d > 0, shore: d };
}

// Наводка курса протяжкой.
//
// Курс стартовой точки — единственное в разметке, что не является местом, и
// цифрой он задаётся плохо: отсчёт тут от оси X против часовой, как `psi` в
// физике, а не компасный, и держать этот перевод в голове ради каждой точки
// незачем. Протянуть мышью от точки туда, куда должен смотреть нос, — то же
// самое действие, только без перевода.
//
// Порог в тридцать метров нарочно: без него любое дрожание при клике сбивало бы
// курс, подобранный по течению, на случайный.
const AIM_MIN = 30;
let aiming = null;      // {i, x, y} — наводимая точка и её место

function aimTo(p) {
  const dx = p.x - aiming.x, dy = p.y - aiming.y;
  if (Math.hypot(dx, dy) < AIM_MIN) return false;
  MARKS.starts[aiming.i].heading_deg = Math.round(Math.atan2(dy, dx) / RAD);
  syncHeading(aiming.i);
  touch();
  rebuildMarks();
  return true;
}

// Что под курсором. Ставится это не для отладки, хотя и для неё тоже: поле,
// раскрашенное шкалой, отвечает на «где», а на «сколько именно» отвечать
// нечему. Здесь и отвечается — теми же функциями, что считают силы.
function status(p) {
  const box = document.getElementById('status');
  if (!p || !TER) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  if (aiming) {
    const h = MARKS.starts[aiming.i].heading_deg;
    const d = Math.hypot(p.x - aiming.x, p.y - aiming.y);
    box.textContent = 'курс ' + Math.round(h) + '° от оси X (' +
      ((90 - h + 360) % 360).toFixed(0) + '° по компасу)' +
      (d < AIM_MIN ? '  ·  тяните дальше' : '');
    return;
  }
  const bits = ['x ' + (p.x / 1000).toFixed(2) + ' км, y ' + (p.y / 1000).toFixed(2) + ' км'];
  if (!p.wet) {
    bits.push('суша');
  } else {
    bits.push('до берега ' + (p.shore >= 127 ? '>127' : p.shore.toFixed(0)) + ' м');
    const f = TER.fetch(p.x, p.y, opts.dir);
    const sh = shelterFactor(TER.skyline(p.x, p.y, opts.dir), opts.d0, opts.k);
    bits.push('ветер ×' + (fetchFactor(f, WIND_SHORE_A, WIND_SHORE_L) * sh).toFixed(2) +
              ' (разгон ' + (f / 1000).toFixed(1) + ' км, укрытие ×' + sh.toFixed(2) + ')');
    TER.channel(p.x, p.y, tmpV);
    const rot = channelTurn(tmpV.x, tmpV.y, opts.dir, opts.chan);
    if (Math.abs(rot) > 0.5 * RAD)
      bits.push('вдоль долины ' + (rot > 0 ? '+' : '') + (rot / RAD).toFixed(0) + '°');
    TER.current(p.x, p.y, opts.cur, tmpV);
    const cs = Math.hypot(tmpV.x, tmpV.y);
    if (cs > 1e-3)
      bits.push('течение ' + cs.toFixed(2) + ' м/с на ' +
                ((Math.atan2(tmpV.y, tmpV.x) / RAD + 360) % 360).toFixed(0) + '°');
  }
  box.textContent = bits.join('  ·  ');
}

// --------------------------------------------------------------- панель

let tool = 'look';

function setTool(t) {
  // Повторное нажатие на «Ход» заканчивает линию: способов закончить должно
  // быть несколько, иначе единственный из них обязательно окажется тем, о
  // котором забыли.
  if (t !== 'fairway' || tool === 'fairway') finishLine();
  tool = t;
  for (const b of document.querySelectorAll('#tools button'))
    b.classList.toggle('on', b.dataset.tool === t);
  renderer.domElement.style.cursor = t === 'look' ? '' : 'crosshair';
  document.getElementById('toolhint').textContent =
    t === 'look' ? 'Клик — выбрать, Del — удалить. Протяжка от старта наводит курс.'
    : t === 'fairway' ? 'Клики по воде — точки хода. Закончить: Enter, двойной клик '
                     + 'или «Ход» ещё раз. Esc — отменить.'
    : t === 'start' ? 'Нажать на воде — поставить, протянуть — навести курс. '
                   + 'Без протяжки курс берётся вниз по течению.'
    : 'Клик по воде — поставить.';
}

function finishLine() {
  if (drawing && drawing.points.length >= 2) {
    MARKS.fairway.push(drawing);
    touch();
  }
  drawing = null;
  rebuildMarks();
  listMarks();
}

function touch() { dirty = true; document.getElementById('save').classList.add('on'); }

function nearest(p) {
  // Выбор по близости в метрах, а не по попаданию в фигуру: фигуры мелкие, а
  // промахнуться по букве закона легко.
  let best = null, bd = 400 * Math.max(1, cam.dist / 9000);
  const test = (kind, i, x, y) => {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < bd) { bd = d; best = { kind, i }; }
  };
  MARKS.starts.forEach((s, i) => test('starts', i, s.x, s.y));
  MARKS.buoys.forEach((b, i) => test('buoys', i, b.x, b.y));
  MARKS.fairway.forEach((f, i) => f.points.forEach(q => test('fairway', i, q[0], q[1])));
  return best;
}

function placeMark(p) {
  if (!p.wet) { flash('здесь суша'); return; }
  if (tool === 'start') {
    // Курс по умолчанию — вниз по течению: на реке это самое осмысленное
    // направление, и поправить его потом можно числом.
    TER.current(p.x, p.y, 1, tmpV);
    const h = Math.hypot(tmpV.x, tmpV.y) > 1e-3
      ? Math.atan2(tmpV.y, tmpV.x) / RAD : 0;
    MARKS.starts.push({ name: 'Старт ' + (MARKS.starts.length + 1),
                        x: p.x, y: p.y, heading_deg: Math.round(h) });
    picked = { kind: 'starts', i: MARKS.starts.length - 1 };
  } else if (tool === 'buoy') {
    const kind = document.getElementById('buoykind').value;
    MARKS.buoys.push({ name: '', x: p.x, y: p.y, kind });
    picked = { kind: 'buoys', i: MARKS.buoys.length - 1 };
  } else if (tool === 'fairway') {
    if (!drawing) drawing = { name: 'Ход ' + (MARKS.fairway.length + 1), points: [] };
    drawing.points.push([Math.round(p.x), Math.round(p.y)]);
    rebuildMarks();
    return;                                     // счёт пойдёт по завершении
  }
  touch();
  rebuildMarks();
  listMarks();
}

function removePicked() {
  if (!picked) return;
  MARKS[picked.kind].splice(picked.i, 1);
  picked = null;
  touch();
  rebuildMarks();
  listMarks();
}

function listMarks() {
  const rows = [];
  const row = (kind, i, title, extra) =>
    '<div class="mk' + (sel(kind, i) ? ' on' : '') + '" data-kind="' + kind +
    '" data-i="' + i + '"><span class="dot" style="background:' + title.colour + '"></span>' +
    '<input class="nm" value="' + (title.name || '').replace(/"/g, '&quot;') + '">' +
    (extra || '') + '<button class="x">✕</button></div>';
  MARKS.starts.forEach((s, i) => rows.push(row('starts', i, { colour: '#ffcf5a', name: s.name },
    '<input class="hd" type="number" step="5" value="' + Math.round(s.heading_deg) + '">')));
  MARKS.buoys.forEach((b, i) => rows.push(row('buoys', i,
    { colour: '#' + KINDS[b.kind].colour.toString(16).padStart(6, '0'), name: b.name })));
  MARKS.fairway.forEach((f, i) => rows.push(row('fairway', i,
    { colour: '#9fd8ff', name: f.name }, '<span class="n">' + f.points.length + '</span>')));
  const box = document.getElementById('marks');
  box.innerHTML = rows.join('') ||
    '<div class="empty">Пока пусто. Выберите инструмент и щёлкните по воде.</div>';
  box.querySelectorAll('.mk').forEach(el => {
    const kind = el.dataset.kind, i = +el.dataset.i;
    el.querySelector('.x').addEventListener('click', ev => {
      ev.stopPropagation();
      MARKS[kind].splice(i, 1);
      if (sel(kind, i)) picked = null;
      touch(); rebuildMarks(); listMarks();
    });
    el.querySelector('.nm').addEventListener('input', ev => {
      MARKS[kind][i].name = ev.target.value; touch();
    });
    const hd = el.querySelector('.hd');
    if (hd) hd.addEventListener('input', ev => {
      MARKS[kind][i].heading_deg = +ev.target.value || 0;
      touch(); rebuildMarks();
    });
    // Клик по самой строке выбирает, клик по полю внутри — нет. Раньше
    // выбиралось и то и другое, и список пересобирался целиком: поле, в которое
    // только что ткнули, исчезало вместе со всем списком, и ввести в него
    // хоть что-нибудь было нельзя. Теперь выделение меняет класс на месте.
    el.addEventListener('pointerdown', ev => {
      if (ev.target.closest('input, button, select')) return;
      picked = { kind, i };
      rebuildMarks();
      syncSelection();
    });
  });
}

// Подсветка выбранного — без пересборки списка: она сдувает и фокус, и ввод.
function syncSelection() {
  for (const el of document.querySelectorAll('#marks .mk'))
    el.classList.toggle('on', sel(el.dataset.kind, +el.dataset.i));
}

// Показать курс в поле, не трогая остального: во время протяжки цифра обязана
// бежать за стрелкой, а список — стоять на месте.
function syncHeading(i) {
  const el = document.querySelector('#marks .mk[data-kind="starts"][data-i="' + i + '"] .hd');
  if (el && document.activeElement !== el) el.value = Math.round(MARKS.starts[i].heading_deg);
}

function flash(text, bad) {
  const n = document.getElementById('note');
  n.textContent = text;
  n.className = bad ? 'bad' : '';
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { n.textContent = ''; }, 2600);
}

async function save() {
  try {
    const r = await fetch(API, { method: 'PUT', body: JSON.stringify(MARKS) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    dirty = false;
    document.getElementById('save').classList.remove('on');
    flash('записано в ' + j.saved);
  } catch (e) {
    flash('не сохранилось: ' + e.message, true);
  }
}

// --------------------------------------------------------------- запуск

function bindTools() {
  for (const b of document.querySelectorAll('#tools button'))
    b.addEventListener('click', () => setTool(b.dataset.tool));
  document.getElementById('save').addEventListener('click', save);
  for (const b of document.querySelectorAll('#fields button'))
    b.addEventListener('click', () => {
      opts.field = b.dataset.field;
      for (const o of document.querySelectorAll('#fields button'))
        o.classList.toggle('on', o.dataset.field === opts.field);
      paintField(); redraw();
    });
  const box = (id, mesh) => document.getElementById(id).addEventListener('change', e => {
    mesh.visible = e.target.checked; paintArrows(); redraw();
  });
  box('arr-cur', curArrows);
  box('arr-wind', windArrows);
  box('arr-axis', axisLines);
  const slider = (id, fn, fmt) => {
    const e = document.getElementById(id);
    const go = () => {
      fn(+e.value);
      document.getElementById('v-' + id).textContent = fmt(+e.value);
      paintField(); paintArrows(); redraw();
    };
    e.addEventListener('input', go);
    go();
  };
  slider('wdir', v => { opts.dir = v * RAD; }, v => v.toFixed(0) + '°');
  slider('shade', v => { opts.d0 = v; }, v => v === 0 ? 'нет' : '−' + (v * 100).toFixed(0) + '%');
  slider('chank', v => { opts.chan = v; }, v => v === 0 ? 'нет' : 'до ' + (v * 90).toFixed(0) + '°');
  slider('curv', v => { opts.cur = v; }, v => v.toFixed(2) + ' м/с');

  // Клик, а не протяжка: облёт вращается тем же указателем, и ставить знак на
  // каждом повороте камеры было бы наказанием.
  const el = renderer.domElement;
  let down = null;
  el.addEventListener('wheel', () => setTimeout(checkScale, 0), { passive: true });

  // Старт ставится НА НАЖАТИИ, а не на отпускании: только так протяжка от него
  // успевает стать наводкой курса. Буи и точки хода — по-прежнему на клике,
  // наводить там нечего.
  el.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY };
    aiming = null;
    if (mode !== 'orbit' || !TER) return;
    const p = pickWater(e);
    if (!p) return;
    if (tool === 'start') {
      if (!p.wet) { flash('здесь суша'); return; }
      placeMark(p);
      aiming = { i: MARKS.starts.length - 1, x: p.x, y: p.y };
    } else if (tool === 'look') {
      const n = nearest(p);
      if (n && n.kind === 'starts') {
        picked = n;
        aiming = { i: n.i, x: MARKS.starts[n.i].x, y: MARKS.starts[n.i].y };
        rebuildMarks();
        syncSelection();
      }
    }
    // Протяжка теперь наша, и камера на ней стоять обязана: одно движение мыши
    // не должно делать два дела разом.
    if (aiming) releaseDrag();
  });

  el.addEventListener('pointerup', e => {
    const wasAiming = aiming;
    aiming = null;
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (wasAiming) return;                    // поставили и навели на нажатии
    if (moved > 4 || mode !== 'orbit' || !TER) return;
    const p = pickWater(e);
    if (!p) return;
    if (tool === 'look') { picked = nearest(p); rebuildMarks(); syncSelection(); }
    else placeMark(p);
  });

  el.addEventListener('dblclick', () => { if (drawing) finishLine(); });
  el.addEventListener('pointermove', e => {
    if (mode !== 'orbit' || !TER) return;
    const p = pickWater(e);
    if (aiming && p) { aimTo(p); releaseDrag(); }
    status(p);
  });
  el.addEventListener('pointerleave', () => { aiming = null; status(null); });
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { removePicked(); e.preventDefault(); }
    if (e.key === 'Enter' && drawing) finishLine();
    if (e.key === 'Escape') { drawing = null; picked = null; rebuildMarks(); listMarks(); }
  });
  addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
}

async function boot() {
  const off = document.getElementById('offline');
  try {
    const [p, m] = await Promise.all([
      fetch('/out/export/terrain_pack.json').then(r => r.ok ? r.json() : Promise.reject(r.status)),
      fetch(API).then(r => r.ok ? r.json() : Promise.reject(r.status)),
    ]);
    PACK = p;
    TER = new Terrain(PACK);
    MARKS = m;
  } catch (e) {
    // Не молчать и не прятать карточку целиком: страница обязана сказать, чего
    // ей не хватает, и что с этим делать. Пропадают только органы — смотреть
    // ими нечего.
    off.style.display = 'block';
    off.innerHTML += '<br>' + (e && e.message ? e.message : e);
    document.getElementById('tools').style.display = 'none';
    document.getElementById('marks').style.display = 'none';
    document.getElementById('save').style.display = 'none';
    document.getElementById('fieldbox').style.display = 'none';
    return;
  }
  // Отпечаток полей — тот же, что пишет сборщик пакета. Разметка ставится по
  // этой картинке, и если поля с тех пор пересобрали, знать об этом надо.
  document.getElementById('packhash').textContent = PACK.hash;
  markS = markScale();
  fieldS = fieldScale();
  buildNodes(240 * fieldS);
  bindTools();
  setTool('look');
  rebuildMarks();
  listMarks();
  paintField();
  paintArrows();
  redraw();
}

boot();
