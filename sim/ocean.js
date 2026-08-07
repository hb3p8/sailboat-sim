// Море: спектр, БПФ, поверхность.
//
// До этого вода в сцене была нарисована: четыре синуса, сложенные в
// `waveHeight`, с амплитудой, взятой прямо из скорости ветра. Смотреть на неё
// было можно, читать по ней — нет. Четыре синуса не дают ни правильной формы
// гребня, ни правильного разброса длин, ни связи с тем волнением, по которому
// физика считает добавочное сопротивление: картинка жила по своему числу,
// силы — по своему. Ровно та беда, что уже описана в main.js про поле порывов,
// только с волной.
//
// Здесь вода считается так же, как её считают в океанографии и в кино: волна
// раскладывается в спектр, спектр — в поле высот обратным преобразованием
// Фурье. Двумя словами:
//
//   1. По состоянию моря строится спектр JONSWAP с угловым распределением
//      Хассельмана — сколько энергии приходится на волну такой-то длины,
//      бегущую под таким-то углом к ветру. Это делается ОДИН раз на смену
//      ветра, а не каждый кадр;
//
//   2. каждой волне даётся случайная фаза и амплитуда по Рэлею — так рождается
//      конкретная реализация моря. Она детерминирована зерном: с тем же зерном
//      и тем же ветром выйдет то же море;
//
//   3. каждый кадр фазы прокручиваются по дисперсионному соотношению
//      ω = √(g·k) — длинные волны бегут быстрее коротких, отчего море и
//      выглядит живым, а не дышащим на месте;
//
//   4. обратное БПФ переводит спектр в поле смещений на квадратной плитке,
//      которая кроется по всей акватории.
//
// Что это даёт против четырёх синусов:
//
//   * высота волны — та самая, что считает waves.js. Не «0.10 + 0.035·ветер»,
//     а значительная высота hs по ветру и разгону. Вода и силы больше не
//     расходятся, и по виду волны стало можно судить, за что лодка платит
//     ходом;
//
//   * гребни острые, подошвы пологие. Это не украшение, а прямое следствие
//     ГОРИЗОНТАЛЬНОГО смещения: вода в волне не только поднимается, но и
//     сдвигается к гребню. Синусы этого не умеют в принципе;
//
//   * волна перестала быть одной. На воде одновременно живут и полутораметровая
//     рябь, и десятиметровая зыбь, и на глаз это и есть разница между «дует»
//     и «задувает»;
//
//   * на волне стало можно качаться. Проба под лодкой (`setProbe`, `probeHeight`)
//     отдаёт высоту и наклон поверхности плавучести (sim/physics.js), и
//     всплытие с дифферентом считает она — тем же объёмом, той же жёсткостью и
//     тем же демпфированием, что и посадку под грузом. В сцене при этом не
//     подрисовано ничего.
//
// ------------------------------------------------------------------ каскады
//
// Одной плиткой весь диапазон не закрыть. Плитка в шестьдесят метров с решёткой
// 256×256 разрешает волну не короче полуметра, а рябь под бортом — это
// сантиметры; плитка в три метра держит рябь, но повторяется через три метра и
// на длинной волне бесполезна. Поэтому плиток три, каждая со своей полосой:
//
//     64 м   — всё, что длиннее 15 м   (длинная волна свежего ветра)
//     15.2 м — от 3.6 до 15 м          (основная волна на здешнем разгоне)
//     3.6 м  — всё, что короче 3.6 м   (чоп и рябь под бортом)
//
// Размеры подобраны ПОД ЭТУ ВОДУ, а не под океан. Разгон здесь речной, и
// waves.js даёт длину волны в пике от 1.3 м на трёх метрах в секунду до 15 м на
// шестнадцати — весь размах укладывается в эти три полосы. С океанскими
// плитками (сотни метров) две крупные стояли бы пустыми: замерено на стенде,
// при 130/31/7.3 на верхний каскад приходился один процент дисперсии на любом
// ветре, а вся волна сидела в мелком.
//
// Размеры НАРОЧНО не кратны друг другу: 64/15.2 = 4.21, 15.2/3.6 = 4.22. У
// кратных плиток совпадали бы швы, и вся вода повторялась бы с периодом самой
// крупной — а так совпадение уезжает за горизонт.
//
// Полосы стыкуются по волновому числу k = 2π/λ и на стыке размазаны: жёсткий
// обрез виден на воде полосой одинаково-мелкой ряби.
//
// -------------------------------------------------------------- вычисления
//
// Всё считается на видеокарте, в compute-шейдерах TSL, и на процессор не
// возвращается — кроме горстки пробных точек (см. `probe`). За кадр это
// пятнадцать запусков: на каждый каскад прокрутка фаз, БПФ по строкам, БПФ по
// столбцам, сборка смещений и нормали с пеной.
//
// БПФ живёт в разделяемой памяти рабочей группы: одна группа на строку, все
// восемь ступеней бабочек внутри, без единого промежуточного буфера в памяти
// видеокарты. Так на каскад приходится два запуска вместо шестнадцати. Ядро
// проверено против прямого ДПФ на стенде: невязка на уровне точности float32.
//
// Отката на WebGL2 здесь нет и не предполагается: WebGL2 не умеет compute, и
// эмуляция через transform feedback — это другой код, а не тот же самый.

