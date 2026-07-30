// Просмотрщик на three.js. Сборка three вклеена выше этого кода в тот же
// модуль, поэтому все классы уже в области видимости — импортировать нечего.
//
// Мир в миллиметрах и с осью Z вверх, как в судостроительной системе Ф0:
// X от кормовой оконечности в нос, Y полуширота, Z вверх от КВЛ.

const RAD = Math.PI / 180;
const stage = document.getElementById('stage');
const svg = document.getElementById('leaders');
const labelBox = document.getElementById('labels');
const F = DATA.frame, HULL = DATA.hull || null;

// ------------------------------------------------------------------ сцена

const scene = new Scene();
const camera = new PerspectiveCamera(32, 1, 20, 400000);
camera.up.set(0, 0, 1);

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
stage.insertBefore(renderer.domElement, svg);

function css(v) {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}

const hemi = new HemisphereLight(css('--sky'), css('--ground'), 2.0);
scene.add(hemi);
const key = new DirectionalLight(0xffffff, 2.2);
key.position.set(-4000, -6000, 7000);
scene.add(key);
const fill = new DirectionalLight(0xffffff, 0.8);
fill.position.set(5000, 4000, 1500);
scene.add(fill);

// ------------------------------------------------------------------ слои

const layers = [];
const themed = [];   // материалы, которые надо перекрасить при смене темы

function add(spec, object, cssVar) {
  object.visible = spec.on;
  scene.add(object);
  layers.push(Object.assign({ object }, spec));
  if (cssVar) themed.push([object, cssVar]);
  return object;
}

function segmentsOf(polys) {
  const pos = [];
  for (const poly of polys)
    for (let i = 0; i < poly.length - 1; i++)
      pos.push(poly[i][0], poly[i][1], poly[i][2],
               poly[i + 1][0], poly[i + 1][1], poly[i + 1][2]);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return g;
}

function lineLayer(spec, polys, cssVar, opacity) {
  const mat = new LineBasicMaterial({
    color: new Color(css(cssVar)),
    transparent: opacity != null, opacity: opacity == null ? 1 : opacity,
  });
  return add(spec, new LineSegments(segmentsOf(polys), mat), cssVar);
}

// Толстые линии в WebGL не поддерживаются — важные кривые каркаса рисуем
// тонкими трубками. Заодно они честно затеняются и не теряются на фоне.
function tubeLayer(spec, polys, cssVar, radius) {
  const group = new Group();
  const mat = new MeshStandardMaterial({
    color: new Color(css(cssVar)), roughness: 0.5, metalness: 0.0,
  });
  for (const poly of polys) {
    const pts = poly.map(p => new Vector3(p[0], p[1], p[2]));
    if (pts.length < 2) continue;
    const curve = new CatmullRomCurve3(pts, false, 'centripetal', 0.0);
    group.add(new Mesh(
      new TubeGeometry(curve, Math.max(8, pts.length * 2), radius, 6, false),
      mat));
  }
  return add(spec, group, cssVar);
}

// --- подложка: исходный чертёж ---------------------------------------------

const UNDERLAY = [
  ['deck_line', 'Линия борта, вид сверху', '--c-draw', true],
  ['plan', 'Вид сверху: палуба и оборудование', '--c-draw2', true],
  ['profile', 'Вид сбоку: палубные детали', '--c-draw2', true],
  ['sailplan', 'Рангоут и паруса', '--c-draw2', false],
  ['rig', 'Такелаж и выноски', '--c-draw2', false],
  ['other', 'Прочее с листа', '--c-draw2', false],
];

for (const [id, label, color, on] of UNDERLAY) {
  const g = DATA.draw[id];
  if (!g || !g.paths.length) continue;
  const flat = g.plane === 'plan';
  const polys = g.paths.map(p => p.pts.map(
    q => flat ? [q[0], q[1], 0] : [q[0], 0, q[1]]));
  lineLayer({ id, label, group: 'Подложка — исходный чертёж', on, color },
            polys, color, 0.75);
}

