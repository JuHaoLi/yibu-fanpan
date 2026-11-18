// 电脑看局面的权重（chess.js 的 EVAL）用自我对打学出来：每次把一个权重往上或往下挪一档，新权重和当前最好的那组对打，
// 赢得够多（默认 54% 以上）才换上。对局两边用同一套随机卡组、轮流先手、同一组种子，只有权重不同。多核并行。
// 用法：node tools/ai_tune.mjs [每次比较的局数=400] [轮数=3]，跑完把最后打印的 EVAL 抄回 chess.js
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { DECKS, PROTOCOL, EVAL, newGame, apply, aiTurn } from '../chess.js';

const AI = { deep: true, beam: 12 };
const POOL = [...DECKS.map(d => d.cards), PROTOCOL];
function play(wa, wb, from, to) { // 第 from 到 to 局，返回 wa 赢了几局
  let won = 0;
  for (let g = from; g < to; g++) { const pair = g >> 2; let seed = 7919 * pair + 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const d0 = POOL[pair % POOL.length], d1 = POOL[(pair * 7 + 3) % POOL.length], swapD = (g >> 1) & 1, aFirst = (g & 1) === 0; // 同一对卡组、同一个种子打四局：两边各用两套卡组、各先手一次，只有权重不同
    const da = swapD ? d1 : d0, db = swapD ? d0 : d1, s0 = aFirst ? [da, db] : [db, da]; let s = newGame(s0, rnd); const seatA = aFirst ? 0 : 1;
    while (s.winner === null && s.n <= 70) for (const x of aiTurn(s, { ...AI, rnd, w: s.turn === seatA ? wa : wb })) s = apply(s, x).state;
    if (s.winner === seatA) won++; else if (s.winner === null && s.base[seatA] > s.base[1 - seatA]) won++;
  }
  return won;
}
if (!isMainThread) { parentPort.postMessage(play(...workerData)); }
else {
  const G = +(process.argv[2] ?? 400), PASSES = +(process.argv[3] ?? 3), CPU = Math.max(1, availableParallelism() - 1);
  const match = (wa, wb) => Promise.all(Array.from({ length: CPU }, (_, i) => new Promise((ok, no) => { const w = new Worker(new URL(import.meta.url), { workerData: [wa, wb, Math.floor(G * i / CPU), Math.floor(G * (i + 1) / CPU)] }); w.on('message', ok); w.on('error', no); }))).then(r => r.reduce((a, b) => a + b, 0) / G);
  let best = { ...EVAL }; const t0 = Date.now();
  for (let p = 0; p < PASSES; p++) { let moved = false;
    for (const k of Object.keys(best)) for (const f of [1.4, 1 / 1.4]) {
      const cand = { ...best, [k]: best[k] === 0 ? (f > 1 ? .5 : 0) : Math.round(best[k] * f * 100) / 100 }; if (cand[k] === best[k]) continue;
      const r = await match(cand, best); console.log(`第 ${p + 1} 轮 ${k} ${best[k]} → ${cand[k]}：${(100 * r).toFixed(1)}%${r >= .54 ? '  采用' : ''}  (${((Date.now() - t0) / 1000).toFixed(0)} 秒)`);
      if (r >= .54) { best = cand; moved = true; break; } }
    if (!moved) break; }
  const final = await match(best, EVAL);
  console.log(`\n学出来的权重对原来的权重：${(100 * final).toFixed(1)}%（${G} 局）`);
  console.log('export const EVAL = ' + JSON.stringify(best).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ') + ';');
}
