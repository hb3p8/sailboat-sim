// След за лодкой: мировое поле, которое читает сама вода.
//
// До этого след был лентой — сто пятьдесят точек, склеенных в полосу белых
// четырёхугольников на высоте пять сантиметров. Пока вода была почти плоской,
// это сходило. С БПФ перестало: поверхность ходит на десятки сантиметров, а при
// разгоне в тридцать километров — на метр, и лента про это ничего не знает. На
// гребне она уходит под воду, в подошве висит в воздухе. Подобрать высоту нельзя
// никакую: след обязан быть СВОЙСТВОМ ПОВЕРХНОСТИ, а не геометрией над ней.
//
// Поэтому здесь не рисуется ничего. Здесь живёт поле, привязанное к миру, а
// рисует его вода — тем же выражением, которым рисует пену на гребне.
//
// Два канала, и они про разное:
//
//   ПЕНА — взбитая белая вода. Гаснет медленно, десятками секунд, и это
//     единственное, что в старой ленте было;
//
//   ГЛАДКОСТЬ — то, чего в ленте не было вовсе, а видно её дальше всего.
//     Прошедший корпус сбивает капиллярную рябь, и дорожка за кормой ещё долго
//     остаётся ЗЕРКАЛЬНЕЕ воды вокруг — даже там, где пены давно нет. Именно по
//     этой гладкой полосе чужой след и читается с расстояния, на котором никакой
//     белизны уже не различить. Живёт она ДОЛЬШЕ пены, а не меньше: пузыри
//     всплывают и лопаются за десяток секунд, а рябь в слабый ветер отрастает
//     минуту. Сначала было наоборот, и след выходил ровно наизнанку — белая
//     полоса во весь участок и никакой дорожки за ней.
//
// Поле идёт за лодкой, но НЕ едет вместе с ней: начало щёлкает по целым
// текселям. Это не мелочь и не оптимизация. Поле, которое каждый кадр
// пересэмплируется билинейно на дробный сдвиг, размазывается само об себя: за
// пару секунд от следа остаётся ровное пятно. Целый тексель — значит чтение
// попадает точно в тексель, и накопления размытия нет вовсе.

const WAKE_N = 512;
const WAKE_SPAN = 128;                        // м на всё поле
const WAKE_CELL = WAKE_SPAN / WAKE_N;         // 0.25 м на тексель
// Времена жизни, секунды. Белизна уходит за десяток секунд, гладкая дорожка
// держится вчетверо дольше — при здешнем ходе это дальше, чем всё поле, и
// значит по краю участка она и обрывается, гашением у кромки.
const WAKE_TAU_FOAM = 11;
const WAKE_TAU_SLICK = 45;
// Ход, на котором след начинается и на котором он выходит в полную силу. Ниже
// первого числа за лодкой не остаётся ничего — и это правда: яхта, ползущая в
// полузла, идёт по воде, а не пашет её.
const WAKE_V0 = 0.8;                          // м/с
const WAKE_V1 = 3.2;                          // м/с
// Полуширина полосы: полуширина по ватерлинии плюс прибавка на ход. Корма
// разгоняет воду шире корпуса, и чем быстрее, тем шире.
const WAKE_WIDE_V = 0.10;                     // м на каждый м/с
// Дальше какого расстояния за кадр отрезок считается не ходом, а прыжком.
// Сброс лодки (`X`, расхождение физики) не должен прочерчивать полосу через всю
// акваторию — ровно та беда, ради которой в чужих реализациях заведены флаги
// «стоит» и «телепорт».
const WAKE_JUMP = 6;                          // м

// Полуширина следа по ватерлинии ставится снаружи: обводы живут в пакете
// физики, а не здесь.
let HALF_BEAM = 0.9;
function wakeSetBeam(halfBeam) { HALF_BEAM = halfBeam; }

