// Линейная часть полного уравнения: ленточная ткань и отдельный глобальный конец планки.
export function bandFactor(matrix, n, band) {
  const stride = band + 1, L = matrix.slice();
  for (let i = 0; i < n; i++) for (let j = Math.max(0, i - band); j <= i; j++) {
    let sum = L[i * stride + i - j];
    for (let k = Math.max(0, i - band); k < j; k++)
      sum -= L[i * stride + i - k] * L[j * stride + j - k];
    if (i === j) {
      if (!(sum > 0 && Number.isFinite(sum))) throw new Error('Матрица направления не положительна или связи зависимы');
      L[i * stride] = Math.sqrt(sum);
    } else L[i * stride + i - j] = sum / L[j * stride];
  }
  return rhs => {
    const x = Float64Array.from(rhs);
    for (let i = 0; i < n; i++) {
      for (let j = Math.max(0, i - band); j < i; j++) x[i] -= L[i * stride + i - j] * x[j];
      x[i] /= L[i * stride];
    }
    for (let i = n - 1; i >= 0; i--) {
      for (let j = i + 1; j <= Math.min(n - 1, i + band); j++) x[i] -= L[j * stride + j - i] * x[j];
      x[i] /= L[i * stride];
    }
    return x;
  };
}


// [A B; Bᵀ D]. A ленточная; малый D содержит координаты конца общей планки.
// Блоки исключаются точно, без замены жёсткости или отбрасывания связей.
export function borderedBandFactor(matrix, coupling, border, n, band, size) {
  const coreSolve = bandFactor(matrix, n, band);
  const responses = Array.from({ length: size }, (_, a) => coreSolve(
    Float64Array.from({ length: n }, (_, i) => coupling[i * size + a])));
  const schur = border.slice();
  for (let a = 0; a < size; a++) for (let b = 0; b <= a; b++)
    for (let i = 0; i < n; i++) schur[a * size + a - b] -= coupling[i * size + a] * responses[b][i];
  const borderSolve = bandFactor(schur, size, Math.max(0, size - 1));
  return rhs => {
    const x = coreSolve(rhs.slice(0, n)), reduced = Float64Array.from(rhs.slice(n));
    for (let a = 0; a < size; a++) for (let i = 0; i < n; i++) reduced[a] -= coupling[i * size + a] * x[i];
    const end = borderSolve(reduced), result = new Float64Array(n + size);
    for (let i = 0; i < n; i++) {
      let v = x[i]; for (let a = 0; a < size; a++) v -= responses[a][i] * end[a];
      result[i] = v;
    }
    result.set(end, n); return result;
  };
}