const OCEAN_G = 9.80665;

// Сторона решётки каскада. 256 — это 65 тысяч волн на каскад и восемь ступеней
// бабочек; 512 стоит вчетверо дороже и на здешней воде не видно.
const OCEAN_N = 256;
const OCEAN_LOG2N = 8;

// Размеры плиток, м. Некратные и подобранные под здешний разгон — см. выше.
const OCEAN_TILES = [64, 15.2, 3.6];

// Период зацикливания фаз, с. Частоты округляются до кратных 2π/T, и потому
// море точно повторяется через T. Нужно это не ради повтора, а ради точности:
// без округления в ω·t на длинном счёте набегает столько, что float32 начинает
// врать фазой, и мелкая рябь идёт рябью из ошибок.
//
// Округление само по себе искажает частоту, и тем сильнее, чем цикл короче.
// Полчаса — это треть процента на самой длинной волне (её и проверяет
// tests/ocean.test.mjs) и восемь тысячных радиана потери точности на самой
// короткой. Ни того, ни другого не видно.
const OCEAN_LOOP = 1800;

// Горизонтальное смещение в долях физического. Единица — как в воде; больше
// единицы даёт нарочито острые гребни, меньше — приглаженные. Чуть ниже
// единицы: на короткой озёрной волне полная острота гребня выглядит злее, чем
// бывает.
const OCEAN_CHOP = 0.85;

// Порог пены по якобиану смещения. Якобиан меньше единицы — вода в этом месте
// сжимается, гребень заворачивается; меньше порога — считаем, что забурлило.
// На здешнем волнении это случается редко и только в свежий ветер, и это
// правильно: барашки на реке при пяти метрах в секунду не появляются.
const OCEAN_FOAM_J = 0.55;

// Полоса каскада по волновому числу k = 2π/λ.
//
// Нижняя граница — своя основная гармоника: волну длиннее плитки плитка не
// держит. Верхняя — основная гармоника СЛЕДУЮЩЕГО каскада, чтобы полосы
// стыковались без нахлёста и без дыры: нахлёст даёт волну вдвое выше
// заказанной, дыра — провал в спектре, видимый на воде как полоса одинаково
// мелкой ряби. У последнего каскада верха нет, только защита от угловых мод у
// самого Найквиста, где решётка уже врёт направлением.
//
// Вынесено из класса, чтобы стык проверялся тестом по тем же числам, по которым
// строится спектр, а не по их копии.
function oceanBand(index) {
  const tile = OCEAN_TILES[index];
  return {
    tile: tile,
    kLo: 2 * Math.PI / tile,
    kHi: index + 1 < OCEAN_TILES.length
      ? 2 * Math.PI / OCEAN_TILES[index + 1]
      : Math.PI * OCEAN_N / tile * 0.85,
  };
}

// Целочисленный хэш: из номера волны — равномерное число в (0, 1). Через
// fract(sin(...)), как принято в шейдерах, здесь нельзя: на 65 тысячах номеров
// у него видны регулярности, и море идёт клетчатым.
function oceanRand(u) {
  const x = u.mul(uint(747796405)).add(uint(2891336453)).toVar();
  x.assign(x.bitXor(x.shiftRight(uint(16))).mul(uint(2246822519)));
  x.assign(x.bitXor(x.shiftRight(uint(13))).mul(uint(3266489917)));
  x.assign(x.bitXor(x.shiftRight(uint(16))));
  return float(x.bitAnd(uint(0xffffff))).div(16777216.0).add(1e-6);
}

// Комплексное умножение.
function oceanCMul(a, b) {
  return vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));
}

