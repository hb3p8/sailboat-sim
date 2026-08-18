// Био — Савар по рёбрам: та самая петля, в которой живёт 95% цены пелены.
//
// Портируется РОВНО цикл по рёбрам из `FreeWake.field` (sim/vlm.js), и ничего
// больше. Полубесконечные хвосты остаются в JS: их F штук против ne рёбер, цена
// пренебрежима, а всякая перенесённая строка — это строка, где порядок сложения
// можно случайно изменить.
//
// ГЛАВНОЕ СВОЙСТВО, ради которого выбрана именно такая вектеризация.
//
// Вектор идёт ПО ТОЧКАМ, а не по рёбрам. У каждой полосы свой накопитель, рёбра
// обходятся в том же порядке, что в JS, — значит порядок сложения для КАЖДОГО
// выходного числа не меняется. Отсюда следует то, чего обычно от порта не ждут:
// ответ обязан совпасть с JS ПОБИТОВО, а не «в пределах допуска».
//
// Держится это на трёх вещах, и все три обязательны:
//
//   -ffp-contract=off  — иначе clang на ARM сольёт a*b+c в FMA, и результат
//                        станет точнее исходного, то есть ДРУГИМ. В wasm
//                        инструкции FMA нет вовсе, и без этого флага нативная
//                        сборка разошлась бы с wasm;
//   без -ffast-math    — переассоциация тут запрещена;
//   только sqrt        — она правильно округлена и в IEEE, и в JS, и в wasm.
//                        Никаких sin/cos/pow: у них своя libm с последними
//                        разрядами, и вот они бы совпасть не могли.
//
// Проверяется это не рассуждением, а батареей: `tests/kernel.test.mjs` гоняет
// обе реализации на одних данных и требует РАВЕНСТВА, а не близости.
//
// Ветвления `continue` заменены маской. Маска именно обнуляет вклад битовым И,
// а не умножает на ноль: в отброшенной полосе деление на нулевую длину даёт
// бесконечность, и 0·inf вернуло бы NaN.

#include "vec.h"

// e — плотная запись рёбер по восемь чисел: начало (3), вектор до конца (3),
// сила, знаменатель ограничителя. Ровно `FreeWake.pack`.
KEXPORT("field_edges")
void field_edges(const double *e, int ne,
                 const double *qx, const double *qy, const double *qz, int np,
                 double *ox, double *oy, double *oz) {
  for (int j = 0; j < np; j++) { ox[j] = 0.0; oy[j] = 0.0; oz[j] = 0.0; }
  if (ne <= 0) return;

  const f64x2 eps = vsplat(EPS), fourpi = vsplat(FOURPI);
  const int np2 = np & ~1;

  for (int m = 0, k8 = 0; m < ne; m++, k8 += 8) {
    const f64x2 ax = vsplat(e[k8]),     ay = vsplat(e[k8 + 1]), az = vsplat(e[k8 + 2]);
    const f64x2 r0x = vsplat(e[k8 + 3]), r0y = vsplat(e[k8 + 4]), r0z = vsplat(e[k8 + 5]);
    const f64x2 g = vsplat(e[k8 + 6]),  den = vsplat(e[k8 + 7]);

    for (int j = 0; j < np2; j += 2) {
      f64x2 q1 = { qx[j], qx[j + 1] };
      f64x2 q2 = { qy[j], qy[j + 1] };
      f64x2 q3 = { qz[j], qz[j + 1] };

      const f64x2 r1x = q1 - ax, r1y = q2 - ay, r1z = q3 - az;
      const f64x2 r2x = r1x - r0x, r2y = r1y - r0y, r2z = r1z - r0z;

      const f64x2 cx = r1y * r2z - r1z * r2y;
      const f64x2 cy = r1z * r2x - r1x * r2z;
      const f64x2 cz = r1x * r2y - r1y * r2x;
      const f64x2 c2 = cx * cx + cy * cy + cz * cz;

      const f64x2 l1 = vsqrt(r1x * r1x + r1y * r1y + r1z * r1z);
      const f64x2 l2 = vsqrt(r2x * r2x + r2y * r2y + r2z * r2z);

      // Те же три условия, что в JS, и в том же смысле: полоса, не прошедшая
      // хоть одно, не даёт вклада вовсе.
      const i64x2 ok = (c2 >= eps) & (l1 >= eps) & (l2 >= eps);

      const f64x2 fq = (r0x * r1x + r0y * r1y + r0z * r1z) / l1 -
                       (r0x * r2x + r0y * r2y + r0z * r2z) / l2;
      const f64x2 kk = fq / (fourpi * vmax(c2, den));

      // Скобки как в JS: g * (c * kk), а не (g * c) * kk. Порядок умножений
      // виден в последнем разряде.
      const f64x2 vx = vkeep(ok, g * (cx * kk));
      const f64x2 vy = vkeep(ok, g * (cy * kk));
      const f64x2 vz = vkeep(ok, g * (cz * kk));

      ox[j] += vx[0]; ox[j + 1] += vx[1];
      oy[j] += vy[0]; oy[j + 1] += vy[1];
      oz[j] += vz[0]; oz[j + 1] += vz[1];
    }

    // Хвостовая точка при нечётном np — тем же кодом, скаляром.
    for (int j = np2; j < np; j++) {
      const double r1x = qx[j] - e[k8],     r1y = qy[j] - e[k8 + 1], r1z = qz[j] - e[k8 + 2];
      const double r2x = r1x - e[k8 + 3],   r2y = r1y - e[k8 + 4],   r2z = r1z - e[k8 + 5];
      const double cx = r1y * r2z - r1z * r2y;
      const double cy = r1z * r2x - r1x * r2z;
      const double cz = r1x * r2y - r1y * r2x;
      const double c2 = cx * cx + cy * cy + cz * cz;
      if (c2 < EPS) continue;
      const double l1 = __builtin_sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
      const double l2 = __builtin_sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
      if (l1 < EPS || l2 < EPS) continue;
      const double fq = (e[k8 + 3] * r1x + e[k8 + 4] * r1y + e[k8 + 5] * r1z) / l1 -
                        (e[k8 + 3] * r2x + e[k8 + 4] * r2y + e[k8 + 5] * r2z) / l2;
      const double den = e[k8 + 7];
      const double kk = fq / (FOURPI * (c2 > den ? c2 : den));
      const double g = e[k8 + 6];
      ox[j] += g * (cx * kk); oy[j] += g * (cy * kk); oz[j] += g * (cz * kk);
    }
  }
}


