// Матрицы влияния решётки: `Lattice.build` из sim/vlm.js.
//
// По профилю это самая дорогая часть шага после пелены — `build` 23% плюс его
// `segment` 10%, то есть половина всего, что осталось в JS.
//
// ВЕКТОР ИДЁТ ПО ПАНЕЛЯМ `j`, и довод о побитовости тот же, что у пелены,
// только по другой оси: элементы `k[i*n+j]` независимы, у каждой полосы своя
// последовательность вкладов в том же порядке, что в скаляре. Значит порядок
// арифметики для каждого элемента матрицы не меняется, и совпадение обязано
// быть точным.
//
// ДВЕ МАТРИЦЫ ЗА ОДИН ПРОХОД. `k` — скос в контрольной точке, `kw` — только от
// сходящей пелены и в СЕРЕДИНЕ присоединённого вихря, где приложена сила по
// Жуковскому. Геометрия панели у них общая, поэтому считать раздельно значило
// бы дважды читать одно и то же.
//
// УСЛОВИЯ МЕНЯЮТСЯ ПО ПОЛОСАМ — `lead[j]`, `trail[j]`, `tw[j] > 0`, `i != j`.
// Вынести их из цикла нельзя, поэтому каждое становится маской. И маскируется
// НЕ слагаемое, а накопитель целиком (`vsel`): в образце стоит
// `if (условие) v += x`, то есть при ложном условии `v` остаётся нетронутым — а
// `v + 0.0` превращает −0.0 в +0.0. На нуле это видно, и сверка на равенство
// такое поймает.

#include "vec.h"

typedef struct { f64x2 x, y, z; } v3;

static inline v3 ld3(const double *p, int j0, int j1) {
  v3 r;
  r.x = (f64x2){ p[j0 * 3],     p[j1 * 3] };
  r.y = (f64x2){ p[j0 * 3 + 1], p[j1 * 3 + 1] };
  r.z = (f64x2){ p[j0 * 3 + 2], p[j1 * 3 + 2] };
  return r;
}

static inline v3 vzero(void) { v3 r; r.x = r.y = r.z = vsplat(0.0); return r; }

static inline v3 vadd(v3 a, v3 b) { v3 r; r.x = a.x + b.x; r.y = a.y + b.y; r.z = a.z + b.z; return r; }
static inline v3 vmul(f64x2 s, v3 a) { v3 r; r.x = s * a.x; r.y = s * a.y; r.z = s * a.z; return r; }
static inline v3 vpick(i64x2 m, v3 a, v3 b) {
  v3 r; r.x = vsel(m, a.x, b.x); r.y = vsel(m, a.y, b.y); r.z = vsel(m, a.z, b.z); return r;
}
static inline f64x2 vdot(v3 a, f64x2 nx, f64x2 ny, f64x2 nz) {
  return a.x * nx + a.y * ny + a.z * nz;
}

// Отрезок вихревой нити P1→P2. Точка одна на все полосы, концы — свои у каждой.
// Форма один в один с `segment` образца, включая ограничитель `rc2 * l0`.
static inline v3 seg(f64x2 px, f64x2 py, f64x2 pz, v3 a, v3 b, f64x2 rc2) {
  const f64x2 r1x = px - a.x, r1y = py - a.y, r1z = pz - a.z;
  const f64x2 r2x = px - b.x, r2y = py - b.y, r2z = pz - b.z;
  const f64x2 cx = r1y * r2z - r1z * r2y;
  const f64x2 cy = r1z * r2x - r1x * r2z;
  const f64x2 cz = r1x * r2y - r1y * r2x;
  const f64x2 c2 = cx * cx + cy * cy + cz * cz;
  const f64x2 l1 = vsqrt(r1x * r1x + r1y * r1y + r1z * r1z);
  const f64x2 l2 = vsqrt(r2x * r2x + r2y * r2y + r2z * r2z);
  const f64x2 eps = vsplat(EPS);
  const i64x2 ok = (c2 >= eps) & (l1 >= eps) & (l2 >= eps);
  const f64x2 r0x = b.x - a.x, r0y = b.y - a.y, r0z = b.z - a.z;
  const f64x2 f = (r0x * r1x + r0y * r1y + r0z * r1z) / l1 -
                  (r0x * r2x + r0y * r2y + r0z * r2z) / l2;
  const f64x2 l0 = r0x * r0x + r0y * r0y + r0z * r0z;
  const f64x2 k = f / (vsplat(FOURPI) * vmax(c2, rc2 * l0));
  v3 o; o.x = vkeep(ok, cx * k); o.y = vkeep(ok, cy * k); o.z = vkeep(ok, cz * k);
  return o;
}

