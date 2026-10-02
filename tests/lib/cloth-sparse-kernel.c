// Разреженное разложение Холецкого и совместное решение правых частей.
// SIMD распределён по независимым ответам; порядок сумм каждой координаты сохранён.
#include <wasm_simd128.h>
#define EXPORTED __attribute__((visibility("default")))

// Совместная система ткани и ограничений: A=L D Lᵀ. Отрицательные
// диагонали множителей ожидаемы; нулевой/нечисловой или неверный знак — отказ.
EXPORTED int sparse_ldl_factor(double *L, double *work, int n,
    const int *rp, const int *col, const int *cp, const int *cr, const int *ce,
    const int *signs) {
  for (int i = 0; i < n; i++) {
    int end = rp[i + 1] - 1;
    for (int a = rp[i]; a <= end; a++) work[col[a]] = L[a];
    for (int a = rp[i]; a < end; a++) {
      int j = col[a]; double D = L[rp[j + 1] - 1], v = work[j] / D; L[a] = v;
      double scaled = v * D;
      for (int b = cp[j]; b < cp[j + 1] && cr[b] < i; b++) work[cr[b]] -= scaled * L[ce[b]];
      work[i] -= v * v * D;
    }
    if (!(work[i] * signs[i] > 0 && __builtin_isfinite(work[i]))) return i + 1;
    L[end] = work[i];
  }
  return 0;
}

EXPORTED int sparse_factor(double *L, double *work, int n,
    const int *rp, const int *col, const int *cp, const int *cr, const int *ce) {
  for (int i = 0; i < n; i++) {
    int end = rp[i + 1] - 1;
    for (int a = rp[i]; a <= end; a++) work[col[a]] = L[a];
    for (int a = rp[i]; a < end; a++) {
      int j = col[a]; double v = work[j] / L[rp[j + 1] - 1]; L[a] = v;
      for (int b = cp[j]; b < cp[j + 1] && cr[b] < i; b++) work[cr[b]] -= v * L[ce[b]];
      work[i] -= v * v;
    }
    if (!(work[i] > 0 && __builtin_isfinite(work[i]))) return 1;
    L[end] = __builtin_sqrt(work[i]);
  }
  return 0;
}

// x[координата][ответ], ширина чётная; лишняя дорожка заполняется нулями.
EXPORTED void sparse_solve_many(const double *L, double *x, int n, int width,
    const int *rp, const int *col, const int *cp, const int *cr, const int *ce) {
  for (int i = 0; i < n; i++) for (int r = 0; r < width; r += 2) {
    int end = rp[i + 1] - 1; v128_t v = wasm_v128_load(x + i * width + r);
    for (int a = rp[i]; a < end; a++)
      v = wasm_f64x2_sub(v, wasm_f64x2_mul(wasm_f64x2_splat(L[a]), wasm_v128_load(x + col[a] * width + r)));
    wasm_v128_store(x + i * width + r, wasm_f64x2_div(v, wasm_f64x2_splat(L[end])));
  }
  for (int i = n - 1; i >= 0; i--) for (int r = 0; r < width; r += 2) {
    v128_t v = wasm_v128_load(x + i * width + r);
    for (int a = cp[i]; a < cp[i + 1]; a++)
      v = wasm_f64x2_sub(v, wasm_f64x2_mul(wasm_f64x2_splat(L[ce[a]]), wasm_v128_load(x + cr[a] * width + r)));
    wasm_v128_store(x + i * width + r, wasm_f64x2_div(v, wasm_f64x2_splat(L[rp[i + 1] - 1])));
  }
}

EXPORTED void sparse_ldl_solve_many(const double *L, double *x, int n, int width,
    const int *rp, const int *col, const int *cp, const int *cr, const int *ce) {
  for (int i = 0; i < n; i++) for (int r = 0; r < width; r += 2) {
    int end = rp[i + 1] - 1; v128_t v = wasm_v128_load(x + i * width + r);
    for (int a = rp[i]; a < end; a++)
      v = wasm_f64x2_sub(v, wasm_f64x2_mul(wasm_f64x2_splat(L[a]), wasm_v128_load(x + col[a] * width + r)));
    wasm_v128_store(x + i * width + r, v);
  }
  for (int i = 0; i < n; i++) for (int r = 0; r < width; r += 2)
    wasm_v128_store(x + i * width + r, wasm_f64x2_div(wasm_v128_load(x + i * width + r), wasm_f64x2_splat(L[rp[i + 1] - 1])));
  for (int i = n - 1; i >= 0; i--) for (int r = 0; r < width; r += 2) {
    v128_t v = wasm_v128_load(x + i * width + r);
    for (int a = cp[i]; a < cp[i + 1]; a++)
      v = wasm_f64x2_sub(v, wasm_f64x2_mul(wasm_f64x2_splat(L[ce[a]]), wasm_v128_load(x + cr[a] * width + r)));
    wasm_v128_store(x + i * width + r, v);
  }
}
