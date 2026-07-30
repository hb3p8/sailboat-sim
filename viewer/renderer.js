// Каркасный просмотрщик: canvas 2D + ручная проекция. Никаких внешних библиотек —
// геометрия здесь линейная, а полсотни строк математики дешевле, чем тащить движок.

const RAD = Math.PI / 180;
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const F = DATA.frame, M = F.metrics;

const cam = { az: -132 * RAD, el: 19 * RAD, dist: 11500, target: [3050, 0, 120], fov: 30 * RAD };
const HOME = Object.assign({}, cam, { target: cam.target.slice() });

// ---------------------------------------------------------------- слои

function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

const CONF = {
  measured:  { color: '--c-measured',  label: 'снято с чертежа',       dash: [] },
  derived:   { color: '--c-derived',   label: 'совмещение двух видов', dash: [] },
  projected: { color: '--c-projected', label: 'проекция, Y неизвестен', dash: [7, 4] },
  inferred:  { color: '--c-inferred',  label: 'достроено',             dash: [3, 4] }
};

const layers = [];

function lift(group) {
  const flat = group.plane === 'plan';
  return group.paths.map(p => p.pts.map(q => flat ? [q[0], q[1], 0] : [q[0], 0, q[1]]));
}

const UNDERLAY = [
  ['deck_line', 'Линия борта, вид сверху', '--c-draw', 1.4],
  ['plan',      'Вид сверху: палуба и оборудование', '--c-draw2', 0.8],
  ['profile',   'Вид сбоку: палубные детали', '--c-draw2', 0.8],
  ['sailplan',  'Рангоут и паруса', '--c-draw2', 0.7],
  ['rig',       'Такелаж и выноски', '--c-draw2', 0.7],
  ['other',     'Прочее с листа', '--c-draw2', 0.7]
];

for (const [id, label, color, w] of UNDERLAY) {
  const g = DATA.draw[id];
  if (!g || !g.paths.length) continue;
  layers.push({
    id, label, color, width: w, dash: [], group: 'Подложка — исходный чертёж',
    on: id === 'deck_line' || id === 'plan' || id === 'profile',
    polys: lift(g), count: g.paths.length
  });
}

for (const c of F.curves) {
  const cf = CONF[c.confidence] || CONF.inferred;
  layers.push({
    id: c.name, label: c.label, color: cf.color, width: 2.6, dash: cf.dash,
    group: 'Каркас Ф1', on: true, polys: [c.points], conf: c.confidence, note: c.note
  });
}

// ------------------------------------------------- служебная геометрия

const grid = [];
for (let x = 0; x <= 6000; x += 1000) grid.push([[x, -1200, 0], [x, 1200, 0]]);
grid.push([[0, 0, 0], [6100, 0, 0]]);
grid.push([[0, -1200, 0], [6100, -1200, 0]], [[0, 1200, 0], [6100, 1200, 0]]);
layers.push({ id: 'grid', label: 'Плоскость КВЛ, сетка 1 м', color: '--c-draw2',
              width: 0.8, dash: [2, 5], group: 'Служебное', on: true, polys: grid });

// зона, где по паспорту корпус есть, а на чертеже — ничего
const T = -M.draft_hull_spec_mm, xa = M.lwl_aft_x_mm, xf = M.lwl_fwd_x_mm;
const gapPoly = [[xa, 0, 0], [xf, 0, 0], [xf, 0, T], [xa, 0, T], [xa, 0, 0]];
const gapHatch = [gapPoly];
for (let x = xa; x <= xf; x += 120) gapHatch.push([[x, 0, 0], [x + 120, 0, T]]);
layers.push({ id: 'gap', label: 'Подводная часть: пробел', color: '--c-gap',
              width: 1.0, dash: [], group: 'Служебное', on: true, polys: gapHatch, alpha: .45 });

const NOTES = DATA.notes;

// ---------------------------------------------------------------- камера