// Полубесконечная нить из A по единичному вектору u.
static inline v3 tl(f64x2 px, f64x2 py, f64x2 pz, v3 a,
                    f64x2 ux, f64x2 uy, f64x2 uz, f64x2 rc2) {
  const f64x2 rx = px - a.x, ry = py - a.y, rz = pz - a.z;
  const f64x2 cx = uy * rz - uz * ry;
  const f64x2 cy = uz * rx - ux * rz;
  const f64x2 cz = ux * ry - uy * rx;
  const f64x2 c2 = cx * cx + cy * cy + cz * cz;
  const f64x2 l = vsqrt(rx * rx + ry * ry + rz * rz);
  const f64x2 eps = vsplat(EPS);
  const i64x2 ok = (c2 >= eps) & (l >= eps);
  const f64x2 k = (vsplat(1.0) + (ux * rx + uy * ry + uz * rz) / l) /
                  (vsplat(FOURPI) * vmax(c2, rc2));
  v3 o; o.x = vkeep(ok, cx * k); o.y = vkeep(ok, cy * k); o.z = vkeep(ok, cz * k);
  return o;
}

struct geo {
  const double *a, *b, *ta, *tb;          // настоящая геометрия панелей, n*3
  const double *ma, *mb, *mta, *mtb;      // она же, отражённая в z = 0
  const double *cpt, *nrm, *mid;          // контрольная точка, нормаль, середина
  const unsigned char *lead, *trail;
  const double *tw;
};

// Один шаг по паре панелей. Вынесен функцией, чтобы нечётный хвост считался ТЕМ
// ЖЕ кодом с j0 = j1 = n−1, а не своей скалярной копией: две копии одной
// формулы — это две формулы, и расходятся они молча.
static inline void pairAt(const struct geo *G, int i, int j0, int j1,
                          f64x2 ux, f64x2 uy, f64x2 uz, f64x2 rc2,
                          int self, int ground, f64x2 *outK, f64x2 *outKw) {
  const f64x2 cix = vsplat(G->cpt[i * 3]), ciy = vsplat(G->cpt[i * 3 + 1]),
              ciz = vsplat(G->cpt[i * 3 + 2]);
  const f64x2 nix = vsplat(G->nrm[i * 3]), niy = vsplat(G->nrm[i * 3 + 1]),
              niz = vsplat(G->nrm[i * 3 + 2]);
  const f64x2 mix = vsplat(G->mid[i * 3]), miy = vsplat(G->mid[i * 3 + 1]),
              miz = vsplat(G->mid[i * 3 + 2]);

  const v3 A = ld3(G->a, j0, j1), B = ld3(G->b, j0, j1);
  const v3 TA = ld3(G->ta, j0, j1), TB = ld3(G->tb, j0, j1);
  const f64x2 twv = { G->tw[j0], G->tw[j1] };

  const i64x2 mLead  = { G->lead[j0] ? -1LL : 0LL,  G->lead[j1] ? -1LL : 0LL };
  const i64x2 mTrail = { G->trail[j0] ? -1LL : 0LL, G->trail[j1] ? -1LL : 0LL };
  const i64x2 mTw = (twv > vsplat(0.0));
  const i64x2 mSelf = self ? (i64x2){ -1LL, -1LL }
                           : (i64x2){ i != j0 ? -1LL : 0LL, i != j1 ? -1LL : 0LL };

  // --- k: скос в контрольной точке ---
  v3 v = vpick(mSelf, seg(cix, ciy, ciz, A, B, rc2), vzero());
  v = vpick(mLead,  vadd(v, seg(cix, ciy, ciz, TA, A, rc2)), v);
  v = vpick(mTrail, vadd(v, seg(cix, ciy, ciz, B, TB, rc2)), v);
  v = vpick(mTw, vadd(v, vmul(twv, tl(cix, ciy, ciz, TB, ux, uy, uz, rc2))), v);
  v = vpick(mTw, vadd(v, vmul(-twv, tl(cix, ciy, ciz, TA, ux, uy, uz, rc2))), v);
  f64x2 kij = vdot(v, nix, niy, niz);

  // --- kw: только продольные отрезки и хвосты, в середине связанного вихря ---
  v3 w = vzero();
  w = vpick(mLead,  vadd(w, seg(mix, miy, miz, TA, A, rc2)), w);
  w = vpick(mTrail, vadd(w, seg(mix, miy, miz, B, TB, rc2)), w);
  w = vpick(mTw, vadd(w, vmul(twv, tl(mix, miy, miz, TB, ux, uy, uz, rc2))), w);
  w = vpick(mTw, vadd(w, vmul(-twv, tl(mix, miy, miz, TA, ux, uy, uz, rc2))), w);
  f64x2 kwij = vdot(w, nix, niy, niz);

  if (ground) {
    const v3 MA = ld3(G->ma, j0, j1), MB = ld3(G->mb, j0, j1);
    const v3 MTA = ld3(G->mta, j0, j1), MTB = ld3(G->mtb, j0, j1);

    // Связанный отрезок зеркала БЕЗУСЛОВЕН: отражение собственной панели лежит
    // в другом месте, и пропускать его нельзя (в образце проверки `i != j`
    // здесь тоже нет).
    v3 z = vadd(vzero(), seg(cix, ciy, ciz, MA, MB, rc2));
    z = vpick(mLead,  vadd(z, seg(cix, ciy, ciz, MTA, MA, rc2)), z);
    z = vpick(mTrail, vadd(z, seg(cix, ciy, ciz, MB, MTB, rc2)), z);
    z = vpick(mTw, vadd(z, vmul(twv, tl(cix, ciy, ciz, MTB, ux, uy, uz, rc2))), z);
    z = vpick(mTw, vadd(z, vmul(-twv, tl(cix, ciy, ciz, MTA, ux, uy, uz, rc2))), z);
    kij = kij - vdot(z, nix, niy, niz);

    v3 zw = vzero();
    zw = vpick(mLead,  vadd(zw, seg(mix, miy, miz, MTA, MA, rc2)), zw);
    zw = vpick(mTrail, vadd(zw, seg(mix, miy, miz, MB, MTB, rc2)), zw);
    zw = vpick(mTw, vadd(zw, vmul(twv, tl(mix, miy, miz, MTB, ux, uy, uz, rc2))), zw);
    zw = vpick(mTw, vadd(zw, vmul(-twv, tl(mix, miy, miz, MTA, ux, uy, uz, rc2))), zw);
    kwij = kwij - vdot(zw, nix, niy, niz);
  }

  *outK = kij;
  *outKw = kwij;
}

