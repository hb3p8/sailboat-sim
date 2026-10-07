// Изолированный кандидат использует уже сохранённую границу столбца.
// Рабочий C-код/модуль не меняются; исходники и сборка сохраняются отдельно.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),arg=args.find(v=>v.startsWith('--out-prefix=')),mode=args.find(v=>v.startsWith('--mode='))?.slice(7)??'stop';
assert(args.length===1+args.filter(v=>v.startsWith('--mode=')).length&&arg?.startsWith('--out-prefix=')&&['stop','runs'].includes(mode));
const prefix=resolve(arg.slice(13));assert(arg.slice(13));
for(const suffix of ['.c','.original.c','.wasm','.build.json','.tool.mjs'])assert(!existsSync(prefix+suffix),'Сохранённую сборку нельзя перезаписывать');
const source='tests/lib/cloth-sparse-kernel.c',original=readFileSync(source,'utf8');let candidate=original;
for(const [before,after] of [
  ['      column_values[row_to_col[a]] = v;','      int stop = row_to_col[a]; column_values[stop] = v;'],
  ['      int b = cp[j], end_col = cp[j + 1];','      int b = cp[j];'],
  ['      while (b < end_col && cr[b] < i) {','      while (b < stop) {'],
  ['        if (b + 1 < end_col && cr[b + 1] == cr[b] + 1 && cr[b + 1] < i) {',
   '        if (b + 1 < stop && cr[b + 1] == cr[b] + 1) {']]) {
  assert.equal(candidate.split(before).length,2,'Граница C-кода должна быть единственной');candidate=candidate.replace(before,after);
}
if(mode==='runs') {
  const blocks=[...candidate.matchAll(/EXPORTED int sparse_ldl_factor\([\s\S]+?(?=\nEXPORTED int sparse_factor\()/g)];assert.equal(blocks.length,1);
  let block=blocks[0][0].replace('sparse_ldl_factor(','sparse_ldl_factor_runs(')
    .replace('const int *signs) {','const int *signs, const int *run_ends) {');
  const loop=block.slice(block.indexOf('      while (b < stop) {'),block.indexOf('      work[i] -= v * v * D;'));
  assert(loop.includes('b += 2;')&&loop.includes('column_values[b]'));
  block=block.replace(loop,`      while (b < stop) {
        int end_run = run_ends[b]; if (end_run > stop) end_run = stop;
        int row = cr[b];
        while (b + 1 < end_run) {
          v128_t current = wasm_v128_load(work + row);
          v128_t factors = wasm_v128_load(column_values + b);
          wasm_v128_store(work + row, wasm_f64x2_sub(current, wasm_f64x2_mul(scale_pair, factors)));
          b += 2; row += 2;
        }
        if (b < end_run) { work[row] -= scaled * column_values[b]; b++; }
      }
`);
  candidate=original+`\n// План непрерывных участков принадлежит отдельному месту неизменного pattern.
EXPORTED int sparse_ldl_runs_abi(void) { return 1; }
EXPORTED void sparse_ldl_prepare_runs(int n, const int *cp, const int *cr, int *run_ends) {
  for (int j = 0; j < n; j++) {
    int stop = cp[j + 1], end_run = stop;
    for (int b = stop - 1; b >= cp[j]; b--) {
      if (b + 1 == stop || cr[b + 1] != cr[b] + 1) end_run = b + 1;
      run_ends[b] = end_run;
    }
  }
}
\n`+block;
}
mkdirSync(dirname(prefix),{recursive:true});writeFileSync(prefix+'.original.c',original,{flag:'wx'});writeFileSync(prefix+'.c',candidate,{flag:'wx'});
writeFileSync(prefix+'.tool.mjs',readFileSync(fileURLToPath(import.meta.url)),{flag:'wx'});
const compiler='/opt/homebrew/opt/llvm/bin/clang',flags=['--target=wasm32','-O3','-ffp-contract=off','-fno-fast-math','-msimd128','-nostdlib',
  '-Wl,--no-entry','-Wl,--export-dynamic','-Wl,--export=__heap_base','-Wl,--initial-memory=131072'];
const command=[...flags,'-o',prefix+'.wasm',prefix+'.c'],hash=b=>createHash('sha256').update(b).digest('hex');
const manifest={schema:'cloth-sparse-stop-build-v1',mode,revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  tool:{path:fileURLToPath(import.meta.url),sha256:hash(readFileSync(fileURLToPath(import.meta.url)))},compiler,
  compilerVersion:execFileSync(compiler,['--version'],{encoding:'utf8'}).trim(),command,
  source:{path:source,sha256:hash(original)},originalCopy:{path:prefix+'.original.c',sha256:hash(original)},candidate:{path:prefix+'.c',sha256:hash(candidate)},
  rule:'Только LDL: row_to_col[a] — место текущей строки i в столбце j. Для корректного неизменного sparsePattern оно равно первой границе cr[b]>=i. В runs непрерывные участки готовятся один раз в отдельной памяти места, прежний экспорт оставлен. Умножения/вычитания и SIMD-пары прежние; fast-math/FMA запрещены.'};
try {
  execFileSync(compiler,command,{env:{...process.env,PATH:'/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:'+process.env.PATH}});
  manifest.wasm={path:prefix+'.wasm',sha256:hash(readFileSync(prefix+'.wasm'))};manifest.phase='complete';
} catch(e){manifest.phase='failed';manifest.failure=e.message;process.exitCode=1;}
writeFileSync(prefix+'.build.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(`Граница LDL: сборка ${manifest.phase==='complete'?'готова':'отказала'}, исходник ${manifest.candidate.sha256}.`);
