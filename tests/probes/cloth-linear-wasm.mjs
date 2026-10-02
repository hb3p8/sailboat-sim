// Изолированная оболочка опыта WASM; к полному парусу не подключена.
export async function loadBandFactor(bytes) {
 const module = await WebAssembly.compile(bytes);
 return function bandFactor(matrix, n, band) {
  const instance = new WebAssembly.Instance(module), e = instance.exports;
  const start = Number(e.__heap_base.value), end = start + 8 * (matrix.length + n);
  if (end > e.memory.buffer.byteLength) e.memory.grow(Math.ceil((end - e.memory.buffer.byteLength) / 65536));
  const L = new Float64Array(e.memory.buffer, start, matrix.length);
  const xStart = start + 8 * matrix.length, x = new Float64Array(e.memory.buffer, xStart, n);
  L.set(matrix);
  if (e.factor(start, n, band)) throw new Error('Матрица направления не положительна или связи зависимы');
  return rhs => {x.set(rhs); e.solve(start, xStart, n, band); return x.slice();};
 };
}