// Габарит всего, что показываем: по нему камера подгоняется под окно.
const BB = (() => {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const L of layers) {
    if (L.group !== 'Каркас Ф1' && L.id !== 'gap') continue;
    for (const poly of L.polys) for (const p of poly)
      for (let i = 0; i < 3; i++) {
        if (p[i] < lo[i]) lo[i] = p[i];
        if (p[i] > hi[i]) hi[i] = p[i];
      }
  }
  return { lo, hi, c: [0, 1, 2].map(i => (lo[i] + hi[i]) / 2) };
})();

function fitCamera() {
  const B = basis();
  let hu = 0, hv = 0, hw = 0;
  for (let m = 0; m < 8; m++) {
    const d = [0, 1, 2].map(i => (m >> i & 1 ? BB.hi[i] : BB.lo[i]) - cam.target[i]);
    const du = Math.abs(d[0] * B.right[0] + d[1] * B.right[1] + d[2] * B.right[2]);
    const dv = Math.abs(d[0] * B.up[0] + d[1] * B.up[1] + d[2] * B.up[2]);
    const dw = Math.abs(d[0] * B.fwd[0] + d[1] * B.fwd[1] + d[2] * B.fwd[2]);
    if (du > hu) hu = du; if (dv > hv) hv = dv; if (dw > hw) hw = dw;
  }
  const ty = Math.tan(cam.fov / 2), tx = ty * (W / H);
  cam.dist = Math.max(hu / tx, hv / ty) * 1.16 + hw;
}

function basis() {
  const ce = Math.cos(cam.el), se = Math.sin(cam.el);
  const u = [ce * Math.cos(cam.az), ce * Math.sin(cam.az), se];
  const eye = [cam.target[0] + cam.dist * u[0], cam.target[1] + cam.dist * u[1],
               cam.target[2] + cam.dist * u[2]];
  const fwd = [-u[0], -u[1], -u[2]];
  // right = fwd × worldUp; при взгляде с левого борта даёт нос справа, как на чертеже
  const rn = Math.hypot(fwd[1], fwd[0]) || 1;
  const right = [fwd[1] / rn, -fwd[0] / rn, 0];
  const up = [right[1] * fwd[2] - right[2] * fwd[1],
              right[2] * fwd[0] - right[0] * fwd[2],
              right[0] * fwd[1] - right[1] * fwd[0]];
  return { eye, fwd, right, up, f: (H / 2) / Math.tan(cam.fov / 2) };
}

function toCam(p, B) {
  const d0 = p[0] - B.eye[0], d1 = p[1] - B.eye[1], d2 = p[2] - B.eye[2];
  return [d0 * B.right[0] + d1 * B.right[1] + d2 * B.right[2],
          d0 * B.up[0] + d1 * B.up[1] + d2 * B.up[2],
          d0 * B.fwd[0] + d1 * B.fwd[1] + d2 * B.fwd[2]];
}

const NEAR = 20;

function screenOf(c, B) { return [W / 2 + B.f * c[0] / c[2], H / 2 - B.f * c[1] / c[2]]; }

// ---------------------------------------------------------------- отрисовка

let W = 0, H = 0, fitted = false;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!fitted) { cam.target = BB.c.slice(); fitCamera(); fitted = true; }
  draw();
}

