// Проверка настоящих факторов, включая промежуточные массивы и знак нуля.
// Два экземпляра живут только в аудите, не используются движением/замером шага.
import assert from 'node:assert/strict';
export function compareLDLFactors(baselineModule,candidateModule) {
  const cache=new WeakMap(),counts={matrices:0,factorElements:0,scratchElements:0,patternChecks:0,rejected:0,
    nativeMs:{baseline:0,candidate:0}};
  function prepare(module,p) {
    const e=new WebAssembly.Instance(module).exports;let cursor=Number(e.__heap_base.value);
    const allocate=(length,size)=>{cursor=Math.ceil(cursor/8)*8;const start=cursor;cursor+=length*size;return start;};
    const indices=[p.rowPtr,p.cols,p.colPtr,p.colRows,p.colEntries,p.rowToCol],starts=indices.map(a=>allocate(a.length,4));
    const planned=typeof e.sparse_ldl_factor_runs==='function';
    if(planned)assert.equal(e.sparse_ldl_runs_abi(),1);
    const lStart=allocate(p.cols.length,8),workStart=allocate(p.n,8),columnStart=allocate(p.colRows.length,8),signStart=allocate(p.n,4),runStart=planned?allocate(p.colRows.length,4):0;
    if(cursor>e.memory.buffer.byteLength)e.memory.grow(Math.ceil((cursor-e.memory.buffer.byteLength)/65536));
    indices.forEach((a,i)=>new Int32Array(e.memory.buffer,starts[i],a.length).set(a));
    if(planned) {
      e.sparse_ldl_prepare_runs(p.n,starts[2],starts[3],runStart);
      const ends=new Int32Array(e.memory.buffer,runStart,p.colRows.length);
      for(let j=0;j<p.n;j++)for(let b=p.colPtr[j];b<p.colPtr[j+1];b++) {
        let end=b+1;while(end<p.colPtr[j+1]&&p.colRows[end]===p.colRows[end-1]+1)end++;
        assert.equal(ends[b],end,'Неверный конец непрерывного участка');
      }
    }
    const L=new Float64Array(e.memory.buffer,lStart,p.cols.length),work=new Float64Array(e.memory.buffer,workStart,p.n),
      column=new Float64Array(e.memory.buffer,columnStart,p.colRows.length),signs=new Int32Array(e.memory.buffer,signStart,p.n);
    const params=[lStart,workStart,p.n,...starts.slice(0,5),starts[5],columnStart,signStart];
    return{L,work,column,signs,run:()=>planned?e.sparse_ldl_factor_runs(...params,runStart):e.sparse_ldl_factor(...params)};
  }
  return {compare(matrix,p,signs){
    assert.equal(matrix.length,p.cols.length);assert.equal(signs.length,p.n);
    let pair=cache.get(p);
    if(!pair) {
      // Граница проверяется независимо по старому критерию, один раз на план.
      for(let i=0;i<p.n;i++)for(let a=p.rowPtr[i];a<p.rowPtr[i+1]-1;a++) {
        const j=p.cols[a],stop=p.rowToCol[a];let oldStop=p.colPtr[j];
        while(oldStop<p.colPtr[j+1]&&p.colRows[oldStop]<i)oldStop++;
        assert.equal(stop,oldStop,'Сохранённая граница не совпала со старым обходом');assert.equal(p.colRows[stop],i);
      }
      counts.patternChecks++;pair={baseline:prepare(baselineModule,p),candidate:prepare(candidateModule,p)};cache.set(p,pair);
    }
    const failures={};
    for(const variant of counts.matrices%2?['candidate','baseline']:['baseline','candidate']) {
      const w=pair[variant];w.L.set(matrix);w.signs.set(signs);
      const start=performance.now();failures[variant]=w.run();counts.nativeMs[variant]+=performance.now()-start;
    }
    assert.equal(failures.candidate,failures.baseline,'Изменилось место отказа LDL');
    for(const name of ['L','work','column'])for(let i=0;i<pair.baseline[name].length;i++)
      assert(Object.is(pair.baseline[name][i],pair.candidate[name][i]),`Расходится ${name}[${i}]`);
    counts.matrices++;counts.factorElements+=matrix.length;counts.scratchElements+=p.n+p.colRows.length;
    if(failures.baseline)counts.rejected++;return failures.baseline;
  },statistics:()=>structuredClone(counts)};
}
