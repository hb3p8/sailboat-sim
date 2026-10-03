// Прямой численный интерфейс против прежнего кода из Git, не против обёртки.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {materialSurface,gridTriangles,MODEL_MATERIAL} from './lib/cloth-material.mjs';
const args=process.argv.slice(2);
assert(args.every(v=>/^--(baseline|out)=.+$/.test(v))&&new Set(args.map(v=>v.split('=')[0])).size===args.length);
const baseline=args.find(v=>v.startsWith('--baseline='))?.slice(11),output=args.find(v=>v.startsWith('--out='))?.slice(6);
assert(baseline,'Нужна --baseline=прежняя-ревизия');
const hash=b=>createHash('sha256').update(b).digest('hex');
const path='tests/lib/cloth-material.mjs',baseBytes=execFileSync('git',['show',`${baseline}:${path}`]);
const baseUrl=new URL('./lib/cloth-material.mjs',import.meta.url);
const imports=[];
const source=baseBytes.toString().replace(/\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1/g,(_,quote,relative)=>{
  const url=new URL(relative,baseUrl),repoPath='tests/'+url.pathname.split('/tests/')[1];
  assert.equal(hash(readFileSync(url)),hash(execFileSync('git',['show',`${baseline}:${repoPath}`])),`Изменился общий импорт ${repoPath}`);
  imports.push(repoPath);return `from ${quote}${url.href}${quote}`;
});
const old=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const fixturePath='out/acceptance/rigid-sail-60321b9-plus-five.json',fixtureBytes=readFileSync(fixturePath),recipe=JSON.parse(fixtureBytes).recipe;
const reference=Array.from({length:20},(_,i)=>{
  const x=(i%5)*.37,y=Math.floor(i/5)*.31;return [x,y,.09*Math.sin(x*1.3)*Math.cos(y*.7)];
}).flat();
const deformed=reference.map((v,k)=>v*(k%3===0?1.03:k%3===1?.98:1)+.02*Math.sin(k*.47));
const record={schema:'cloth-material-buffers-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),baselineRevision:execFileSync('git',['rev-parse',baseline],{encoding:'utf8'}).trim(),
  baselineMaterialSha256:hash(baseBytes),sourceSha256:{},input:{path:fixturePath,sha256:hash(fixtureBytes)},checkedValues:0,checkedGradientComponents:0};
for(const p of ['tests/cloth-material-buffers.test.mjs',path,...imports])record.sourceSha256[p]=hash(readFileSync(p));
for(const setup of [
  {rows:4,cols:5,reference,current:deformed,bending:'curvature',side:1},
  {rows:4,cols:5,reference,current:deformed,bending:'curvature',side:-1},
  {rows:4,cols:5,reference,current:deformed,bending:'hinge',side:1},
  {rows:recipe.rows,cols:recipe.cols,reference:recipe.reference,current:recipe.positions.slice(0,recipe.reference.length),bending:'curvature',side:1},
]) {
  const mirror=p=>Float64Array.from(p,(v,k)=>k%3===1?setup.side*v:v),ref=mirror(setup.reference),current=mirror(setup.current);
  const tris=gridTriangles(setup.rows,setup.cols),options={bendingModel:setup.bending,rows:setup.rows,cols:setup.cols};
  const a=materialSurface(ref,tris,MODEL_MATERIAL,options),b=old.materialSurface(ref,tris,MODEL_MATERIAL,options);
  const states=[ref,current];
  for(const k of [0,1,2,current.length-3,current.length-2,current.length-1])for(const sign of [-1,1]) {
    const q=current.slice();q[k]+=sign*2e-6*Math.max(1,Math.abs(q[k]));states.push(q);
  }
  for(const q of states) {
    assert.deepEqual(a.evaluate(q,true),b.evaluate(q,true));
    for(let j=0;j<a.constraints.length;j++) {
      const c=a.constraints[j],prior=b.constraints[j].value(q),value=c.value(q);
      assert.deepEqual(value,prior);record.checkedValues++;
      if(!c.valueInto)continue;
      const buffer=new Float64Array(3*c.gradientNodes.length).fill(123),snapshot=structuredClone(value);
      assert.equal(c.valueInto(q,buffer),prior.C);
      assert.deepEqual(c.gradientNodes,prior.grad.map(([node])=>node));
      assert.deepEqual(Array.from(buffer),prior.grad.flatMap(([,g])=>g));record.checkedGradientComponents+=buffer.length;
      buffer.fill(999);c.valueInto(ref,buffer);assert.deepEqual(value,snapshot,'Обычный снимок градиента изменился');
      const wrong=new Float64Array(buffer.length+1).fill(7);
      assert.throws(()=>c.valueInto(q,wrong),/длины/);assert(wrong.every(v=>v===7));
    }
    for(let j=0;j<a.constraints.length;j++) {
      const c=a.constraints[j],group=c.gradientGroup;if(!group||c.gradientSlot!==0)continue;
      const modes=a.constraints.slice(j,j+group.size),buffers=modes.map(c=>new Float64Array(3*c.gradientNodes.length).fill(9));
      const C=group.valueInto(q,buffers);
      modes.forEach((c,k)=>{
        const expected=b.constraints[j+k].value(q);
        assert.equal(C[k],expected.C);assert.deepEqual(Array.from(buffers[k]),expected.grad.flatMap(([,g])=>g));
      });
      buffers.forEach(g=>g.fill(11));
      assert.throws(()=>group.valueInto(q,buffers.slice(1)),/длины/);assert(buffers.every(g=>g.every(v=>v===11)));
    }
  }
}
record.phase='complete';if(output)writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(`ок: ${record.checkedValues} значений и ${record.checkedGradientComponents} компонент точно против ${baseline}; оба зеркала, изгиб/старый угловой контроль, весь крой, возмущения, независимые снимки и неверная длина`);
