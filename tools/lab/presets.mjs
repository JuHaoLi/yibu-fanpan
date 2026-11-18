// 12 套预设两两对打（两边同一个电脑，轮流先手），看每套的总胜率和互相克制。验收线：总胜率 45–55%、先手 47–53%。
// 用法：node tools/lab/presets.mjs [电脑=strong] [每对局数=200，取偶数] [线程数]
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DECKS, FACTIONS, newGame, apply, aiTurn } from '../../chess.js';
import { makeAI, lcg, farm } from './play.mjs';

const K = DECKS.length, PAIRS = []; for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) PAIRS.push([a, b]);
if (!isMainThread) {
  const ai = makeAI(workerData.ai), per = workerData.per;
  parentPort.on('message', ({ from, n }) => { const res = [];
    for (let g = from; g < from + n; g++) { const [a, b] = PAIRS[Math.floor(g / per)], k = g % per, aFirst = (k & 1) === 0, seed = (31337 + Math.floor(g / 2)) * 2654435761 >>> 0, rnd = lcg(seed);
      let s = newGame(aFirst ? [DECKS[a].cards, DECKS[b].cards] : [DECKS[b].cards, DECKS[a].cards], rnd);
      while (s.winner === null && s.n <= 70) for (const x of aiTurn(s, { ...ai, rnd })) s = apply(s, x).state;
      const w = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1;
      res.push([a, b, w < 0 ? .5 : (w === 0) === aFirst ? 1 : 0, w === 0 ? 1 : w < 0 ? .5 : 0]); }
    parentPort.postMessage(res); });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ai = 'strong', per = '200', W = String(Math.max(1, availableParallelism() - 1))] = process.argv.slice(2), P = +per, t0 = Date.now();
  const M = Array.from({ length: K }, () => Array(K).fill(0)), C = Array.from({ length: K }, () => Array(K).fill(0)); let first = 0, n = 0;
  await farm(new URL(import.meta.url), PAIRS.length * P, +W, 20, { ai, per: P }, r => { for (const [a, b, wa, f] of r) { M[a][b] += wa; M[b][a] += 1 - wa; C[a][b]++; C[b][a]++; first += f; n++; } });
  const name = i => `${FACTIONS[DECKS[i].f].name}·${DECKS[i].name}`, tot = i => { let w = 0, c = 0; for (let j = 0; j < K; j++) { w += M[i][j]; c += C[i][j]; } return 100 * w / c; };
  console.log(`${ai}，每对 ${P} 局，共 ${n} 局，${((Date.now() - t0) / 1000).toFixed(0)} 秒；先手胜率 ${(100 * first / n).toFixed(1)}%`);
  for (const i of [...Array(K).keys()].sort((x, y) => tot(y) - tot(x))) { const worst = [...Array(K).keys()].filter(j => j !== i).sort((x, y) => M[i][x] / C[i][x] - M[i][y] / C[i][y]);
    console.log(`${tot(i).toFixed(1).padStart(5)}%  ${name(i)}  最怕 ${name(worst[0])} ${(100 * M[i][worst[0]] / C[i][worst[0]]).toFixed(0)}%，最克 ${name(worst.at(-1))} ${(100 * M[i][worst.at(-1)] / C[i][worst.at(-1)]).toFixed(0)}%`); }
}
