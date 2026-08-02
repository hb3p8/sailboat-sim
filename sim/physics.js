// Физика хода яхты: четыре степени свободы, фиксированный шаг 1/30 с.
//
// Система координат судостроительная, та же что во всём проекте:
// X в нос, Y на правый борт, Z вверх. Отрисовка переводит её в свою уже сама.
//
// Что моделируется:
//   продольное движение, дрейф, рыскание и крен — четыре уравнения;
//   всплытие и дифферент — квазистатически по таблице гидростатики, потому
//   что на тридцати герцах их собственные колебания всё равно не разрешить,
//   а на управление они влияют слабо.
//
// Что откуда взято:
//   массы, моменты инерции, GZ, гидростатика, площади и удлинения крыльев —
//   из пакета physics.json, то есть из геометрии;
//   коэффициенты парусов и крыльев — модели здесь, в коде: их настраивают
//   на ходу, и держать их в пакете незачем.

import { WindField } from './wind.js';
import { Lattice } from './vlm.js';

const DEG = Math.PI / 180;

// Полосок на парус. Шесть хватает: профиль ветра по высоте гладкий, и на
// восьми ответ отличается меньше чем на процент, а считать нужно каждый кадр.
const STRIPS = 6;

// Панелей вдоль хорды. Одной не хватает: грот со стакселем стоят на расстоянии
// меньше хорды друг от друга, и при одной панели условие непротекания ставится
// в одной точке на весь парус — взаимное влияние выходит вдвое-втрое больше
// настоящего, и грот в расчёте умирает. Три панели ставят его в трёх точках по
// хорде, и поверхность наконец «чувствуется» как поверхность.
const NCHORD = 3;

// Пузо паруса, доля хорды, по параболической средней линии. Взято так, чтобы
// угол нулевой подъёмной силы остался прежним — 2·пузо = 3°, — и поляра от
// перехода на решётку не поехала сама по себе. Настоящее пузо у мягкого паруса
// больше, но это отдельное решение, и принимать его надо отдельно.
const SAIL_CAMBER = 0.0262;

// За срывом потенциальное течение неприменимо, и поправка на скос гасится.
const IND_FADE0 = 20 * DEG;
const IND_FADE1 = 35 * DEG;

// Матрица влияния решётки перестраивается не каждый шаг. Она зависит только от
// формы рига — крена, твиста, выноса — и от направления пелены, а всё это
// меняется на порядок медленнее, чем идёт счёт. Сама же перестройка стоит
// полутора тысяч вычислений закона Био — Савара и съедает почти всё время
// шага. Решается система при этом каждый шаг: она дешёвая.
//
// Момент перестройки считается ОТ ВРЕМЕНИ, а не свободным счётчиком. Со
// счётчиком это было бы скрытое состояние: ответ модели зависел бы от того, на
// каком шаге её запустили, и записанный прогон переставал воспроизводиться.
// Ровно это и поймал tests/replay.test.mjs.
const LATTICE_EVERY = 6;

// Центр давления полоски, доля хорды от передней шкаторины. У паруса он
// заметно впереди середины — это парус, а не симметричный профиль.
const CP_CHORD = 0.42;

// Коэффициент поперечного обтекания полоски корпуса. Для мелкого широкого
// днища это около единицы; величина одна и общая, а не набор подгоночных.
const HULL_CROSSFLOW_CD = 1.0;

// Приводящий момент от несимметрии накренённого корпуса. Явление настоящее и
// для широкой плоской лодки крупное: на крене подветренная скула сидит глубже,
// и корпус работает как изогнутое крыло, разворачивая нос на ветер. Посчитать
// его честно можно только по обтеканию, поэтому здесь он в форме, принятой в
// VPP, с одним коэффициентом.
//
// Коэффициент откалиброван по наблюдению владельца лодки: с брошенным рулём
// в бейдевинд лодка должна слегка приводиться, а не валиться под ветер.
// Это второе и последнее место в проекте, где число подобрано, а не выведено.
//
// Пересчитывается всякий раз, когда меняется геометрия рига: наблюдение одно
// и то же, а доля корпуса в нём зависит от того, сколько приводящего момента
// даёт сам парус. Сперва 0.55 — после того, как у стакселя поправили шкотовый
// угол. Теперь 0.35 — после обмера парусов по чертежу: центр парусности
// поднялся на восемьдесят сантиметров, лодка кренится сильнее, приводящий
// момент от паруса вырос сам, и корпусу осталось взять меньше.
//
// Верхняя граница ставится не наблюдением, а рулём: при 0.45 лодку приходится
// держать девятью градусами пера на острых курсах, а это уже тормоз. Нижняя —
// самим наблюдением: при 0.25 лодка с брошенным рулём уже валится под ветер.
const HULL_HEEL_YAW = 0.35;

// Насколько ветер должен зайти за диаметральную плоскость, чтобы парус
// перекинулся на другой борт. Без этого запаса парус на чистом фордевинде
// перекидывался от каждого колебания ветра — по десятку раз за пару минут, со
// скачком боковой силы в двести ньютонов за один шаг. Выглядело это как мелкая
// неестественная дрожь лодки, и она же ломала картинку: парус телепортировался
// с борта на борт. На воде гик стоит там, где стоит, пока не перекинется
// по-настоящему — в поворот фордевинд или оверштаг.
//
// Тот же запас работает и в левентике: там ветер переходит через ДП носом, а
// не кормой, но явление ровно то же.
const GYBE_MARGIN = 11 * Math.PI / 180;

// Гик переходит на другой борт не мгновенно: секунда с небольшим на переброс.
// Мгновенный переброс — это скачок боковой силы в сотню ньютонов за один шаг;
// на воде такого не бывает, и по дороге парус проходит через диаметральную
// плоскость, где почти ничего не даёт. Поэтому сторона паруса — не знак, а
// непрерывная величина от −1 до +1: ноль это гик в ДП, ровно посередине
// переброса.
const GYBE_RATE = 1.8;