class Ocean {
  // `renderer` — уже инициализированный WebGPURenderer. `seed` — зерно
  // реализации: с одним и тем же зерном и ветром получается одно и то же море.
  constructor(renderer, seed = 1) {
    this.renderer = renderer;
    this.seed = seed >>> 0;

    // --- то, что меняется каждый кадр --------------------------------------
    //
    // Время уже приведено по модулю периода зацикливания — см. `step`.
    this.uTime = uniform(0);
    // Значительная высота волны, м. Приходит из waves.js через main.js, а не
    // считается здесь: высота — свойство состояния моря, а не картинки.
    this.uHs = uniform(0);
    this.uChop = uniform(OCEAN_CHOP);

    // --- то, что меняется на смену ветра -----------------------------------
    this.uOmegaP = uniform(2 * Math.PI);   // частота пика спектра
    this.uWindDir = uniform(0);            // куда дует, рад (мир: 0 = на восток)

    // Сумма |h0|² по всем каскадам: по ней поле нормируется на hs. Считается
    // сверткой на видеокарте, чтобы формула спектра осталась в одном месте —
    // повторить её на процессоре ради нормировки значило бы завести вторую
    // реализацию, и когда-нибудь они разойдутся.
    this.varPart = instancedArray(OCEAN_TILES.length * OCEAN_N, 'float');
    this.varTotal = instancedArray(1, 'float');

    this.cascades = OCEAN_TILES.map((tile, i) => this._cascade(tile, i));

    this._buildSpectrumKernels();
    this._buildFrameKernels();
    this._buildProbe();

    // Ветер, при котором последний раз строился спектр. Спектр перестраивается
    // не каждый кадр: направление ветра ходит непрерывно, а пересборка — это
    // полсотни микросекунд на видеокарте и, главное, скачок реализации. Порог
    // такой, что скачка не видно, а поворот волны за ветром — видно.
    this.builtAt = { omegaP: NaN, dir: NaN };
    this.ready = false;
  }

  // Один каскад: буферы спектра, буферы БПФ, выходные текстуры.
  _cascade(tile, index) {
    const n2 = OCEAN_N * OCEAN_N;
    // Смещение и нормаль лежат в текстурах, а не в буферах: выборка из текстуры
    // идёт с аппаратной билинейной фильтрацией, а из буфера её пришлось бы
    // писать руками — четыре чтения и три подмешивания на каждый каскад в
    // каждом фрагменте.
    const disp = new StorageTexture(OCEAN_N, OCEAN_N);
    const norm = new StorageTexture(OCEAN_N, OCEAN_N);
    for (const t of [disp, norm]) {
      // Половинная точность: смещения — метры с точностью до миллиметра, и
      // этого хватает с запасом. Полная точность вчетверо дороже по полосе, а
      // в WebGPU ещё и не фильтруется без отдельного расширения.
      t.type = HalfFloatType;
      // Плитка кроется, поэтому выборка обязана заворачиваться.
      t.wrapS = RepeatWrapping;
      t.wrapT = RepeatWrapping;
      t.minFilter = LinearFilter;
      t.magFilter = LinearFilter;
    }
    return {
      tile: tile,
      index: index,
      dk: 2 * Math.PI / tile,
      kLo: oceanBand(index).kLo,
      kHi: oceanBand(index).kHi,
      h0: instancedArray(n2, 'vec4'),      // (Re, Im, kx, ky)
      specA: [0, 1, 2].map(() => instancedArray(n2, 'vec2')),
      specB: [0, 1, 2].map(() => instancedArray(n2, 'vec2')),
      dispBuf: instancedArray(n2, 'vec4'), // (De, Dn, Du, 0) — мир: восток, север, вверх
      dispTex: disp,
      normTex: norm,
    };
  }

  // --------------------------------------------------------------- спектр

  _buildSpectrumKernels() {
    const N = OCEAN_N;
    this.kSpectrum = this.cascades.map(c => this._spectrumKernel(c));
    // Свёртка дисперсии: сначала по строке, потом одним потоком по строкам.
    // Две ступени вместо одной — чтобы не сваливать 65 тысяч слагаемых в один
    // поток; гоняется это только на смену ветра, красоты ради тут ничего не
    // нужно.
    this.kVarRows = this.cascades.map(c => Fn(() => {
      const base = instanceIndex.mul(uint(N));
      const acc = float(0).toVar();
      Loop(N, ({ i }) => {
        const h = c.h0.element(base.add(uint(i)));
        acc.addAssign(h.x.mul(h.x).add(h.y.mul(h.y)));
      });
      this.varPart.element(uint(c.index * N).add(instanceIndex)).assign(acc);
    })().compute(N));
    this.kVarTotal = Fn(() => {
      const acc = float(0).toVar();
      Loop(OCEAN_TILES.length * N, ({ i }) => {
        acc.addAssign(this.varPart.element(uint(i)));
      });
      this.varTotal.element(uint(0)).assign(acc);
    })().compute(1);
  }

