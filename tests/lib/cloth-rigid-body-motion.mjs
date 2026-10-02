// Проверочный общий расчёт свободного тела и ткани в физических координатах.
// Четыре массы задают инерцию тела; связи не добавляют скрытой жёсткости.
import {ImplicitEnergyMotion} from './cloth-implicit-motion.mjs';
import {distance} from '../cloth-compliance.mjs';
const point=(p,i)=>Array.from(p.slice(3*i,3*i+3));
const sub=(a,b)=>a.map((v,d)=>v-b[d]);
const dot=(a,b)=>a.reduce((s,v,d)=>s+v*b[d],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const finiteVector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);

// Инерция задаётся в собственных главных осях, orientation переводит их
// в неподвижные декартовы оси. Ограничение: объёмное тело, строгие неравенства.
export function fourPointBody({massKg,principalInertiaKgM2,originM=[0,0,0],orientation=[1,0,0,0,1,0,0,0,1]}) {
  if (!(Number.isFinite(massKg)&&massKg>0) || !finiteVector(principalInertiaKgM2,3) ||
      !principalInertiaKgM2.every(v=>v>0) || !finiteVector(originM,3) || !finiteVector(orientation,9))
    throw new Error('Некорректная масса, инерция или система координат тела');
  const columns=[0,1,2].map(d=>[orientation[d],orientation[3+d],orientation[6+d]]);
  if (columns.some((a,i)=>columns.some((b,j)=>Math.abs(dot(a,b)-(i===j?1:0))>64*Number.EPSILON)) ||
      Math.abs(dot(columns[0],cross(columns[1],columns[2]))-1)>64*Number.EPSILON)
    throw new Error('Нужен собственный ортогональный поворот тела');
  const [Ix,Iy,Iz]=principalInertiaKgM2;
  const squared=[(-Ix+Iy+Iz)/(2*massKg),(Ix-Iy+Iz)/(2*massKg),(Ix+Iy-Iz)/(2*massKg)];
  if (!squared.every(v=>Number.isFinite(v)&&v>0)) throw new Error('Инерция не задаёт невырожденное объёмное тело');
  const lengths=squared.map(Math.sqrt),signs=[[1,1,1],[-1,-1,1],[1,-1,-1],[-1,1,-1]];
  const positions=signs.flatMap(s=>originM.map((v,d)=>v+s.reduce((sum,sign,j)=>sum+orientation[3*d+j]*sign*lengths[j],0)));
  if (!positions.every(Number.isFinite) || !(massKg/4>0)) throw new Error('Переполнение представления тела');
  return {positionsM:Float64Array.from(positions),massKg:new Float64Array(4).fill(massKg/4)};
}

function tetraFrame(p,nodes) {
  const origin=point(p,nodes[0]),edges=nodes.slice(1).map(i=>sub(point(p,i),origin));
  const determinant=dot(edges[0],cross(edges[1],edges[2]));
  const scale=edges.reduce((s,e)=>s*Math.hypot(...e),1);
  if (!Number.isFinite(determinant)||!Number.isFinite(scale)||Math.abs(determinant)<=64*Number.EPSILON*scale)
    throw new Error('Вырожденное представление свободного тела');
  const inverse=[cross(edges[1],edges[2]),cross(edges[2],edges[0]),cross(edges[0],edges[1])].map(r=>r.map(v=>v/determinant));
  return {origin,edges,inverse,determinant};
}

// Считывание свойств той же четвёрки масс. Момент считается в текущем ЦТ,
// не в прежней точке; скорость из истории не выдаётся за точный угловой поворот.
export function rigidBodyProperties(positions,mass,nodes,previous,dt=0) {
  if(positions?.length!==3*mass?.length||!Array.isArray(nodes)||nodes.length!==4||new Set(nodes).size!==4||
      nodes.some(i=>!Number.isInteger(i)||i<0||i>=mass.length||!Number.isFinite(mass[i])||mass[i]<=0||
        !point(positions,i).every(Number.isFinite))||!Number.isFinite(dt)||dt<0||
      (dt>0&&(previous?.length!==positions.length||nodes.some(i=>!point(previous,i).every(Number.isFinite)))))
    throw new Error('Некорректные данные измерения свободного тела');
  const totalMassKg=nodes.reduce((s,i)=>s+mass[i],0),originM=[0,0,0],velocityMS=[0,0,0];
  for(const i of nodes)for(let d=0;d<3;d++) {
    originM[d]+=mass[i]*positions[3*i+d]/totalMassKg;
    if(dt>0)velocityMS[d]+=mass[i]*(positions[3*i+d]-previous[3*i+d])/(totalMassKg*dt);
  }
  const inertiaKgM2=new Float64Array(9),angularMomentumNms=[0,0,0];
  for(const i of nodes) {
    const r=sub(point(positions,i),originM),r2=dot(r,r);
    for(let d=0;d<3;d++)for(let e=0;e<3;e++)inertiaKgM2[3*d+e]+=mass[i]*((d===e?r2:0)-r[d]*r[e]);
    if(dt>0) {
      const v=[0,1,2].map(d=>mass[i]*((positions[3*i+d]-previous[3*i+d])/dt-velocityMS[d]));
      cross(r,v).forEach((x,d)=>{angularMomentumNms[d]+=x;});
    }
  }
  if(!Number.isFinite(totalMassKg)||![...originM,...velocityMS,...inertiaKgM2,...angularMomentumNms].every(Number.isFinite))
    throw new Error('Переполнение измерения свободного тела');
  return {totalMassKg,originM,velocityMS,inertiaKgM2,angularMomentumNms};
}