class Wake {
  constructor(renderer) {
    this.renderer = renderer;

    const make = () => {
      const t = new StorageTexture(WAKE_N, WAKE_N);
      // Половинная точность: тут доли единицы, точности хватает с запасом.
      t.type = HalfFloatType;
      // Поле не кроется — за его краем нет следа, а не «след из-за угла».
      t.wrapS = ClampToEdgeWrapping;
      t.wrapT = ClampToEdgeWrapping;
      t.minFilter = LinearFilter;
      t.magFilter = LinearFilter;
      return t;
    };
    this.tex = [make(), make()];
    this.flip = 0;

    this.uOrigin = uniform(new Vector2(0, 0));   // мировой угол поля
    this.uShift = uniform(new Vector2(0, 0));    // на сколько текселей уехало
    this.uDecay = uniform(new Vector2(1, 1));    // множители гашения за кадр
    this.uSegA = uniform(new Vector2(0, 0));     // отрезок впрыска, мир
    this.uSegB = uniform(new Vector2(0, 0));
    this.uInj = uniform(new Vector4(0, 0, 1, 0));  // пена, гладкость, полуширина, вкл

    // Узел для выборки водой. Значение подменяется каждый кадр — производные
    // узлы (`sample`) держат ссылку на этот же, базовый, и едут за ним. Так же
    // устроено зеркало отражения в three.
    this.node = texture(this.tex[0]);

    this.kStep = [this._kernel(this.tex[0], this.tex[1]),
                  this._kernel(this.tex[1], this.tex[0])];

    this.have = false;      // была ли прошлая точка, от которой вести отрезок
    this.px = 0; this.py = 0;
    this.ox = 0; this.oy = 0;
    this.cleared = false;
  }

  // Один проход: сдвинуть, погасить, впрыснуть.
  _kernel(src, dst) {
    const N = WAKE_N;
    return Fn(() => {
      const i = instanceIndex;
      const ix = i.mod(uint(N)), iy = i.div(uint(N));

      // Тот же кусок мира в прошлом кадре лежал на uShift текселей в сторону.
      const fx = float(ix).add(this.uShift.x).toVar();
      const fy = float(iy).add(this.uShift.y).toVar();
      // «Попали ли в прошлое поле» — арифметикой, без логических узлов.
      // Координаты здесь целые, поэтому clamp(fx + 1, 0, 1) даёт ровно ноль при
      // fx = −1 и ровно единицу при fx ≥ 0; то же с другого конца. Приведение
      // bool к числу в этой цепочке однажды уже стоило чёрной воды.
      const ok = fx.add(1).clamp(0, 1).mul(float(N).sub(fx).clamp(0, 1))
        .mul(fy.add(1).clamp(0, 1)).mul(float(N).sub(fy).clamp(0, 1)).toVar();
      const prev = textureLoad(src, ivec2(int(fx.clamp(0, N - 1)),
                                          int(fy.clamp(0, N - 1)))).toVar();
      const foam = prev.x.mul(this.uDecay.x).mul(ok).toVar();
      const slick = prev.y.mul(this.uDecay.y).mul(ok).toVar();

      // Впрыск — по ОТРЕЗКУ от прошлого положения к нынешнему, а не точкой.
      // Точкой след выходит пунктиром: на четырёх метрах в секунду и просевших
      // кадрах лодка успевает уехать на треть корпуса между впрысками.
      const p = this.uOrigin
        .add(vec2(float(ix).add(0.5), float(iy).add(0.5)).mul(WAKE_CELL)).toVar();
      const ab = this.uSegB.sub(this.uSegA).toVar();
      const t = p.sub(this.uSegA).dot(ab).div(ab.dot(ab).max(1e-6))
        .clamp(0, 1).toVar();
      const d = p.sub(this.uSegA.add(ab.mul(t))).length().toVar();
      // Мягкий край: сердцевина полосы полная, к кромке сходит на нет. Концы у
      // smoothstep по возрастанию, разворот через oneMinus — у WGSL при
      // low ≥ high результат не определён.
      const w = d.smoothstep(this.uInj.z.mul(0.4), this.uInj.z)
        .oneMinus().mul(this.uInj.w).toVar();
      // Не сложение, а максимум: сложение зависело бы от числа кадров, и на
      // просевшей частоте след выходил бы бледнее при том же ходе.
      foam.assign(foam.max(w.mul(this.uInj.x)));
      slick.assign(slick.max(w.mul(this.uInj.y)));

      textureStore(dst, ivec2(int(ix), int(iy)), vec4(foam, slick, 0, 1));
    })().compute(N * N);
  }