// Постоянная времени откренивания. Экипаж отзывается на порыв не мгновенно:
// пока почувствуешь, пока откинешься. Без запаздывания он гасит крен точно и
// сразу, лодка стоит как вкопанная и вообще перестаёт качаться — а на воде
// порыв сначала кладёт, и только потом его откренивают.
const HIKE_TAU = 1.2;

// Перо руля не переставляется мгновенно: на румпеле рука, а не сервопривод.
// Ограничение живёт здесь, а не в интерфейсе, — это свойство лодки, и тесты
// должны видеть ту же задержку, что и человек за рулём.
const RUDDER_RATE = 26 * DEG;

// Нормировка угла без цикла: при расходимости `while` по бесконечности вешает
// вкладку намертво, и это не гипотеза — так и было.
function wrapPi(a) {
  if (!isFinite(a)) return 0;
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function clamp(v, lim) {
  if (!isFinite(v)) return 0;
  return v < -lim ? -lim : (v > lim ? lim : v);
}

// Шкаторина задана ломаной [[x, z], ...] — снята с чертежа и по высоте
// монотонна. Отсюда абсцисса шкаторины на любой высоте; за пределами обвода
// продолжения нет, берётся крайняя точка.
export function edgeFn(poly) {
  const pts = poly.slice().sort((a, b) => a[1] - b[1]);
  return z => {
    if (z <= pts[0][1]) return pts[0][0];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (z <= b[1]) {
        const dz = b[1] - a[1];
        return dz > 1e-9 ? a[0] + (b[0] - a[0]) * (z - a[1]) / dz : b[0];
      }
    }
    return pts[pts.length - 1][0];
  };
}

function lerpTable(rows, key, x, field) {
  const n = rows.length;
  if (x <= rows[0][key]) return rows[0][field];
  if (x >= rows[n - 1][key]) return rows[n - 1][field];
  for (let i = 0; i < n - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (x >= a[key] && x <= b[key]) {
      const u = (x - a[key]) / (b[key] - a[key] || 1);
      return a[field] + u * (b[field] - a[field]);
    }
  }
  return rows[n - 1][field];
}

// Крыло с срывом: до срыва линейный участок, после — плоская пластина.
// Переход сглаженный, иначе руль на больших углах перекладки дёргается.
//
// Угол атаки принимается любой, включая обтекание задом наперёд. Это не
// придирка: в левентике лодка идёт кормой вперёд, и крыло обязано вести себя
// разумно и там. Прежняя версия считала угол через max(0.05, u), на заднем
// ходу получала девяносто градусов и выдавала силы, разгонявшие лодку назад
// до полусотни узлов.
function foilCoeffs(alphaRad, ar, stallDeg, cd0) {
  const a0 = wrapPi(alphaRad);
  const sgn = a0 < 0 ? -1 : 1;
  const a = Math.abs(a0);
  const reversed = a > Math.PI / 2;
  const eff = reversed ? Math.PI - a : a;          // угол от ближайшей кромки
  const stall = stallDeg * DEG;
  const slope = 2 * Math.PI * ar / (ar + 2);        // теория несущей линии
  const clLin = slope * eff;
  const clFlat = 2 * Math.sin(eff) * Math.cos(eff);
  const cdFlat = 2 * Math.sin(eff) * Math.sin(eff);
  const blend = eff <= stall ? 0 : Math.min(1, (eff - stall) / (12 * DEG));
  let cl = clLin * (1 - blend) + clFlat * blend;
  const cdi = cl * cl / (Math.PI * ar * 0.9);
  let cd = (cd0 + cdi) * (1 - blend) + cdFlat * blend;
  if (reversed) { cl *= 0.55; cd = cd * 1.4 + 0.02; }   // тупой кромкой вперёд
  return { cl: cl * sgn, cd: cd };
}

// Угол атаки, при котором мягкий парус набирает полную форму. Меньше — он
// полощет: тряпка, а не крыло.
const SAIL_FILL = 5 * DEG;

// Насколько сама собой раскрывается задняя шкаторина, когда шкот перестаёт
// быть натянутым. Твист задаёт не отдельный человек: шкот тянет гик вниз и
// назад одной и той же снастью, и стоит потравить его до того, что парус
// больше не упирается, — верх раскрывается сам и перестаёт работать первым.
// Без этого лодка с полностью отданными шкотами ехала три с половиной узла,
// причём тягу давали как раз верхние полоски, которым полагалось полоскать.
const FREE_TWIST = 42 * DEG;
const LOADED_ALPHA = 8 * DEG;      // при таком угле атаки шкот уже держит
const SHEET_GIVE = 25 * DEG;       // на сколько парус сдаёт за своим пределом

