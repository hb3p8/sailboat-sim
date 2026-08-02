// Пул рабочих потоков для перебора настроек.
//
// Батареи перебирают сотни установившихся ходов, и все они друг от друга не
// зависят. На одном ядре лавировочная батарея шла одиннадцать минут — столько
// ждать между правками нельзя, и правки от этого делаются реже и крупнее, что
// само по себе плохо.
//
// Модель при этом не трогается вовсе: рабочий поток гоняет тот же самый
// steady() из того же файла. Параллельность живёт только в тестах.
//
// Условия раздаются кусками (по нескольку на поток за раз): пересылка стоит
// заметно дороже одного прогона, и слать их по одному — значит платить за
// пересылку больше, чем за счёт.

import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { steady } from './steady.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export class Pool {
  constructor(packPath, pack, size) {
    // Одно ядро оставляем системе, иначе на ноутбуке всё начинает дёргаться.
    this.n = size || Math.max(1, Math.min(8, cpus().length - 2));
    this.pack = pack;
    this.packPath = packPath;
    this.workers = null;
  }

  _start() {
    if (this.workers) return;
    this.workers = [];
    for (let i = 0; i < this.n; i++) {
      const w = new Worker(join(HERE, 'worker.mjs'),
                           { workerData: { pack: this.packPath } });
      w.unref();
      this.workers.push(w);
    }
  }

  // Посчитать список условий. Возвращает результаты в том же порядке.
  async map(specs) {
    if (specs.length <= 2) return specs.map(s => steady(this.pack, s));
    this._start();
    const chunks = [];
    const per = Math.max(1, Math.ceil(specs.length / (this.n * 3)));
    for (let i = 0; i < specs.length; i += per) {
      chunks.push({ at: i, specs: specs.slice(i, i + per) });
    }
    const out = new Array(specs.length);
    let next = 0;
    await Promise.all(this.workers.map(w => new Promise((resolve, reject) => {
      // Обработчик ошибки вешается один на поток, а не на порцию: иначе на
      // сотне порций node справедливо ругается на утечку слушателей.
      const onError = err => reject(err);
      w.once('error', onError);
      const feed = () => {
        if (next >= chunks.length) { w.off('error', onError); resolve(); return; }
        const c = chunks[next++];
        w.once('message', msg => {
          for (let i = 0; i < msg.out.length; i++) out[c.at + i] = msg.out[i];
          feed();
        });
        w.postMessage({ id: c.at, specs: c.specs });
      };
      feed();
    })));
    return out;
  }

  close() {
    if (!this.workers) return;
    for (const w of this.workers) w.terminate();
    this.workers = null;
  }
}
