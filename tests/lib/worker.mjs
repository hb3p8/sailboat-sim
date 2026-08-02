// Рабочий поток пула: считает установившиеся ходы по присланным условиям.
//
// Пакет читается здесь, а не пересылается: он маленький, а пересылка структур
// между потоками стоит дороже разбора двадцати килобайт JSON.

import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { steady } from './steady.mjs';

const pack = JSON.parse(readFileSync(workerData.pack, 'utf8'));

parentPort.on('message', msg => {
  if (msg === null) { parentPort.close(); return; }
  const out = new Array(msg.specs.length);
  for (let i = 0; i < msg.specs.length; i++) out[i] = steady(pack, msg.specs[i]);
  parentPort.postMessage({ id: msg.id, out: out });
});
