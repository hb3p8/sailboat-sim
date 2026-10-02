// Линейная часть полного уравнения: ленточная ткань и отдельный глобальный конец планки.
export function bandFactor(matrix, n, band) {
  const stride = band + 1, L = matrix.slice();
  for (let i = 0; i < n; i++) {
    const row = i * stride, start = Math.max(0, i - band);
    for (let j = start; j <= i; j++) {
      const otherRow = j * stride, entry = row + i - j;
      let sum = L[entry], a = row + i - start, b = otherRow + j - start;
      for (let k = start; k < j; k++, a--, b--) sum -= L[a] * L[b];
      if (i === j) {
        if (!(sum > 0 && Number.isFinite(sum))) throw new Error('Матрица направления не положительна или связи зависимы');
        L[row] = Math.sqrt(sum);
      } else L[entry] = sum / L[otherRow];
    }
  }
  return rhs => {
    const x = Float64Array.from(rhs);
    for (let i = 0; i < n; i++) {
      const row = i * stride, start = Math.max(0, i - band);
      let value = x[i], entry = row + i - start;
      for (let j = start; j < i; j++, entry--) value -= L[entry] * x[j];
      x[i] = value / L[row];
    }
    for (let i = n - 1; i >= 0; i--) {
      const end = Math.min(n - 1, i + band);
      let value = x[i], entry = (i + 1) * stride + 1;
      for (let j = i + 1; j <= end; j++, entry += stride + 1) value -= L[entry] * x[j];
      x[i] = value / L[i * stride];
    }
    return x;
  };
}


// [A B; Bᵀ D]. A ленточная; малый D содержит координаты конца общей планки.
// Блоки исключаются точно, без замены жёсткости или отбрасывания связей.
export function borderedBandFactor(matrix, coupling, border, n, band, size, coreFactor = bandFactor) {
  const coreSolve = coreFactor(matrix, n, band);
  const borderRightSides = Array.from({ length: size }, (_, a) =>
    Float64Array.from({ length: n }, (_, i) => coupling[i * size + a]));
  const responses = coreSolve.many ? coreSolve.many(borderRightSides) : borderRightSides.map(coreSolve);
  const schur = border.slice();
  for (let a = 0; a < size; a++) for (let b = 0; b <= a; b++)
    for (let i = 0; i < n; i++) schur[a * size + a - b] -= coupling[i * size + a] * responses[b][i];
  const borderSolve = bandFactor(schur, size, Math.max(0, size - 1));
  const finish = (rhs, x) => {
    const reduced = Float64Array.from(rhs.slice(n));
    for (let a = 0; a < size; a++) for (let i = 0; i < n; i++) reduced[a] -= coupling[i * size + a] * x[i];
    const end = borderSolve(reduced), result = new Float64Array(n + size);
    for (let i = 0; i < n; i++) {
      let v = x[i]; for (let a = 0; a < size; a++) v -= responses[a][i] * end[a];
      result[i] = v;
    }
    result.set(end, n); return result;
  };
  const solve = rhs => finish(rhs, coreSolve(rhs.slice(0, n)));
  if (coreSolve.many) solve.many = rightSides => {
    const solved = coreSolve.many(rightSides.map(rhs => rhs.slice(0, n)));
    return rightSides.map((rhs, i) => finish(rhs, solved[i]));
  };
  return solve;
}