  // Ядро спектра: из номера волны — комплексная амплитуда h0 при t = 0.
  _spectrumKernel(c) {
    const N = OCEAN_N, half = N / 2;
    const seed = this.seed;
    return Fn(() => {
      const i = instanceIndex;
      const ix = i.mod(uint(N)), iy = i.div(uint(N));
      // Решётка волновых чисел центрирована: индекс N/2 — это k = 0.
      const kx = float(int(ix).sub(int(half))).mul(c.dk).toVar();
      const ky = float(int(iy).sub(int(half))).mul(c.dk).toVar();
      const k = kx.mul(kx).add(ky.mul(ky)).sqrt().max(1e-4).toVar();

      // Дисперсия волн на глубокой воде. Здешние глубины — единицы метров, и
      // строго говоря на такой воде волна уже чувствует дно; но чувствует она
      // его на длинах в десятки метров, которых на этом разгоне почти нет.
      const w = k.mul(OCEAN_G).sqrt().toVar();
      const wp = this.uOmegaP;
      const r = wp.div(w).toVar();

      // JONSWAP: спектр Пирсона–Московица, домноженный на пик. Множитель
      // энергии (α) опущен нарочно — поле всё равно нормируется на hs, и
      // тащить сюда зависимость α от разгона значило бы повторить waves.js.
      const sigma = w.lessThanEqual(wp).select(float(0.07), float(0.09));
      const rr = r.mul(r).toVar();
      const peak = w.sub(wp).mul(w.sub(wp)).negate()
        .div(sigma.mul(sigma).mul(wp).mul(wp).mul(2).add(1e-6)).exp();
      const s = w.pow(-5.0)
        .mul(rr.mul(rr).mul(-1.25).exp())
        .mul(float(3.3).pow(peak))
        .toVar();

      // S(ω) → S(k): якобиан дисперсии dω/dk = g/(2ω) и азимутальный 1/k.
      const sk = s.mul(OCEAN_G).div(w.mul(2)).div(k).toVar();

      // Угловое распределение Хассельмана: короткие волны разбегаются шире
      // длинных. cos^{2s}(θ/2) в виде ((1+cosθ)/2)^s, чтобы не звать косинус
      // половинного угла.
      const cosT = kx.mul(this.uWindDir.cos()).add(ky.mul(this.uWindDir.sin()))
        .div(k).toVar();
      const spread = float(9.77).mul(
        w.div(wp).pow(w.lessThanEqual(wp).select(float(5.0), float(-2.5)))).toVar();
      const dir = cosT.add(1).mul(0.5).max(1e-4).pow(spread)
        .mul(spread.add(0.25).sqrt().mul(0.28209479))   // 1/(2√π)
        .toVar();

      // Полоса каскада, со смазанными краями.
      const band = k.smoothstep(c.kLo / 1.35, c.kLo * 1.35)
        .mul(k.smoothstep(c.kHi * 1.35, c.kHi / 1.35))
        .toVar();

      const variance = sk.mul(dir).mul(band).mul(c.dk * c.dk).max(0).toVar();

      // Амплитуда по Рэлею, фаза равномерная — то есть гауссов комплексный
      // шум с нужной дисперсией. Это и есть «конкретная реализация моря».
      const u1 = oceanRand(i.add(uint(Math.imul(seed, 0x9e3779b1) >>> 0)));
      const u2 = oceanRand(i.add(uint((Math.imul(seed, 0x85ebca6b) + 0x27d4eb2f) >>> 0)));
      const amp = u1.log().mul(-2).sqrt().mul(variance.sqrt()).mul(0.70710678).toVar();
      const phase = u2.mul(2 * Math.PI).toVar();

      c.h0.element(i).assign(vec4(amp.mul(phase.cos()), amp.mul(phase.sin()), kx, ky));
    })().compute(N * N);
  }

  // ----------------------------------------------------------------- кадр

  _buildFrameKernels() {
    this.kFrame = [];
    for (const c of this.cascades) {
      this.kFrame.push(this._evolveKernel(c));
      this.kFrame.push(this._fftKernel(c, c.specA, c.specB, true));
      this.kFrame.push(this._fftKernel(c, c.specB, c.specA, false));
      this.kFrame.push(this._assembleKernel(c));
      this.kFrame.push(this._normalKernel(c));
    }
  }

