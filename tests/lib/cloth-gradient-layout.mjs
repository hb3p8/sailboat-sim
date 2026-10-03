// Постоянная раскладка градиента: сохраняет порядок сложения повторных узлов.
// Численные значения читаются заново, план не хранит отдельную физику.
export function gradientLayout(grad) {
  const nodes=new Map(),coordinates=[],slots=[];
  for(const [node] of grad) {
    if(!nodes.has(node)) {nodes.set(node,coordinates.length);coordinates.push(3*node,3*node+1,3*node+2);}
    const start=nodes.get(node);slots.push(start,start+1,start+2);
  }
  return {nodes:Int32Array.from(grad,([node])=>node),coordinates:Int32Array.from(coordinates),slots:Int32Array.from(slots)};
}

export function gradientValues(layout,grad,target) {
  if(target.length!==layout.coordinates.length)throw new Error('Неверная длина численных значений градиента');
  let plan=layout;
  if(grad.length!==layout.nodes.length||grad.some(([node],i)=>node!==layout.nodes[i])) {
    // Перестановка повторов разрешена, если канонический порядок узлов прежний.
    // Сложение всё равно следует новому порядку входных слагаемых.
    plan=gradientLayout(grad);
    if(plan.coordinates.length!==layout.coordinates.length||plan.coordinates.some((v,i)=>v!==layout.coordinates[i]))
      throw new Error('Изменился локальный набор узлов градиента');
  }
  target.fill(0);
  for(let i=0;i<grad.length;i++)for(let d=0;d<3;d++)target[plan.slots[3*i+d]]+=grad[i][1][d];
  return target;
}
