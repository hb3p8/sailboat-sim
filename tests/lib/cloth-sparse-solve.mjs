// Точное разреженное разложение той же положительной матрицы направления.
// Структура и перестановка сохраняются; численные коэффициенты пересчитываются.

// Области исключаются раньше разделяющей полосы шириной два узла.
// Изгиб связывает узлы через два шага; три координаты узла остаются рядом.
export function gridDissection(rows, cols, offset, coreDofs) {
  const order = [];
  const emit = (r0, r1, c0, c1) => {
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const j = offset[r * cols + c];
      if (j >= 0 && j < coreDofs) for (let d = 0; d < 3; d++) order.push(j + d);
    }
  };
  const visit = (r0, r1, c0, c1) => {
    const nr = r1 - r0, nc = c1 - c0;
    if (Math.max(nr, nc) <= 6) { emit(r0, r1, c0, c1); return; }
    if (nr >= nc) {
      const middle = r0 + Math.floor((nr - 2) / 2);
      visit(r0, middle, c0, c1); visit(middle + 2, r1, c0, c1);
      emit(middle, middle + 2, c0, c1);
    } else {
      const middle = c0 + Math.floor((nc - 2) / 2);
      visit(r0, r1, c0, middle); visit(r0, r1, middle + 2, c1);
      emit(r0, r1, middle, middle + 2);
    }
  };
  visit(0, rows, 0, cols);
  return Int32Array.from(order);
}

export function sparsePattern(n, groups, order = Int32Array.from({ length: n }, (_, i) => i), edges = []) {
  if (order.length !== n || new Set(order).size !== n || !Array.from(order).every(i => i >= 0 && i < n))
    throw new Error('Некорректная перестановка разреженной матрицы');
  const inverse = new Int32Array(n); order.forEach((i, k) => inverse[i] = k);
  const columns = Array.from({ length: n }, () => new Set());
  for (const g of groups) for (const i of g) for (const j of g) {
    if (i >= n || j >= n) continue;
    const a = inverse[i], b = inverse[j]; if (a > b) columns[b].add(a);
  }
  for (const [i, j] of edges) {
    const a = inverse[i], b = inverse[j]; if (a !== b) columns[Math.min(a, b)].add(Math.max(a, b));
  }
  // Символическое исключение: соседи удаляемой вершины получают все связи.
  const lower = Array.from({ length: n }, (_, i) => [i]), columnRows = [];
  for (let j = 0; j < n; j++) {
    const neighbors = Array.from(columns[j]).sort((a, b) => a - b);
    columnRows.push(neighbors);
    for (const i of neighbors) lower[i].push(j);
    for (let a = 0; a < neighbors.length; a++) for (let b = a + 1; b < neighbors.length; b++)
      columns[neighbors[a]].add(neighbors[b]);
    columns[j] = null;
  }
  const rowPtr = new Int32Array(n + 1), cols = [], locations = [];
  for (let i = 0; i < n; i++) {
    lower[i].sort((a, b) => a - b);
    locations.push(new Map(lower[i].map((j, k) => [j, cols.length + k])));
    cols.push(...lower[i]); rowPtr[i + 1] = cols.length;
  }
  const colPtr = new Int32Array(n + 1), colRows = [], colEntries = [];
  const rowToCol = new Int32Array(cols.length);
  for (let j = 0; j < n; j++) {
    for (const i of columnRows[j]) {
      const entry = locations[i].get(j); rowToCol[entry] = colRows.length;
      colRows.push(i); colEntries.push(entry);
    }
    colPtr[j + 1] = colRows.length;
  }
  return { n, order, inverse, rowPtr, cols: Int32Array.from(cols), colPtr,
    colRows: Int32Array.from(colRows), colEntries: Int32Array.from(colEntries), rowToCol, locations };
}

export function sparseFactor(matrix, p) {
  const { n, rowPtr, cols, colPtr, colRows, colEntries } = p;
  const L = matrix.slice(), work = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const end = rowPtr[i + 1] - 1;
    for (let a = rowPtr[i]; a <= end; a++) work[cols[a]] = L[a];
    for (let a = rowPtr[i]; a < end; a++) {
      const j = cols[a], v = work[j] / L[rowPtr[j + 1] - 1]; L[a] = v;
      for (let b = colPtr[j]; b < colPtr[j + 1] && colRows[b] < i; b++)
        work[colRows[b]] -= v * L[colEntries[b]];
      work[i] -= v * v;
    }
    if (!(work[i] > 0 && Number.isFinite(work[i])))
      throw new Error('Матрица направления не положительна или связи зависимы');
    L[end] = Math.sqrt(work[i]);
  }
  return rhs => {
    const x = Float64Array.from(rhs);
    for (let i = 0; i < n; i++) {
      const end = rowPtr[i + 1] - 1; let v = x[i];
      for (let a = rowPtr[i]; a < end; a++) v -= L[a] * x[cols[a]];
      x[i] = v / L[end];
    }
    for (let i = n - 1; i >= 0; i--) {
      let v = x[i];
      for (let a = colPtr[i]; a < colPtr[i + 1]; a++) v -= L[colEntries[a]] * x[colRows[a]];
      x[i] = v / L[rowPtr[i + 1] - 1];
    }
    return x;
  };
}
