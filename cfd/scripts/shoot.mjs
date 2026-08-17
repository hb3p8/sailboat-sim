// Снимок отчёта в обеих темах плюс перехват ошибок страницы.
//
//     node cfd/scripts/shoot.mjs cfd/reports/hydro.html /tmp/shot
//
// Нужен затем, что проверить вид отчёта иначе нечем: правила рисования
// проверяются глазами, а не батареей. Ошибки консоли ловятся здесь же —
// молча оборвавшаяся отрисовка выглядит как «короткий отчёт», а не как сбой.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const src = resolve(process.argv[2] || 'cfd/reports/hydro.html');
const out = process.argv[3] || '/tmp/shot';

const browser = await chromium.launch({ channel: 'chromium' });
let bad = 0;
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 900 },
    colorScheme: scheme,
    deviceScaleFactor: 1,
  });
  page.on('pageerror', e => { bad++; console.log('ОШИБКА СТРАНИЦЫ:', e.message); });
  page.on('console', m => {
    if (m.type() === 'error'){ bad++; console.log('КОНСОЛЬ:', m.text()); }
  });
  await page.goto('file://' + src);
  await page.waitForTimeout(4500);
  const h = await page.evaluate(() => document.body.scrollHeight);
  const n = await page.evaluate(() => document.querySelectorAll('canvas').length);
  console.log(scheme + ': высота ' + h + ' px, полотен ' + n);
  await page.screenshot({ path: out + '-' + scheme + '.png', fullPage: true });
  await page.close();
}
await browser.close();
console.log(bad ? ('ошибок: ' + bad) : 'ошибок нет');
