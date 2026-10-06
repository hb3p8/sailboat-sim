// Строгая проверка арифметики сборки в исполняющем движке до живого шага.
import {materialSurface,gridTriangles,MODEL_MATERIAL} from '../lib/cloth-material.mjs';
import {gradientLayout,gradientValues} from '../lib/cloth-gradient-layout.mjs';
export function verifyAssemblyKernel(kernel,recipe) {
  if(recipe.rows!==11||recipe.cols!==9||recipe.reference?.length!==297||recipe.positions?.length<297)
    throw new Error('Проверка движка сборки требует прежнюю постановку 11×9');
  const counts={schema:'cloth-assembly-engine-check-v1',abi:1,matrices:0,elements:0,groups:0,pairAdds:0};
  const small=Array.from({length:20},(_,i)=>{const x=i%5*.37,y=Math.floor(i/5)*.31;
    return[x,y,.09*Math.sin(x*1.3)*Math.cos(y*.7)];}).flat();
  for(const shape of [{rows:4,cols:5,reference:small,positions:small.map((v,k)=>v+.02*Math.sin(k*.47))},recipe])
    for(const side of [1,-1]) {
      const mirror=p=>Float64Array.from(p,(v,k)=>k%3===1?side*v:v),ref=mirror(shape.reference),q=mirror(shape.positions.slice(0,ref.length)),
        surface=materialSurface(ref,gridTriangles(shape.rows,shape.cols),MODEL_MATERIAL,{bendingModel:'curvature',rows:shape.rows,cols:shape.cols});
      for(const p of [ref,q]) {
        const soft=surface.constraints.filter(c=>c.alpha>0).map(c=>{
          const {grad}=c.value(p),layout=gradientLayout(grad),values=gradientValues(layout,grad,new Float64Array(layout.coordinates.length));
          return {c,g:Array.from(layout.coordinates,(coordinate,i)=>[coordinate,values[i]])};
        });
        const plans=soft.map(({g})=>{const entries=[];
          for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++) {
            const i=g[a][0],j=g[b][0],hi=Math.max(i,j),lo=Math.min(i,j);entries.push(hi*(hi+1)/2+lo);
          }
          return {coordinates:Int32Array.from(g,([i])=>i),entries:Int32Array.from(entries)};
        });
        const length=p.length*(p.length+1)/2,expected=Float64Array.from({length},(_,i)=>i%7===0?-0:(i%31-15)*.03125),actual=expected.slice();
        kernel.compile(length,plans).assemble(actual,soft);
        for(let k=0;k<soft.length;k++) {
          const {c,g}=soft[k];let entry=0;
          for(let a=0;a<g.length;a++)for(let b=0;b<=a;b++)expected[plans[k].entries[entry++]]+=g[a][1]*g[b][1]/c.alpha;
          counts.pairAdds+=entry;
        }
        for(let i=0;i<length;i++)if(!Object.is(actual[i],expected[i]))throw new Error('Сборка WASM расходится с JS: матрица '+counts.matrices+', элемент '+i);
        counts.matrices++;counts.elements+=length;counts.groups+=soft.length;
      }
    }
  return counts;
}
