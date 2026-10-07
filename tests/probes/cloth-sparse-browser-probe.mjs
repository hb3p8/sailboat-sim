// Чистые вспомогательные операции аудита; одинаковы в Node и браузерном Worker.
export function requireProbe(condition,message){if(!condition)throw new Error(message);}
export function equalProbe(a,b,path='ответ'){
  if(Object.is(a,b))return;
  if(a&&b&&typeof a==='object'&&typeof b==='object'){
    const keys=Object.keys(a);requireProbe(keys.length===Object.keys(b).length,'Разный состав '+path);
    for(const key of keys){requireProbe(Object.hasOwn(b,key),'Отсутствует '+path+'.'+key);equalProbe(a[key],b[key],path+'.'+key);}return;
  }
  throw new Error('Различие '+path+': '+a+' / '+b);
}
export const serialProbe=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serialProbe):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serialProbe(x)])):v;
export async function shaProbe(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
export async function fetchProbe(part){const response=await fetch('/'+part.path,{cache:'no-store'});requireProbe(response.ok,'Не прочитан '+part.path);
  const bytes=await response.arrayBuffer();requireProbe(await shaProbe(bytes)===part.sha256,'Изменился SHA '+part.path);return bytes;}
export function captureViews(capture,buffer){
  requireProbe(capture.phase==='complete'&&capture.schema==='cloth-sparse-capture-v1'&&capture.binary.endian==='little','Неверный формат захвата');
  requireProbe(buffer.byteLength===capture.binary.byteLength,'Неверная длина захвата');
  requireProbe(new Uint8Array(Uint32Array.of(1).buffer)[0]===1,'Нужен little-endian');
  const view=(description,Type)=>{const {offset,length,byteLength}=description;
    requireProbe(Number.isInteger(offset)&&Number.isInteger(length)&&offset>=0&&length>=0&&offset%Type.BYTES_PER_ELEMENT===0&&
      byteLength===length*Type.BYTES_PER_ELEMENT&&offset+byteLength<=buffer.byteLength,'Неверная граница захвата');
    return new Type(buffer,offset,length);};
  const patterns=capture.patterns.map(p=>({n:p.n,...Object.fromEntries(['rowPtr','cols','colPtr','colRows','colEntries','rowToCol'].map(k=>[k,view(p[k],Int32Array)]))}));
  for(const p of patterns){requireProbe(p.rowPtr.length===p.n+1&&p.colPtr.length===p.n+1&&p.cols.length===p.rowToCol.length&&p.colRows.length===p.colEntries.length,'Неверные размеры структуры');
    for(let i=0;i<p.n;i++)for(let a=p.rowPtr[i];a<p.rowPtr[i+1]-1;a++){
      const j=p.cols[a];let stop=p.colPtr[j];while(stop<p.colPtr[j+1]&&p.colRows[stop]<i)stop++;
      requireProbe(stop===p.rowToCol[a]&&p.colRows[stop]===i,'Граница не совпала со старым поиском');}}
  const samples=capture.samples.map(s=>({...s,matrix:view(s.matrix,Float64Array),signs:view(s.signs,Int32Array)}));
  for(const s of samples){const p=patterns[s.pattern];requireProbe(p&&s.matrix.length===p.cols.length&&s.signs.length===p.n,'Неверные размеры чисел');}
  return {patterns,samples};
}
export function prepareProbeLDL(module,p,now=()=>performance.now()){
  const start=now(),e=new WebAssembly.Instance(module).exports,instantiated=now(),initialBytes=e.memory.buffer.byteLength;
  const planned=typeof e.sparse_ldl_factor_runs==='function';
  requireProbe(!planned||typeof e.sparse_ldl_prepare_runs==='function'&&typeof e.sparse_ldl_runs_abi==='function'&&e.sparse_ldl_runs_abi()===1,'Несовместимый ABI участков');
  let cursor=Number(e.__heap_base.value);
  const allocate=(length,size)=>{cursor=Math.ceil(cursor/8)*8;const at=cursor;cursor+=length*size;return at;};
  const indices=[p.rowPtr,p.cols,p.colPtr,p.colRows,p.colEntries,p.rowToCol],starts=indices.map(a=>allocate(a.length,4)),
    lStart=allocate(p.cols.length,8),workStart=allocate(p.n,8);allocate(0,8);
  const signStart=allocate(p.n,4),columnStart=allocate(p.colRows.length,8),runStart=planned?allocate(p.colRows.length,4):0,outputStart=allocate(0,8),allocated=now();
  const pages=Math.max(0,Math.ceil((outputStart+16*p.n-initialBytes)/65536));if(pages)e.memory.grow(pages);const grown=now();
  indices.forEach((a,i)=>new Int32Array(e.memory.buffer,starts[i],a.length).set(a));const uploaded=now();
  if(planned)e.sparse_ldl_prepare_runs(p.n,starts[2],starts[3],runStart);const prepared=now();
  if(planned){const ends=new Int32Array(e.memory.buffer,runStart,p.colRows.length);
    for(let j=0;j<p.n;j++)for(let b=p.colPtr[j];b<p.colPtr[j+1];b++){
      let end=b+1;while(end<p.colPtr[j+1]&&p.colRows[end]===p.colRows[end-1]+1)end++;
      requireProbe(ends[b]===end,'Неверный конец участка');}}
  const L=new Float64Array(e.memory.buffer,lStart,p.cols.length),work=new Float64Array(e.memory.buffer,workStart,p.n),
    column=new Float64Array(e.memory.buffer,columnStart,p.colRows.length),signs=new Int32Array(e.memory.buffer,signStart,p.n),params=[lStart,workStart,p.n,...starts.slice(0,5),starts[5],columnStart,signStart];
  return {L,work,column,signs,preparation:{planned,initialBytes,finalBytes:e.memory.buffer.byteLength,grownPages:pages,
    instanceMs:instantiated-start,allocationMs:allocated-instantiated,growMs:grown-allocated,uploadMs:uploaded-grown,planMs:prepared-uploaded,
    setupMs:prepared-start,validationMs:now()-prepared},
    run(matrix,inputSigns){const t=now();L.set(matrix);signs.set(inputSigns);const copied=now(),failure=planned?e.sparse_ldl_factor_runs(...params,runStart):e.sparse_ldl_factor(...params),ended=now();
      return {failure,copyMs:copied-t,nativeMs:ended-copied,elapsedMs:ended-t};}};
}
export function compareProbeLDL(a,b){for(const name of ['L','work','column']){requireProbe(a[name].length===b[name].length,'Разная длина '+name);
  for(let i=0;i<a[name].length;i++)requireProbe(Object.is(a[name][i],b[name][i]),'Расходится '+name+'['+i+']');}}