// Полубесконечные нити: те же Био — Савар, только второй конец ушёл в
// бесконечность. Запись такая же, по восемь чисел: начало (3), единичное
// направление (3), сила, квадрат ядра.
//
// НЕ ОБНУЛЯЕТ выход, а добавляет к нему: в JS хвосты всегда идут после рёбер и
// складываются в те же массивы. Обнулять здесь значило бы стереть рёбра.
//
// Зеркало от воды кладётся отдельной записью с перевёрнутым z и обратным знаком
// силы — ровно как у конечных рёбер в `pack`. Это не сокращение записи, а
// сохранение ПОРЯДКА: в JS на каждую точку сперва идёт настоящий хвост нити,
// потом её зеркальный, и порядок обхода должен остаться тем же, иначе
// побитового совпадения не будет. Что `x + ((-g)*y)` и `x - (g*y)` равны точно,
// следует из того, что знак в IEEE отдельный от мантиссы.
KEXPORT("tails_at")
void tails_at(const double *t, int nt,
              const double *qx, const double *qy, const double *qz, int np,
              double *ox, double *oy, double *oz) {
  if (nt <= 0) return;
  const f64x2 eps = vsplat(EPS), fourpi = vsplat(FOURPI), one = vsplat(1.0);
  const int np2 = np & ~1;

  for (int m = 0, k8 = 0; m < nt; m++, k8 += 8) {
    const f64x2 ax = vsplat(t[k8]),     ay = vsplat(t[k8 + 1]), az = vsplat(t[k8 + 2]);
    const f64x2 ux = vsplat(t[k8 + 3]), uy = vsplat(t[k8 + 4]), uz = vsplat(t[k8 + 5]);
    const f64x2 g = vsplat(t[k8 + 6]),  rc2 = vsplat(t[k8 + 7]);

    for (int j = 0; j < np2; j += 2) {
      f64x2 p1 = { qx[j], qx[j + 1] };
      f64x2 p2 = { qy[j], qy[j + 1] };
      f64x2 p3 = { qz[j], qz[j + 1] };

      const f64x2 rx = p1 - ax, ry = p2 - ay, rz = p3 - az;
      const f64x2 cx = uy * rz - uz * ry;
      const f64x2 cy = uz * rx - ux * rz;
      const f64x2 cz = ux * ry - uy * rx;
      const f64x2 c2 = cx * cx + cy * cy + cz * cz;
      const f64x2 l = vsqrt(rx * rx + ry * ry + rz * rz);

      const i64x2 ok = (c2 >= eps) & (l >= eps);
      const f64x2 k = (one + (ux * rx + uy * ry + uz * rz) / l) /
                      (fourpi * vmax(c2, rc2));

      const f64x2 vx = vkeep(ok, g * (cx * k));
      const f64x2 vy = vkeep(ok, g * (cy * k));
      const f64x2 vz = vkeep(ok, g * (cz * k));

      ox[j] += vx[0]; ox[j + 1] += vx[1];
      oy[j] += vy[0]; oy[j + 1] += vy[1];
      oz[j] += vz[0]; oz[j + 1] += vz[1];
    }

    for (int j = np2; j < np; j++) {
      const double rx = qx[j] - t[k8], ry = qy[j] - t[k8 + 1], rz = qz[j] - t[k8 + 2];
      const double ux0 = t[k8 + 3], uy0 = t[k8 + 4], uz0 = t[k8 + 5];
      const double cx = uy0 * rz - uz0 * ry;
      const double cy = uz0 * rx - ux0 * rz;
      const double cz = ux0 * ry - uy0 * rx;
      const double c2 = cx * cx + cy * cy + cz * cz;
      const double l = __builtin_sqrt(rx * rx + ry * ry + rz * rz);
      if (c2 < EPS || l < EPS) continue;
      const double rc = t[k8 + 7], g0 = t[k8 + 6];
      const double k = (1.0 + (ux0 * rx + uy0 * ry + uz0 * rz) / l) /
                       (FOURPI * (c2 > rc ? c2 : rc));
      ox[j] += g0 * (cx * k); oy[j] += g0 * (cy * k); oz[j] += g0 * (cz * k);
    }
  }
}

// Бамп-распределитель. Ничего не освобождает нарочно: буферы пелены заводятся
// один раз на жизнь лодки и дальше только переиспользуются, а настоящий
// аллокатор здесь стоил бы больше, чем экономил.
#if defined(__wasm__)
extern unsigned char __heap_base;
static unsigned long bump;

KEXPORT("alloc")
void *kalloc(unsigned long bytes) {
  if (bump == 0) bump = (unsigned long)&__heap_base;
  bump = (bump + 15u) & ~15ul;          // выравнивание под вектор
  void *p = (void *)bump;
  bump += bytes;
  return p;
}

KEXPORT("heap_used")
unsigned long heap_used(void) { return bump; }
#endif
