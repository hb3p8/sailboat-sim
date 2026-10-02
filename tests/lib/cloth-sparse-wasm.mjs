// Загрузка явного вычислительного варианта; Node и браузер получают байты извне.
export async function loadSparseFactor(bytes, { reuse = true } = {}) {
  if (typeof reuse !== 'boolean') throw new Error('Повторное использование памяти задаётся логическим значением');
  const module = await WebAssembly.compile(bytes);
  const pools = new WeakMap();
  const counts = { instancesCreated: 0, instancesReused: 0, symbolicUploads: 0, numericFactorizations: 0,
    releases: 0, grownPages: 0 };
  const prepare = (pattern, diagonal) => {
    const instance = new WebAssembly.Instance(module), e = instance.exports;
    counts.instancesCreated++;
    const { n, rowPtr, cols, colPtr, colRows, colEntries, rowToCol } = pattern;
    let cursor = Number(e.__heap_base.value);
    const allocate = (length, size) => { cursor = Math.ceil(cursor / 8) * 8; const start = cursor; cursor += length * size; return start; };
    const indices = [rowPtr, cols, colPtr, colRows, colEntries, rowToCol], starts = indices.map(a => allocate(a.length, 4));
    const baseStarts = starts.slice(0, 5);
    const lStart = allocate(cols.length, 8), workStart = allocate(n, 8), xStart = allocate(0, 8);
    const signStart = diagonal ? allocate(n, 4) : 0;
    const columnStart = diagonal ? allocate(colRows.length, 8) : 0;
    const outputStart = diagonal ? allocate(0, 8) : xStart;
    const grow = end => {
      if (end <= e.memory.buffer.byteLength) return;
      const pages = Math.ceil((end - e.memory.buffer.byteLength) / 65536);
      e.memory.grow(pages); counts.grownPages += pages;
    };
    // Один ответ использует две дорожки SIMD; место готовится до первого решения.
    grow(outputStart + 16 * n);
    indices.forEach((a, i) => new Int32Array(e.memory.buffer, starts[i], a.length).set(a));
    counts.symbolicUploads++;
    return { e, n, lStart, workStart, signStart, columnStart, outputStart, baseStarts, starts, grow };
  };
  const factor = (matrix, pattern, signs) => {
    const diagonal = Boolean(signs);
    if (matrix.length !== pattern.cols.length || (diagonal && signs.length !== pattern.n))
      throw new Error('Неверная длина коэффициентов или знаков диагонали');
    let pool = pools.get(pattern);
    if (!pool) { pool = [[], []]; pools.set(pattern, pool); }
    const free = pool[diagonal ? 1 : 0];
    // pattern — неизменная символьная структура. Только явно освобождённый
    // решатель отдаёт своё место: сохранённые функции никогда не перезаписываются.
    const workspace = reuse && free.length ? free.pop() : prepare(pattern, diagonal);
    if (workspace.releasedBefore) counts.instancesReused++;
    const { e, n, lStart, workStart, signStart, columnStart, outputStart, baseStarts, starts, grow } = workspace;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; counts.releases++;
      workspace.releasedBefore = true;
      // Ограниченный запас не удерживает произвольное число прежних факторов.
      if (reuse && free.length < 2) free.push(workspace);
    };
    new Float64Array(e.memory.buffer, lStart, matrix.length).set(matrix);
    if (signs) new Int32Array(e.memory.buffer, signStart, n).set(signs);
    counts.numericFactorizations++;
    const failure = signs ? e.sparse_ldl_factor(lStart, workStart, n, ...baseStarts, starts[5], columnStart, signStart) : e.sparse_factor(lStart, workStart, n, ...baseStarts);
    if (failure) { release(); throw new Error(`Матрица направления не положительна или связи зависимы: ${failure}`); }
    const many = rightSides => {
      if (released) throw new Error('Решатель явно освобождён');
      if (!rightSides.length) return [];
      if (rightSides.some(a => a.length !== n)) throw new Error('Неверная длина правой части');
      const width = Math.ceil(rightSides.length / 2) * 2;
      grow(outputStart + 8 * n * width);
      const x = new Float64Array(e.memory.buffer, outputStart, n * width); x.fill(0);
      for (let i = 0; i < n; i++) for (let r = 0; r < rightSides.length; r++) x[i * width + r] = rightSides[r][i];
      const run = signs ? e.sparse_ldl_solve_many : e.sparse_solve_many;
      run(lStart, outputStart, n, width, ...baseStarts);
      return rightSides.map((_, r) => Float64Array.from({ length: n }, (_, i) => x[i * width + r]));
    };
    const solve = rhs => many([rhs])[0]; solve.many = many; solve.release = release; return solve;
  };
  factor.ldl = (matrix, pattern, signs) => factor(matrix, pattern, signs);
  factor.statistics = () => ({ ...counts });
  return factor;
}