KEXPORT("lattice_build")
void lattice_build(const double *a, const double *b, const double *ta, const double *tb,
                   const double *ma, const double *mb, const double *mta, const double *mtb,
                   const double *cpt, const double *nrm, const double *mid,
                   const unsigned char *lead, const unsigned char *trail,
                   const double *tw, int n,
                   double ux, double uy, double uz, double rc2,
                   int self, int ground,
                   double *k, double *kw) {
  struct geo G = { a, b, ta, tb, ma, mb, mta, mtb, cpt, nrm, mid, lead, trail, tw };
  const f64x2 vux = vsplat(ux), vuy = vsplat(uy), vuz = vsplat(uz), vrc = vsplat(rc2);
  const int n2 = n & ~1;

  for (int i = 0; i < n; i++) {
    f64x2 kk, kw2;
    for (int j = 0; j < n2; j += 2) {
      pairAt(&G, i, j, j + 1, vux, vuy, vuz, vrc, self, ground, &kk, &kw2);
      k[i * n + j] = kk[0];  k[i * n + j + 1] = kk[1];
      kw[i * n + j] = kw2[0]; kw[i * n + j + 1] = kw2[1];
    }
    if (n2 != n) {
      pairAt(&G, i, n - 1, n - 1, vux, vuy, vuz, vrc, self, ground, &kk, &kw2);
      k[i * n + n - 1] = kk[0];
      kw[i * n + n - 1] = kw2[0];
    }
  }
}

// Бамп-распределитель — свой у каждого модуля: линейные памяти у них разные.
#if defined(__wasm__)
extern unsigned char __heap_base;
static unsigned long bump;

KEXPORT("alloc")
void *kalloc(unsigned long bytes) {
  if (bump == 0) bump = (unsigned long)&__heap_base;
  bump = (bump + 15u) & ~15ul;
  void *p = (void *)bump;
  bump += bytes;
  return p;
}
#endif