function linearCoordinate(node,weights,d,family) {
  return {alpha:0,unilateral:false,family,unit:'м',value(p) {
    const axis=[0,0,0];axis[d]=1;
    return {C:p[3*node+d]-weights.reduce((s,[i,w])=>s+w*p[3*i+d],0),
      grad:[[node,axis],...weights.map(([i,w])=>[i,axis.map(v=>-w*v)])]};
  }};
}

export class RigidBodyEnergyMotion extends ImplicitEnergyMotion {
  constructor(options) {
    const {rigidBody,board,translatingBody,positions,mass,fixed=[]}=options;
    const nodes=rigidBody?.nodes,attachments=rigidBody?.attachments,dampingHz=rigidBody?.dampingHz??0;
    const valid=i=>Number.isInteger(i)&&i>=0&&i<mass?.length;
    if (translatingBody || !Array.isArray(nodes) || nodes.length!==4 || new Set(nodes).size!==4 ||
        nodes.some(i=>!valid(i)||fixed.includes(i)) || !Array.isArray(attachments) ||
        new Set(attachments).size!==attachments.length || attachments.some(i=>!valid(i)||nodes.includes(i)||fixed.includes(i)) ||
        rigidBody.frame!=='inertial-cartesian' || !Number.isFinite(dampingHz)||dampingHz<0 || positions?.length!==3*mass?.length)
      throw new Error('Свободное тело требует четырёх отдельных масс, инерциальных осей и непересекающихся закреплений');
    const initial=tetraFrame(positions,nodes),bindings=attachments.map(node=> {
      const local=sub(point(positions,node),initial.origin),u=initial.inverse.map(row=>dot(row,local));
      const weights=[1-u.reduce((s,v)=>s+v,0),...u];
      if (!weights.every(Number.isFinite))throw new Error('Переполнение закрепления свободного тела');
      return Object.freeze({node,weights:Object.freeze(nodes.map((i,j)=>Object.freeze([i,weights[j]])))});
    });
    const rigidConstraints=[];
    for(let a=0;a<4;a++)for(let b=0;b<a;b++)rigidConstraints.push({...distance(nodes[a],nodes[b],
      Math.hypot(...sub(point(positions,nodes[a]),point(positions,nodes[b]))),0),family:'жёсткое тело'});
    const bindingConstraints=bindings.flatMap(({node,weights})=>[0,1,2].map(d=>linearCoordinate(node,weights,d,'закрепление на свободном теле')));
    const affineConstraints=[];let affineBoard;
    if(board) {
      const {head,end,nodes:bn,fractions}=board;
      if(!attachments.includes(head)||fixed.includes(end)||!Array.isArray(bn)||!Array.isArray(fractions)||bn.length!==fractions.length||
          new Set(bn).size!==bn.length||!bn.includes(head)||!bn.includes(end)||bn.some(i=>!valid(i)||nodes.includes(i)||
            (i!==head&&(attachments.includes(i)||fixed.includes(i))))||
          fractions.some(t=>!Number.isFinite(t)||t<0||t>1)||fractions[bn.indexOf(head)]!==0||fractions[bn.indexOf(end)]!==1)
        throw new Error('Некорректная планка свободного тела');
      affineBoard=Object.freeze({head,end,nodes:Object.freeze(bn.slice()),fractions:Object.freeze(fractions.slice())});
      for(let j=0;j<bn.length;j++)if(bn[j]!==head&&bn[j]!==end)
        for(let d=0;d<3;d++)affineConstraints.push(linearCoordinate(bn[j],[[head,1-fractions[j]],[end,fractions[j]]],d,'аффинная планка свободного тела'));
    }
    super({...options,board:null,translatingBody:null,
      constraints:[...(options.constraints??[]),...rigidConstraints,...affineConstraints,...bindingConstraints]});
    this.rigidBody=Object.freeze({nodes:Object.freeze(nodes.slice()),attachments:Object.freeze(attachments.slice()),
      frame:rigidBody.frame,dampingHz,bindings:Object.freeze(bindings)});
    this.rigidNodes=new Set(nodes);this.affineBoard=affineBoard;
    // Объекты constraints копируются родителем; семейство однозначно не задаёт
    // источник. Храним точный диапазон созданных связей, без поиска по названию.
    const bindStart=this.constraints.length-bindingConstraints.length;
    this.bindingConstraints=this.constraints.slice(bindStart);
    this.geometryConstraints=this.constraints.slice((options.constraints??[]).length);
    this.initialDeterminant=initial.determinant;
    this.referenceFrameInverse=Object.freeze(initial.inverse.map(row=>Object.freeze(row.slice())));
    this.auditNodeBalance=true;
    this.validatePose(this.pos);this.validatePose(this.prev);
    rigidBodyProperties(this.pos,this.mass,this.rigidBody.nodes);
  }

