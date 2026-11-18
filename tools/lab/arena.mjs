// 两个电脑对打，看 A 的胜率。同一对卡组、同一个种子打四局：两边各用两套卡组、各先手一次，只有电脑不同。
// 用法：node tools/lab/arena.mjs <电脑A> <电脑B> [局数=2000，取 4 的倍数] [线程数=核数-1] [种子起点=900001]
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { newGame, apply, aiTurn } from '../../chess.js';
import { makeAI, pickDeck, lcg, farm } from './play.mjs';

if (!isMainThread) {
  const A = makeAI(workerData.a), B = makeAI(workerData.b);
  parentPort.on('message', ({ from, n }) => {
    let won = 0, games = 0, ms = [0, 0], turns = [0, 0];
    for (let g = from; g < from + n; g++) {
      const pair = g >> 2, seed = (workerData.base + pair) * 2654435761 >>> 0, dr = lcg(seed ^ 0x5bd1e995), d0 = pickDeck(dr), d1 = pickDeck(dr);
      const swapD = (g >> 1) & 1, aFirst = (g & 1) === 0, da = swapD ? d1 : d0, db = swapD ? d0 : d1, seatA = aFirst ? 0 : 1, rnd = lcg(seed);
      let s = newGame(aFirst ? [da, db] : [db, da], rnd);
      while (s.winner === null && s.n <= 70) { const isA = s.turn === seatA, t = performance.now(); const acts = aiTurn(s, { ...(isA ? A : B), rnd }); ms[isA ? 0 : 1] += performance.now() - t; turns[isA ? 0 : 1]++; for (const x of acts) s = apply(s, x).state; }
      const res = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1;
      won += res === seatA ? 1 : res < 0 ? .5 : 0; games++;
    }
    parentPort.postMessage({ won, games, ms, turns });
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [a, b, G = '2000', W = String(Math.max(1, availableParallelism() - 1)), base = '900001'] = process.argv.slice(2), t0 = Date.now();
  let won = 0, games = 0; const ms = [0, 0], turns = [0, 0];
  await farm(new URL(import.meta.url), +G, +W, 8, { a, b, base: +base }, r => { won += r.won; games += r.games; for (const k of [0, 1]) { ms[k] += r.ms[k]; turns[k] += r.turns[k]; } });
  const p = won / games, ci = 1.96 * Math.sqrt(p * (1 - p) / games);
  console.log(`${a} 对 ${b}：A 胜率 ${(100 * p).toFixed(1)}% ± ${(100 * ci).toFixed(1)}（${games} 局，${((Date.now() - t0) / 1000).toFixed(0)} 秒）；每回合想多久 A ${(ms[0] / turns[0]).toFixed(1)} 毫秒、B ${(ms[1] / turns[1]).toFixed(1)} 毫秒`);
}
