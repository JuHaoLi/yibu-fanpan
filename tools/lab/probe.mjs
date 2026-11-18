// 诊断：手写评分和价值网络，谁更能从"刚结束回合"的局面猜出最后谁赢。按回合段分开看。
// 用法：node tools/lab/probe.mjs <权重.json> [局数=300]
import { newGame, apply, aiTurn, evaluate, EVAL, STRONG } from '../../chess.js';
import { valueFn } from './net.mjs';
import { pickDeck, lcg, readPlayNet } from './play.mjs';

const [file, G = '300'] = process.argv.slice(2), V = valueFn(readPlayNet(file), 1), rows = [];
for (let g = 0; g < +G; g++) { const seed = (777000 + g) * 2654435761 >>> 0, rnd = lcg(seed), dr = lcg(seed ^ 0x5bd1e995);
  let s = newGame([pickDeck(dr), pickDeck(dr)], rnd); const pts = [];
  while (s.winner === null && s.n <= 70) { const me = s.turn; for (const x of aiTurn(s, { ...STRONG, rnd })) s = apply(s, x).state; if (s.winner === null) pts.push([evaluate(s, me, EVAL), V(s, me), me, s.n]); }
  const res = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1; if (res < 0) continue;
  for (const [h, v, me, n] of pts) rows.push([h, v, res === me ? 1 : 0, n]); }
for (const [lo, hi] of [[0, 8], [8, 16], [16, 24], [24, 99], [0, 99]]) { const r = rows.filter(x => x[3] >= lo && x[3] < hi); if (!r.length) continue;
  const acc = k => (100 * r.filter(x => (x[k] > 0) === (x[2] === 1)).length / r.length).toFixed(1);
  console.log(`回合 ${lo}–${hi === 99 ? '' : hi}：${r.length} 个局面，手写评分猜对 ${acc(0)}%，网络猜对 ${acc(1)}%`); }