// --- каркас Ф1 --------------------------------------------------------------

const CONF = {
  measured: { color: '--c-measured', label: 'снято с чертежа' },
  derived: { color: '--c-derived', label: 'совмещение двух видов' },
  projected: { color: '--c-projected', label: 'проекция, Y неизвестен' },
  inferred: { color: '--c-inferred', label: 'достроено' },
};

for (const c of F.curves) {
  const cf = CONF[c.confidence] || CONF.inferred;
  tubeLayer({ id: c.name, label: c.label, group: 'Каркас Ф1', on: true,
              color: cf.color, note: c.note }, [c.points], cf.color, 9);
}

// --- обводы -----------------------------------------------------------------

if (HULL) {
  const V = HULL.mesh.verts, Q = HULL.mesh.quads;
  const pos = [];
  for (const p of V) pos.push(p[0], p[1], p[2]);
  for (const p of V) pos.push(p[0], -p[1], p[2]);
  const off = V.length;
  const idx = [];
  for (const q of Q) {
    // Обход сетки идёт снизу вверх и с кормы в нос: нормаль такой рамки
    // смотрит внутрь корпуса. Правый борт разворачиваем, левый — нет,
    // зеркальное отражение переворачивает ориентацию само.
    idx.push(q[3], q[2], q[1], q[3], q[1], q[0]);
    idx.push(q[0] + off, q[1] + off, q[2] + off,
             q[0] + off, q[2] + off, q[3] + off);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  add({ id: 'surface', label: 'Поверхность корпуса', group: 'Обводы',
        on: true, color: '--c-surface' },
      new Mesh(geo, new MeshStandardMaterial({
        color: new Color(css('--c-surface')), roughness: 0.42, metalness: 0.05,
        side: DoubleSide })),
      '--c-surface');

  const mirror = pts => pts.map(p => [p[0], -p[1], p[2]]);
  lineLayer({ id: 'stations', label: 'Шпангоуты', group: 'Обводы', on: false,
              color: '--c-hull' },
            HULL.stations.concat(HULL.stations.map(mirror)), '--c-hull', 0.85);
  tubeLayer({ id: 'chine', label: 'Линия скулы', group: 'Обводы', on: true,
              color: '--c-projected' },
            [HULL.chine_line, mirror(HULL.chine_line)], '--c-projected', 7);
  tubeLayer({ id: 'keelline', label: 'Линия киля в ДП', group: 'Обводы',
              on: true, color: '--c-hull' }, [HULL.keel_line], '--c-hull', 7);
}

// --- киль и руль ------------------------------------------------------------

if (HULL && HULL.appendages) {
  const A = HULL.appendages;
  const solid = (name, cssVar) => {
    const g = new BufferGeometry();
    const pos = [];
    for (const p of A[name].verts) pos.push(p[0], p[1], p[2]);
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setIndex(A[name].tris.flat());
    g.computeVertexNormals();
    return new Mesh(g, new MeshStandardMaterial({
      color: new Color(css(cssVar)), roughness: 0.45, metalness: 0.15,
      side: DoubleSide }));
  };
  add({ id: 'fin', label: 'Перо киля', group: 'Киль и руль', on: true,
        color: '--c-keel' }, solid('fin', '--c-keel'), '--c-keel');
  add({ id: 'bulb', label: 'Бульб', group: 'Киль и руль', on: true,
        color: '--c-ballast' }, solid('bulb', '--c-ballast'), '--c-ballast');
  add({ id: 'rudder', label: 'Перо руля', group: 'Киль и руль', on: true,
        color: '--c-keel' }, solid('rudder', '--c-keel'), '--c-keel');
}

// --- служебное --------------------------------------------------------------

const grid = [];
for (let x = 0; x <= 6000; x += 1000) grid.push([[x, -1300, 0], [x, 1300, 0]]);
for (let y = -1000; y <= 1000; y += 1000) grid.push([[0, y, 0], [6100, y, 0]]);
lineLayer({ id: 'grid', label: 'Плоскость КВЛ, сетка 1 м', group: 'Служебное',
            on: true, color: '--c-draw2' }, grid, '--c-draw2', 0.5);

const waterGeo = new PlaneGeometry(7400, 3000);
waterGeo.translate(3050, 0, 0);
add({ id: 'water', label: 'Вода на КВЛ', group: 'Служебное', on: true,
      color: '--c-measured' },
    new Mesh(waterGeo, new MeshBasicMaterial({
      color: new Color(css('--c-measured')), transparent: true, opacity: 0.07,
      side: DoubleSide, depthWrite: false })),
    '--c-measured');

// --------------------------------------------------------------- камера

const BB = new Box3();
for (const L of layers)
  if (L.group === 'Каркас Ф1' || L.id === 'surface' || L.group === 'Киль и руль')
    BB.expandByObject(L.object);
const CENTER = BB.getCenter(new Vector3());

const cam = { az: -138 * RAD, el: 20 * RAD, dist: 14000,
              target: CENTER.clone() };

function applyCamera() {
  const ce = Math.cos(cam.el);
  camera.position.set(
    cam.target.x + cam.dist * ce * Math.cos(cam.az),
    cam.target.y + cam.dist * ce * Math.sin(cam.az),
    cam.target.z + cam.dist * Math.sin(cam.el));
  camera.lookAt(cam.target);
  camera.updateMatrixWorld();
}

function fitCamera() {
  applyCamera();
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const fwd = new Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
  let hu = 0, hv = 0, hw = 0;
  for (let m = 0; m < 8; m++) {
    const d = new Vector3(m & 1 ? BB.max.x : BB.min.x,
                          m & 2 ? BB.max.y : BB.min.y,
                          m & 4 ? BB.max.z : BB.min.z).sub(cam.target);
    hu = Math.max(hu, Math.abs(d.dot(right)));
    hv = Math.max(hv, Math.abs(d.dot(up)));
    hw = Math.max(hw, Math.abs(d.dot(fwd)));
  }
  const ty = Math.tan(camera.fov * RAD / 2);
  cam.dist = Math.max(hu / (ty * camera.aspect), hv / ty) * 1.14 + hw;
  applyCamera();
}

// ------------------------------------------------------------- отрисовка

let W = 0, H = 0, needsDraw = true;

function resize() {
  const r = stage.getBoundingClientRect();
  W = Math.max(1, r.width); H = Math.max(1, r.height);
  renderer.setSize(W, H, true);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  needsDraw = true;
}

function frame() {
  if (needsDraw) {
    needsDraw = false;
    applyCamera();
    renderer.render(scene, camera);
    placeLabels();
    document.getElementById('hud').textContent =
      'азимут ' + (cam.az / RAD).toFixed(0) + '°  возвышение ' +
      (cam.el / RAD).toFixed(0) + '°  дистанция ' +
      (cam.dist / 1000).toFixed(1) + ' м\n' +
      'ЛКМ — вращать · колесо — приблизить · Shift+ЛКМ — сдвинуть';
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------- пометки

const NOTES = DATA.notes;
let showNotes = true;
const SVGNS = 'http://www.w3.org/2000/svg';

const chips = NOTES.map(n => {
  const d = document.createElement('div');
  d.className = 'label';
  d.textContent = n.t;
  labelBox.appendChild(d);
  const line = document.createElementNS(SVGNS, 'line');
  const dot = document.createElementNS(SVGNS, 'circle');
  dot.setAttribute('r', '3.5');
  svg.appendChild(line);
  svg.appendChild(dot);
  return { n, d, line, dot };
});

function placeLabels() {
  const v = new Vector3();
  const boxes = [];
  for (const c of chips) {
    if (!showNotes) {
      c.d.style.display = c.line.style.display = c.dot.style.display = 'none';
      continue;
    }
    v.set(c.n.p[0], c.n.p[1], c.n.p[2]).project(camera);
    const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
    const vis = v.z < 1 && sx > -200 && sx < W + 200 && sy > -200 && sy < H + 200;
    c.d.style.display = c.line.style.display = c.dot.style.display =
      vis ? '' : 'none';
    if (!vis) continue;
    const w = c.d.offsetWidth, h = c.d.offsetHeight;
    boxes.push({
      c, sx, sy, w, h,
      x: Math.max(4, Math.min(W - w - 4,
        c.n.d[0] >= 0 ? sx + c.n.d[0] : sx + c.n.d[0] - w)),
      y: Math.max(4, Math.min(H - h - 4, sy + c.n.d[1] - h / 2)),
    });
  }
  boxes.sort((a, b) => a.y - b.y);
  for (let i = 0; i < boxes.length; i++)
    for (let j = 0; j < i; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w + 6 && a.x + a.w + 6 > b.x &&
          a.y < b.y + b.h + 6 && a.y + a.h + 6 > b.y)
        a.y = Math.min(H - a.h - 4, b.y + b.h + 6);
    }
  const dim = css('--dim');
  for (const b of boxes) {
    b.c.d.style.left = b.x + 'px';
    b.c.d.style.top = b.y + 'px';
    const ax = b.sx > b.x + b.w ? b.x + b.w : (b.sx < b.x ? b.x : b.x + b.w / 2);
    const ay = b.sy > b.y + b.h ? b.y + b.h : (b.sy < b.y ? b.y : b.y + b.h / 2);
    b.c.line.setAttribute('x1', b.sx); b.c.line.setAttribute('y1', b.sy);
    b.c.line.setAttribute('x2', ax); b.c.line.setAttribute('y2', ay);
    b.c.line.setAttribute('stroke', dim);
    b.c.line.setAttribute('stroke-opacity', '0.55');
    b.c.dot.setAttribute('cx', b.sx); b.c.dot.setAttribute('cy', b.sy);
    b.c.dot.setAttribute('fill', css(b.c.n.c || '--accent'));
  }
}

// ---------------------------------------------------------------- ввод

let drag = null;
const el = renderer.domElement;
el.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 };
  el.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});