function strokeLayer(L, B) {
  ctx.strokeStyle = css(L.color);
  ctx.lineWidth = L.width;
  ctx.globalAlpha = L.alpha == null ? 1 : L.alpha;
  ctx.setLineDash(L.dash || []);
  ctx.beginPath();
  for (const poly of L.polys) {
    let prev = null, prevIn = false;
    for (const p of poly) {
      const c = toCam(p, B), inside = c[2] > NEAR;
      if (prev) {
        if (inside && prevIn) {
          const a = screenOf(prev, B), b = screenOf(c, B);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        } else if (inside !== prevIn) {
          const t = (NEAR - prev[2]) / (c[2] - prev[2]);
          const m = [prev[0] + (c[0] - prev[0]) * t, prev[1] + (c[1] - prev[1]) * t, NEAR];
          const a = screenOf(prevIn ? prev : m, B), b = screenOf(prevIn ? m : c, B);
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        }
      }
      prev = c; prevIn = inside;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

let showNotes = true;

function drawNotes(B) {
  ctx.font = '11px ui-sans-serif, -apple-system, "Segoe UI", sans-serif';
  const fg = css('--fg'), dim = css('--dim'), panel = css('--panel'), line = css('--line');

  // 1. позиции: якорь на модели + желаемое место подписи
  const boxes = [];
  for (const n of NOTES) {
    const c = toCam(n.p, B);
    if (c[2] <= NEAR) continue;
    const s = screenOf(c, B);
    if (s[0] < -300 || s[0] > W + 300 || s[1] < -300 || s[1] > H + 300) continue;
    const lines = n.t.split('\n');
    const w = Math.max(...lines.map(t => ctx.measureText(t).width)) + 12;
    const h = 18 + (lines.length - 1) * 14;
    boxes.push({
      n, s, lines, w, h,
      x: Math.max(4, Math.min(W - w - 4, n.d[0] >= 0 ? s[0] + n.d[0] : s[0] + n.d[0] - w)),
      y: Math.max(4, Math.min(H - h - 4, s[1] + n.d[1] - 9 - (lines.length - 1) * 7))
    });
  }

  // 2. разводим налезающие друг на друга подписи по вертикали
  boxes.sort((a, b) => a.y - b.y);
  for (let i = 0; i < boxes.length; i++)
    for (let j = 0; j < i; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w + 6 && a.x + a.w + 6 > b.x &&
          a.y < b.y + b.h + 6 && a.y + a.h + 6 > b.y) {
        a.y = Math.min(H - a.h - 4, b.y + b.h + 6);
      }
    }

  // 3. рисуем
  for (const bx of boxes) {
    const { n, s, lines, w, h, x, y } = bx;
    const near = [x + (s[0] > x + w / 2 ? w : (s[0] < x ? 0 : w / 2)),
                  y + (s[1] > y + h ? h : (s[1] < y ? 0 : h / 2))];
    ctx.strokeStyle = dim; ctx.lineWidth = 1; ctx.globalAlpha = .55;
    ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(near[0], near[1]); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(n.c || '--accent');
    ctx.beginPath(); ctx.arc(s[0], s[1], 3, 0, 7); ctx.fill();

    ctx.fillStyle = panel; ctx.globalAlpha = .93;
    roundRect(x, y, w, h, 4); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = fg;
    lines.forEach((t, i) => ctx.fillText(t, x + 6, y + 13 + i * 14));
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  const B = basis();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const L of layers) if (L.on && L.group === 'Служебное') strokeLayer(L, B);
  for (const L of layers) if (L.on && L.group === 'Подложка — исходный чертёж') strokeLayer(L, B);
  for (const L of layers) if (L.on && L.group === 'Каркас Ф1') strokeLayer(L, B);
  if (showNotes) drawNotes(B);
  document.getElementById('hud').textContent =
    `азимут ${(cam.az / RAD).toFixed(0)}°  возвышение ${(cam.el / RAD).toFixed(0)}°  ` +
    `дистанция ${(cam.dist / 1000).toFixed(1)} м\n` +
    'ЛКМ — вращать · колесо — приблизить · Shift+ЛКМ — сдвинуть';
}

// ---------------------------------------------------------------- ввод

let drag = null;
cv.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 };
  cv.setPointerCapture(e.pointerId); cv.classList.add('dragging');
});
cv.addEventListener('pointermove', e => {
  if (!drag) return;
  if (e.buttons === 0) { drag = null; cv.classList.remove('dragging'); return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.pan) {
    const B = basis(), k = cam.dist / B.f;
    for (let i = 0; i < 3; i++)
      cam.target[i] += -B.right[i] * dx * k + B.up[i] * dy * k;
  } else {
    cam.az -= dx * 0.006;
    cam.el = Math.max(-89 * RAD, Math.min(89 * RAD, cam.el + dy * 0.006));
  }
  draw();
});
const stop = e => { drag = null; cv.classList.remove('dragging'); };
cv.addEventListener('pointerup', stop);
cv.addEventListener('pointercancel', stop);
cv.addEventListener('wheel', e => {
  e.preventDefault();
  cam.dist = Math.max(1200, Math.min(60000, cam.dist * Math.exp(e.deltaY * 0.0012)));
  draw();
}, { passive: false });

