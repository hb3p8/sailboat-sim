// Строгий перенос водных функций: прежний Boat из Git и новый, те же условия.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [out]=process.argv.slice(2);assert(out&&process.argv.length===3&&!existsSync(out)&&!existsSync(out+'.sources'));
const revision='bc8453d',hash=b=>createHash('sha256').update(b).digest('hex'),graphs={};
function copyGraph(label,revision) {
  const root=resolve(out+'.sources',label),sources={};
  function source(path) {
    if(sources[path])return;
    const bytes=revision?execFileSync('git',['show',revision+':'+path],{maxBuffer:16*1024*1024}):readFileSync(path);
    sources[path]=hash(bytes);const dest=resolve(root,path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,bytes,{flag:'wx'});
    for(const m of bytes.toString().matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g))source(posix.normalize(posix.join(posix.dirname(path),m[1])));
  }
  source('sim/physics.js');graphs[label]={revision:revision??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:revision?false:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),sources};
  return pathToFileURL(resolve(root,'sim/physics.js'));
}
const Old=(await import(copyGraph('baseline',revision))).Boat,New=(await import(copyGraph('candidate'))).Boat;
const physics=readFileSync('out/export/physics.json'),pack=JSON.parse(physics);
const serial=v=>ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(serial):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,serial(x)])):v;
const fields=['x','y','psi','u','v','r','phi','p_','zc','th','w','q','t','rigSide','rigRate','hike'];
const report={schema:'boat-water-transfer-check-v1',phase:'running',graphs,physicsSha256:hash(physics),cases:[],exactSteps:0};
try {
  for(const side of [-1,1])for(const crew of [0,220])for(const gen of [false,true]) {
    const row={side,crew,gen,steps:[]};report.cases.push(row);
    const boats=[Old,New].map(B=>{const b=new B(pack,undefined,{gennakerUp:gen,crewMass:crew,crewHike:side*.2,windDir:side*140*Math.PI/180});
      Object.assign(b,{u:1.7,v:side*.05,r:side*.02,phi:side*.2,p_:side*.03,th:.025,q:-.02,zc:.003,w:-.01});return b;});
    for(let k=0;k<30;k++) {
      const states=boats.map(b=>{b.o.rudderTarget=side*(k<15?8:-4)*Math.PI/180;b.step(1/30);
        return serial({state:Object.fromEntries(fields.map(f=>[f,b[f]])),rudder:b.o.rudder,telemetry:b.telemetry});});
      assert.deepEqual(states[1],states[0]);row.steps.push(states[1]);report.exactSteps++;
    }
  }
  report.phase='complete';
} catch(e){report.phase='failed';report.failure={message:e.message,stack:e.stack};process.exitCode=1;}
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`Перенос водных функций Boat: ${report.exactSteps} строгих шагов, состояние ${report.phase==='complete'?'пройдено':'отказ'}.`);
