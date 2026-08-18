// Кернел Био — Савара из wasm: загрузка и вызов.
//
// Зачем он здесь. На настольной машине пелена стоит 2.7 мс на шаг и в кадр не
// упирается. На телефоне физика занимает 10.4 мс из 18 (docs/perf.md §3), и
// одним из рычагов было «не считать пелену на телефоне» — то есть отгружать
// туда модель без индуктивного сопротивления от пелены и без Вагнера. Кернел
// затевался ради того, чтобы этот рычаг убрать, а не ради круглого числа в
// замере.
//
// ПОЧЕМУ ЗАГРУЗКА СИНХРОННАЯ, хотя обычно так нельзя. Браузеры запрещают
// `new WebAssembly.Module` в главном потоке на буферах больше четырёх
// килобайт. Наш модуль весит два — он помещается под ограничение, и это не
// случайность, а следствие того, что портирован ровно один цикл. Будь портирован
// весь vlm.js, пришлось бы городить асинхронную готовность и решать, что делать
// на первых кадрах; здесь этого не нужно вовсе.
//
// ОТКАТ ОБЯЗАТЕЛЕН И ПРОВЕРЯЕТСЯ. Если модуль не собрался — старый браузер, CSP,
// что угодно, — `fieldEdges` возвращает false, и вызывающий считает по-старому
// на JS. Обе ветки дают ПОБИТОВО один ответ (kernel/biot.c, tests/kernel.test.mjs),
// поэтому откат не меняет поведение, а только цену.

import { BIOT_WASM_B64 } from './biotwasm.js';

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

// Выключатель для A/B и для проверки самого отката. Не «на всякий случай»:
// обе ветки обязаны давать побитово одно, и единственный способ это утверждать —
// уметь прогнать лодку и так, и так на одном состоянии.
const OFF = typeof process !== 'undefined' && process.env &&
            process.env.SV20_NO_WASM === '1';

let X = null;           // экспорты модуля
let F64 = null;         // вид на линейную память, заводится один раз
let buf = null;         // отведённые под обмен куски

try {
  if (OFF) throw new Error('выключен SV20_NO_WASM');
  const inst = new WebAssembly.Instance(new WebAssembly.Module(unb64(BIOT_WASM_B64)), {});
  X = inst.exports;
  F64 = new Float64Array(X.memory.buffer);
} catch (err) {
  X = null;
}

export const kernelReady = X !== null;

// Исход загрузки говорится ВСЛУХ, и это не отладочный мусор.
//
// Молчащий откат — ровно тот дефект, что перечислен в docs/stability.md §4:
// неверный ответ (здесь — вдвое более дорогой) сделан невидимым. Кернел
// затевался ради телефона, а телефон как раз то место, где он с наибольшей
// вероятностью не соберётся — старый WebKit, жёсткий CSP. Отвалиться молча он
// не имеет права: тогда на мобильном тихо вернётся выключенная пелена, ради
// которой всё и делалось.
//
// Наружу выставлен и признак: отладочная панель и стенды спрашивают его, не
// залезая в область сборки.
if (typeof globalThis !== 'undefined') globalThis.SV20_KERNEL = kernelReady;
if (typeof console !== 'undefined' && console.info) {
  console.info(kernelReady
    ? 'кернел Био — Савара: wasm SIMD'
    : 'кернел Био — Савара: ОТКАТ НА JS — пелена будет стоить вдвое'
      + (OFF ? ' (выключен SV20_NO_WASM)' : ''));
}

// Обмен идёт КОПИЕЙ, а не видами на линейную память, и это осознанный размен.
//
// Виды были бы бесплатны, но потребовали бы, чтобы `FreeWake` заводил свои
// массивы внутри памяти модуля, — то есть чтобы откат на JS перестал быть
// независимым путём. Цена копии считается: рёбер самое большее шестнадцать
// тысяч чисел, это сто тридцать килобайт, около десяти микросекунд против двух
// с лишним миллисекунд самого счёта. Меньше процента.
function ensure(neCap, npCap) {
  if (buf && buf.ne >= neCap && buf.np >= npCap) return buf;
  const ne = Math.max(neCap, buf ? buf.ne * 2 : 4096);
  const np = Math.max(npCap, buf ? buf.np * 2 : 1024);
  buf = {
    ne, np,
    e: X.alloc(ne * 8 * 8),
    qx: X.alloc(np * 8), qy: X.alloc(np * 8), qz: X.alloc(np * 8),
    ox: X.alloc(np * 8), oy: X.alloc(np * 8), oz: X.alloc(np * 8),
  };
  // Память модуля не растёт (начальный размер задан при сборке), поэтому вид
  // не отваливается и переснимать его не нужно.
  return buf;
}

// Возвращает false, если кернела нет: тогда считает вызывающий, по-старому.
// Массивы приходят НЕ ОБЯЗАТЕЛЬНО типизированные, и это не теория: стенды
// пелены зовут `field` с обычными Array (tests/wake.test.mjs). На них нет ни
// `subarray`, ни `set`, и первая версия падала прямо там — поймала батарея,
// а не браузер, и только потому, что стенды не поленились завести свои точки
// массивом.
function inTo(src, n, off) {
  if (src.length === n && src.BYTES_PER_ELEMENT) { F64.set(src, off); return; }
  for (let i = 0; i < n; i++) F64[off + i] = src[i];
}
function outFrom(dst, n, off) {
  for (let i = 0; i < n; i++) dst[i] = F64[off + i];
}

export function fieldEdges(e, ne, qx, qy, qz, np, ox, oy, oz) {
  if (!X || ne <= 0) return false;
  const b = ensure(ne, np);
  const o = (p) => p >> 3;
  inTo(e, ne * 8, o(b.e));
  inTo(qx, np, o(b.qx)); inTo(qy, np, o(b.qy)); inTo(qz, np, o(b.qz));
  X.field_edges(b.e, ne, b.qx, b.qy, b.qz, np, b.ox, b.oy, b.oz);
  outFrom(ox, np, o(b.ox)); outFrom(oy, np, o(b.oy)); outFrom(oz, np, o(b.oz));
  return true;
}
