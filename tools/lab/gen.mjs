// 自我对打出训练数据：每个"某方刚结束回合"的局面存一条（编码 + 这一方最后的胜负）。
// 用法：node tools/lab/gen.mjs <电脑> <局数> <线程数> <输出文件> [种子起点=1]
// 输出：每条 L+1 个 int16，最后一个是结果：1 赢、0 输、2 平
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openSync, writeSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { newGame, apply, aiTurn } from '../../chess.js';
import { encode, L } from './net.mjs';
import { makeAI, pickDeck, lcg, farm } from './play.mjs';

if (!isMainThread) {
  const ai = makeAI(workerData.ai);
  parentPort.on('message', ({ from, n }) => {
    const recs = [];
    for (let g = 0; g < n; g++) {
      const seed = (workerData.base + from + g) * 2654435761 >>> 0, rnd = lcg(seed), dr = lcg(seed ^ 0x5bd1e995);
      let s = newGame([pickDeck(dr), pickDeck(dr)], rnd); const mine = [];
      while (s.winner === null && s.n <= 70) { const me = s.turn; for (const x of aiTurn(s, { ...ai, rnd })) s = apply(s, x).state; if (s.winner === null) mine.push([encode(s, me), me]); }
      const res = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1;
      for (const [e, me] of mine) { const r = new Int16Array(L + 1); r.set(e); r[L] = res < 0 ? 2 : res === me ? 1 : 0; recs.push(r); }
    }
    const out = new Int16Array(recs.length * (L + 1)); recs.forEach((r, i) => out.set(r, i * (L + 1)));
    parentPort.postMessage({ out, games: n }, [out.buffer]);
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ai, G, W, file, base = '1'] = process.argv.slice(2), fd = openSync(file, 'w'), t0 = Date.now(); let games = 0, recs = 0, shown = 0;
  await farm(new URL(import.meta.url), +G, +W, 50, { ai, base: +base }, r => { writeSync(fd, new Uint8Array(r.out.buffer)); games += r.games; recs += r.out.length / (L + 1);
    if (games - shown >= 2000) { shown = games; console.log(`${games}/${G} 局，${recs} 条，${((Date.now() - t0) / 1000).toFixed(0)} 秒`); } });
  closeSync(fd); console.log(`完成：${games} 局，${recs} 条，${((Date.now() - t0) / 1000).toFixed(0)} 秒 → ${file}`);
}
