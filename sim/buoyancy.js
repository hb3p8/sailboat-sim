// Плавучесть по вытесненному объёму: сколько воды корпус отодвинул сейчас.
//
// Раньше остойчивость входила в симулятор таблицей GZ(крен), посчитанной при
// сборке. Таблица честная — корпус там кренится по-настоящему, и уровень воды
// подбирается под то же водоизмещение, — но она отвечает только на один вопрос
// и только для одного случая: лодка без хода, без дифферента, ровно на своей
// ватерлинии. Всплытия и дифферента у модели не было вовсе.
//
// Здесь то же самое считается на каждом шаге. Корпус задан замкнутыми контурами
// шпангоутов (палуба включена, поэтому уход борта под воду учитывается сам),
// плоскость воды отсекает их, а дальше обычная гидростатика: объём, центр
// величины, площадь ватерлинии.
//
// ГЛАВНОЕ УПРОЩЕНИЕ. Шпангоуты не поворачиваются — поворачивается ВОДА. Это не
// приближение, а тождество: положение плоскости относительно корпуса и есть всё,
// что нужно для отсечения, а в каком месте мира эта плоскость находится, объёму
// безразлично. Выигрыш в том, что сечение остаётся в своей плоскости при любом
// дифференте, и станции не нужно пересобирать.
//
// Оси связанные: X в нос, Y на ЛЕВЫЙ борт, Z вверх. Верх мира в этих осях при
// крене phi и дифференте th (плюс — нос кверху) есть
//
//     n = (sin th, sin phi * cos th, cos phi * cos th)
//
// и точка p погружена, когда n·p + zc <= 0, где zc — высота начала координат
// лодки над спокойной водой. Для станции x = const это обычное отсечение
// прямой в плоскости (y, z), со своим порогом на каждой станции.

export class Buoyancy {
  constructor(pack) {
    const s = pack && pack.sections;
    this.ready = !!(s && s.x_m && s.x_m.length > 2);
    if (!this.ready) return;
    this.xs = s.x_m;
    // Контуры разворачиваются в плоские массивы: обход по паре чисел вместо
    // массива массивов даёт вчетверо меньше обращений к памяти, а считается это
    // тридцать раз в секунду.
    this.py = [];
    this.pz = [];
    for (const poly of s.poly) {
      const y = new Float64Array(poly.length), z = new Float64Array(poly.length);
      for (let i = 0; i < poly.length; i++) { y[i] = poly[i][0]; z[i] = poly[i][1]; }
      this.py.push(y); this.pz.push(z);
    }
    // Рабочие массивы по станциям, чтобы не выделять память на каждом шаге.
    const n = this.xs.length;
    this.area = new Float64Array(n);
    this.cy = new Float64Array(n);
    this.cz = new Float64Array(n);
    this.wid = new Float64Array(n);
    // Смоченный периметр шпангоута: длина погружённой части обвода БЕЗ отрезка
    // по ватерлинии. Нужен глиссированию — сокращение смоченной поверхности это
    // половина того, зачем оно вообще заводится, — и считается тем же обходом
    // отсечённого контура, что и площадь. Лишнего прохода нет.
    this.gir = new Float64Array(n);
    // Буфер отсечённого контура: точек не больше, чем в исходном, плюс две
    // на пересечения.
    let most = 0;
    for (const y of this.py) most = Math.max(most, y.length);
    this.qy = new Float64Array(most + 4);
    this.qz = new Float64Array(most + 4);
  }

  // Площадь погружённой части шпангоута, её центр и ширина по ватерлинии.
  // Отсечение Сазерленда—Ходжмана по прямой ny*y + nz*z = d, оставляем ниже.
  station(i, ny, nz, d) {
    const py = this.py[i], pz = this.pz[i], n = py.length;
    const qy = this.qy, qz = this.qz;
    let m = 0, cuts = 0, cutA = 0, cutB = 0;
    let ay = py[n - 1], az = pz[n - 1];
    let fa = ny * ay + nz * az - d;
    for (let k = 0; k < n; k++) {
      const by = py[k], bz = pz[k];
      const fb = ny * by + nz * bz - d;
      if (fa <= 0) { qy[m] = ay; qz[m] = az; m++; }
      if ((fa <= 0) !== (fb <= 0)) {
        const t = fa / (fa - fb);
        const iy = ay + t * (by - ay), iz = az + t * (bz - az);
        qy[m] = iy; qz[m] = iz; m++;
        // Ширина по ватерлинии — расстояние между двумя пересечениями. Больше
        // двух бывает у контура с вырезом кокпита; тогда берутся крайние.
        if (cuts === 0) { cutA = iy; cutB = iy; } else {
          cutA = Math.min(cutA, iy); cutB = Math.max(cutB, iy);
        }
        cuts++;
      }
      ay = by; az = bz; fa = fb;
    }
    this.wid[i] = cuts >= 2 ? cutB - cutA : 0;
    if (m < 3) {
      this.area[i] = 0; this.cy[i] = 0; this.cz[i] = 0; this.gir[i] = 0; return;
    }
    // Периметр по отсечённому контуру, минус отрезок по самой ватерлинии: он
    // проходит по воде, а не по обшивке, и в смоченную поверхность не входит.
    let per = 0;
    {
      let py0 = qy[m - 1], pz0 = qz[m - 1];
      for (let k = 0; k < m; k++) {
        const py1 = qy[k], pz1 = qz[k];
        const onWl = Math.abs(ny * py0 + nz * pz0 - d) < 1e-9 &&
                     Math.abs(ny * py1 + nz * pz1 - d) < 1e-9;
        if (!onWl) per += Math.hypot(py1 - py0, pz1 - pz0);
        py0 = py1; pz0 = pz1;
      }
    }
    this.gir[i] = per;
    // Площадь и центр многоугольника по формуле шнурков.
    let a2 = 0, sy = 0, sz = 0;
    let y0 = qy[m - 1], z0 = qz[m - 1];
    for (let k = 0; k < m; k++) {
      const y1 = qy[k], z1 = qz[k];
      const cr = y0 * z1 - y1 * z0;
      a2 += cr; sy += (y0 + y1) * cr; sz += (z0 + z1) * cr;
      y0 = y1; z0 = z1;
    }
    if (Math.abs(a2) < 1e-12) { this.area[i] = 0; this.cy[i] = 0; this.cz[i] = 0; return; }
    this.area[i] = Math.abs(0.5 * a2);
    this.cy[i] = sy / (3 * a2);
    this.cz[i] = sz / (3 * a2);
  }

