// Изолированный опыт стоимости той же арифметики; не часть модели лодки.
// Собирать без слияния операций и переассоциации, см. docs/research/cloth-performance.md.
__attribute__((visibility("default"))) int factor(double *L, int n, int band) {
  int stride = band + 1;
  for (int i = 0; i < n; i++) {
    int row = i * stride, start = i > band ? i - band : 0;
    for (int j = start; j <= i; j++) {
      int other = j * stride, entry = row + i - j;
      double sum = L[entry];
      int a = row + i - start, b = other + j - start;
      for (int k = start; k < j; k++, a--, b--) sum -= L[a] * L[b];
      if (i == j) {
        if (!(sum > 0 && __builtin_isfinite(sum))) return 1;
        L[row] = __builtin_sqrt(sum);
      } else L[entry] = sum / L[other];
    }
  }
  return 0;
}

__attribute__((visibility("default"))) void solve(const double *L, double *x, int n, int band) {
  int stride = band + 1;
  for (int i = 0; i < n; i++) {
    int row = i * stride, start = i > band ? i - band : 0;
    double value = x[i]; int entry = row + i - start;
    for (int j = start; j < i; j++, entry--) value -= L[entry] * x[j];
    x[i] = value / L[row];
  }
  for (int i = n - 1; i >= 0; i--) {
    int end = n - 1 < i + band ? n - 1 : i + band;
    double value = x[i]; int entry = (i + 1) * stride + 1;
    for (int j = i + 1; j <= end; j++, entry += stride + 1) value -= L[entry] * x[j];
    x[i] = value / L[i * stride];
  }
}
