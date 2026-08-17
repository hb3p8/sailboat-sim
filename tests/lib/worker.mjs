// Рабочий поток пула: считает установившиеся ходы по присланным условиям.
//
// Пакет читается здесь, а не пересылается: он маленький, а пересылка структур
// между потоками стоит дороже разбора двадцати килобайт JSON.

import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { steady } from './steady.mjs';
import { RUNS } from './runs.mjs';

const pack = JSON.parse(readFileSync(workerData.pack, 'utf8'));
// Акватория строится один раз на поток и только если её просили: разбор пакета
// стоит заметно дороже одного прогона.
let terrain = null;
if (workerData.terrain) {
  const { Terrain } = await import('../../sim/terrain.js');
  terrain = new Terrain(JSON.parse(readFileSync(workerData.terrain, 'utf8')));
}

parentPort.on('message', msg => {
  if (msg === null) { parentPort.close(); return; }
  const out = new Array(msg.specs.length);
  // `run` — именованный сценарий из runs.mjs, иначе установившийся ход. Развилка
  // одна на оба пути (главный поток зовёт то же самое через Pool.one/map).
  for (let i = 0; i < msg.specs.length; i++) {
    const s = msg.specs[i];
    out[i] = s.run ? RUNS[s.run](pack, s, terrain) : steady(pack, s);
  }
  parentPort.postMessage({ id: msg.id, out: out });
});