el.addEventListener('pointermove', e => {
  if (!drag) return;
  if (e.buttons === 0) { drag = null; stage.classList.remove('dragging'); return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.pan) {
    const k = cam.dist * 2 * Math.tan(camera.fov * RAD / 2) / H;
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  } else {
    cam.az -= dx * 0.006;
    cam.el = Math.max(-89 * RAD, Math.min(89 * RAD, cam.el + dy * 0.006));
  }
  needsDraw = true;
});
const stopDrag = () => { drag = null; stage.classList.remove('dragging'); };
el.addEventListener('pointerup', stopDrag);
el.addEventListener('pointercancel', stopDrag);
el.addEventListener('wheel', e => {
  e.preventDefault();
  cam.dist = Math.max(900, Math.min(90000,
    cam.dist * Math.exp(e.deltaY * 0.0012)));
  needsDraw = true;
}, { passive: false });

// ---------------------------------------------------------------- виды

const VIEWS = [
  ['Изометрия', -138, 20], ['Сверху', -90, 89], ['Сбоку', -90, 0],
  ['С кормы', 180, 2], ['С носа', 0, 2], ['Три четверти', -55, 14],
];

const vbox = document.getElementById('views');
VIEWS.forEach(([name, az, elv], i) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.className = 'view';
  b.onclick = () => {
    cam.az = az * RAD; cam.el = elv * RAD; cam.target.copy(CENTER);
    fitCamera();
    vbox.querySelectorAll('.view').forEach(c => c.classList.remove('on'));
    b.classList.add('on');
    needsDraw = true;
  };
  if (i === 0) b.classList.add('on');
  vbox.appendChild(b);
});