  // Прокрутка фаз на время t и подготовка трёх спектров: высота и два
  // горизонтальных смещения.
  _evolveKernel(c) {
    const N = OCEAN_N;
    // Шаг округления частоты — он и делает море периодическим по времени.
    const dOmega = 2 * Math.PI / OCEAN_LOOP;
    return Fn(() => {
      const i = instanceIndex;
      const ix = i.mod(uint(N)), iy = i.div(uint(N));
      const h = c.h0.element(i).toVar();
      const k = h.z.mul(h.z).add(h.w.mul(h.w)).sqrt().max(1e-4).toVar();
      const w = k.mul(OCEAN_G).sqrt().div(dOmega).round().mul(dOmega).toVar();
      const ang = w.mul(this.uTime).toVar();
      const cs = ang.cos().toVar(), sn = ang.sin().toVar();

      // Сопряжённая мода −k: море вещественно, и без этого слагаемого высота
      // вышла бы комплексной. Индекс зеркалится по обеим осям.
      const jx = uint(N).sub(ix).mod(uint(N));
      const jy = uint(N).sub(iy).mod(uint(N));
      const hc = c.h0.element(jy.mul(uint(N)).add(jx)).toVar();

      // ĥ(k,t) = h0(k)·e^{−iωt} + conj(h0(−k))·e^{+iωt}
      const re = h.x.mul(cs).add(h.y.mul(sn))
        .add(hc.x.mul(cs)).add(hc.y.mul(sn)).toVar();
      const im = h.y.mul(cs).sub(h.x.mul(sn))
        .add(hc.x.mul(sn)).sub(hc.y.mul(cs)).toVar();

      // Горизонтальное смещение — это −i·(k/|k|)·ĥ. Отсюда и берётся острый
      // гребень: вершина волны съезжает сама к себе, подошва растягивается.
      const ex = h.z.div(k).toVar(), en = h.w.div(k).toVar();

      // Записывается сразу в бит-реверсном порядке — по обеим осям, потому что
      // дальше идут два БПФ подряд. Так ядро БПФ остаётся без перестановки.
      const d = oceanBitrevNode(iy).mul(uint(N)).add(oceanBitrevNode(ix));
      c.specA[0].element(d).assign(vec2(re, im));
      c.specA[1].element(d).assign(vec2(im.mul(ex), re.negate().mul(ex)));
      c.specA[2].element(d).assign(vec2(im.mul(en), re.negate().mul(en)));
    })().compute(N * N);
  }

  // Обратное БПФ по одной оси, все три спектра сразу.
  //
  // Одна рабочая группа — одна строка (или столбец). Строка целиком лежит в
  // разделяемой памяти, все восемь ступеней бабочек проходят там же, и наружу
  // выходит уже готовый результат. Барьер между ступенями обязателен и стоит в
  // однородном потоке управления: ступени развёрнуты на сборке, а не крутятся
  // циклом по переменной.
  _fftKernel(c, src, dst, byRow) {
    const N = OCEAN_N, half = N / 2;
    const shared = [0, 1, 2].map(() => workgroupArray('vec2', N));
    return Fn(() => {
      const line = workgroupId.x.toVar();
      const t = localId.x.toVar();
      const at = i => byRow ? line.mul(uint(N)).add(i) : i.mul(uint(N)).add(line);
      const t2 = t.add(uint(half)).toVar();

      for (let f = 0; f < 3; f++) {
        shared[f].element(t).assign(src[f].element(at(t)));
        shared[f].element(t2).assign(src[f].element(at(t2)));
      }
      workgroupBarrier();

      for (let s = 0; s < OCEAN_LOG2N; s++) {
        const span = 1 << s;
        const j = t.shiftRight(uint(s)).shiftLeft(uint(s + 1))
          .add(t.bitAnd(uint(span - 1))).toVar();
        const jh = j.add(uint(span)).toVar();
        const ang = float(t.bitAnd(uint(span - 1))).mul(Math.PI / span);
        const tw = vec2(ang.cos(), ang.sin()).toVar();
        for (let f = 0; f < 3; f++) {
          const a = shared[f].element(j).toVar();
          const b = oceanCMul(shared[f].element(jh), tw).toVar();
          shared[f].element(j).assign(a.add(b));
          shared[f].element(jh).assign(a.sub(b));
        }
        workgroupBarrier();
      }

      for (let f = 0; f < 3; f++) {
        dst[f].element(at(t)).assign(shared[f].element(t));
        dst[f].element(at(t2)).assign(shared[f].element(t2));
      }
    })().compute(N * half, [half]);
  }

  // Сборка смещений: вещественные части трёх спектров, знак от центрированной
  // решётки, нормировка на hs.
  _assembleKernel(c) {
    const N = OCEAN_N;
    return Fn(() => {
      const i = instanceIndex;
      const ix = i.mod(uint(N)), iy = i.div(uint(N));
      // Решётка волновых чисел центрирована на нуле, а БПФ считает так, будто
      // она начинается с нуля. Разница — множитель (−1)^(x+y).
      const sgn = float(1).sub(float(ix.add(iy).mod(uint(2))).mul(2)).toVar();
      // hs = 4√(дисперсия), дисперсия поля = 2·Σ|h0|².
      const scale = this.uHs.div(
        this.varTotal.element(uint(0)).mul(2).max(1e-12).sqrt().mul(4)).toVar();
      const chop = this.uChop.mul(scale).toVar();
      c.dispBuf.element(i).assign(vec4(
        c.specA[1].element(i).x.mul(sgn).mul(chop),
        c.specA[2].element(i).x.mul(sgn).mul(chop),
        c.specA[0].element(i).x.mul(sgn).mul(scale),
        0));
      textureStore(c.dispTex, ivec2(int(ix), int(iy)), c.dispBuf.element(i));
    })().compute(N * N);
  }