// Парус: сечение, ДВУМЕРНОЕ. Наклон кривой подъёмной силы 2π, без поправки на
// удлинение, и никакого индуктивного сопротивления: и то и другое считает
// вихревая решётка (sim/vlm.js) по настоящей форме паруса и его закрутке, а не
// по паспортному числу. Двойной учёт был бы грубой ошибкой.
//
// Угол атаки здесь считается от ХОРДЫ и
// принимается любой, включая обтекание с задней стороны: на полных курсах
// парус вынесен так, что поток идёт под углом далеко за девяносто градусов.
//
// Парус мягкий, и это не мелочь: пузо у него берётся не из кроя, а из того,
// что поток прижимает полотно к шкоту. Около нулевого угла атаки прижимать
// нечем, парус полощет и не даёт почти ничего. Без этого лодка с полностью
// отданными шкотами ехала три с половиной узла и понемногу разгонялась —
// подъёмную силу давала «пузатость», которой у полощущего паруса нет.
function sailCoeffs(alphaRad) {
  const a = Math.abs(alphaRad);
  const f = Math.min(1, a / SAIL_FILL);
  const fill = f * f * (3 - 2 * f);
  // Срыв у двумерного сечения наступает раньше и резче, чем казалось раньше.
  // До вихревой решётки наклон брался с поправкой на удлинение (около 4 вместо
  // 2π), и она заодно работала неявным ограничителем: подъёмная сила просто не
  // успевала вырасти до невозможных значений. Теперь поправку делает решётка,
  // наклон стал честным 2π — и ограничивать срыв должен сам срыв. Тринадцать
  // градусов дают максимум около 1.75, что для мягкого выгнутого паруса
  // примерно и есть предел.
  const stall = 13 * DEG;
  const clLin = 2 * Math.PI * (a + 2 * SAIL_CAMBER * fill);
  const clFlat = 2 * Math.sin(a) * Math.cos(a);
  const cdFlat = 1.2 * Math.sin(a) * Math.sin(a) + 0.08;
  const blend = a <= stall ? 0 : Math.min(1, (a - stall) / (15 * DEG));
  const cl = (clLin * (1 - blend) + clFlat * blend) * fill;
  // Полощущий парус тоже тормозит — он хлопает поперёк потока, — но тяги не
  // даёт никакой. Индуктивного сопротивления здесь нет: его даёт решётка.
  const cd = (0.06 * (1 - blend) + cdFlat * blend) * fill + (1 - fill) * 0.12;
  return { cl: cl * Math.sign(alphaRad || 1), cd: cd };
}

export class Boat {
  constructor(pack, opts) {
    this.p = pack;
    this.o = Object.assign({
      windSpeed: 6.0,          // истинный ветер, м/с
      windDir: 100 * DEG,      // откуда дует, рад, отсчёт от оси X мира
      sheet: 25 * DEG,         // угол выноса паруса от ДП
      rudder: 0.0,             // текущее положение пера, рад
      rudderTarget: null,      // куда его ведут; null — держать как есть
      crewHike: 0.0,           // откренивание: 0 — в ДП, 1 — на борту
      crewMass: 0.0,
      sailScale: 1.0,          // 1 — грот со стакселем, больше — с генакером
      twist: 0.0,              // раскрытие задней шкаторины к топу, рад
    }, opts || {});

    // Поле ветра: скорость и направление в опциях — опорные, на десяти метрах.
    // Порывы по умолчанию выключены, иначе тесты меряли бы погоду, а не лодку.
    this.wind = new WindField({ speed: this.o.windSpeed, dir: this.o.windDir });

    const m = pack.mass;
    this.mass = m.total_kg;
    this.buildStrips();
    this.reset();
  }

  // Разбивка парусов на полоски по высоте.
  //
  // Полоска считается той же самой моделью сечения, что раньше считался весь
  // риг целиком: ничего нового про аэродинамику здесь не появилось. Новое —
  // то, что каждая полоска видит свой ветер (свой по профилю, свой по порыву)
  // и свой угол атаки, потому что парус закручен. Отсюда берётся то, чего
  // раньше просто не существовало: смысл у твиста, уход центра парусности при
  // заходе, аэродинамическое демпфирование качки (мачта машет по воздуху) и
  // рывок от порыва, приходящего сначала на топ.
  //
  // Площадь по высоте распределена не по формуле, а по самому обводу: сколько
  // хорды пришлось на полоску, столько у неё и площади. У грота с серпом это
  // не то же самое, что у треугольника, — серп добавляет площадь наверху, где
  // плечо больше всего.
  buildStrips() {
    const rig = this.p.rig;
    // Обводы сняты с плана парусности 610.pdf (src/sv20/sailplan.py) и лежат
    // в пакете: передняя шкаторина от галсового угла к фаловому, задняя от
    // фалового к шкотовому. Это те же самые контуры, по которым в пакете
    // посчитаны площади и центр парусности, — иначе плечо паруса разъедется
    // с тем, под которое калибровался приводящий момент корпуса.
    //
    // maxSheet — до какого выноса парус ещё держится шкотом. У грота это
    // ванты: гик упирается в них примерно на прямом угле. У стакселя шкот
    // идёт к точке на палубе, и вынести его дальше примерно тридцати пяти
    // градусов нечем: травить дальше — значит просто отпустить парус, а не
    // вынести его. За пределом он не стоит на упоре, а сваливается по потоку
    // и полощет; переход растянут на SHEET_GIVE, чтобы не было скачка.
    const sails = [
      Object.assign({ maxSheet: 90 * DEG }, rig.sails.main),
      Object.assign({ maxSheet: 35 * DEG }, rig.sails.jib),
    ];
    // Отрисовка строит поверхность парусов по этим же обводам и по тому же
    // закону твиста. Иначе нарисованный парус и посчитанный расходятся, и
    // отладочный вид начинает врать — а он затем и нужен, чтобы не врал.
    this.sails = sails;
    this.strips = [];
    this.stripState = [];
    for (const s of sails) {
      const zLo = Math.max(s.tack[1], s.clew[1]);
      const zHi = Math.min(s.head[1], s.head_aft[1]);
      const span = zHi - zLo;
      const ar = span * span / Math.max(1, s.area_m2);
      const luff = edgeFn(s.luff), leech = edgeFn(s.leech);
      const chordAt = z => Math.max(0.05, luff(z) - leech(z));
      // Площадь и её центр по полоске — прямым интегрированием хорды. Обвод
      // ломаный, поэтому и хватает грубой квадратуры: внутри полоски излом
      // задней шкаторины даёт доли процента.
      //
      // Сумма по полоскам приводится к площади паруса из пакета. Расходятся
      // они на срезанные краешки — у грота между шкотовым и галсовым углом
      // разница в четыре сантиметра по высоте, и полоски туда не достают, —
      // а площадь эта паруса, и терять её незачем.
      const NQ = 24;
      let sum = 0;
      for (let q = 0; q < NQ * STRIPS; q++) {
        sum += chordAt(zLo + span * (q + 0.5) / (NQ * STRIPS)) * span / (NQ * STRIPS);
      }
      const norm = sum > 1e-9 ? s.area_m2 / sum : 1;
      for (let i = 0; i < STRIPS; i++) {
        const f0 = i / STRIPS, f1 = (i + 1) / STRIPS;
        const hLo = zLo + f0 * span, hHi = zLo + f1 * span;
        let a = 0, mz = 0;
        for (let q = 0; q < NQ; q++) {
          const z = hLo + (hHi - hLo) * (q + 0.5) / NQ;
          const c = chordAt(z) * (hHi - hLo) / NQ;
          a += c; mz += c * z;
        }
        const h = a > 1e-9 ? mz / a : (hLo + hHi) / 2;
        const f = span > 1e-9 ? (h - zLo) / span : 0.5;
        a *= norm;
        this.strips.push({
          area: a, ar: ar, maxSheet: s.maxSheet,
          h: h,                               // высота по мачте, без крена
          hLo: hLo, hHi: hHi,                 // границы размаха полоски
          chordLo: chordAt(hLo), chordHi: chordAt(hHi),
          xLuffLo: luff(hLo), xLuffHi: luff(hHi),
          chord: chordAt(h),
          xLuff: luff(h),
          // Твист растёт к топу быстрее линейного: у настоящего паруса
          // задняя шкаторина раскрывается в основном в верхней трети.
          twistF: Math.pow(f, 1.3),
        });
        this.stripState.push({
          h: 0, z: 0, area: a, ws: 0, awaDeg: 0, alphaDeg: 0,
          cl: 0, drive: 0, side: 0,
        });
      }
    }
    this.sailOut = { fx: 0, fy: 0, fz: 0, mx: 0, mz: 0, ceZ: 0,
                     awa: 0, awaEff: 0, alpha: 0, cl: 0, area: 0 };
    // Вихревая решётка на весь риг сразу: гроту и стакселю положено знать друг
    // о друге, и в одной решётке они узнают об этом сами.
    const n = this.strips.length;
    this.lattice = new Lattice(n * NCHORD);
    this.stripCalc = this.strips.map(() => ({
      xi: 0, yi: 0, zi: 0, ve: 0, d1: 0, d2: 0, alpha: 0, awa: 0,
      chord: 0, area: 0, live: false,
    }));
    this.alphaInd = new Float64Array(n);
    this.latRhs = new Float64Array(n * NCHORD);
    this.latRebuild = true;
    this.latReady = false;
  }