// ---------------------------------------------------------------- виды

const VIEWS = [
  ['Изометрия', { az: -132, el: 19 }],
  ['Сверху', { az: -90, el: 89 }],
  ['Сбоку', { az: -90, el: 0 }],
  ['С кормы', { az: 180, el: 2 }],
  ['С носа', { az: 0, el: 2 }]
];

const vbox = document.getElementById('views');
VIEWS.forEach(([name, v], i) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => {
    cam.az = v.az * RAD; cam.el = v.el * RAD;
    cam.target = BB.c.slice();
    fitCamera();
    [...vbox.children].forEach(c => c.classList.contains('view') && c.classList.remove('on'));
    b.classList.add('on'); draw();
  };
  b.classList.add('view');
  if (i === 0) b.classList.add('on');
  vbox.appendChild(b);
});

const rb = document.createElement('button');
rb.textContent = 'Сброс';
rb.onclick = () => { cam.target = BB.c.slice(); fitCamera(); draw(); };
vbox.appendChild(rb);

const nb = document.createElement('button');
nb.textContent = 'Пометки'; nb.classList.add('on');
nb.onclick = () => { showNotes = !showNotes; nb.classList.toggle('on', showNotes); draw(); };
vbox.appendChild(nb);

const tb = document.createElement('button');
tb.textContent = 'Тема';
tb.onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  draw();
};
vbox.appendChild(tb);

// ---------------------------------------------------------------- панель

const P = document.getElementById('panel');

function h2(t) { const e = document.createElement('h2'); e.textContent = t; P.appendChild(e); return e; }

function table(rows) {
  const t = document.createElement('table');
  for (const [k, v, u] of rows) {
    const tr = t.insertRow();
    tr.insertCell().textContent = k;
    const c = tr.insertCell(); c.className = 'v'; c.textContent = v;
    const uc = tr.insertCell(); uc.className = 'u'; uc.textContent = u || '';
  }
  P.appendChild(t);
  return t;
}

const seen = new Set();
for (const L of layers) {
  if (!seen.has(L.group)) { h2(L.group); seen.add(L.group); }
  const lab = document.createElement('label');
  lab.className = 'row';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = L.on;
  cb.onchange = () => { L.on = cb.checked; draw(); };
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.borderTopColor = css(L.color);
  sw.style.borderTopStyle = (L.dash && L.dash.length) ? 'dashed' : 'solid';
  const txt = document.createElement('span');
  txt.textContent = L.label;
  if (L.conf) txt.title = L.note;
  lab.append(cb, sw, txt);
  P.appendChild(lab);
}

h2('Достоверность кривых');
for (const k of ['measured', 'derived', 'projected', 'inferred']) {
  const d = document.createElement('div');
  d.className = 'note';
  d.innerHTML = `<code style="color:${css(CONF[k].color)}">${k}</code> — ${CONF[k].label}`;
  P.appendChild(d);
}

h2('Привязка');
const dv = document.createElement('p');
dv.className = 'note';
dv.textContent = `Масштаб ${F.datum.mm_per_pt.toFixed(4)} мм/пт, получен из габаритной длины ` +
  '6100 мм. Проверки — независимые паспортные величины:';
P.appendChild(dv);
table(F.calibration_checks.map(c => [
  c.name.replace(', мм', '').replace(', пт', ''),
  c.value.toFixed(2) + (c.deviation === null ? '' : ` (${(c.deviation * 100).toFixed(2)}%)`),
  ''
]));

h2('Снятые величины');
table(DATA.metricRows);

h2('Чего на чертеже нет');
for (const g of F.gaps) {
  const d = document.createElement('div');
  d.className = 'gap';
  d.innerHTML = `<b></b><span></span>`;
  d.querySelector('b').textContent = g.what;
  d.querySelector('span').textContent = g.detail;
  P.appendChild(d);
}

addEventListener('resize', resize);
resize();