function toolButton(text, on, fn) {
  const b = document.createElement('button');
  b.textContent = text;
  if (on) b.classList.add('on');
  b.onclick = () => { fn(b); needsDraw = true; };
  vbox.appendChild(b);
}

toolButton('Пометки', true, b => {
  showNotes = !showNotes;
  b.classList.toggle('on', showNotes);
});

toolButton('Тема', false, () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  for (const [obj, v] of themed) {
    const c = new Color(css(v));
    if (obj.material) obj.material.color.copy(c);
    obj.traverse(o => { if (o.material) o.material.color.copy(c); });
  }
  hemi.color.set(css('--sky'));
  hemi.groundColor.set(css('--ground'));
  for (const L of layers) {
    const sw = L.swatch;
    if (sw) sw.style.borderTopColor = css(L.color);
  }
});

// ---------------------------------------------------------------- панель

const P = document.getElementById('panel');

function h2(t) {
  const e = document.createElement('h2');
  e.textContent = t;
  P.appendChild(e);
}

function table(rows) {
  const t = document.createElement('table');
  for (const [k, v, u] of rows) {
    const tr = t.insertRow();
    tr.insertCell().textContent = k;
    const c = tr.insertCell(); c.className = 'v'; c.textContent = v;
    const uc = tr.insertCell(); uc.className = 'u'; uc.textContent = u || '';
  }
  P.appendChild(t);
}