  // Нормаль и пена: центральные разности по смещению.
  _normalKernel(c) {
    const N = OCEAN_N;
    const h = c.tile / OCEAN_N;
    return Fn(() => {
      const i = instanceIndex;
      const ix = i.mod(uint(N)), iy = i.div(uint(N));
      const at = (x, y) => y.mod(uint(N)).mul(uint(N)).add(x.mod(uint(N)));
      const one = uint(1), nn = uint(N);
      const de = c.dispBuf.element(at(ix.add(one), iy))
        .sub(c.dispBuf.element(at(ix.add(nn).sub(one), iy))).div(2 * h).toVar();
      const dn = c.dispBuf.element(at(ix, iy.add(one)))
        .sub(c.dispBuf.element(at(ix, iy.add(nn).sub(one)))).div(2 * h).toVar();

      // Касательные вдоль востока и севера с учётом того, что смещена и сама
      // точка, а не только высота.
      const te = vec3(de.x.add(1), de.y, de.z).toVar();
      const tn = vec3(dn.x, dn.y.add(1), dn.z).toVar();
      const nrm = te.cross(tn).normalize().toVar();

      // Якобиан горизонтального смещения: меньше единицы — вода сжимается,
      // гребень заворачивается. Это и есть барашек.
      const jac = de.x.add(1).mul(dn.y.add(1)).sub(de.y.mul(dn.x)).toVar();
      const foam = jac.smoothstep(OCEAN_FOAM_J, OCEAN_FOAM_J - 0.45).toVar();

      textureStore(c.normTex, ivec2(int(ix), int(iy)), vec4(nrm, foam));
    })().compute(N * N);
  }

  // ---------------------------------------------------------------- выборка

  // Смещение поверхности в точке мира, м, в осях мира (восток, север, вверх).
  //
  // `worldXY` — узел vec2 с мировыми координатами. `weight` — функция от номера
  // каскада, возвращающая узел-множитель: ею гасятся каскады там, где сетка их
  // всё равно не разрешает. Без гашения дальняя вода идёт не волной, а
  // муаром из ошибок дискретизации.
  //
  // Вернуть из `weight` null — значит выкинуть каскад совсем, вместе с
  // выборкой. Это не то же, что вернуть ноль: ноль всё равно стоит трёх
  // выборок из текстуры, а нужен он бывает как раз затем, чтобы их не делать.
  //
  // Каскады выбираются ЦЕПОЧКОЙ: каждый следующий берётся в точке, уже сдвинутой
  // предыдущим. Смещение задано в системе невозмущённой воды, и без цепочки
  // мелкая волна сидела бы не на гребне крупной, а рядом с ним.
  displace(worldXY, weight) {
    // Тело завёрнуто в Fn: временные переменные шейдера (`toVar`) живут только
    // внутри функции, а звать выборку приходится и из материала, где никакой
    // функции вокруг нет. Без обёртки TSL ругается на присваивание без стека —
    // и ругается в консоль, не падая, так что заметить это можно не сразу.
    return Fn(() => {
      const p = worldXY.toVar();
      const sum = vec3(0).toVar();
      for (const c of this.cascades) {
        const w = weight(c.index);
        if (w === null) continue;
        const d = texture(c.dispTex, oceanUV(p, c)).xyz.mul(w).toVar();
        sum.addAssign(d);
        p.addAssign(vec2(d.x, d.y));
      }
      return sum;
    })();
  }

  // Нормаль поверхности (оси мира) и пена, одним узлом vec4.
  //
  // Наклоны каскадов складываются, а не нормали: нормаль — это уже
  // нормированный вектор, и складывать их значит получать не ту крутизну.
  surface(worldXY, weight) {
    return Fn(() => {
      const p = worldXY.toVar();
      const slope = vec2(0).toVar();
      const foam = float(0).toVar();
      for (const c of this.cascades) {
        const w = weight(c.index);
        if (w === null) continue;
        const uv = oceanUV(p, c).toVar();
        // Нормаль каскада — это (−∂h/∂e, −∂h/∂n, 1), уже нормированная. Деление
        // на вертикаль возвращает наклоны, которые и складываются.
        const s = texture(c.normTex, uv).toVar();
        slope.addAssign(vec2(s.x, s.y).div(s.z.max(1e-3)).mul(w));
        foam.assign(foam.max(s.w.mul(w)));
        p.addAssign(texture(c.dispTex, uv).xy.mul(w));
      }
      return vec4(vec3(slope.x, slope.y, 1).normalize(), foam);
    })();
  }

  // ------------------------------------------------------------------ пробы

