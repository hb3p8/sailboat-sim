// Только таймеры в отдельной копии. Порядок операций модели не изменяется.
import assert from 'node:assert/strict';
export function instrumentDirection(original) {
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
  return `const phaseNames=['prepare','clothMatrix','constraints','bodyCoupling','linear','finish'];
const directionPhases=Object.fromEntries(['ordinary','correction'].map(k=>[k,Object.fromEntries(phaseNames.map(p=>[p,{calls:0,ms:0}]))]));
const directionWork={};
export const directionProfile=()=>({work:structuredClone(directionWork),phases:structuredClone(directionPhases)});
`+code;
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