const seen = new Set();
for (const L of layers) {
  if (!seen.has(L.group)) { h2(L.group); seen.add(L.group); }
  const lab = document.createElement('label');
  lab.className = 'row';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = L.on;
  cb.onchange = () => { L.object.visible = cb.checked; needsDraw = true; };
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.borderTopColor = css(L.color);
  L.swatch = sw;
  const txt = document.createElement('span');
  txt.textContent = L.label;
  if (L.note) txt.title = L.note;
  lab.append(cb, sw, txt);
  P.appendChild(lab);
}

if (HULL && HULL.appendages) {
  h2('Киль и руль — размеры');
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = HULL.appendages.note;
  P.appendChild(p);
  table(HULL.appendages.rows);
}

if (HULL) {
  h2('Гидростатика');
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = HULL.source_note;
  P.appendChild(p);
  table(HULL.hydroRows);
}

h2('Достоверность кривых');
for (const k of ['measured', 'derived', 'projected', 'inferred']) {
  const d = document.createElement('div');
  d.className = 'note';
  const code = document.createElement('code');
  code.textContent = k;
  code.style.color = css(CONF[k].color);
  d.append(code, document.createTextNode(' — ' + CONF[k].label));
  P.appendChild(d);
}

h2('Привязка');
const dv = document.createElement('p');
dv.className = 'note';
dv.textContent = 'Масштаб ' + F.datum.mm_per_pt.toFixed(4) +
  ' мм/пт из габаритной длины 6100 мм. Проверки — независимые паспортные ' +
  'величины:';
P.appendChild(dv);
table(F.calibration_checks.map(c => [
  c.name.replace(', мм', '').replace(', пт', ''),
  c.value.toFixed(2) + (c.deviation === null ? ''
    : ' (' + (c.deviation * 100).toFixed(2) + '%)'), '']));

h2('Снятые с чертежа');
table(DATA.metricRows);

h2('Чего на чертеже нет');
for (const g of F.gaps) {
  const d = document.createElement('div');
  d.className = 'gap';
  const b = document.createElement('b');
  b.textContent = g.what;
  const s = document.createElement('span');
  s.textContent = g.detail;
  d.append(b, s);
  P.appendChild(d);
}

// ----------------------------------------------------------------- старт

addEventListener('resize', resize);
resize();
fitCamera();
frame();
