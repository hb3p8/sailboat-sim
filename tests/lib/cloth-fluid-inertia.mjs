// Обобщённая инерция в связанных правых осях, начало — ЦТ сухого тела.
// Вода хранится отдельной матрицей энергии и не становится весом.
export const cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const dotN=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0);
export const matrixVector=(m,v)=>Array.from({length:v.length},(_,d)=>dotN(m.slice(d*v.length,(d+1)*v.length),v));
export const rotate3=(m,v)=>matrixVector(m,v);
export const transpose3=m=>[0,3,6,1,4,7,2,5,8].map(i=>m[i]);
export const product3=(a,b)=>Array.from({length:9},(_,i)=>[0,1,2].reduce((s,k)=>s+a[3*Math.floor(i/3)+k]*b[3*k+i%3],0));
export const finiteArray=(a,n)=>a?.length===n&&Array.from(a).every(Number.isFinite);

export function checkRotation(r) {
  if(!finiteArray(r,9))throw new Error('Нужен конечный поворот');
  const cols=[0,1,2].map(d=>[r[d],r[3+d],r[6+d]]);
  if(cols.some((a,i)=>cols.some((b,j)=>Math.abs(dotN(a,b)-(i===j?1:0))>256*Number.EPSILON))||
      Math.abs(dotN(cols[0],cross3(cols[1],cols[2]))-1)>256*Number.EPSILON)
    throw new Error('Поворот должен сохранять длины и ориентацию');
}

function positiveMatrix(m,n,semidefinite) {
  const L=new Float64Array(n*n),scale=Math.max(...m.map(Math.abs)),roundoff=128*Number.EPSILON*Math.max(1,scale);
  for(let i=0;i<n;i++)for(let j=0;j<=i;j++) {
    if(Math.abs(m[i*n+j]-m[j*n+i])>roundoff)throw new Error('Инерция должна быть симметричной');
    let v=m[i*n+j];for(let k=0;k<j;k++)v-=L[i*n+k]*L[j*n+k];
    if(i===j) {
      if(semidefinite?v < -roundoff:v<=0)throw new Error('Инерция должна задавать неотрицательную энергию');
      L[i*n+i]=Math.sqrt(Math.max(0,v));
    } else if(L[j*n+j]>0)L[i*n+j]=v/L[j*n+j];
    else if(Math.abs(v)>roundoff)throw new Error('Смешанная инерция при нулевой диагонали');
  }
}

export function fluidInertia({dryMassKg,dryPrincipalInertiaKgM2,addedMass6=new Array(36).fill(0)}) {
  const I=Array.from(dryPrincipalInertiaKgM2??[]),A=Array.from(addedMass6);
  if(!(Number.isFinite(dryMassKg)&&dryMassKg>0)||!finiteArray(I,3)||I.some(v=>v<=0)||
      I.some((v,d)=>v>I[(d+1)%3]+I[(d+2)%3])||!finiteArray(A,36))
    throw new Error('Некорректная сухая масса, физическая инерция или водная матрица');
  const referenceLengthM=Math.sqrt(I.reduce((s,v)=>s+v,0)/(2*dryMassKg));
  const coordinateScale=[1,1,1,1/referenceLengthM,1/referenceLengthM,1/referenceLengthM];
  const scaled=m=>m.map((v,i)=>v*coordinateScale[Math.floor(i/6)]*coordinateScale[i%6]);
  positiveMatrix(scaled(A),6,true);
  const M=A.slice(),dryDiagonal=[dryMassKg,dryMassKg,dryMassKg,...I];
  dryDiagonal.forEach((v,d)=>{M[7*d]+=v;});positiveMatrix(scaled(M),6,false);
  const frozenM=Object.freeze(M),frozenA=Object.freeze(A);
  return Object.freeze({dryMassKg,dryPrincipalInertiaKgM2:Object.freeze(I),referenceLengthM,
    matrix6:frozenM,addedMass6:frozenA,
    momentum(velocity6) {
      if(!finiteArray(velocity6,6))throw new Error('Нужны шесть конечных скоростей');
      return matrixVector(frozenM,velocity6);
    },
    kineticJ(velocity6) {return .5*dotN(velocity6,this.momentum(velocity6));},
    convective(velocity6) {
      const p=this.momentum(velocity6),v=velocity6.slice(0,3),w=velocity6.slice(3);
      const spin=cross3(w,p.slice(3)),translation=cross3(v,p.slice(0,3));
      return [...cross3(w,p.slice(0,3)),...spin.map((x,d)=>x+translation[d])];
    }
  });
}

// Конечное вращение Кэли. R+−R− = h Rbar S(omega+) ровно,
// что связывает перемещение крепления с обобщённой работой одного шага.
export function cayleyBodyPose(originM,orientation9,velocity6,hS) {
  const u=velocity6.slice(3).map(v=>v*hS),S=[0,-u[2],u[1],u[2],0,-u[0],-u[1],u[0],0];
  const SS=product3(S,S),denominator=1+dotN(u,u)/4;
  const increment=S.map((v,i)=>(i%4===0?1:0)+(v+.5*SS[i])/denominator);
  const rotation=product3(orientation9,increment),average=rotation.map((v,i)=>(v+orientation9[i])/2);
  const displacement=rotate3(average,velocity6.slice(0,3)).map(v=>v*hS);
  return {originM:originM.map((v,d)=>v+displacement[d]),orientation9:rotation,averageRotation9:average};
}

// Малый несимметричный Newton-блок проверочного расчёта, с выбором опоры.
// Его стоимость не выдается за производительность браузерной ткани.
export function denseSolve(matrix,rhs) {
  const n=rhs.length,a=Float64Array.from(matrix),b=Float64Array.from(rhs);
  for(let j=0;j<n;j++) {
    let pivot=j;for(let i=j+1;i<n;i++)if(Math.abs(a[i*n+j])>Math.abs(a[pivot*n+j]))pivot=i;
    if(!(Number.isFinite(a[pivot*n+j])&&Math.abs(a[pivot*n+j])>0))throw new Error('Вырожденное общее уравнение');
    if(pivot!==j) {for(let k=j;k<n;k++)[a[j*n+k],a[pivot*n+k]]=[a[pivot*n+k],a[j*n+k]];[b[j],b[pivot]]=[b[pivot],b[j]];}
    for(let i=j+1;i<n;i++) {
      const ratio=a[i*n+j]/a[j*n+j];
      for(let k=j+1;k<n;k++)a[i*n+k]-=ratio*a[j*n+k];b[i]-=ratio*b[j];
    }
  }
  const x=new Float64Array(n);
  for(let j=n-1;j>=0;j--) {let v=b[j];for(let k=j+1;k<n;k++)v-=a[j*n+k]*x[k];x[j]=v/a[j*n+j];}
  if(!x.every(Number.isFinite))throw new Error('Переполнение общего решения');
  return x;
}
