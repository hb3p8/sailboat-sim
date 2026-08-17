# -*- coding: utf-8 -*-
"""HTML-отчёт по расчётам: страница со всеми графиками в одном файле.

Почему одним файлом и без единой внешней библиотеки. Отчёт переживает свои
расчёты: через полгода к нему возвращаются, чтобы понять, откуда взялась
поправка в модели. Страница, которая ходит в сеть за библиотекой графиков, к
этому моменту либо не откроется, либо нарисует что-то другое. Здесь всё —
данные, разметка, рисование — лежит в одном файле, и он открывается двойным
щелчком без сервера.

Анимация не украшение и стоит там, где показывает то, чего не видно на
статичной картинке: как сила выходит на плато (и выходит ли), и куда на самом
деле идёт поток. Всё, что можно понять по неподвижному графику, неподвижным и
остаётся. Уважается `prefers-reduced-motion`.

Цвета взяты из проверенной палитры: слоты 1—3 (синий, оранжевый, бирюзовый) —
единственная тройка, проходящая проверку по всем парам сразу в обоих режимах.
Синий всегда CFD, оранжевый всегда симулятор, бирюзовый — опубликованные
данные. Цвет закреплён за сущностью, а не за порядком в списке.
"""

import datetime
import json
import os

PAGE = r"""<!DOCTYPE html>
<html lang="ru" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root{
  color-scheme: light;
  --plane:#f9f9f7; --surface:#fcfcfb;
  --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,0.10);
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a;
  --good:#0ca30c; --warn:#fab219; --serious:#ec835a; --crit:#d03b3b;
  --seq0:#cde2fb; --seq1:#9ec5f4; --seq2:#6da7ec; --seq3:#3987e5;
  --seq4:#256abf; --seq5:#184f95; --seq6:#0d366b;
  --divmid:#f0efec;
}
:root[data-theme="dark"], :root[data-theme="auto"]:where(.dark){
  color-scheme: dark;
  --plane:#0d0d0d; --surface:#1a1a19;
  --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10);
  --s1:#3987e5; --s2:#d95926; --s3:#199e70;
  --divmid:#383835;
}
@media (prefers-color-scheme: dark){
  :root[data-theme="auto"]{
    color-scheme: dark;
    --plane:#0d0d0d; --surface:#1a1a19;
    --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10);
    --s1:#3987e5; --s2:#d95926; --s3:#199e70;
    --divmid:#383835;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:27px;margin:0 0 6px;letter-spacing:-0.01em}
h2{font-size:21px;margin:44px 0 6px;letter-spacing:-0.01em}
h3{font-size:16px;margin:26px 0 4px}
p{margin:8px 0;color:var(--ink2);max-width:74ch}
.lede{font-size:16px;color:var(--ink2);max-width:74ch}
small,.small{font-size:13px;color:var(--muted)}
a{color:var(--s1)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--surface);border:1px solid var(--border);
  border-radius:4px;padding:1px 5px}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.btn{font:13px system-ui;color:var(--ink2);background:var(--surface);
  border:1px solid var(--border);border-radius:8px;padding:6px 12px;cursor:pointer}
.btn:hover{color:var(--ink)}
.card{background:var(--surface);border:1px solid var(--border);
  border-radius:12px;padding:18px 18px 14px;margin:16px 0}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 4px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:10px 14px;min-width:126px}
.tile .k{font-size:12px;color:var(--muted);letter-spacing:.01em}
.tile .v{font-size:21px;margin-top:2px}
.tile .u{font-size:12px;color:var(--muted);margin-left:3px}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin:6px 0 10px;font-size:13px;
  color:var(--ink2)}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;
  margin-right:6px;vertical-align:-1px}
figure{margin:6px 0 2px}
figcaption{font-size:13px;color:var(--muted);margin-top:7px;max-width:80ch}
canvas,svg{display:block;width:100%;height:auto}
table{border-collapse:collapse;font-size:13px;margin:10px 0;width:100%;
  font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:5px 9px;border-bottom:1px solid var(--grid)}
th:first-child,td:first-child{text-align:left;font-variant-numeric:normal}
th{color:var(--muted);font-weight:500}
details{margin:8px 0}
summary{cursor:pointer;font-size:13px;color:var(--muted)}
summary:hover{color:var(--ink2)}
.badge{display:inline-block;font-size:12px;padding:2px 9px;border-radius:999px;
  border:1px solid var(--border);color:var(--ink2);margin-left:6px}
.badge.ok{color:var(--good);border-color:currentColor}
.badge.look{color:var(--serious);border-color:currentColor}
.badge.bad{color:var(--crit);border-color:currentColor}
.tip{position:fixed;pointer-events:none;background:var(--surface);
  border:1px solid var(--border);border-radius:8px;padding:7px 10px;
  font-size:12.5px;color:var(--ink);box-shadow:0 4px 14px rgba(0,0,0,.14);
  opacity:0;transition:opacity .1s;z-index:20;font-variant-numeric:tabular-nums}
.note{border-left:3px solid var(--s2);padding:2px 0 2px 14px;margin:14px 0;
  color:var(--ink2);max-width:74ch}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:860px){.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<div class="topbar">
  <div>
    <h1>__TITLE__</h1>
    <p class="lede">__LEDE__</p>
  </div>
  <button class="btn" id="theme">тема</button>
</div>
<div id="root"></div>
</div>
<div class="tip" id="tip"></div>
<script id="payload" type="application/json">__PAYLOAD__</script>
<script>
"use strict";
const D = JSON.parse(document.getElementById("payload").textContent);
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const tip = document.getElementById("tip");

document.getElementById("theme").onclick = () => {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === "dark" ? "light"
                  : r.dataset.theme === "light" ? "auto" : "dark";
  redrawAll();
};
const cssv = n => getComputedStyle(document.documentElement)
  .getPropertyValue(n).trim();

const fmt = (v, d) => v === null || v === undefined || !isFinite(v) ? "—"
  : (Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-3))
    ? v.toExponential(2) : v.toFixed(d === undefined ? 3 : d);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
function showTip(ev, html){
  tip.innerHTML = html; tip.style.opacity = 1;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY - r.height - 10;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y < 8) y = ev.clientY + 16;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => tip.style.opacity = 0;

// --- общее для графиков -------------------------------------------------------
//
// Каждый график получает свою функцию перерисовки и кладёт её в REDRAW: при
// смене темы цвета берутся из CSS-переменных заново. Иначе тёмная тема
// оставляла бы светлые оси — их цвет был бы снят один раз при первой отрисовке.
const REDRAW = [];
const redrawAll = () => REDRAW.forEach(f => f());

function setupCanvas(cv, w, h){
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = w * dpr; cv.height = h * dpr;
  cv.style.aspectRatio = w + " / " + h;
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}
function ticks(lo, hi, n){
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const s = [1, 2, 2.5, 5, 10].find(m => p * m >= raw) * p;
  const out = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + s * 1e-9; v += s) out.push(v);
  return out;
}
const tickDigits = t => {
  if (t.length < 2) return 2;
  const step = Math.abs(t[1] - t[0]);
  if (!(step > 0)) return 2;
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + 1));
};
function axes(g, W, H, M, xs, ys, xlab, ylab, opt){
  opt = opt || {};
  if (opt.yd === undefined) opt.yd = tickDigits(ys.t);
  if (opt.xd === undefined) opt.xd = tickDigits(xs.t);
  g.strokeStyle = cssv("--grid"); g.lineWidth = 1;
  g.fillStyle = cssv("--muted");
  g.font = "11px system-ui"; g.textAlign = "right"; g.textBaseline = "middle";
  ys.t.forEach(v => {
    const y = Math.round(ys(v)) + 0.5;
    g.beginPath(); g.moveTo(M.l, y); g.lineTo(W - M.r, y); g.stroke();
    g.fillText(opt.yfmt ? opt.yfmt(v) : fmt(v, opt.yd), M.l - 7, y);
  });
  g.textAlign = "center"; g.textBaseline = "top";
  xs.t.forEach(v => {
    const x = Math.round(xs(v)) + 0.5;
    g.fillText(opt.xfmt ? opt.xfmt(v) : fmt(v, opt.xd), x, H - M.b + 7);
  });
  g.strokeStyle = cssv("--axis");
  g.beginPath();
  g.moveTo(M.l, H - M.b + 0.5); g.lineTo(W - M.r, H - M.b + 0.5); g.stroke();
  g.fillStyle = cssv("--muted"); g.textAlign = "center";
  if (xlab) g.fillText(xlab, (M.l + W - M.r) / 2, H - 13);
  if (ylab){ g.save(); g.translate(12, (M.t + H - M.b) / 2); g.rotate(-Math.PI/2);
    g.textBaseline = "middle"; g.fillText(ylab, 0, 0); g.restore(); }
}
const scale = (d0, d1, r0, r1) => {
  const s = v => d1 === d0 ? (r0 + r1) / 2 : r0 + (v - d0) * (r1 - r0) / (d1 - d0);
  s.inv = q => d1 === d0 ? d0 : d0 + (q - r0) * (d1 - d0) / (r1 - r0);
  return s;
};

// --- график сходимости силы ---------------------------------------------------
//
// Рисуется полоса от минимума до максимума по окну прореживания, а не одна
// линия: сошедшийся случай отличается от колеблющегося именно ТОЛЩИНОЙ этой
// полосы, и прореживание по среднему её бы съело.
function convergenceChart(host, hist, keys, windowFrom, caption){
  const W = 560, H = 230, M = {l: 62, r: 16, t: 12, b: 42};
  const cv = el("canvas");
  const fig = el("figure"); fig.appendChild(cv);
  if (caption) fig.appendChild(el("figcaption", null, caption));
  host.appendChild(fig);
  let anim = REDUCED ? 1 : 0;
  const t = hist.t;
  let lo = Infinity, hi = -Infinity;
  keys.forEach(k => {
    const s = hist.series[k]; if (!s) return;
    const half = Math.floor(s.lo.length / 3);
    for (let i = half; i < s.lo.length; i++){
      lo = Math.min(lo, s.lo[i]); hi = Math.max(hi, s.hi[i]);
    }
  });
  const pad = (hi - lo) * 0.35 || Math.abs(hi) * 0.1 || 1;
  lo -= pad; hi += pad;
  const COL = k => cssv(k === keys[0] ? "--s1" : k === keys[1] ? "--s2" : "--s3");

  function draw(){
    const g = setupCanvas(cv, W, H);
    const xs = scale(t[0], t[t.length-1], M.l, W - M.r);
    const ys = scale(lo, hi, H - M.b, M.t);
    xs.t = ticks(t[0], t[t.length-1], 6); ys.t = ticks(lo, hi, 5);
    axes(g, W, H, M, xs, ys, "итерация", "Н", {xd: 0});
    if (windowFrom != null && windowFrom > t[0]){
      g.fillStyle = cssv("--grid");
      g.globalAlpha = 0.75;
      g.fillRect(xs(windowFrom), M.t, (W - M.r) - xs(windowFrom), H - M.b - M.t);
      g.globalAlpha = 1;
      g.fillStyle = cssv("--muted"); g.font = "11px system-ui";
      g.textAlign = "left"; g.textBaseline = "top";
      g.fillText("окно усреднения", xs(windowFrom) + 6, M.t + 4);
    }
    const n = Math.max(2, Math.floor(t.length * anim));
    keys.forEach(k => {
      const s = hist.series[k]; if (!s) return;
      g.fillStyle = COL(k); g.globalAlpha = 0.28;
      g.beginPath();
      for (let i = 0; i < n; i++) g.lineTo(xs(t[i]), ys(s.hi[i]));
      for (let i = n - 1; i >= 0; i--) g.lineTo(xs(t[i]), ys(s.lo[i]));
      g.closePath(); g.fill(); g.globalAlpha = 1;
      g.strokeStyle = COL(k); g.lineWidth = 2; g.lineJoin = "round";
      g.beginPath();
      for (let i = 0; i < n; i++){
        const y = ys((s.lo[i] + s.hi[i]) / 2);
        i ? g.lineTo(xs(t[i]), y) : g.moveTo(xs(t[i]), y);
      }
      g.stroke();
      if (n > 2){
        const i = n - 1, y = ys((s.lo[i] + s.hi[i]) / 2);
        g.fillStyle = COL(k); g.font = "12px system-ui";
        g.textAlign = "right"; g.textBaseline = "bottom";
        g.fillText(k, xs(t[i]) - 4, y - 5);
      }
    });
    cv._xs = xs; cv._ys = ys;
  }
  REDRAW.push(draw);
  function step(){
    if (anim < 1){ anim = Math.min(1, anim + 0.022); draw(); requestAnimationFrame(step); }
    else draw();
  }
  step();
  cv.onmousemove = ev => {
    const r = cv.getBoundingClientRect();
    const x = (ev.clientX - r.left) * W / r.width;
    if (!cv._xs) return;
    const ti = cv._xs.inv(x);
    let i = 0, best = Infinity;
    t.forEach((v, j) => { const d = Math.abs(v - ti); if (d < best){best = d; i = j;} });
    let h = "<b>итерация " + Math.round(t[i]) + "</b>";
    keys.forEach(k => { const s = hist.series[k]; if (!s) return;
      h += "<br>" + k + " = " + fmt((s.lo[i] + s.hi[i]) / 2, 3)
         + " Н <span style='color:var(--muted)'>±" + fmt((s.hi[i]-s.lo[i])/2, 3) + "</span>"; });
    showTip(ev, h);
  };
  cv.onmouseleave = hideTip;
}

// --- невязки ------------------------------------------------------------------
function residualChart(host, res, caption){
  const W = 560, H = 200, M = {l: 62, r: 46, t: 12, b: 42};
  const cv = el("canvas");
  const fig = el("figure"); fig.appendChild(cv);
  if (caption) fig.appendChild(el("figcaption", null, caption));
  host.appendChild(fig);
  const names = Object.keys(res);
  let lo = 1e-12, hi = 1, imax = 1;
  names.forEach(k => { imax = Math.max(imax, res[k].i[res[k].i.length-1]); });
  const COLS = ["--s1", "--s2", "--s3", "--muted", "--axis", "--ink2"];
  function draw(){
    const g = setupCanvas(cv, W, H);
    const xs = scale(1, imax, M.l, W - M.r);
    const ys = scale(Math.log10(hi), Math.log10(lo), M.t, H - M.b);
    xs.t = ticks(1, imax, 6);
    ys.t = []; for (let e = 0; e >= -12; e -= 2) ys.t.push(e);
    axes(g, W, H, M, xs, ys, "итерация", "невязка",
         {xd: 0, yfmt: e => "1e" + e});
    const ends = [];
    names.forEach((k, ci) => {
      g.strokeStyle = cssv(COLS[ci % COLS.length]); g.lineWidth = 2;
      g.beginPath();
      res[k].i.forEach((x, j) => {
        const y = ys(Math.log10(Math.max(res[k].v[j], 1e-12)));
        j ? g.lineTo(xs(x), y) : g.moveTo(xs(x), y);
      });
      g.stroke();
      const j = res[k].i.length - 1;
      ends.push({k: k, ci: ci, y: ys(Math.log10(Math.max(res[k].v[j], 1e-12)))});
    });
    ends.sort((a, b) => a.y - b.y);
    let prev = -1e9;
    ends.forEach(e => {
      const y = Math.max(e.y, prev + 12);
      prev = y;
      g.fillStyle = cssv(COLS[e.ci % COLS.length]);
      g.font = "11px system-ui"; g.textAlign = "left"; g.textBaseline = "middle";
      g.fillText(e.k, W - M.r + 4, y);
    });
  }
  REDRAW.push(draw); draw();
}

// --- поляра: точки CFD и кривая симулятора ------------------------------------
function polarChart(host, pts, curve, xlab, ylab, caption, opt){
  opt = opt || {};
  const W = 460, H = 280, M = {l: 62, r: 22, t: 14, b: 44};
  const cv = el("canvas");
  const fig = el("figure"); fig.appendChild(cv);
  if (caption) fig.appendChild(el("figcaption", null, caption));
  host.appendChild(fig);
  const allx = pts.map(p => p.x).concat(curve.map(p => p.x));
  const ally = pts.map(p => p.y).concat(curve.map(p => p.y));
  let x0 = Math.min(...allx), x1 = Math.max(...allx);
  let y0 = Math.min(...ally, 0), y1 = Math.max(...ally);
  const py = (y1 - y0) * 0.12 || 0.1; y0 -= py; y1 += py;
  let anim = REDUCED ? 1 : 0;
  function draw(){
    const g = setupCanvas(cv, W, H);
    const xs = scale(x0, x1, M.l, W - M.r), ys = scale(y0, y1, H - M.b, M.t);
    xs.t = ticks(x0, x1, 5); ys.t = ticks(y0, y1, 5);
    axes(g, W, H, M, xs, ys, xlab, ylab, {xd: 0, yd: opt.yd});
    g.strokeStyle = cssv("--s2"); g.lineWidth = 2; g.lineJoin = "round";
    g.beginPath();
    const nc = Math.max(2, Math.floor(curve.length * anim));
    for (let i = 0; i < nc; i++){
      const p = curve[i];
      i ? g.lineTo(xs(p.x), ys(p.y)) : g.moveTo(xs(p.x), ys(p.y));
    }
    g.stroke();
    if (nc > 3){
      const p = curve[nc-1];
      g.fillStyle = cssv("--s2"); g.font = "12px system-ui";
      g.textAlign = "left"; g.textBaseline = "middle";
      g.fillText("симулятор", xs(p.x) + 7, ys(p.y));
    }
    const np = Math.floor(pts.length * Math.min(1, anim * 1.4));
    for (let i = 0; i < np; i++){
      const p = pts[i];
      g.fillStyle = cssv("--surface");
      g.beginPath(); g.arc(xs(p.x), ys(p.y), 7, 0, 7); g.fill();
      g.fillStyle = cssv("--s1");
      g.beginPath(); g.arc(xs(p.x), ys(p.y), 5, 0, 7); g.fill();
    }
    if (np > 0){
      const p = pts[np-1];
      g.fillStyle = cssv("--s1"); g.font = "12px system-ui";
      g.textAlign = "center"; g.textBaseline = "bottom";
      g.fillText("CFD", xs(p.x), ys(p.y) - 10);
    }
    cv._xs = xs; cv._ys = ys;
  }
  REDRAW.push(draw);
  (function step(){ if (anim < 1){ anim = Math.min(1, anim + 0.03); draw();
    requestAnimationFrame(step);} else draw(); })();
  cv.onmousemove = ev => {
    if (!cv._xs) return;
    const r = cv.getBoundingClientRect();
    const mx = (ev.clientX - r.left) * W / r.width;
    const my = (ev.clientY - r.top) * H / r.height;
    let best = null, bd = 18 * 18;
    pts.forEach(p => {
      const dx = cv._xs(p.x) - mx, dy = cv._ys(p.y) - my;
      const d = dx*dx + dy*dy; if (d < bd){ bd = d; best = p; }
    });
    if (!best){ hideTip(); return; }
    showTip(ev, "<b>" + (best.label || "") + "</b><br>" + xlab + " = "
      + fmt(best.x, 2) + "<br>" + ylab + " = " + fmt(best.y, 4)
      + (best.sim != null ? "<br>симулятор = " + fmt(best.sim, 4) : ""));
  };
  cv.onmouseleave = hideTip;
}

// --- поле течения: тепловая карта и частицы -----------------------------------
//
// Частицы несутся тем же полем, что нарисовано под ними. Это единственный
// способ увидеть на неподвижной картинке, где поток разворачивается и где
// стоит: линии тока на статике сливаются, а точка, которая никуда не едет,
// видна сразу.
function decode(q, n){
  const out = new Float32Array(n);
  const span = (q.hi - q.lo) || 1;
  for (let i = 0; i < n; i++){
    const v = q.data[i];
    out[i] = v === 0 ? NaN : q.lo + (v - 1) / 65534 * span;
  }
  return out;
}
function fieldView(host, sl, caption, opt){
  opt = opt || {};
  const nx = sl.nx, ny = sl.ny;
  const speed = decode(sl.speed, nx*ny);
  const u = decode(sl.u, nx*ny), v = decode(sl.v, nx*ny);
  const pr = sl.p ? decode(sl.p, nx*ny) : null;
  const aspect = (sl.x1 - sl.x0) / (sl.y1 - sl.y0);
  const W = 560, H = Math.max(190, Math.round(W / aspect));
  const cv = el("canvas");
  const fig = el("figure"); fig.appendChild(cv);
  const modeRow = el("div", "legend");
  fig.insertBefore(modeRow, cv);
  if (caption) fig.appendChild(el("figcaption", null, caption));
  host.appendChild(fig);

  let mode = "speed";
  [["speed", "модуль скорости"], ["p", "давление"]].forEach(([k, name]) => {
    if (k === "p" && !pr) return;
    const b = el("button", "btn", name);
    b.style.padding = "3px 10px"; b.style.fontSize = "12px";
    b.onclick = () => { mode = k; paintBase(); };
    modeRow.appendChild(b);
  });

  const SEQ = () => [cssv("--seq0"), cssv("--seq1"), cssv("--seq2"),
                     cssv("--seq3"), cssv("--seq4"), cssv("--seq5"), cssv("--seq6")]
                     .map(hex2rgb);
  function hex2rgb(h){ h = h.replace("#",""); return [parseInt(h.slice(0,2),16),
    parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
  function ramp(cols, t){
    t = Math.max(0, Math.min(1, t));
    const x = t * (cols.length - 1), i = Math.min(cols.length - 2, Math.floor(x));
    const f = x - i, a = cols[i], b = cols[i+1];
    return [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f];
  }
  let base = null;
  function paintBase(){
    const g = cv.getContext("2d");
    const img = g.createImageData(nx, ny);
    const cols = SEQ();
    const surf = hex2rgb(cssv("--surface"));
    const src = mode === "p" && pr ? pr : speed;
    const good = [];
    for (let i = 0; i < src.length; i++) if (isFinite(src[i])) good.push(src[i]);
    good.sort((a, b) => a - b);
    const q = f => good.length ? good[Math.min(good.length - 1,
      Math.max(0, Math.round(f * (good.length - 1))))] : 0;
    let lo = q(0.01), hi = q(0.99);
    if (mode === "p"){ const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
    if (!(hi > lo)){ lo = good[0] || 0; hi = (good[good.length-1] || 1); }
    const divA = hex2rgb(cssv("--s1")), divB = hex2rgb(cssv("--crit"));
    const mid = hex2rgb(cssv("--divmid"));
    for (let j = 0; j < ny; j++){
      for (let i = 0; i < nx; i++){
        const k = j*nx + i, o = ((ny-1-j)*nx + i) * 4;
        const val = src[k];
        let c;
        if (!isFinite(val)) c = surf;
        else if (mode === "p"){
          const t = (val - lo) / ((hi - lo) || 1);
          c = t < 0.5 ? ramp([divA, mid], t*2) : ramp([mid, divB], (t-0.5)*2);
        } else c = ramp(cols, (val - lo) / ((hi - lo) || 1));
        img.data[o] = c[0]; img.data[o+1] = c[1]; img.data[o+2] = c[2];
        img.data[o+3] = 255;
      }
    }
    const off = document.createElement("canvas");
    off.width = nx; off.height = ny;
    off.getContext("2d").putImageData(img, 0, 0);
    base = {off: off, lo: lo, hi: hi};
    scaleRow.innerHTML = "<span>" + (mode === "p" ? "давление p/ρ" : "|U|")
      + ": " + fmt(lo, 2) + " … " + fmt(hi, 2)
      + (mode === "p" ? " м²/с²" : " м/с")
      + " <span style='opacity:.7'>(1—99 процентиль; крайние значения "
      + "обрезаны, иначе одна ячейка красит всё поле в один цвет)</span></span>";
  }
  const scaleRow = el("div", "small");
  fig.insertBefore(scaleRow, cv);

  // Частицы
  const N = REDUCED ? 260 : 420;
  const TAIL = 7;
  const P = new Float32Array(N*3);
  const TR = new Float32Array(N * TAIL * 2);   // хвост: пары (x, y)
  const rnd = (a, b) => a + Math.random() * (b - a);
  function spawn(i, anywhere){
    const edge = anywhere ? false : Math.random() < 0.7;
    P[i*3] = edge ? rnd(0, 0.04) : rnd(0, 1);
    P[i*3+1] = rnd(0, 1);
    P[i*3+2] = rnd(20, 160);
    for (let t = 0; t < TAIL; t++){
      TR[(i*TAIL + t)*2] = P[i*3]; TR[(i*TAIL + t)*2 + 1] = P[i*3+1];
    }
  }
  for (let i = 0; i < N; i++) spawn(i, true);
  function sample(arr, fx, fy){
    const x = fx * (nx - 1), y = fy * (ny - 1);
    const i = Math.min(nx-2, Math.max(0, Math.floor(x)));
    const j = Math.min(ny-2, Math.max(0, Math.floor(y)));
    const a = arr[j*nx+i], b = arr[j*nx+i+1];
    const c = arr[(j+1)*nx+i], d = arr[(j+1)*nx+i+1];
    if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d)) return NaN;
    const tx = x - i, ty = y - j;
    return a*(1-tx)*(1-ty) + b*tx*(1-ty) + c*(1-tx)*ty + d*tx*ty;
  }
  const spanx = sl.x1 - sl.x0, spany = sl.y1 - sl.y0;
  const umax = Math.max(Math.abs(sl.u.lo), Math.abs(sl.u.hi),
                        Math.abs(sl.v.lo), Math.abs(sl.v.hi)) || 1;
  // Полтора процента ширины кадра за кадр — примерно секунда на пролёт.
  const DT = 0.015 * spanx / umax;
  function frame(){
    const g = setupCanvas(cv, W, H);
    if (!base) paintBase();
    g.imageSmoothingEnabled = true;
    g.drawImage(base.off, 0, 0, W, H);
    if (N){
      g.lineCap = "round"; g.lineJoin = "round";
      g.strokeStyle = cssv("--ink");
      for (let i = 0; i < N; i++){
        const fx = P[i*3], fy = P[i*3+1];
        const uu = sample(u, fx, fy), vv = sample(v, fx, fy);
        if (!isFinite(uu)){ spawn(i, false); continue; }
        const nxp = fx + uu / spanx * DT, nyp = fy + vv / spany * DT;
        // Сдвиг хвоста: голова вперёд, самая старая точка выбрасывается.
        for (let t = TAIL - 1; t > 0; t--){
          TR[(i*TAIL + t)*2] = TR[(i*TAIL + t - 1)*2];
          TR[(i*TAIL + t)*2 + 1] = TR[(i*TAIL + t - 1)*2 + 1];
        }
        TR[i*TAIL*2] = nxp; TR[i*TAIL*2 + 1] = nyp;
        for (let t = 0; t < TAIL - 1; t++){
          const ax = TR[(i*TAIL + t)*2], ay = TR[(i*TAIL + t)*2 + 1];
          const bx = TR[(i*TAIL + t + 1)*2], by = TR[(i*TAIL + t + 1)*2 + 1];
          if (Math.abs(ax - bx) > 0.3 || Math.abs(ay - by) > 0.3) break;
          g.globalAlpha = 0.62 * (1 - t / TAIL);
          g.lineWidth = 1.9 * (1 - 0.6 * t / TAIL);
          g.beginPath();
          g.moveTo(ax*W, (1-ay)*H); g.lineTo(bx*W, (1-by)*H);
          g.stroke();
        }
        P[i*3] = nxp; P[i*3+1] = nyp; P[i*3+2] -= 1;
        if (nxp < 0 || nxp > 1 || nyp < 0 || nyp > 1 || P[i*3+2] < 0) spawn(i, false);
      }
      g.globalAlpha = 1;
    }
    // При включённом «уменьшить движение» кадр рисуется один раз: хвосты у
    // частиц уже есть, и картинка читается неподвижной.
    if (N && !REDUCED) requestAnimationFrame(frame);
  }
  REDRAW.push(() => { base = null; if (REDUCED) frame(); });
  if (REDUCED){ for (let k = 0; k < TAIL + 2; k++) frame(); } else frame();
  cv.onmousemove = ev => {
    const r = cv.getBoundingClientRect();
    const fx = (ev.clientX - r.left) / r.width;
    const fy = 1 - (ev.clientY - r.top) / r.height;
    const s = sample(speed, fx, fy);
    const px = sl.x0 + fx*spanx, py = sl.y0 + fy*spany;
    if (!isFinite(s)){ showTip(ev, "внутри тела"); return; }
    let h = "x = " + fmt(px, 2) + " м, " + (sl.axes[1] === 1 ? "y" : "z")
          + " = " + fmt(py, 2) + " м<br>|U| = " + fmt(s, 3) + " м/с";
    if (pr){ const q = sample(pr, fx, fy);
      if (isFinite(q)) h += "<br>p/ρ = " + fmt(q, 2) + " м²/с²"; }
    showTip(ev, h);
  };
  cv.onmouseleave = hideTip;
}

// --- тройка сеток -------------------------------------------------------------
function meshChart(host, r, quantity, caption){
  const W = 460, H = 250, M = {l: 70, r: 24, t: 16, b: 46};
  const cv = el("canvas");
  const fig = el("figure"); fig.appendChild(cv);
  if (caption) fig.appendChild(el("figcaption", null, caption));
  host.appendChild(fig);
  const cells = r.refinement.cells;   // coarse, medium, fine
  const vals = [r.values.coarse, r.values.medium, r.values.fine];
  const hs = cells.map(n => Math.pow(1 / n, 1/3));
  const hx = hs.map(h => h / hs[0]);
  const ext = r.extrapolated;
  const ally = vals.concat(ext == null ? [] : [ext]);
  let y0 = Math.min(...ally), y1 = Math.max(...ally);
  const pad = (y1 - y0) * 0.35 || Math.abs(y1) * 0.02 || 1;
  y0 -= pad; y1 += pad;
  function draw(){
    const g = setupCanvas(cv, W, H);
    const xs = scale(0, Math.max(...hx) * 1.08, M.l, W - M.r);
    const ys = scale(y0, y1, H - M.b, M.t);
    xs.t = ticks(0, Math.max(...hx) * 1.08, 4); ys.t = ticks(y0, y1, 5);
    axes(g, W, H, M, xs, ys, "относительный размер ячейки h/h_coarse",
         quantity, {xd: 2, yd: 3});
    if (ext != null){
      g.strokeStyle = cssv("--s3"); g.setLineDash([5, 4]); g.lineWidth = 2;
      g.beginPath(); g.moveTo(M.l, ys(ext)); g.lineTo(W - M.r, ys(ext)); g.stroke();
      g.setLineDash([]);
      g.fillStyle = cssv("--s3"); g.font = "12px system-ui";
      g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillText("Ричардсон h→0", M.l + 6, ys(ext) - 5);
    }
    g.strokeStyle = cssv("--s1"); g.lineWidth = 2;
    g.beginPath();
    hx.forEach((h, i) => i ? g.lineTo(xs(h), ys(vals[i])) : g.moveTo(xs(h), ys(vals[i])));
    g.stroke();
    const names = ["coarse", "medium", "fine"];
    hx.forEach((h, i) => {
      g.fillStyle = cssv("--surface");
      g.beginPath(); g.arc(xs(h), ys(vals[i]), 7.5, 0, 7); g.fill();
      g.fillStyle = cssv("--s1");
      g.beginPath(); g.arc(xs(h), ys(vals[i]), 5.5, 0, 7); g.fill();
      g.fillStyle = cssv("--ink2"); g.font = "11px system-ui";
      g.textAlign = "center"; g.textBaseline = "top";
      g.fillText(names[i], xs(h), ys(vals[i]) + 10);
    });
    cv._pts = hx.map((h, i) => ({x: xs(h), y: ys(vals[i]), n: names[i],
                                 v: vals[i], c: cells[i]}));
  }
  REDRAW.push(draw); draw();
  cv.onmousemove = ev => {
    if (!cv._pts) return;
    const r2 = cv.getBoundingClientRect();
    const mx = (ev.clientX - r2.left) * W / r2.width;
    const my = (ev.clientY - r2.top) * H / r2.height;
    const p = cv._pts.find(q => (q.x-mx)**2 + (q.y-my)**2 < 200);
    if (!p){ hideTip(); return; }
    showTip(ev, "<b>" + p.n + "</b><br>ячеек " + p.c.toLocaleString("ru")
      + "<br>" + quantity + " = " + fmt(p.v, 4));
  };
  cv.onmouseleave = hideTip;
}

// --- парное сравнение CFD и симулятора ----------------------------------------
function compareBars(host, rows, caption){
  const W = 560, rowH = 42, M = {l: 168, r: 74, t: 26, b: 16};
  const H = M.t + M.b + rows.length * rowH;
  const cv = el("canvas");
  const fig = el("figure"); fig.appendChild(cv);
  if (caption) fig.appendChild(el("figcaption", null, caption));
  host.appendChild(fig);
  const maxv = Math.max(...rows.map(r => Math.max(Math.abs(r.cfd), Math.abs(r.sim))));
  let anim = REDUCED ? 1 : 0;
  function draw(){
    const g = setupCanvas(cv, W, H);
    const xs = scale(0, maxv * 1.05, M.l, W - M.r);
    g.font = "12px system-ui";
    g.fillStyle = cssv("--muted"); g.textAlign = "left"; g.textBaseline = "bottom";
    g.fillText("|значение|", M.l, M.t - 8);
    rows.forEach((r, i) => {
      const y = M.t + i * rowH;
      g.fillStyle = cssv("--ink2"); g.textAlign = "right"; g.textBaseline = "middle";
      g.font = "12.5px system-ui";
      g.fillText(r.label, M.l - 12, y + rowH/2 - 1);
      [[Math.abs(r.cfd), "--s1", 0], [Math.abs(r.sim), "--s2", 1]].forEach(([v, c, k]) => {
        const w = (xs(v) - M.l) * anim;
        g.fillStyle = cssv(c);
        const yy = y + 5 + k * 15, h = 11;
        g.beginPath();
        if (g.roundRect) g.roundRect(M.l, yy, Math.max(w, 0.5), h, [0, 4, 4, 0]);
        else g.rect(M.l, yy, Math.max(w, 0.5), h);
        g.fill();
      });
      g.fillStyle = cssv("--ink2"); g.textAlign = "left"; g.textBaseline = "middle";
      g.font = "12px system-ui";
      const d = r.sim === 0 ? null : 100 * (r.cfd - r.sim) / Math.abs(r.sim);
      g.fillText(d == null ? "—" : (d > 0 ? "+" : "") + d.toFixed(0) + "%",
                 W - M.r + 8, y + rowH/2 - 1);
    });
  }
  REDRAW.push(draw);
  (function step(){ if (anim < 1){ anim = Math.min(1, anim + 0.04); draw();
    requestAnimationFrame(step);} else draw(); })();
}

// --- таблица (обязательный текстовый дубль каждого графика) --------------------
function table(host, head, rows, open){
  const d = el("details");
  if (open) d.open = true;
  d.appendChild(el("summary", null, "таблица тех же чисел"));
  const t = el("table");
  const th = el("tr");
  head.forEach(h => th.appendChild(el("th", null, h)));
  t.appendChild(th);
  rows.forEach(r => {
    const tr = el("tr");
    r.forEach(c => tr.appendChild(el("td", null, c === null || c === undefined
      ? "—" : (typeof c === "number" ? fmt(c, 4) : c))));
    t.appendChild(tr);
  });
  d.appendChild(t);
  host.appendChild(d);
}

function tiles(host, items){
  const row = el("div", "tiles");
  items.forEach(([k, v, u]) => {
    const t = el("div", "tile");
    t.appendChild(el("div", "k", k));
    t.appendChild(el("div", "v", v + (u ? "<span class='u'>" + u + "</span>" : "")));
    row.appendChild(t);
  });
  host.appendChild(row);
}
function legend(host, items){
  const l = el("div", "legend");
  items.forEach(([c, n]) => l.appendChild(el("span", null,
    "<i style='background:" + c + "'></i>" + n)));
  host.appendChild(l);
}

// --- сборка страницы ----------------------------------------------------------
//
// Что показывать, решает питон: сюда приходит готовый список секций и блоков.
// Здесь только отрисовка. Разделение нужно затем, чтобы решение «эту величину
// в отчёт, а эту нет» принималось там же, где известно, что она значит.
const root = document.getElementById("root");

function renderBlock(host, b){
  if (b.kind === "text"){ host.appendChild(el("p", null, b.html)); return; }
  if (b.kind === "note"){ host.appendChild(el("div", "note", b.html)); return; }
  if (b.kind === "h3"){ host.appendChild(el("h3", null, b.html)); return; }
  if (b.kind === "tiles"){ tiles(host, b.items); return; }
  if (b.kind === "table"){ table(host, b.head, b.rows, b.open); return; }
  const card = el("div", "card");
  if (b.title) card.appendChild(el("h3", null, b.title));
  if (b.text) card.appendChild(el("p", null, b.text));
  if (b.kind === "convergence"){
    legend(card, [[cssv("--s1"), b.keys[0]]].concat(
      (b.keys.slice(1) || []).map((k, i) => [cssv(i ? "--s3" : "--s2"), k])));
    convergenceChart(card, b.hist, b.keys, b.window, b.caption);
    if (b.table) table(card, b.table.head, b.table.rows);
  } else if (b.kind === "residuals"){
    residualChart(card, b.res, b.caption);
  } else if (b.kind === "polar"){
    legend(card, [[cssv("--s1"), "CFD"], [cssv("--s2"), "симулятор"]]);
    polarChart(card, b.pts, b.curve, b.xlab, b.ylab, b.caption, b.opt);
    if (b.table) table(card, b.table.head, b.table.rows, true);
  } else if (b.kind === "field"){
    fieldView(card, b.slice, b.caption);
  } else if (b.kind === "mesh"){
    meshChart(card, b.result, b.quantity, b.caption);
    if (b.table) table(card, b.table.head, b.table.rows, true);
  } else if (b.kind === "bars"){
    legend(card, [[cssv("--s1"), "CFD"], [cssv("--s2"), "симулятор"]]);
    compareBars(card, b.rows, b.caption);
    if (b.table) table(card, b.table.head, b.table.rows, true);
  }
  host.appendChild(card);
}

D.sections.forEach(sec => {
  const h = el("h2", null, sec.title + (sec.badge
    ? " <span class='badge " + (sec.badgeKind || "") + "'>" + sec.badge + "</span>"
    : ""));
  root.appendChild(h);
  (sec.blocks || []).forEach(b => renderBlock(root, b));
});

redrawAll();
</script>
</body>
</html>
"""


def build(payload, title, lede, dst):
    """Собрать страницу. Данные уходят в неё JSON-ом, разметка строится в браузере.

    `</script>` внутри данных закрыл бы тег и сломал страницу — экранируется.
    Случай не выдуманный: в заметке к случаю может оказаться что угодно.
    """
    blob = (json.dumps(payload, ensure_ascii=False)
            .replace("</", "<\\/"))
    html = (PAGE.replace("__TITLE__", title)
                .replace("__LEDE__", lede)
                .replace("__PAYLOAD__", blob))
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(html)
    return dst


def stamp():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