  // Горстка точек, в которых поверхность нужна процессору. Читается это
  // асинхронно и приходит с задержкой в кадр — на воде с периодом в пару секунд
  // такая задержка меньше сантиметра.
  //
  // Точек несколько не для запаса. ОДНОЙ точкой корпус на волне не снять, и это
  // не тонкость, а разница между лодкой и мячиком: в поле живут волны от
  // сантиметров до десятков метров, а шестиметровый корпус коротких попросту не
  // чувствует — он их перекрывает, и давление под ним усредняется. Проба точкой
  // отдаёт всё подряд, лодка отыгрывает каждую рябь, и на замере это три с
  // лишним метра в секунду вертикальной скорости на волне в семнадцать
  // сантиметров. Пять проб по корпусу с подгонкой плоскости дают восемь
  // десятых — то есть корпус вместо поплавка. Раскладывает их main.js: где у
  // лодки нос и борта, море не знает.
  _buildProbe() {
    this.probeCount = OCEAN_PROBE.length;
    this.probeIn = instancedArray(this.probeCount, 'vec2');
    this.probeOut = instancedArray(this.probeCount, 'vec4');
    this.probeHost = new Float32Array(this.probeCount * 4);
    this._probeBusy = false;
    this.kProbe = Fn(() => {
      const p = this.probeIn.element(instanceIndex).toVar();
      const d = this.displace(p, () => float(1)).toVar();
      // `surface` отдаёт НОРМАЛЬ, а наружу нужен наклон. Это не одно и то же и
      // даже не с точностью до множителя: у нормали (−∂h/∂e, −∂h/∂n, 1) знак
      // горизонтальных составляющих обратный, и она нормирована. Отдать её как
      // наклон — значит наклонить лодку против волны, и она честно
      // отрабатывает вдвое: свой наклон плюс зеркальный. Именно так и было, и
      // именно от этого лодку швыряло.
      const s = this.surface(p, () => float(1)).toVar();
      const up = s.z.max(1e-3);
      this.probeOut.element(instanceIndex).assign(
        vec4(d.z, s.x.negate().div(up), s.y.negate().div(up), s.w));
    })().compute(this.probeCount);
  }

  // Поставить пробу номер `i` в точку мира.
  setProbe(i, x, y) {
    if (i >= this.probeCount) return;
    const a = this.probeIn.value.array;
    a[i * 2] = x; a[i * 2 + 1] = y;
    this.probeIn.value.needsUpdate = true;
  }

  // Последнее прочитанное: высота воды в пробе `i`, м.
  probeHeight(i) { return this.probeHost[i * 4]; }
  // Наклон поверхности в пробе: восток и север, безразмерный.
  probeSlopeE(i) { return this.probeHost[i * 4 + 1]; }
  probeSlopeN(i) { return this.probeHost[i * 4 + 2]; }

  // ------------------------------------------------------------------- ход

  // Состояние моря. `hs` — значительная высота, м; `tp` — период пика, с;
  // `dir` — куда бежит волна (мир, рад).
  //
  // Спектр пересобирается не на каждый вызов: пересборка — это новая
  // реализация, то есть скачок картинки. Порог подобран так, чтобы поворот
  // волны за ветром был плавным, а нагрузки не было.
  setSea(hs, tp, dir) {
    this.uHs.value = hs > 0 ? hs : 0;
    const wp = 2 * Math.PI / Math.max(0.2, tp);
    const b = this.builtAt;
    const turned = Math.abs(Math.atan2(Math.sin(dir - b.dir), Math.cos(dir - b.dir)));
    if (this.ready && Math.abs(wp - b.omegaP) < 0.02 * wp && turned < 0.035) return;
    this.uOmegaP.value = wp;
    this.uWindDir.value = dir;
    b.omegaP = wp; b.dir = dir;
    this.renderer.compute([...this.kSpectrum, ...this.kVarRows, this.kVarTotal]);
    this.ready = true;
  }

  // Прогнать море на момент времени `t` (с начала счёта, с).
  step(t) {
    if (!this.ready) return;
    this.uTime.value = t - Math.floor(t / OCEAN_LOOP) * OCEAN_LOOP;
    // Одним пакетом: внутри прохода WebGPU держит порядок и видимость записей
    // между запусками, а на каждый вызов compute() приходится своя отправка
    // очереди — пятнадцать отправок за кадр стоили бы дороже самого счёта.
    this.renderer.compute([...this.kFrame, this.kProbe]);
    if (!this._probeBusy) {
      this._probeBusy = true;
      this.renderer.getArrayBufferAsync(this.probeOut.value).then(ab => {
        this.probeHost.set(new Float32Array(ab));
        this._probeBusy = false;
      }).catch(() => { this._probeBusy = false; });
    }
  }
}