  reset() {
    this.x = 0; this.y = 0;          // положение в мире, м
    this.psi = 0;                    // курс, рад, от оси X мира
    this.u = 0; this.v = 0;          // скорости в связанной системе, м/с
    this.r = 0;                      // угловая скорость рыскания, рад/с
    this.phi = 0; this.p_ = 0;       // крен и его скорость
    this.rigSide = null;             // борт паруса, от −1 до 1; null — не ставлен
    this.rigTarget = null;           // куда он переходит
    this.hike = 0;                   // момент откренивания сейчас, Н·м
    this.t = 0;
  }

  // --- ветер ---------------------------------------------------------------

  // Кажущийся ветер в точке рига (xb, yb — в горизонтной системе от миделя,
  // zb — высота над водой), которая сама движется со скоростью (vx, vy).
  // Раньше такой точкой была вся лодка; теперь их двенадцать, по числу полосок.
  apparentAt(xb, yb, zb, vx, vy) {
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    const w = this.wind.sample(this.x + xb * c - yb * s,
                              this.y + xb * s + yb * c,
                              Math.max(0.3, zb), this.t);
    const ax = w.x * c + w.y * s - vx;
    const ay = -w.x * s + w.y * c - vy;
    return { x: ax, y: ay, speed: Math.hypot(ax, ay),
             angle: Math.atan2(ay, ax), ws: w.speed };
  }

  // Кажущийся ветер «у лодки» — на высоте центра парусности. Это то, что
  // показывает флюгер и роза; силы считаются по полоскам, а не по нему.
  apparentWind() {
    const rig = this.p.rig;
    return this.apparentAt(rig.ce_x_m != null ? rig.ce_x_m : rig.mast_x_m, 0,
                           rig.ce_height_m * Math.cos(this.phi),
                           this.u, this.v);
  }

  // Угол считается от носа до направления, ОТКУДА дует, как принято на воде:
  // ноль — в лоб, 180 — точно в корму. Та же условность, что и у кажущегося
  // ветра, иначе один и тот же курс читается двумя разными числами.
  trueWindAngle() {
    return wrapPi(this.o.windDir - this.psi);
  }

  // --- силы ----------------------------------------------------------------

