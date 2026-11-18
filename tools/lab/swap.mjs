// 替换测试：14 套预设各把最贵的非首领牌换成指定的牌，对 14 套原卡组打 N 局（同种子再打一遍原卡组做对照），报胜率变化
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { DECKS, CARDS, newGame, apply, aiTurn } from '../../chess.js';
import { makeAI, lcg, farm } from './play.mjs';
const K = process.env.CARD || 'B_n1', D = DECKS.map(d => { const c = [...d.cards], i = c.reduce((b, k, j) => !CARDS[k].boss && CARDS[k].cost >= CARDS[c[b]].cost ? j : b, 0); c[i] = K; return c; });
const P = []; for (let a = 0; a < DECKS.length; a++) for (let b = 0; b < DECKS.length; b++) P.push([a, b]);
if (!isMainThread) { const ai = makeAI('strong'), per = workerData.per;
  const one = (d0, d1, first, seed) => { const rnd = lcg(seed); let s = newGame(first ? [d0, d1] : [d1, d0], rnd); while (s.winner === null && s.n <= 70) for (const x of aiTurn(s, { ...ai, rnd })) s = apply(s, x).state; const w = s.winner ?? (s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1); return w < 0 ? .5 : (w === 0) === first ? 1 : 0; };
  parentPort.on('message', ({ from, n }) => { const res = []; for (let g = from; g < from + n; g++) { const [a, b] = P[Math.floor(g / per)], k = g % per, seed = (999 + g) * 2654435761 >>> 0;
    res.push([one(D[a], DECKS[b].cards, (k & 1) === 0, seed) - one(DECKS[a].cards, DECKS[b].cards, (k & 1) === 0, seed)]); } parentPort.postMessage(res); });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const per = +(process.argv[2] || 40); let sum = 0, n = 0;
  await farm(new URL(import.meta.url), P.length * per, 15, 20, { per }, r => { for (const [d] of r) { sum += d; n++; } });
  console.log(`${process.env.LV || '现版'}（${CARDS[K].cost} 费，玩家手里）：替换后胜率变化 ${(100 * sum / n).toFixed(1)} 个百分点，${n} 局`);
}