// Плоскость воды по пяти пробам: высота и два наклона, по востоку и по северу.
//
// Пробы приходят в порядке, в котором их раскладывают: центр, нос, корма, левый
// борт, правый. Наклон вдоль корпуса — разность нос-корма на длину базы, поперёк
// — разность бортов на ширину; дальше поворот по курсу в оси мира.
//
// `x0` — где стоит середина этих проб в связанных осях лодки. Ноль модели у
// SV20 лежит у транца, а не на миделе, и пробы раскладываются вокруг середины
// ВАТЕРЛИНИИ, то есть в трёх с лишним метрах от него. Высота же наружу нужна в
// самом нуле: плавучесть строит плоскость воды от начала координат корпуса, и
// подставить ей высоту из другой точки — значит посадить лодку с дифферентом на
// ровном месте. Отсюда снос на `along * x0`.
//
// Вынесено сюда, а не оставлено в main.js, ровно из-за поворота и этого сноса.
// Это место, где легко перепутать борт со знаком или точку отсчёта, и ошибка
// вышла бы тихой: лодка кренилась бы не в ту сторону только на некоторых курсах
// либо ровно села бы носом. Здесь это можно проверить тестом — что одна и та же
// вода даёт одни и те же наклоны в мире на любом курсе и ту же высоту в нуле, —
// и он проверяет (tests/ocean.test.mjs).
// Где стоят пробы: доли полудлины ватерлинии и полуширины, в осях лодки.
//
// Восемь точек, а не пять, и не ради охвата — ради устойчивости. Наклон по
// двум точкам держится на двух числах: одна проба, попавшая на гребень, врёт
// наклоном целиком. Наименьшие квадраты по восьми точкам ту же ошибку делят.
// Особенно это заметно поперёк: база там всего девяносто сантиметров, и
// поперечный наклон был самой шумной из трёх величин — теперь в него входит
// шесть проб вместо двух.
//
// Раскладка симметрична нарочно. У симметричного набора нормальные уравнения
// распадаются: суммы x, y и xy обращаются в ноль, и решение наименьших
// квадратов сводится к трём независимым отношениям — без матрицы и без
// обращения. Стоит нарушить симметрию, и понадобится решать систему.
//
// Центральной пробы нет: у симметричного набора среднее по восьми точкам и есть
// оценка высоты в середине, а девятая точка нарушила бы кратность восьми, на
// которую рассчитан буфер видеокарты.
const OCEAN_PROBE = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.55, 0.8], [0.55, -0.8], [-0.55, 0.8], [-0.55, -0.8],
];

// Плоскость воды по пробам: высота в НАЧАЛЕ КООРДИНАТ лодки и два наклона в
// осях мира.
//
// Раскладку берёт из OCEAN_PROBE — той же таблицы, по которой пробы и ставятся.
// Считать её здесь по-своему значило бы завести вторую копию, и разъехались бы
// они молча: подгонка продолжала бы возвращать плоскость, просто не ту.
function oceanPlaneFit(h, psi, halfL, halfB, x0, out) {
  const c = Math.cos(psi), s = Math.sin(psi);
  const n = OCEAN_PROBE.length;
  let sum = 0, sxh = 0, syh = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const x = OCEAN_PROBE[i][0] * halfL, y = OCEAN_PROBE[i][1] * halfB;
    sum += h[i]; sxh += x * h[i]; syh += y * h[i];
    sxx += x * x; syy += y * y;
  }
  const along = sxx > 1e-9 ? sxh / sxx : 0;
  const across = syy > 1e-9 ? syh / syy : 0;
  // Пробы разложены вокруг середины ватерлинии, а высота наружу нужна в нуле
  // лодки: у SV20 он у транца, и разница равна наклону на плечо.
  out.z = sum / n - along * x0;
  out.se = along * c - across * s;
  out.sn = along * s + across * c;
  return out;
}

// Мировая точка → координаты выборки в плитке каскада.
//
// Полтексела сдвига — не педантизм: узел решётки с номером 0 стоит в мировом
// нуле, а центр нулевого тексела — на полтексела правее. Без поправки смещение
// и нормаль разъезжаются на полклетки, и на крупном каскаде это четверть метра.
function oceanUV(p, c) {
  return p.div(c.tile).add(0.5 / OCEAN_N);
}

// Бит-реверс номера в решётке: узел TSL. Разворачивается на сборке, потому что
// разрядность известна заранее.
function oceanBitrevNode(i) {
  let r = uint(0);
  for (let b = 0; b < OCEAN_LOG2N; b++) {
    r = r.add(i.shiftRight(uint(b)).bitAnd(uint(1)).shiftLeft(uint(OCEAN_LOG2N - 1 - b)));
  }
  return r;
}

export { Ocean, oceanBand, oceanPlaneFit, OCEAN_PROBE, OCEAN_TILES, OCEAN_N,
         OCEAN_LOOP, OCEAN_CHOP, OCEAN_FOAM_J };
