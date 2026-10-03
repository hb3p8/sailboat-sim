// Изломы измеряем по координатам, независимо от света и сглаживания нормалей.
import {gridTriangles} from './cloth-material.mjs';

const point=(p,i)=>Array.from(p.slice(3*i,3*i+3));
const sub=(a,b)=>a.map((v,d)=>v-b[d]);
const dot=(a,b)=>a.reduce((v,x,d)=>v+x*b[d],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,dot(a,b)/(Math.hypot(...a)*Math.hypot(...b)))));

export function polylineTurns(points) {
  if(points.length<3||points.some(p=>p.length!==3||!p.every(Number.isFinite)))
    throw new Error('Нужна конечная линия минимум из трёх точек');
  const turns=[];
  for(let i=1;i<points.length-1;i++) {
    const a=sub(points[i],points[i-1]),b=sub(points[i+1],points[i]);
    const leftM=Math.hypot(...a),rightM=Math.hypot(...b);
    if(!(leftM>0&&rightM>0))throw new Error('Нулевая длина участка линии');
    const angleRad=angle(a,b),dualLengthM=(leftM+rightM)/2;
    turns.push({index:i,pointM:points[i],angleDeg:angleRad*180/Math.PI,dualLengthM,
      curvaturePerM:angleRad/dualLengthM});
  }
  return {maximumAngle:turns.reduce((a,b)=>a.angleDeg>=b.angleDeg?a:b),
    maximumCurvature:turns.reduce((a,b)=>a.curvaturePerM>=b.curvaturePerM?a:b),turns};
}

export function surfaceTurns({rows,cols},positions) {
  if(![rows,cols].every(v=>Number.isInteger(v)&&v>=3)||positions.length!==3*rows*cols||
      !Array.from(positions).every(Number.isFinite))throw new Error('Нужна полная конечная поверхность');
  const edges={
    luff:Array.from({length:rows},(_,r)=>r*cols),
    leech:Array.from({length:rows},(_,r)=>r*cols+cols-1),
    foot:Array.from({length:cols},(_,c)=>c)};
  const boundary=Object.fromEntries(Object.entries(edges).map(([name,nodes])=>{
    const turns=polylineTurns(nodes.map(i=>point(positions,i)));
    for(const t of turns.turns)t.node=nodes[t.index];
    return [name,turns];
  }));
  const adjacency=new Map(),triangles=gridTriangles(rows,cols),normals=[];
  let degenerateTriangles=0;
  triangles.forEach((nodes,j)=>{
    const [a,b,c]=nodes.map(i=>point(positions,i)),n=cross(sub(b,a),sub(c,a));
    const length=Math.hypot(...n);
    normals.push(length>0?n.map(v=>v/length):null);
    if(!(length>0))degenerateTriangles++;
    for(let k=0;k<3;k++) {
      const edge=[nodes[k],nodes[(k+1)%3]].sort((a,b)=>a-b),key=edge.join(':');
      const entry=adjacency.get(key)??{nodes:edge,triangles:[]};
      entry.triangles.push(j);adjacency.set(key,entry);
    }
  });
  let maximumDihedral=null;
  for(const edge of adjacency.values())if(edge.triangles.length===2) {
    const [a,b]=edge.triangles.map(j=>normals[j]);if(!a||!b)continue;
    const angleDeg=angle(a,b)*180/Math.PI;
    if(!maximumDihedral||angleDeg>maximumDihedral.angleDeg)maximumDihedral={...edge,angleDeg};
  }
  return {boundary,maximumDihedral,degenerateTriangles};
}
