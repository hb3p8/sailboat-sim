// Каждый скомпилированный план имеет собственную память и копии индексов.
// Наружу не передаются представления WASM; результат публикуется целиком.
export async function loadAssemblyKernel(bytes) {
 const module=await WebAssembly.compile(bytes),probe=new WebAssembly.Instance(module);
 if(probe.exports.assembly_abi_version?.()!==1||typeof probe.exports.assemble_soft!=='function')
  throw new Error('Несовместимая версия сборщика матрицы');
 return {compile(matrixLength,plans) {
  if(!Number.isInteger(matrixLength)||matrixLength<0||matrixLength>1e6||!Array.isArray(plans))throw new Error('Некорректный план матрицы');
  const sizes=[],indices=[];
  for(const plan of plans) {
   const size=plan.coordinates?.length,entries=plan.entries;
   if(!Number.isInteger(size)||size<0||size>96||!(entries instanceof Int32Array)||entries.length!==size*(size+1)/2||
     entries.some(i=>i<0||i>=matrixLength)||new Set(entries).size!==entries.length)
    throw new Error('Неверные или повторные места локального вклада');
   sizes.push(size);indices.push(...entries);
  }
  const count=sizes.length,valuesCount=sizes.reduce((sum,v)=>sum+v,0),e=new WebAssembly.Instance(module).exports;
  let next=Number(e.__heap_base.value);
  const allocate=(length,alignment)=>{next=Math.ceil(next/alignment)*alignment;const begin=next;next+=length*alignment;return begin;};
  const sizesAt=allocate(count,4),entriesAt=allocate(indices.length,4),valuesAt=allocate(valuesCount,8),alphasAt=allocate(count,8),matrixAt=allocate(matrixLength,8);
  if(next>16*1024*1024)throw new Error('Превышена память прототипа сборки');
  if(next>e.memory.buffer.byteLength)e.memory.grow(Math.ceil((next-e.memory.buffer.byteLength)/65536));
  new Int32Array(e.memory.buffer,sizesAt,count).set(sizes);new Int32Array(e.memory.buffer,entriesAt,indices.length).set(indices);
  const values=new Float64Array(e.memory.buffer,valuesAt,valuesCount),alphas=new Float64Array(e.memory.buffer,alphasAt,count),matrixCopy=new Float64Array(e.memory.buffer,matrixAt,matrixLength);
  let calls=0;
  return {statistics:()=>({groups:count,values:valuesCount,pairAdds:indices.length,matrixLength,allocatedBytes:next,calls}),assemble(matrix,soft) {
   if(!(matrix instanceof Float64Array)||matrix.length!==matrixLength||!Array.isArray(soft)||soft.length!==count)
    throw new Error('Неверный вход сборки');
   let offset=0;
   for(let k=0;k<count;k++) {
    const g=soft[k]?.g,alpha=soft[k]?.c?.alpha;
    if(!Array.isArray(g)||g.length!==sizes[k]||!Number.isFinite(alpha)||!(alpha>0))throw new Error('Некорректный градиент/податливость');
    alphas[k]=alpha;
    for(let j=0;j<g.length;j++) {
     const v=g[j]?.[1];if(!Number.isFinite(v))throw new Error('Неконечный градиент');values[offset++]=v;
    }
   }
   matrixCopy.set(matrix);e.assemble_soft(count,sizesAt,entriesAt,valuesAt,alphasAt,matrixAt);matrix.set(matrixCopy);calls++;
  }};
 }};
}
