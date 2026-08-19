// Кернел Био — Савара из wasm: загрузка и вызов.
//
// Зачем он здесь. На настольной машине пелена стоит 2.7 мс на шаг и в кадр не
// упирается. На телефоне физика занимает 10.4 мс из 18 (docs/perf.md §3), и
// одним из рычагов было «не считать пелену на телефоне» — то есть отгружать
// туда модель без индуктивного сопротивления от пелены и без Вагнера. Кернел
// затевался ради того, чтобы этот рычаг убрать, а не ради круглого числа в
// замере.
//
// МОДУЛЕЙ ДВА, и грузятся они по-разному не от вкуса. Браузеры запрещают
// синхронную компиляцию в главном потоке на буферах больше четырёх килобайт:
// пелена (3115 байт) под лимитом, решётка (7470) — нет, и `-Oz` её до лимита не
// доводит, даёт 4481 и уже ценой скорости. Поэтому оба инстанцируются
// асинхронно, одинаково: развилка по размеру сэкономила бы микросекунды и
// стоила бы второго пути загрузки.
//
// ОТКАТА НА JS ЗДЕСЬ НЕТ, и это осознанно.
//
// Сперва он был: обе ветки давали побитово один ответ, и казалось, что запасной
// путь бесплатен. Довод против сильнее: две копии одной формулы — это две
// формулы, и расходятся они МОЛЧА. Запасная ветка не исполняется никогда (wasm
// собирается всегда), значит её никто не проверяет, значит первая же правка
// кернела оставит её позади — и обнаружится это на том единственном устройстве,
// где wasm не собрался.
//
// Поэтому копия ровно одна, а образец, с которым её сверяют, живёт в батарее
// (`tests/kernel.test.mjs`) и сравнивается КАЖДЫЙ ПРОГОН. Разница между
// дубликатом и свидетелем в том и состоит: свидетеля проверяют, дубликат — нет.
//
// Раз запасного пути нет, модули обязаны быть готовы ДО первого шага физики.
// Ждёт этого сам импорт: страница собирается как `<script type="module">`, и
// верхнеуровневый `await` останавливает весь граф модулей до готовности. Не
// стартовать симулятор, пока не загружен кернел, оказалось проще, чем городить
// готовность.

import { BIOT_WASM_B64 } from './biotwasm.js';
import { LATTICE_WASM_B64 } from './latticewasm.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Свой разбор base64 вместо `atob`/`Buffer`: первого нет в старом node, второго
// нет в браузере, а развилка по окружению в горячем модуле — лишний повод
// разойтись между стендом и симулятором.
function unb64(s) {
  const n = s.length;
  let pad = 0;
  while (pad < 2 && s.charCodeAt(n - 1 - pad) === 61) pad++;
  const out = new Uint8Array((n >> 2) * 3 - pad);
  const idx = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) idx[B64.charCodeAt(i)] = i;
  for (let i = 0, o = 0; i < n; i += 4) {
    const a = idx[s.charCodeAt(i)], b = idx[s.charCodeAt(i + 1)];
    const c = idx[s.charCodeAt(i + 2)], d = idx[s.charCodeAt(i + 3)];
    const v = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}

// Оба модуля инстанцируются ЗДЕСЬ, на верхнем уровне, и ошибка не глотается:
// без кернела считать нечем, и притворяться, что всё в порядке, значит отдать
// пользователю страницу, которая молча не работает.
let biot, lat;
try {
  biot = (await WebAssembly.instantiate(unb64(BIOT_WASM_B64), {})).instance.exports;
  lat = (await WebAssembly.instantiate(unb64(LATTICE_WASM_B64), {})).instance.exports;
} catch (err) {
  // Сообщение своё, потому что родное («CompileError», «magic word») ничего не
  // говорит о том, что случилось с лодкой. А случилось то, что физики не будет.
  throw new Error('кернелы wasm не собрались, физику считать нечем: ' + err.message);
}

const X = biot, F64 = new Float64Array(X.memory.buffer);
const L = lat, LF64 = new Float64Array(L.memory.buffer), LU8 = new Uint8Array(L.memory.buffer);
let buf = null, lbuf = null;

function lensure(n) {
  if (lbuf && lbuf.n >= n) return lbuf;
  const m = Math.max(n, lbuf ? lbuf.n * 2 : 64);
  const v3 = () => L.alloc(m * 3 * 8);
  lbuf = {
    n: m,
    a: v3(), b: v3(), ta: v3(), tb: v3(),
    ma: v3(), mb: v3(), mta: v3(), mtb: v3(),
    cpt: v3(), nrm: v3(), mid: v3(),
    lead: L.alloc(m), trail: L.alloc(m), tw: L.alloc(m * 8),
    k: L.alloc(m * m * 8), kw: L.alloc(m * m * 8),
  };
  return lbuf;
}