  // Кадр. Мировые XY — оси физики: восток и север.
  //
  // `x`, `y` — точка впрыска (транец), `speed` — ход по воде, `dt` — секунды.
  step(dt, x, y, speed) {
    // Начало поля щёлкает по целым текселям — см. заголовок.
    const ox = Math.round((x - WAKE_SPAN / 2) / WAKE_CELL) * WAKE_CELL;
    const oy = Math.round((y - WAKE_SPAN / 2) / WAKE_CELL) * WAKE_CELL;
    // Первый кадр: поле пустое, а гасить нечего. Сдвиг тогда заведомо огромный,
    // и всё поле честно обнулится признаком «мимо прошлого поля».
    const shiftX = this.cleared ? Math.round((ox - this.ox) / WAKE_CELL) : WAKE_N;
    const shiftY = this.cleared ? Math.round((oy - this.oy) / WAKE_CELL) : WAKE_N;
    this.uShift.value.set(shiftX, shiftY);
    this.uOrigin.value.set(ox, oy);
    this.ox = ox; this.oy = oy;

    const s = Math.max(0, Math.min(1, (speed - WAKE_V0) / (WAKE_V1 - WAKE_V0)));
    // Пена набирается с хода круто: до трети первого узла её нет вовсе, а на
    // полном ходу она сплошная. Гладкость появляется раньше и держится дольше —
    // рябь сбивает и медленный корпус.
    const foam = s * s;
    const slick = Math.sqrt(s);
    const wide = HALF_BEAM + WAKE_WIDE_V * speed;

    // Отрезок: от прошлой точки к нынешней. Прыжок — не ход: полосы через всю
    // акваторию при сбросе быть не должно.
    const moved = this.have ? Math.hypot(x - this.px, y - this.py) : 0;
    const on = this.have && moved > 1e-4 && moved < WAKE_JUMP && s > 0 ? 1 : 0;
    this.uSegA.value.set(on ? this.px : x, on ? this.py : y);
    this.uSegB.value.set(x, y);
    this.uInj.value.set(foam, slick, wide, on);
    this.px = x; this.py = y; this.have = true;

    // Гашение экспоненциальное и считается от dt, а не от кадра: на просевшей
    // частоте след обязан жить те же секунды, а не то же число кадров.
    this.uDecay.value.set(Math.exp(-dt / WAKE_TAU_FOAM),
                          Math.exp(-dt / WAKE_TAU_SLICK));

    this.renderer.compute(this.kStep[this.flip]);
    this.flip = 1 - this.flip;
    this.node.value = this.tex[this.flip];
    this.cleared = true;
  }

  // Забыть след целиком: сброс лодки, перемотка записи. Одного кадра с
  // заведомо промахивающимся сдвигом хватает, чтобы поле обнулилось.
  clear() {
    this.cleared = false;
    this.have = false;
  }

  // Выборка поля водой. Возвращает (пена, гладкость), уже погашенные к краю
  // участка: у поля есть кромка, и без гашения след обрывался бы по ней ровной
  // чертой поперёк воды.
  sample(worldXY) {
    const uv = worldXY.sub(this.uOrigin).div(WAKE_SPAN);
    const edge = uv.sub(0.5).abs().mul(2.0);
    const fade = edge.x.max(edge.y).smoothstep(0.86, 1.0).oneMinus();
    return this.node.sample(uv).xy.mul(fade);
  }
}

export { Wake, wakeSetBeam, WAKE_N, WAKE_SPAN, WAKE_CELL,
         WAKE_TAU_FOAM, WAKE_TAU_SLICK, WAKE_V0, WAKE_V1, WAKE_JUMP };
