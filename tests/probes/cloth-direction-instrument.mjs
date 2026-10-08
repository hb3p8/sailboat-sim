// Только таймеры в отдельной копии. Порядок операций модели не изменяется.
import assert from 'node:assert/strict';
export function instrumentDirection(original,{correction=false}={}) {
  assert.equal(typeof correction,'boolean');
  let code=original;
  const insert=(marker,text)=>{assert.equal(code.split(marker).length,2,'Граница направления должна быть единственной');code=code.replace(marker,text+marker);};
  insert('  const nc=m.pos.length',`  const kind=exact?'correction':'ordinary';let mark=performance.now();
  const checkpoint=name=>{const now=performance.now(),row=directionPhases[kind][name];row.calls++;row.ms+=now-mark;mark=now;};
`);
  insert('  for(let i=0;i<nc;i++)add(i,i',`  if(!directionWork[kind])directionWork[kind]={matrixEntries:matrix.length,softConstraints:soft.length,
    gradientValues:soft.reduce((sum,t)=>sum+t.g.length,0),pairAdds:soft.reduce((sum,t)=>sum+t.g.length*(t.g.length+1)/2,0)};
  checkpoint('prepare');
`);
  insert('  const activeSet=new Set(active)',"  checkpoint('clothMatrix');\n");
  insert('  // Шесть производных скоростей:',"  checkpoint('constraints');\n");
  insert('  // Порядок координат задан',"  checkpoint('bodyCoupling');\n");
  insert('  // Начальное +0 и последовательность',"  checkpoint('linear');\n");
  insert('\n  return result;\n}',"\n  checkpoint('finish');");
  if(correction) {
    const replace=(before,after)=>{assert.equal(code.split(before).length,2,'Граница корректора должна быть единственной');code=code.replace(before,after);};
    replace('    const assemble=({g,plan})=>{','    const assemble=({g,plan})=>{\n      const scatterStart=performance.now();');
    replace('matrix[plan.entries[entry++]]+=.5*(H[a*size+b]+H[b*size+a]);',
      "matrix[plan.entries[entry++]]+=.5*(H[a*size+b]+H[b*size+a]);\n      correctionDetail.scatter.calls++;correctionDetail.scatter.ms+=performance.now()-scatterStart;");
    replace('          group.hessianInto(s.q,block.map(t=>t.weight),block.map(t=>t.plan.hessian));',
      '          const localStart=performance.now();\n          group.hessianInto(s.q,block.map(t=>t.weight),block.map(t=>t.plan.hessian));\n          correctionDetail.local.calls++;correctionDetail.local.ms+=performance.now()-localStart;');
    code="const correctionDetail={local:{calls:0,ms:0},scatter:{calls:0,ms:0}};\nexport const correctionProfile=()=>structuredClone(correctionDetail);\n"+code;
  }
  return `const phaseNames=['prepare','clothMatrix','constraints','bodyCoupling','linear','finish'];
const directionPhases=Object.fromEntries(['ordinary','correction'].map(k=>[k,Object.fromEntries(phaseNames.map(p=>[p,{calls:0,ms:0}]))]));
const directionWork={};
export const directionProfile=()=>({work:structuredClone(directionWork),phases:structuredClone(directionPhases)});
`+code;
}
export function instrumentMaterialHessian(original) {
  let code=original;
  const replace=(before,after)=>{assert.equal(code.split(before).length,2,'Граница местного корректора должна быть единственной');code=code.replace(before,after);};
  replace('      return {hessianInto(p,weights,targets) {',`      return {hessianInto(p,weights,targets) {
        let materialMark=performance.now();const checkpoint=name=>{const t=performance.now(),r=materialHessianPhases[name];r.calls++;r.ms+=t-materialMark;materialMark=t;};`);
  replace('targets.forEach(g=>separate(p,g));hessianOffset??=allocate(3*size*size);prepareInput(p);',
    "targets.forEach(g=>separate(p,g));hessianOffset??=allocate(3*size*size);checkpoint('prepare');prepareInput(p);");
  replace('        new Float64Array(e.memory.buffer,weightsOffset,3).set(weights);calls++;',
    "        new Float64Array(e.memory.buffer,weightsOffset,3).set(weights);checkpoint('upload');calls++;");
  replace('        for(let j=0;j<3;j++)targets[j].set(hessianViews[j]);',
    "        checkpoint('native');for(let j=0;j<3;j++)targets[j].set(hessianViews[j]);checkpoint('read');");
  return "const materialHessianPhases=Object.fromEntries(['prepare','upload','native','read'].map(k=>[k,{calls:0,ms:0}]));\nexport const materialHessianProfile=()=>structuredClone(materialHessianPhases);\n"+code;
}
export function instrumentReadSoft(original) {
  let code=original;
  const replace=(before,after)=>{assert.equal(code.split(before).length,2,'Граница чтения материала должна быть единственной');code=code.replace(before,after);};
  replace('  readSoft(q) {',`  readSoft(q) {
    let softMark=performance.now();const checkpoint=name=>{const t=performance.now(),r=readSoftPhases[name];r.calls++;r.ms+=t-softMark;softMark=t;};`);
  replace('        const values=block.map(sample),C=group.valueInto(q,values.map(v=>v.values));',
    "        const values=block.map(sample),targets=values.map(v=>v.values);checkpoint('prepare');const C=group.valueInto(q,targets);checkpoint('evaluate');");
  replace('values.forEach((v,k)=>{v.C=C[k];samples.push(v);});j+=block.length;',
    "values.forEach((v,k)=>{v.C=C[k];samples.push(v);});j+=block.length;checkpoint('finish');");
  replace('        const v=sample(c);v.C=c.valueInto(q,v.values);samples.push(v);j++;',
    "        const v=sample(c);checkpoint('prepare');v.C=c.valueInto(q,v.values);checkpoint('evaluate');samples.push(v);j++;checkpoint('finish');");
  replace('      } else {samples.push(c.value(q));j++;}',
    "      } else {checkpoint('prepare');const v=c.value(q);checkpoint('evaluate');samples.push(v);j++;checkpoint('finish');}");
  return "const readSoftPhases=Object.fromEntries(['prepare','evaluate','finish'].map(k=>[k,{calls:0,ms:0}]));\nexport const readSoftProfile=()=>structuredClone(readSoftPhases);\n"+code;
}
export function instrumentMaterialValues(original) {
  let code=original;
  const replace=(before,after)=>{assert.equal(code.split(before).length,2,'Граница значений материала должна быть единственной');code=code.replace(before,after);};
  replace('      const execute=(p,requested)=>{',`      let valueMark,valueKind;const checkpoint=name=>{const t=performance.now(),r=materialValuePhases[valueKind][name];r.calls++;r.ms+=t-valueMark;valueMark=t;};
      const execute=(p,requested)=>{`);
  replace('        prepareInput(p);\n        calls++;',"        checkpoint('prepare');prepareInput(p);checkpoint('upload');\n        calls++;");
  replace("        if(failed)throw new Error('Вырожденная нормаль участка кривизны');", "        if(failed)throw new Error('Вырожденная нормаль участка кривизны');checkpoint('native');");
  replace('      },valueInto(p,gradients) {',"      },valueInto(p,gradients) {\n        valueKind='group';valueMark=performance.now();");
  replace('        return [output[0],output[1],output[2]];',"        const values=[output[0],output[1],output[2]];checkpoint('read');return values;");
  replace('      },singleInto(p,j,g) {',"      },singleInto(p,j,g) {\n        valueKind='single';valueMark=performance.now();");
  replace('        separate(p,g);execute(p,j);g.set(gradientViews[j]);return output[j];',
    "        separate(p,g);execute(p,j);g.set(gradientViews[j]);const value=output[j];checkpoint('read');return value;");
  return "const materialValuePhases=Object.fromEntries(['group','single'].map(k=>[k,Object.fromEntries(['prepare','upload','native','read'].map(n=>[n,{calls:0,ms:0}]))]));\nexport const materialValuesProfile=()=>structuredClone(materialValuePhases);\n"+code;
}
export function instrumentSparse(original) {
  let code=original;
  const insert=(marker,text)=>{assert.equal(code.split(marker).length,2,'Граница линейной оболочки должна быть единственной');code=code.replace(marker,text+marker);};
  insert('    const diagonal = Boolean(signs);',`    let linearMark=performance.now();
    const checkpoint=name=>{const t=performance.now(),r=sparsePhases[name];r.calls++;r.ms+=t-linearMark;linearMark=t;};
`);
  insert('    new Float64Array(e.memory.buffer, lStart, matrix.length).set(matrix);',"    checkpoint('factorPrepare');\n");
  insert('    counts.numericFactorizations++;',"    checkpoint('matrixUpload');\n");
  insert('    if (failure) {',"    checkpoint('factorNative');\n");
  insert('      if (released) throw',"      linearMark=performance.now();\n");
  insert('      for (let i = 0; i < n; i++) for',"      checkpoint('rhsPrepare');\n");
  insert('      const run = signs ?',"      checkpoint('rhsUpload');\n");
  insert('      return rightSides.map',"      checkpoint('solveNative');\n");
  const blocks=[...code.matchAll(/      return rightSides\.map[\s\S]*?(?=\n    };\n    const solve)/g)];assert.equal(blocks.length,1);
  const marker=blocks[0][0];code=code.replace(marker,marker.replace('return ','const result = ')+"\n      checkpoint('rhsRead');return result;");
  const finish=' solve.release = release; return solve;';assert.equal(code.split(finish).length,2);
  code=code.replace(finish," solve.release = release; checkpoint('factorFinish');return solve;");
  return `const sparsePhases=Object.fromEntries(['factorPrepare','matrixUpload','factorNative','factorFinish','rhsPrepare','rhsUpload','solveNative','rhsRead'].map(k=>[k,{calls:0,ms:0}]));
export const sparseProfile=()=>structuredClone(sparsePhases);
`+code;
}