// `g` — набор уже плотно уложенных массивов, его собирает `Lattice.build`.
export function latticeBuild(g, n, ux, uy, uz, rc2, self, ground, k, kw) {
  if (n <= 0) return false;
  const b = lensure(n);
  for (const nm of ['a', 'b', 'ta', 'tb', 'ma', 'mb', 'mta', 'mtb', 'cpt', 'nrm', 'mid']) {
    LF64.set(g[nm].subarray(0, n * 3), off(b[nm]));
  }
  LF64.set(g.tw.subarray(0, n), off(b.tw));
  LU8.set(g.lead.subarray(0, n), b.lead);
  LU8.set(g.trail.subarray(0, n), b.trail);
  L.lattice_build(b.a, b.b, b.ta, b.tb, b.ma, b.mb, b.mta, b.mtb,
                  b.cpt, b.nrm, b.mid, b.lead, b.trail, b.tw, n,
                  ux, uy, uz, rc2, self ? 1 : 0, ground ? 1 : 0, b.k, b.kw);
  k.set(LF64.subarray(off(b.k), off(b.k) + n * n));
  kw.set(LF64.subarray(off(b.kw), off(b.kw) + n * n));
  return true;
}

// Обмен идёт КОПИЕЙ, а не видами на линейную память, и это осознанный размен.
//
// Виды были бы бесплатны, но потребовали бы, чтобы `FreeWake` и `Lattice`
// заводили свои массивы внутри памяти модуля — то есть чтобы устройство
// хранилища диктовалось кернелом. Цена копии считается: рёбер самое большее
// шестнадцать тысяч чисел, это сто тридцать килобайт, около десяти микросекунд
// против двух с лишним миллисекунд самого счёта. Меньше процента.

// Смещение в вид на линейную память: байты в индексы двойных.
//
// Функция МОДУЛЬНАЯ, а не локальная. Стрелка внутри вызова выглядит опрятнее, но
// заводится заново каждый раз, и профиль выделений показывал её четвёртой
// строкой сверху — 124 КБ за прогон на ровном месте.
const off = (p) => p >> 3;

function ensure(neCap, npCap) {
  if (buf && buf.ne >= neCap && buf.np >= npCap) return buf;
  const ne = Math.max(neCap, buf ? buf.ne * 2 : 4096);
  const np = Math.max(npCap, buf ? buf.np * 2 : 1024);
  buf = {
    ne, np,
    e: X.alloc(ne * 8 * 8),
    t: X.alloc(ne * 8 * 8),
    qx: X.alloc(np * 8), qy: X.alloc(np * 8), qz: X.alloc(np * 8),
    ox: X.alloc(np * 8), oy: X.alloc(np * 8), oz: X.alloc(np * 8),
  };
  // Память модуля не растёт (начальный размер задан при сборке), поэтому вид
  // не отваливается и переснимать его не нужно.
  return buf;
}

// Массивы приходят НЕ ОБЯЗАТЕЛЬНО типизированные, и это не теория: стенды
// пелены зовут `field` с обычными Array (tests/wake.test.mjs). На них нет ни
// `subarray`, ни `set`, и первая версия падала прямо там — поймала батарея,
// а не браузер, и только потому, что стенды не поленились завести свои точки
// массивом.
function inTo(src, n, at) {
  if (src.length === n && src.BYTES_PER_ELEMENT) { F64.set(src, at); return; }
  for (let i = 0; i < n; i++) F64[at + i] = src[i];
}
function outFrom(dst, n, at) {
  for (let i = 0; i < n; i++) dst[i] = F64[at + i];
}

// Полубесконечные нити. Отдельным вызовом, а не флагом к `fieldEdges`: в JS они
// идут вторым проходом по тем же выходным массивам, и разделение здесь повторяет
// разделение там. Выход НЕ обнуляется — добавляется к посчитанному рёбрами.
export function tailsAt(t, nt, qx, qy, qz, np, ox, oy, oz) {
  if (nt <= 0) return false;
  const b = ensure(nt, np);
  inTo(t, nt * 8, off(b.t));
  inTo(qx, np, off(b.qx)); inTo(qy, np, off(b.qy)); inTo(qz, np, off(b.qz));
  inTo(ox, np, off(b.ox)); inTo(oy, np, off(b.oy)); inTo(oz, np, off(b.oz));
  X.tails_at(b.t, nt, b.qx, b.qy, b.qz, np, b.ox, b.oy, b.oz);
  outFrom(ox, np, off(b.ox)); outFrom(oy, np, off(b.oy)); outFrom(oz, np, off(b.oz));
  return true;
}

export function fieldEdges(e, ne, qx, qy, qz, np, ox, oy, oz) {
  if (ne <= 0) return false;
  const b = ensure(ne, np);
  inTo(e, ne * 8, off(b.e));
  inTo(qx, np, off(b.qx)); inTo(qy, np, off(b.qy)); inTo(qz, np, off(b.qz));
  X.field_edges(b.e, ne, b.qx, b.qy, b.qz, np, b.ox, b.oy, b.oz);
  outFrom(ox, np, off(b.ox)); outFrom(oy, np, off(b.oy)); outFrom(oz, np, off(b.oz));
  return true;
}
