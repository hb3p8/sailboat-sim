// Отдельная память каждого экземпляра поверхности; постоянные веса копируются
// один раз, вход/выход группы — при вызове. Рабочие представления не выдаются.
export async function loadMaterialKernel(bytes) {
  const module=await WebAssembly.compile(bytes);
  const probe=new WebAssembly.Instance(module),hypot=probe.exports.material_hypot3;
  if(probe.exports.material_abi_version?.()!==3)throw new Error('Несовместимая версия вычислителя материала');
  for(const v of [[0,-0,0],[1,2,3],[1e300,1,1e-300],[3e-200,-4e-200,5e-200]])
    if(!Object.is(hypot(...v),Math.hypot(...v)))throw new Error('Math.hypot текущего движка не совпадает с прототипом');
  return {hypot3:hypot,createSurface() {
    const e=new WebAssembly.Instance(module).exports;let next=Number(e.__heap_base.value),groups=0,calls=0,growths=0;
    const allocate=n=>{const offset=next,end=next+8*n;
      if(end>16*1024*1024)throw new Error('Превышена память прототипа материала');
      if(end>e.memory.buffer.byteLength){e.memory.grow(Math.ceil((end-e.memory.buffer.byteLength)/65536));growths++;}
      next=end;
      return offset;
    };
    return {statistics:()=>({groups,calls,growths,allocatedBytes:next,capacityBytes:e.memory.buffer.byteLength}),compile(descriptor) {
      const {kind,nodes}=descriptor;
      if(!['membrane','curvature'].includes(kind)||!Array.isArray(nodes)||!nodes.length||nodes.length>32||
          nodes.some(i=>!Number.isInteger(i)||i<0)||new Set(nodes).size!==nodes.length)
        throw new Error('Некорректная локальная группа материала');
      const indices=nodes.slice(),n=indices.length;let data,center=0;
      const vector=v=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
      if(kind==='membrane') {
        if(n!==3||!vector(descriptor.bx)||!vector(descriptor.by))throw new Error('Некорректные веса мембраны');
        data=[...descriptor.bx,...descriptor.by];
      } else {
        center=indices.indexOf(descriptor.center);
        const {derivatives,modes}=descriptor;
        if(center<0||!Array.isArray(derivatives)||derivatives.length!==2||!derivatives.every(vector)||
            !Array.isArray(modes)||modes.length!==3||modes.some(m=>!Number.isFinite(m.restCurvature)||
              !Array.isArray(m.weights)||m.weights.length!==3||!m.weights.every(vector)))
          throw new Error('Некорректные веса кривизны');
        data=[...derivatives.flat(),...modes.flatMap(m=>m.weights.flat()),...modes.map(m=>m.restCurvature)];
      }
      const dataOffset=allocate(data.length),inputOffset=allocate(3*n),outputOffset=allocate(3+9*n),weightsOffset=allocate(3);
      new Float64Array(e.memory.buffer,dataOffset,data.length).set(data);groups++;
      let input,output,gradientViews,hessianOffset,hessian,hessianViews;
      const prepareInput=p=>{
        if(!input||input.buffer!==e.memory.buffer){
          input=new Float64Array(e.memory.buffer,inputOffset,3*n);output=new Float64Array(e.memory.buffer,outputOffset,3+9*n);
          gradientViews=[0,1,2].map(j=>output.subarray(3+j*3*n,3+(j+1)*3*n));
        }
        for(let k=0;k<n;k++) {
          const a=3*k,b=3*indices[k];input[a]=p[b];input[a+1]=p[b+1];input[a+2]=p[b+2];
        }
      };
      const execute=(p,requested)=>{
        prepareInput(p);
        calls++;
        const failed=kind==='membrane'?e.material_membrane(inputOffset,dataOffset,outputOffset,requested):
          e.material_curvature(inputOffset,n,center,dataOffset,outputOffset,requested);
        if(failed)throw new Error('Вырожденная нормаль участка кривизны');
      };
      const valid=g=>g instanceof Float64Array&&g.length===3*n;
      const separate=(p,g)=>{
        if(p?.buffer===g.buffer&&p.byteOffset<g.byteOffset+g.byteLength&&g.byteOffset<p.byteOffset+p.byteLength)
          throw new Error('Вход и градиент прототипа материала не должны перекрываться');
      };
      return {hessianInto(p,weights,targets) {
        const size=3*n;
        if(!Array.isArray(weights)||weights.length!==3||!weights.every(Number.isFinite)||!Array.isArray(targets)||targets.length!==3||
            !targets.every(v=>v instanceof Float64Array&&v.length===size*size))throw new Error('Некорректные выходы местной матрицы');
        targets.forEach(g=>separate(p,g));hessianOffset??=allocate(3*size*size);prepareInput(p);
        if(!hessian||hessian.buffer!==e.memory.buffer){hessian=new Float64Array(e.memory.buffer,hessianOffset,3*size*size);hessianViews=[0,1,2].map(j=>hessian.subarray(j*size*size,(j+1)*size*size));}
        new Float64Array(e.memory.buffer,weightsOffset,3).set(weights);calls++;
        if(e.material_hessian(inputOffset,n,center,dataOffset,kind==='curvature'?1:0,weightsOffset,hessianOffset))throw new Error('Вырожденная нормаль участка кривизны');
        for(let j=0;j<3;j++)targets[j].set(hessianViews[j]);
      },valueInto(p,gradients) {
        if(!Array.isArray(gradients)||gradients.length!==3||!gradients.every(valid))throw new Error('Некорректные выходы группы материала');
        gradients.forEach(g=>separate(p,g));execute(p,-1);
        for(let j=0;j<3;j++)gradients[j].set(gradientViews[j]);
        return [output[0],output[1],output[2]];
      },singleInto(p,j,g) {
        if(!Number.isInteger(j)||j<0||j>2||!valid(g))throw new Error('Некорректная мода или выход материала');
        separate(p,g);execute(p,j);g.set(gradientViews[j]);return output[j];
      }};
    }};
  }};
}