  decayAtNode(i,h,clothDecay) {
    return this.rigidNodes?.has(i)?Math.exp(-this.rigidBody.dampingHz*h):super.decayAtNode(i,h,clothDecay);
  }

  validatePose(p) {
    for(const c of this.geometryConstraints)if(Math.abs(c.value(p).C)>this.lengthToleranceM)
      throw new Error('Форма тела или закрепление изменены вне общего шага');
    const frame=tetraFrame(p,this.rigidBody.nodes);
    if(frame.determinant*this.initialDeterminant<=0)
      throw new Error('Отражённая ориентация свободного тела');
    return frame;
  }

  step(force,h,passes,supportTargets) {
    this.validatePose(this.pos);this.validatePose(this.prev);
    return super.step(force,h,passes,supportTargets??[]);
  }

  advanceStep(force,h,passes,targets,old,prior) {
    const a=super.advanceStep(force,h,passes,targets,old,prior);
    // Отказ здесь попадает в общий возврат родителя, включая историю/множители.
    const frame=this.validatePose(this.pos);
    // Полный остаток уже посчитан общим аудитом. Для реакции закрепления
    // исключаем только его собственную силу, сохраняя инерцию/материал/кромки.
    const raw=a.nodeBalanceResidualN.slice();
    for(const c of this.bindingConstraints)for(const [i,g] of c.value(this.pos).grad)
      for(let d=0;d<3;d++)raw[3*i+d]+=c.lambda/(h*h)*g[d];
    const properties=rigidBodyProperties(this.pos,this.mass,this.rigidBody.nodes,this.prev,h);
    const bodyRotationFromReference=Float64Array.from({length:9},(_,j)=>[0,1,2].reduce((s,k)=>
      s+frame.edges[k][Math.floor(j/3)]*this.referenceFrameInverse[k][j%3],0));
    const bodyAttachmentForceN=new Float64Array(this.pos.length),bodyNodeInterfaceForceN=new Float64Array(this.pos.length);
    const bodyForceN=[0,0,0],bodyMomentNm=[0,0,0];let bodyWorkJ=0,attachmentWorkJ=0;
    for(const {node,weights} of this.rigidBody.bindings) {
      const reaction=point(raw,node);bodyAttachmentForceN.set(reaction,3*node);
      for(let d=0;d<3;d++) {
        bodyForceN[d]-=reaction[d];attachmentWorkJ+=reaction[d]*(this.pos[3*node+d]-old[3*node+d]);
        for(const [i,w] of weights)bodyNodeInterfaceForceN[3*i+d]-=w*reaction[d];
      }
      cross(sub(point(this.pos,node),properties.originM),reaction.map(v=>-v)).forEach((v,d)=>{bodyMomentNm[d]+=v;});
    }
    const bodyNodeBalanceResidualN=new Float64Array(this.pos.length),bodyBalanceResidualN=[0,0,0];
    for(const i of this.rigidBody.nodes)for(let d=0;d<3;d++) {
      const k=3*i+d;bodyWorkJ+=bodyNodeInterfaceForceN[k]*(this.pos[k]-old[k]);
      bodyNodeBalanceResidualN[k]=raw[k]-bodyNodeInterfaceForceN[k];bodyBalanceResidualN[d]+=bodyNodeBalanceResidualN[k];
    }
    return {...a,bodyFrame:this.rigidBody.frame,bodyOriginM:properties.originM,bodyProperties:properties,bodyRotationFromReference,
      bodyAttachmentForceN,bodyNodeInterfaceForceN,bodyForceN,bodyMomentNm,bodyNodeBalanceResidualN,bodyBalanceResidualN,
      bodyWorkJ,attachmentWorkJ,bodyWorkCancellationResidualJ:bodyWorkJ+attachmentWorkJ};
  }
}
