// Акватория: настоящий участок реки вместо бесконечной воды.
//
// Бесконечная вода — не заглушка, а модель, и у неё ровно одно свойство: она
// всюду одинакова. Всё, что в симуляторе задаётся ползунком, задаётся им именно
// потому, что взять из мира нечего. Настоящий участок отменяет это в четырёх
// местах: разгон волны становится функцией места и направления, ветер перестаёт
// быть однородным, появляются границы и появляется вид. План — docs/terrain-in-sim.md.
//
// **Бесконечная вода остаётся.** Это условие всей затеи, а не оговорка: на ней
// гоняются батареи, воспроизводятся прежние записи и меряются ходовые качества
// лодки, а не места. Отсутствие акватории — не «режим», а отсутствие данных, и
// вести себя оно обязано ровно как раньше, до знака.
//
// Отсюда устройство модуля: у него одно лицо на оба случая. Все выборки
// отвечают `null`, когда данных нет, и вызывающий код разветвляется на этом
// `null`, а не на флаге режима. Разница между «акватории нет» и «акватория
// есть, но здесь ничего не известно» стирается нарочно — на краю участка второе
// должно вести себя как первое.
//
// Оси те же, что у выгрузки и у мира физики: X на восток, Y на север, метры от
// центра участка. Направления (ветер, румбы) отсчитываются от оси X, как `psi`
// и `windDir` в физике.
//
// Зависимостей нет: поля читает физика и отрисовка, сам модуль не читает никого.

// Ничего не известно. Отдельным значением, а не нулём: ноль разгона — это
// «волны нет», а отсутствие данных — «спрашивай ползунок».
export const NO_DATA = null;

const TAU = Math.PI * 2;

function bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class Terrain {
  // `pack` — выгрузка scripts/build_terrain_pack.py. Ложное значение означает
  // бесконечную воду, и это законный, а не вырожденный случай.
  constructor(pack) {
    this.p = pack || null;
    if (!this.p) return;
    const p = this.p;
    const raw = bytes(p.height_dm_b64);
    this.height = new Int16Array(raw.buffer, raw.byteOffset, p.nx * p.ny);
    this.cover = bytes(p.cover_b64);
    this.sdf = bytes(p.sdf_b64);
    this.fetchRaw = bytes(p.fetch_b64);
    this.skyRaw = bytes(p.sky_b64);
    this.cells = p.cnx * p.cny;
  }

  get ready() {
    return this.p !== null;
  }

  // --- выборка ---------------------------------------------------------------
  //
  // Двулинейная по мелкой сетке. Возвращает NaN за краем участка, а не
  // ближайшее значение: за краем данных нет, и делать вид, что есть, нельзя.
  _fine(arr, x, y, scale, offset) {
    const p = this.p;
    const fx = (x - p.x0) / p.step, fy = (y - p.y0) / p.step;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= p.nx - 1 || j >= p.ny - 1) return NaN;
    const u = fx - i, v = fy - j;
    const a = arr[j * p.nx + i], b = arr[j * p.nx + i + 1];
    const c = arr[(j + 1) * p.nx + i], d = arr[(j + 1) * p.nx + i + 1];
    const m = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    return m * scale + offset;
  }

  // Двулинейная по крупной сетке И линейная по направлению. Направление — угол
  // от оси X, тот же, что `windDir`.
  //
  // Известный изъян интерполяции по румбам: за мысом разгон меняется скачком, а
  // она его сглаживает. На масштабе плёса скачки редки, но знать надо.
  _coarse(arr, x, y, dir) {
    const p = this.p;
    const fx = (x - p.x0) / p.coarse, fy = (y - p.y0) / p.coarse;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= p.cnx - 1 || j >= p.cny - 1) return NaN;
    const u = fx - i, v = fy - j;
    let a = dir / TAU * p.rhumbs;
    a -= Math.floor(a / p.rhumbs) * p.rhumbs;
    const k0 = Math.floor(a), k1 = (k0 + 1) % p.rhumbs, w = a - k0;
    const at = k => {
      const o = k * this.cells;
      const q0 = arr[o + j * p.cnx + i], q1 = arr[o + j * p.cnx + i + 1];
      const q2 = arr[o + (j + 1) * p.cnx + i], q3 = arr[o + (j + 1) * p.cnx + i + 1];
      return (q0 * (1 - u) + q1 * u) * (1 - v) + (q2 * (1 - u) + q3 * u) * v;
    };
    return at(k0) * (1 - w) + at(k1) * w;
  }

  // --- поля ------------------------------------------------------------------

  // Высота земли, м над эллипсоидом.
  ground(x, y) {
    if (!this.p) return NO_DATA;
    const h = this._fine(this.height, x, y, 0.1, 0);
    return h === h ? h : NO_DATA;
  }

  // Верх покрова: земля плюс лес или застройка.
  top(x, y) {
    if (!this.p) return NO_DATA;
    const g = this._fine(this.height, x, y, 0.1, 0);
    if (g !== g) return NO_DATA;
    const c = this._fine(this.cover, x, y, 1, 0);
    // Класс в двух старших битах, высота в шести младших. Интерполировать
    // упакованный байт нельзя — на границе классов вылезет мусор, — поэтому
    // высота берётся у ближайшего узла, а не сглаживается.
    const p = this.p;
    const i = Math.round((x - p.x0) / p.step), j = Math.round((y - p.y0) / p.step);
    const cell = this.cover[j * p.nx + i];
    return g + (cell & 0x3F);
  }

  // Расстояние до берега, м. Положительное на воде, отрицательное на суше.
  // Обрезано на ±127: дальше ни мель, ни кромка, ни затухание волны не нужны.
  shore(x, y) {
    if (!this.p) return NO_DATA;
    const d = this._fine(this.sdf, x, y, 1, -128);
    return d === d ? d : NO_DATA;
  }

  // Куда «в воду» от берега: единичный вектор вдоль роста расстояния до берега.
  // Он же нормаль берега — по нему и гасится скорость, когда лодка упирается.
  //
  // Считается центральной разностью. Расстояние до берега для этого и годится:
  // оно гладкое и меняется линейно между узлами, тогда как у маски воды
  // никакого градиента нет вовсе.
  shoreNormal(x, y, out) {
    out.x = 0; out.y = 0;
    if (!this.p) return out;
    // База разности — метр, а не шаг сетки. Расстояние до берега интерполируется
    // билинейно, и внутри ячейки его градиент точен при любой базе; а вот база в
    // двадцать метров у самого уреза сглаживает изгиб берега настолько, что
    // «вдоль берега» по такой нормали уводит в сушу.
    const h = 1.0;
    const dx = this._fine(this.sdf, x + h, y, 1, 0) - this._fine(this.sdf, x - h, y, 1, 0);
    const dy = this._fine(this.sdf, x, y + h, 1, 0) - this._fine(this.sdf, x, y - h, 1, 0);
    const m = Math.hypot(dx, dy);
    if (!(m > 1e-9)) return out;
    out.x = dx / m; out.y = dy / m;
    return out;
  }

  // Разгон волны против ветра, м. `windDir` — откуда дует, от оси X.
  fetch(x, y, windDir) {
    if (!this.p) return NO_DATA;
    const f = this._coarse(this.fetchRaw, x, y, windDir);
    return f === f ? f * this.p.coarse : NO_DATA;
  }

  // Наибольший тангенс угла на берег против ветра. По нему считается укрытие,
  // но сами `D₀` и `k` живут в физике: их подбирают на воде, и запекать их в
  // пакет значило бы пересобирать страницу на каждую пробу.
  skyline(x, y, windDir) {
    if (!this.p) return NO_DATA;
    const s = this._coarse(this.skyRaw, x, y, windDir);
    return s === s ? s / this.p.sky_scale : NO_DATA;
  }

  // Течение, м/с, в мировых осях. Всегда вектор, а не null: складывать с ним
  // приходится каждый шаг, и проверять на пустоту в горячем месте незачем.
  // Без данных — точный ноль, и сложение с ним ничего не меняет побитово.
  current(out) {
    out.x = 0; out.y = 0;
    return out;
  }
}
