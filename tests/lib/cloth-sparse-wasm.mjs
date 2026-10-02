// Загрузка явного вычислительного варианта; Node и браузер получают байты извне.
export async function loadSparseFactor(bytes) {
  const module = await WebAssembly.compile(bytes);
  const factor = (matrix, pattern, signs) => {
    const instance = new WebAssembly.Instance(module), e = instance.exports;
    const { n, rowPtr, cols, colPtr, colRows, colEntries } = pattern;
    let cursor = Number(e.__heap_base.value);
    const allocate = (length, size) => { cursor = Math.ceil(cursor / 8) * 8; const start = cursor; cursor += length * size; return start; };
    const indices = [rowPtr, cols, colPtr, colRows, colEntries], starts = indices.map(a => allocate(a.length, 4));
    const lStart = allocate(matrix.length, 8), workStart = allocate(n, 8), xStart = allocate(0, 8);
    const signStart = signs ? allocate(n, 4) : 0;
    const outputStart = signs ? allocate(0, 8) : xStart;
    const grow = end => { if (end > e.memory.buffer.byteLength) e.memory.grow(Math.ceil((end - e.memory.buffer.byteLength) / 65536)); };
    grow(cursor);
    indices.forEach((a, i) => new Int32Array(e.memory.buffer, starts[i], a.length).set(a));
    new Float64Array(e.memory.buffer, lStart, matrix.length).set(matrix);
    if (signs) new Int32Array(e.memory.buffer, signStart, n).set(signs);
    const failure = signs ? e.sparse_ldl_factor(lStart, workStart, n, ...starts, signStart) : e.sparse_factor(lStart, workStart, n, ...starts);
    if (failure) throw new Error(`Матрица направления не положительна или связи зависимы: ${failure}`);
    const many = rightSides => {
      if (!rightSides.length) return [];
      if (rightSides.some(a => a.length !== n)) throw new Error('Неверная длина правой части');
      const width = Math.ceil(rightSides.length / 2) * 2;
      grow(outputStart + 8 * n * width);
      const x = new Float64Array(e.memory.buffer, outputStart, n * width); x.fill(0);
      for (let i = 0; i < n; i++) for (let r = 0; r < rightSides.length; r++) x[i * width + r] = rightSides[r][i];
      const run = signs ? e.sparse_ldl_solve_many : e.sparse_solve_many;
      run(lStart, outputStart, n, width, ...starts);
      return rightSides.map((_, r) => Float64Array.from({ length: n }, (_, i) => x[i * width + r]));
    };
    const solve = rhs => many([rhs])[0]; solve.many = many; return solve;
  };
  factor.ldl = (matrix, pattern, signs) => factor(matrix, pattern, signs);
  return factor;
}