  // Парус на накренённой мачте.
  //
  // Крен здесь не поправочный множитель, а геометрия. Парус натянут вдоль
  // мачты, и работает только та часть набегающего потока, которая идёт
  // ПОПЕРЁК мачты: вдоль неё воздух просто стекает по полотну. Поэтому весь
  // расчёт ведётся в плоскости, перпендикулярной мачте, а готовая сила
  // раскладывается обратно по связанным осям.
  //
  // Отсюда сама собой берётся разгрузка на крене: угол атаки в этой плоскости
  // равен arctg(tg(AWA)·cos(крен)), и на пятидесяти градусах парус видит вдвое
  // меньший угол, чем показывает флюгер. Без этого модель на свежем ветру
  // ложилась на 55–58° и продолжала идти в лавировку десять узлов — то есть
  // не разгружалась вовсе. Ни одного подобранного числа здесь нет, только
  // проекция; прежний множитель cos(крен) на боковой силе — её частный случай.
  sailForces(aw) {
    const rig = this.p.rig, env = this.p.environment, m = this.p.mass;
    const cphi = Math.cos(this.phi), sphi = Math.sin(this.phi);
    const cgx = m.cg_m[0], cgz = m.cg_m[2];
    const scale = this.o.sailScale;
    const out = this.sailOut;
    out.fx = 0; out.fy = 0; out.fz = 0; out.mx = 0; out.mz = 0;
    out.awa = Math.PI - Math.abs(aw.angle);
    out.awaEff = 0; out.alpha = 0; out.cl = 0; out.area = 0; out.ceZ = 0;

    const rigSide = this.rigSide;
    // Натянут ли шкот. Мерой служит угол атаки у нижней шкаторины: пока он
    // велик, парус упирается в шкот и держит форму; как только он падает к
    // нулю, снасть провисает и задняя шкаторина раскрывается сама.
    const slack = 1 - Math.min(1, Math.max(0, out.awa - this.o.sheet) / LOADED_ALPHA);
    const twist = this.o.twist + FREE_TWIST * slack;
    this.twistEff = twist;
    let load = 0;

    // --- проход первый: геометрия и углы атаки без учёта скоса.
    const lat = this.lattice, calc = this.stripCalc, NS = this.strips.length;
    const e2y = cphi, e2z = sphi;                 // орт «поперёк» накренённого рига
    for (let i = 0; i < NS; i++) {
      const st = this.strips[i], d = this.stripState[i], g = calc[i];
      const area = st.area * scale;
      const sheet = this.o.sheet + twist * st.twistF;
      const chord = st.chord;
      // Положение полоски в горизонтной системе. Точка приложения — центр
      // давления её хорды, а не мачта: поэтому при потраве шкота парусность
      // уходит назад и в сторону, и приводящий момент меняется сам собой.
      const zi = st.h * cphi;
      const yi = -st.h * sphi + CP_CHORD * chord * Math.sin(sheet) * rigSide * cphi;
      const xi = st.xLuff - CP_CHORD * chord * Math.cos(sheet);
      // Своя местная скорость: снос, рыскание и качка на своих плечах. Из
      // последнего слагаемого и получается аэродинамическое демпфирование
      // качки — мачта на размахе машет по воздуху и тормозит крен.
      const vx = this.u - this.r * yi;
      const vy = this.v + this.r * (xi - cgx) - this.p_ * (zi - cgz);
      const a = this.apparentAt(xi, yi, zi, vx, vy);

      // в плоскости, перпендикулярной мачте
      const w1 = a.x, w2 = a.y * cphi;
      const ve = Math.hypot(w1, w2);
      d.h = st.h; d.z = zi; d.area = area; d.ws = a.ws;
      g.xi = xi; g.yi = yi; g.zi = zi; g.area = area; g.ve = ve; g.chord = chord;
      g.live = ve >= 0.05;
      if (!g.live) {
        d.awaDeg = 0; d.alphaDeg = 0; d.indDeg = 0; d.cl = 0; d.drive = 0; d.side = 0;
        for (let k = 0; k < NCHORD; k++) lat.panels[i * NCHORD + k].speed = 0;
        continue;
      }
      const theta = Math.atan2(w2, w1);         // куда дует, в плоскости паруса
      const awa = Math.PI - Math.abs(theta);    // угол от носа, откуда дует
      // Угол атаки меряется от хорды паруса, а не от «наветренной стороны».
      // От хорды всё получается непрерывно во всех четвертях: парус стоит там,
      // где стоит, а поток может подходить к нему с любой стороны.
      // Шкот парус не держит, а только ограничивает: гик вытравливается по
      // потоку, пока шкот его не остановит. За своим пределом парус не стоит
      // на упоре, а сваливается по потоку и полощет.
      const held = Math.min(sheet, awa);
      const over = Math.min(1, Math.max(0, (sheet - st.maxSheet) / SHEET_GIVE));
      const set = held + (awa - held) * over;
      // Хорда смотрит в корму (π) и отклонена от неё на угол выноса. Знак
      // отклонения даёт сторона паруса, а она непрерывная: посреди переброса
      // rigSide равен нулю и хорда лежит точно в ДП, как настоящий гик.
      const chordDir = Math.PI - rigSide * set;
      const alpha = wrapPi(theta - chordDir);
      g.alpha = alpha; g.awa = awa; g.d1 = w1 / ve; g.d2 = w2 / ve;

      // Панели решётки: NCHORD штук вдоль хорды. Присоединённый вихрь каждой на
      // четверти её длины, контрольная точка на трёх четвертях, свободные вихри
      // уходят по потоку прямо от присоединённого — обычная вихревая решётка.
      const cs = Math.cos(set), sn = Math.sin(set) * rigSide;
      const nc = -Math.sin(chordDir), ns = Math.cos(chordDir);
      const camSign = Math.sign(alpha || 1);
      // Точка на средней линии паруса на доле t хорды: вдоль хорды плюс пузо
      // по нормали. Пузо и даёт угол нулевой подъёмной силы.
      const put = (arr, h, ch, xl, t) => {
        const bow = camSign * SAIL_CAMBER * 4 * t * (1 - t) * ch;
        const ax = xl - t * ch * cs + bow * nc;
        const as = t * ch * sn + bow * ns;      // смещение поперёк, в плоскости
        arr[0] = ax;
        arr[1] = -h * sphi + as * e2y;
        arr[2] = h * cphi + as * e2z;
      };
      for (let k = 0; k < NCHORD; k++) {
        const p = lat.panels[i * NCHORD + k];
        const tb = (k + 0.25) / NCHORD, tc = (k + 0.75) / NCHORD;
        put(p.a, st.hHi, st.chordHi, st.xLuffHi, tb);
        put(p.b, st.hLo, st.chordLo, st.xLuffLo, tb);
        // Свободные вихри уходят прямо от присоединённого: у решётки с
        // панелями по хорде отдельных отрезков до задней шкаторины не нужно,
        // их роль играют присоединённые вихри следующих панелей.
        p.ta[0] = p.a[0]; p.ta[1] = p.a[1]; p.ta[2] = p.a[2];
        p.tb[0] = p.b[0]; p.tb[1] = p.b[1]; p.tb[2] = p.b[2];
        put(p.c, st.h, chord, st.xLuff, tc);
        // Нормаль повёрнута на местный наклон средней линии — отсюда и берётся
        // подъёмная сила пуза, без отдельного слагаемого.
        const sl = camSign * SAIL_CAMBER * 4 * (1 - 2 * tc);
        const cd2 = Math.cos(sl), sd2 = Math.sin(sl);
        const nx = nc * cd2 + cs * sd2;         // поворот нормали в плоскости
        const nsr = ns * cd2 + sn * sd2;
        p.nrm[0] = nx; p.nrm[1] = nsr * e2y; p.nrm[2] = nsr * e2z;
        p.chord = chord / NCHORD; p.speed = ve;
        this.latRhs[i * NCHORD + k] = -ve * Math.sin(alpha - sl);
      }
    }

    // --- решётка: скос от собственной пелены и от соседнего паруса.
    //
    // Задача линейная: условие непротекания на всех панелях сразу. Из неё
    // берётся циркуляция полоски, из неё — эффективный угол атаки: тот, при
    // котором двумерное сечение дало бы такую же циркуляцию. Разница с
    // геометрическим и есть скос.
    //
    // За срывом решётка неприменима — потенциальное течение о срыве не знает,
    // а на полных курсах парус живёт именно там. Поэтому поправка плавно
    // гасится от IND_FADE0 до IND_FADE1.
    const awSpeed = Math.hypot(aw.x, aw.y);
    const aInd = this.alphaInd;
    aInd.fill(0);
    if (awSpeed > 0.2) {
      if (this.latRebuild) {
        lat.build(aw.x / awSpeed, aw.y / awSpeed, 0, true, true);
        this.latReady = true;
      }
      const gam = lat.solveLinear(this.latRhs);
      for (let i = 0; i < NS; i++) {
        const g = calc[i];
        if (!g.live) continue;
        let G = 0;
        for (let k = 0; k < NCHORD; k++) G += gam[i * NCHORD + k];
        // Γ = π·b·V·(α − α₀): отсюда эффективный угол.
        const aEff = G / (Math.PI * g.chord * g.ve) -
                     Math.sign(g.alpha || 1) * 2 * SAIL_CAMBER;
        const raw = g.alpha - aEff;
        const a = Math.abs(g.alpha);
        const fade = a <= IND_FADE0 ? 1
          : (a >= IND_FADE1 ? 0 : (IND_FADE1 - a) / (IND_FADE1 - IND_FADE0));
        // Скос не может быть больше самого угла атаки: за этим стоит только
        // выход постановки за пределы применимости.
        aInd[i] = Math.max(-a, Math.min(a, raw)) * fade;
      }
    }

    // --- проход второй: силы по эффективному углу атаки.
    for (let i = 0; i < NS; i++) {
      const g = calc[i], d = this.stripState[i];
      if (!g.live) continue;
      // Скос уменьшает угол атаки и наклоняет подъёмную силу назад — вот
      // отсюда и берётся индуктивное сопротивление, а не из формулы с
      // паспортным удлинением.
      const ai = aInd[i];
      const alpha = g.alpha - ai;
      const k = sailCoeffs(alpha);

      const q = 0.5 * env.rho_air * g.area * g.ve * g.ve;
      const lift = q * k.cl, drag = q * k.cd;
      const d1 = g.d1, d2 = g.d2;
      const along = drag + lift * Math.sin(ai);
      const across = lift * Math.cos(ai);
      const f1 = along * d1 - across * d2;
      const f2 = along * d2 + across * d1;

      const fxi = f1, fyi = f2 * cphi, fzi = f2 * sphi;
      out.fx += fxi; out.fy += fyi; out.fz += fzi;
      // Моменты собираются сразу по полоскам: у каждой своё плечо, и общий
      // центр парусности больше не нужно назначать — он получается сам.
      out.mx += g.yi * fzi - (g.zi - cgz) * fyi;
      out.mz += (g.xi - cgx) * fyi - g.yi * fxi;

      out.area += g.area;
      out.awaEff += g.awa * g.area; out.alpha += -rigSide * alpha * g.area;
      out.cl += Math.abs(k.cl) * g.area;
      const w = Math.abs(f2);
      load += w; out.ceZ += g.zi * w;

      d.awaDeg = g.awa / DEG;
      // Знак угла атаки зависит от галса: с одного борта он положительный, с
      // другого отрицательный. В приборах это только мешает, поэтому
      // показывается «рабочий» угол — одинаковый на обоих галсах.
      d.alphaDeg = -rigSide * alpha / DEG;
      d.indDeg = -rigSide * ai / DEG;
      d.cl = Math.abs(k.cl); d.drive = f1; d.side = f2;
    }

    if (out.area > 0) {
      out.awaEff /= out.area; out.alpha /= out.area; out.cl /= out.area;
    }
    out.ceZ = load > 1e-6 ? out.ceZ / load : rig.ce_height_m * cphi;
    return out;
  }

