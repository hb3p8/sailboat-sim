// Проверка округления в исполняющем движке до создания живого расчёта.
// Сравнение с JS дополняет известные проверки закона; физические пороги не меняет.
import {materialSurface,gridTriangles,MODEL_MATERIAL} from '../lib/cloth-material.mjs';
export function verifyMaterialKernel(kernel,recipe) {
  if(recipe.rows!==11||recipe.cols!==9||recipe.reference?.length!==297||recipe.positions?.length<297)
    throw new Error('Проверка движка материала требует прежнюю постановку 11×9');
  const counts={schema:'cloth-material-engine-check-v1',values:0,gradientComponents:0,hessianComponents:0,hypotCases:0};
  const same=(a,b,name)=>{if(!Object.is(a,b))throw new Error('Материал WASM расходится с JS: '+name);};
  const vector=(a,b,name)=>{if(a.length!==b.length)throw new Error('Неверная длина проверки материала');
    for(let k=0;k<a.length;k++)same(a[k],b[k],name+' '+k);};
  for(let i=0;i<2048;i++) {
    const scale=10**(i%601-300),v=[scale*Math.sin(i*.47),scale*Math.cos(i*.19),scale*Math.sin(i*.31)];
    same(kernel.hypot3(...v),Math.hypot(...v),'длина '+i);counts.hypotCases++;
  }
  for(const v of [[0,0,-0],[Infinity,NaN,0],[NaN,0,1],[Number.MIN_VALUE,-Number.MIN_VALUE,0],[1e308,-1e308,0]]) {
    same(kernel.hypot3(...v),Math.hypot(...v),'особая длина');counts.hypotCases++;
  }
  const small=Array.from({length:20},(_,i)=>{const x=i%5*.37,y=Math.floor(i/5)*.31;
    return[x,y,.09*Math.sin(x*1.3)*Math.cos(y*.7)];}).flat();
  for(const shape of [{rows:4,cols:5,reference:small,positions:small.map((v,k)=>v+.02*Math.sin(k*.47))},recipe])
    for(const side of [1,-1]) {
      const mirror=p=>Float64Array.from(p,(v,k)=>k%3===1?side*v:v),ref=mirror(shape.reference),q=mirror(shape.positions.slice(0,ref.length)),
        options={bendingModel:'curvature',rows:shape.rows,cols:shape.cols},triangles=gridTriangles(shape.rows,shape.cols),
        js=materialSurface(ref,triangles,MODEL_MATERIAL,options),native=materialSurface(ref,triangles,MODEL_MATERIAL,{...options,materialKernel:kernel});
      for(const p of [ref,q])for(let j=0;j<js.constraints.length;j++) {
        const a=js.constraints[j],b=native.constraints[j],size=3*a.gradientNodes.length,ga=new Float64Array(size),gb=new Float64Array(size);
        same(b.valueInto(p,gb),a.valueInto(p,ga),'значение');counts.values++;
        vector(gb,ga,'градиент');counts.gradientComponents+=size;
        if(a.gradientSlot!==0)continue;
        const modes=js.constraints.slice(j,j+3),weights=modes.map(c=>1/c.alpha),
          expected=weights.map(()=>new Float64Array(size*size)),actual=weights.map(()=>new Float64Array(size*size)),
          gp=weights.map(()=>new Float64Array(size)),gm=weights.map(()=>new Float64Array(size)),plus=p.slice(),minus=p.slice();
        const groupGradients=weights.map(()=>new Float64Array(size)),C=b.gradientGroup.valueInto(p,groupGradients);
        for(let m=0;m<3;m++) {
          const g=new Float64Array(size);same(C[m],modes[m].valueInto(p,g),'значение группы');counts.values++;
          vector(groupGradients[m],g,'градиент группы');counts.gradientComponents+=size;
        }
        for(let column=0;column<size;column++) {
          const coordinate=3*a.gradientNodes[Math.floor(column/3)]+column%3,delta=2e-6*Math.max(1,Math.abs(p[coordinate]));
          plus[coordinate]+=delta;minus[coordinate]-=delta;
          const Cp=a.gradientGroup.valueInto(plus,gp),Cm=a.gradientGroup.valueInto(minus,gm);
          for(let mode=0;mode<3;mode++)for(let row=0;row<size;row++)expected[mode][row*size+column]=
            weights[mode]*(Cp[mode]*(0+gp[mode][row])-Cm[mode]*(0+gm[mode][row]))/(2*delta);
          plus[coordinate]=p[coordinate];minus[coordinate]=p[coordinate];
        }
        b.gradientGroup.hessianInto(p,weights,actual);
        for(let m=0;m<3;m++){vector(actual[m],expected[m],'местная матрица');counts.hessianComponents+=size*size;}
      }
    }
  return counts;
}