  // Полная гидростатика при данном положении корпуса.
  //
  //   zc   — высота начала координат лодки над водой, м (вниз отрицательно)
  //   phi  — крен, рад; плюс — правый борт вниз
  //   th   — дифферент, рад; плюс — нос кверху
  //
  // Возвращает объём, центр величины в осях лодки, площадь ватерлинии и её
  // продольный момент инерции — последние два нужны не объёму, а демпфированию:
  // по ним считается собственная частота вертикальной качки и килевой.
  at(zc, phi, th) {
    // Результат — новый объект, а не переиспользуемый буфер. Буфер здесь
    // экономил бы тридцать выделений в секунду и стоил бы первой же ошибки
    // вида «сравнили два состояния, а это одно и то же»: на такой я уже
    // попался в собственном тесте, где `до` и `после` оказались одним объектом.
    const o = { volume: 0, cbx: 0, cby: 0, cbz: 0, awp: 0, ilong: 0, lcf: 0,
                wetted: 0, wetAft: 0 };
    if (!this.ready) return o;
    const cth = Math.cos(th), sth = Math.sin(th);
    const nx = sth, ny = Math.sin(phi) * cth, nz = Math.cos(phi) * cth;
    const xs = this.xs, n = xs.length;
    for (let i = 0; i < n; i++) this.station(i, ny, nz, -zc - nx * xs[i]);
    // Интегрирование вдоль корпуса трапециями.
    let vol = 0, mx = 0, my = 0, mz = 0, awp = 0, sx = 0, wet = 0;
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i];
      const a0 = this.area[i], a1 = this.area[i + 1];
      const av = 0.5 * (a0 + a1) * dx;
      vol += av;
      // Центр по длине — по площадям на концах отрезка, а не по среднему
      // сечению: на оконечностях площадь падает до нуля, и середина отрезка
      // там врёт заметно.
      const xm = (a0 + a1) > 1e-12
        ? (xs[i] * a0 + xs[i + 1] * a1) / (a0 + a1) : 0.5 * (xs[i] + xs[i + 1]);
      mx += av * xm;
      my += 0.5 * (a0 * this.cy[i] + a1 * this.cy[i + 1]) * dx;
      mz += 0.5 * (a0 * this.cz[i] + a1 * this.cz[i + 1]) * dx;
      wet += 0.5 * (this.gir[i] + this.gir[i + 1]) * dx;
      const wv = 0.5 * (this.wid[i] + this.wid[i + 1]) * dx;
      if (a0 > 1e-9 && !o.wetAft) o.wetAft = xs[i];
      awp += wv;
      sx += wv * 0.5 * (xs[i] + xs[i + 1]);
    }
    o.volume = vol;
    o.cbx = vol > 1e-9 ? mx / vol : 0;
    o.cby = vol > 1e-9 ? my / vol : 0;
    o.cbz = vol > 1e-9 ? mz / vol : 0;
    o.awp = awp;
    o.wetted = wet;
    o.lcf = awp > 1e-9 ? sx / awp : 0;
    let il = 0;
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i];
      const xm = 0.5 * (xs[i] + xs[i + 1]) - o.lcf;
      il += 0.5 * (this.wid[i] + this.wid[i + 1]) * dx * xm * xm;
    }
    o.ilong = il;
    return o;
  }

  // Уровень, при котором вытесняется заданный объём. Нужен не ходу, а
  // проверкам и начальной посадке: в динамике лодка приходит туда сама.
  floatAt(volume, phi, th, lo, hi) {
    if (!this.ready) return 0;
    lo = lo == null ? -3 : lo; hi = hi == null ? 3 : hi;
    for (let k = 0; k < 48; k++) {
      const m = 0.5 * (lo + hi);
      if (this.at(m, phi, th).volume > volume) lo = m; else hi = m;
    }
    return 0.5 * (lo + hi);
  }
}