  // Паразитное сопротивление корпуса, рангоута и экипажа в потоке. Сила
  // горизонтальная и приложена низко, так что кренит слабо; но в лавировку
  // кажущийся ветер силён, и она заметно ограничивает остроту хода.
  windage(aw) {
    const rig = this.p.rig, env = this.p.environment;
    const a = rig.windage_area_m2 || 0;
    if (!a || aw.speed < 0.05) return { fx: 0, fy: 0, z: 0.6 };
    const q = 0.5 * env.rho_air * a * (rig.windage_cd || 0.85) * aw.speed;
    return { fx: q * aw.x, fy: q * aw.y, z: 0.6 };
  }

  // Поперечная сила корпуса по полоскам. Заменяет два прежних слагаемых —
  // «сопротивление дрейфу» и «демпфирование рыскания», — потому что на самом
  // деле это одно и то же явление: каждая полоска обтекается поперёк со своей
  // местной скоростью v + r·x, и сумма даёт сразу и силу, и момент, и связь
  // между ними. Раздельные подгоняемые коэффициенты для этого не нужны.
  hullLateral(v, r, n) {
    const P = this.p, env = P.environment, hs = P.hydrostatics;
    const xa = hs.lwl_aft_x_m != null ? hs.lwl_aft_x_m : 0.55;
    const xf = hs.lwl_fwd_x_m != null ? hs.lwl_fwd_x_m : 6.02;
    const cgx = P.mass.cg_m[0];
    const steps = n || 12;
    const dx = (xf - xa) / steps;
    // На ровном киле поперёк потока стоит только осадка корпуса — пятнадцать
    // сантиметров. На крене лодка подставляет потоку днище, и высота растёт до
    // половины ширины. Без этого положенная набок лодка ничем не держится
    // и уезжает боком со скоростью, которой на воде не бывает.
    const c = Math.abs(Math.cos(this.phi)), s2 = Math.abs(Math.sin(this.phi));
    const depth = hs.draft_canoe_m * c + 0.5 * hs.bwl_m * s2;
    const q = 0.5 * env.rho_water * HULL_CROSSFLOW_CD * depth * dx;
    let fy = 0, mz = 0;
    for (let i = 0; i < steps; i++) {
      const arm = xa + (i + 0.5) * dx - cgx;
      const vi = v + r * arm;
      const f = -q * Math.abs(vi) * vi;
      fy += f;
      mz += f * arm;
    }
    return { fy: fy, mz: mz };
  }

