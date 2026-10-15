// Явное выделение сухой ткани из оценочного бюджета; воздух/вода не являются весом.
import {integrateDensity} from './cloth-shared-input.mjs';
import {fluidInertia,finiteArray,cross3} from './cloth-fluid-inertia.mjs';

const shiftedPointInertia=(mass,r)=>{
  const rr=r.reduce((s,x)=>s+x*x,0);
  return Array.from({length:9},(_,k)=>mass*((k%4===0?rr:0)-r[Math.floor(k/3)]*r[k%3]));
};

export function shiftAddedInertia(addedMass6,fromOriginM,toOriginM) {
  if(!finiteArray(addedMass6,36)||!finiteArray(fromOriginM,3)||!finiteArray(toOriginM,3))throw new Error('Нужны водная матрица и два начала');
  const r=fromOriginM.map((v,d)=>v-toOriginM[d]),X=new Array(36).fill(0);
  for(let d=0;d<6;d++)X[7*d]=1;
  for(let k=0;k<3;k++) {
    const omega=[0,0,0];omega[k]=1;const v=cross3(omega,r);
    for(let d=0;d<3;d++)X[6*d+k+3]=v[d];
  }
  const AX=Array.from({length:36},(_,k)=>{const i=Math.floor(k/6),j=k%6;let s=0;for(let q=0;q<6;q++)s+=addedMass6[6*i+q]*X[6*q+j];return s;});
  return Array.from({length:36},(_,k)=>{const i=Math.floor(k/6),j=k%6;let s=0;for(let q=0;q<6;q++)s+=X[6*q+i]*AX[6*q+j];return s;});
}

export function sv20SailMass(pack,recipe,{allocation='rig-budget-point-v1'}={}) {
  const m=pack?.mass,g=pack?.environment?.g,n=recipe.rows*recipe.cols;
  if(allocation!=='rig-budget-point-v1'||!m||!finiteArray(m.cg_m,3)||!(g>0)||recipe.mass?.length<n)
    throw new Error('Нужны пакет SV20 и явное выделение ткани из бюджета');
  const rig=m.budget?.find(v=>v.name==='Рангоут и паруса');
  if(!rig||!finiteArray(rig.com_m,3)||!(rig.mass_kg>0))throw new Error('В пакете отсутствует статья рангоута/парусов');
  const field=integrateDensity(recipe.field,recipe.rows,recipe.cols),dryNodalKg=Array.from({length:n},(_,i)=>Math.hypot(...field.slice(16*i+3,16*i+6))/g);
  const drySailKg=dryNodalKg.reduce((s,v)=>s+v,0),airNodalKg=dryNodalKg.map((v,i)=>recipe.mass[i]-v);
  if(dryNodalKg.some(v=>!Number.isFinite(v)||v<0)||airNodalKg.some(v=>!Number.isFinite(v)||v<0)||!(drySailKg>0&&drySailKg<rig.mass_kg&&m.total_kg>drySailKg))
    throw new Error('Сухая ткань должна помещаться в бюджете, воздушная инерция неотрицательна');
  const bodyKg=m.total_kg-drySailKg,removedLever=rig.com_m.map((v,d)=>v-m.cg_m[d]);
  const cgM=m.cg_m.map((v,d)=>v-drySailKg*removedLever[d]/bodyKg);
  const J=[m.ixx_kg_m2,0,0,0,m.iyy_kg_m2,0,0,0,m.izz_kg_m2];
  const removedJ=shiftedPointInertia(drySailKg,removedLever),recenterJ=shiftedPointInertia(bodyKg,cgM.map((v,d)=>v-m.cg_m[d]));
  const dryInertia9=J.map((v,k)=>v-removedJ[k]-recenterJ[k]);
  // Исходные множители Boat: added_roll — полный множитель, остальные — добавка.
  const addedDiagonal=[m.total_kg*m.added_surge,m.total_kg*m.added_sway,m.total_kg*(m.added_heave??1.2),
    m.ixx_kg_m2*(m.added_roll-1),m.iyy_kg_m2*(m.added_pitch??.9),m.izz_kg_m2*m.added_yaw];
  const addedAtPackageCG=Array.from({length:36},(_,k)=>k%7===0?addedDiagonal[k/7]:0);
  const addedMass6=shiftAddedInertia(addedAtPackageCG,m.cg_m,cgM);
  const inertia=fluidInertia({dryMassKg:bodyKg,dryInertia9,addedMass6});
  return {inertia,cgM,dryNodalKg,airNodalKg,audit:{allocation,drySailKg,bodyKg,totalDryKg:bodyKg+drySailKg,
    effectiveClothKg:recipe.mass.slice(0,n).reduce((s,v)=>s+v,0),addedAirKg:airNodalKg.reduce((s,v)=>s+v,0),
    packageCGM:Array.from(m.cg_m),bodyCGM:cgM,removedAtM:Array.from(rig.com_m),removedOwnInertia9:new Array(9).fill(0),
    dryInertia9,addedAtPackageCG,addedMass6,
    source:'Назначенный вес общего поля; AREAL_KG=0.045 кг/м². Ткань выделена точечной долей из оценочной статьи 45 кг, в её ЦТ, без собственной инерции. Это гипотеза учёта, не обмер положения генакера.'}};
}