  // Сила крыла сразу в связанных осях. Так не нужно отдельно решать, куда
  // смотрит подъёмная сила: она просто перпендикулярна скорости крыла, а
  // сопротивление направлено против неё, и все четверти получаются сами.
  foilForce(foil, ux, vy, deflect, extraCd) {
    const env = this.p.environment;
    const V = Math.hypot(ux, vy);
    if (V < 0.05) return { fx: 0, fy: 0, side: 0, alpha: 0 };
    const heading = Math.atan2(vy, ux);            // куда движется крыло
    const alpha = wrapPi(heading - (deflect || 0));
    const k = foilCoeffs(alpha, foil.effective_ar, foil.stall_deg,
                         0.008 + (extraCd || 0));
    const q = 0.5 * env.rho_water * foil.area_m2 * V * V;
    const L = q * k.cl, Dg = q * k.cd;
    const ex = ux / V, ey = vy / V;                // вдоль движения
    const px = -ey, py = ex;                       // поперёк движения
    return { fx: -Dg * ex - L * px, fy: -Dg * ey - L * py,
             side: -L * py, alpha: alpha, cl: k.cl };
  }

  step(dt) {
    const P = this.p, env = P.environment, m = P.mass;

    if (this.o.rudderTarget != null) {
      const d = this.o.rudderTarget - this.o.rudder;
      const lim = RUDDER_RATE * dt;
      this.o.rudder += Math.max(-lim, Math.min(lim, d));
    }

    // Опорный ветер живёт в опциях, чтобы интерфейс и тесты крутили одно
    // число; поле ветра берёт его отсюда, а профиль и порывы добавляет само.
    this.wind.o.speed = this.o.windSpeed;
    this.wind.o.dir = this.o.windDir;

    // Перестраивать ли матрицу решётки на этом шаге — считается от времени,
    // чтобы не заводить скрытого состояния.
    this.latRebuild = !this.latReady ||
                      (dt > 0 && Math.round(this.t / dt) % LATTICE_EVERY === 0);

    const speed = Math.hypot(this.u, this.v);
    const leeway = speed > 0.05 ? Math.atan2(this.v, Math.max(0.05, this.u)) : 0;

    const aw = this.apparentWind();
    // На каком борту стоит парус — состояние лодки, а не мгновенный отсчёт по
    // флюгеру: парус вынесен на один борт целиком, от колебания ветра туда-сюда
    // не прыгает и перекидывается только когда ветер уверенно зашёл на другую
    // сторону. И перекидывается за конечное время.
    if (this.rigTarget === null ||
        Math.abs(aw.y) > Math.sin(GYBE_MARGIN) * Math.max(0.05, aw.speed)) {
      this.rigTarget = aw.angle > 0 ? 1 : -1;
    }
    if (this.rigSide === null) {
      // Парус ставят на нужный борт, а не перекидывают: в начале хода никакого
      // поворота не было. Иначе лодка первую секунду идёт с гиком в ДП.
      this.rigSide = this.rigTarget;
    } else {
      const swing = GYBE_RATE * dt;
      const dSide = this.rigTarget - this.rigSide;
      this.rigSide += Math.max(-swing, Math.min(swing, dSide));
    }
    const sail = this.sailForces(aw);
    const wind = this.windage(aw);

    // Крылья видят не скорость центра тяжести, а свою местную: к дрейфу
    // добавляется вращение на собственном плече от ЦТ. Для руля это главное
    // слагаемое, ограничивающее циркуляцию: на развороте набегающий поток
    // подходит к перу под меньшим углом, и момент сам себя гасит. Без этого
    // лодка крутилась радиусом меньше собственной длины.
    const keel = P.foils.keel, rud = P.foils.rudder;
    const cgx0 = P.mass.cg_m[0];
    const cphi = Math.cos(this.phi);

    const kf = this.foilForce(keel, this.u,
                              this.v + this.r * (keel.x_m - cgx0), 0, 0);
    const keelSide = kf.fy * cphi;
    const keelFx = kf.fx;

    // Хорда пера повёрнута на угол перекладки: угол атаки меряется от неё.
    // Знак здесь ровно один и его легко перевернуть — тогда руль работает
    // наоборот, а выглядит это как «лодка не держит курс».
    const rf = this.foilForce(rud, this.u,
                              this.v + this.r * (rud.x_m - cgx0),
                              this.o.rudder, 0.004);
    const rudSide = rf.fy * cphi;
    const rudFx = rf.fx;

    // сопротивление корпуса по таблице
    const rt = lerpTable(P.resistance.curve, 'v_ms', Math.abs(this.u), 'rt_n');
    const hullDrag = -Math.sign(this.u || 1) * rt;
    const hull = this.hullLateral(this.v, this.r);

    // --- уравнения движения
    const mx = this.mass * (1 + m.added_surge);
    const my = this.mass * (1 + m.added_sway);
    const iz = m.izz_kg_m2 * (1 + m.added_yaw);
    const ix = m.ixx_kg_m2 * m.added_roll;

    const fx = sail.fx + wind.fx + hullDrag + keelFx + rudFx;
    const fy = sail.fy + wind.fy + keelSide + rudSide + hull.fy;

    const du = fx / mx + this.v * this.r;
    const dv = fy / my - this.u * this.r;

    // Момент рыскания. Плечи меряются от центра тяжести, а не от кормовой
    // оконечности: абсциссы в пакете отсчитаны от транца, и если подставить
    // их напрямую, у киля получается плечо в три метра вместо двадцати пяти
    // сантиметров. Лодка от этого раскручивается за секунды.
    const cgx = m.cg_m[0];
    // Момент паруса собран по полоскам, у каждой своё плечо. Оттуда же сам
    // собой берётся приводящий момент от крена: центр парусности уходит под
    // ветер, и пара «тяга на этом плече» разворачивает нос на ветер. Это
    // главный источник weather helm на живой лодке, и отдельным слагаемым его
    // дописывать не нужно.
    let mz = keelSide * (keel.x_m - cgx) + rudSide * (rud.x_m - cgx)
             + sail.mz + hull.mz;
    mz += HULL_HEEL_YAW * 0.5 * env.rho_water * this.u * this.u *
          P.hydrostatics.lwl_m * P.hydrostatics.draft_canoe_m *
          Math.sin(2 * this.phi);
    const dr = mz / iz;

    // крен: кренящий момент паруса минус восстанавливающий и демпфирование
    const heelDeg = Math.abs(this.phi) / DEG;
    const gz = lerpTable(P.righting.gz, 'heel_deg', heelDeg, 'gz_m');
    const righting = -Math.sign(this.phi || 1) * this.mass * env.g * gz;
    const sailHeel = sail.mx;
    const windHeel = -(wind.z - m.cg_m[2]) * wind.fy;
    const foilHeel = (keelSide * (keel.z_centre_m - m.cg_m[2])
                      + rudSide * (rud.z_centre_m - m.cg_m[2]));

    // Экипаж откренивает столько, сколько нужно, и не больше, чем может.
    //
    // Раньше сторона бралась по знаку крена, а момент был всегда полный. Это
    // реле: у самого нуля крена экипаж мгновенно перепрыгивал с борта на борт,
    // по нескольку раз в секунду, вкладывая в качку по две с половиной тысячи
    // ньютон-метров то в одну сторону, то в другую. На полных курсах, где крен
    // и так около нуля, лодка от этого мелко тряслась на четырёх герцах —
    // вчетверо чаще собственной частоты качки, и амплитуда зависела от шага
    // интегрирования, чего у физического явления быть не может.
    //
    // Настоящий экипаж откренивает против кренящего момента, а не против
    // мгновенного крена, и в лавировку выкладывается полностью, потому что там
    // кренящий момент много больше его возможностей. На полных курсах он
    // просто сидит в лодке — и правильно делает.
    const maxHike = this.o.crewHike * this.o.crewMass * env.g * 1.0;
    const heeling = sailHeel + windHeel + foilHeel;
    const wantHike = -Math.max(-maxHike, Math.min(maxHike, heeling));
    this.hike += (wantHike - this.hike) * Math.min(1, dt / HIKE_TAU);
    const hikeMoment = this.hike;
    // Гидродинамическое демпфирование качки: доля критического, иначе крен
    // звенит. Аэродинамическое сюда не входит и больше не нужно — оно
    // получается само из полосок, машущих по воздуху при качке.
    const wn = Math.sqrt(this.mass * env.g * Math.max(0.05, P.hydrostatics.gm_m) / ix);
    const damp = -2 * 0.18 * wn * ix * this.p_;
    const dp = (sailHeel + windHeel + foilHeel + righting + hikeMoment + damp) / ix;

    // --- интегрирование, полунеявная схема Эйлера
    this.u = clamp(this.u + du * dt, 25);
    this.v = clamp(this.v + dv * dt, 12);
    this.r = clamp(this.r + dr * dt, 3);
    this.p_ = clamp(this.p_ + dp * dt, 6);
    this.phi = clamp(this.phi + this.p_ * dt, Math.PI / 2);
    this.psi = wrapPi(this.psi + this.r * dt);
    if (!isFinite(this.x) || !isFinite(this.y)) { this.x = 0; this.y = 0; }

    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    this.x += (this.u * c - this.v * s) * dt;
    this.y += (this.u * s + this.v * c) * dt;
    this.t += dt;

    this.telemetry = {
      speed: speed, speedKn: speed * 1.94384,
      leewayDeg: leeway / DEG, heelDeg: this.phi / DEG,
      awaDeg: sail.awa / DEG, awsKn: aw.speed * 1.94384,
      awaEffDeg: sail.awaEff / DEG,   // что видит парус, а не флюгер
      ceHeightM: sail.ceZ,            // центр парусности по нагрузке полосок
      twsKn: aw.ws * 1.94384,         // истинный ветер на высоте ЦП
      strips: this.stripState,
      twaDeg: this.trueWindAngle() / DEG,
      alphaDeg: sail.alpha / DEG, sailCl: sail.cl,
      driveN: sail.fx, sideN: sail.fy,
      resistN: rt, keelLiftN: keelSide, rudderLiftN: rudSide,
      sternway: this.u < -0.15,
      gzM: gz, yawRate: this.r / DEG,
      vmg: speed * Math.cos(this.trueWindAngle()) * 1.94384,
      twaAbsDeg: Math.abs(this.trueWindAngle()) / DEG,
    };
    return this.telemetry;
  }
}

export const helpers = { lerpTable, foilCoeffs, sailCoeffs, DEG, STRIPS, NCHORD };
