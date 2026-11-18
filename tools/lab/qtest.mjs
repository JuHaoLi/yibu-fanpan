// Q1 两套卡组对 14 套预设：每对 N 局，轮流先手，最强电脑
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { DECKS, newGame, apply, aiTurn } from '../../chess.js';
import { makeAI, lcg, farm } from './play.mjs';
const Q = [['零号协议', ['q_probe', 'q_patch', 'q_helm', 'q_field', 'q_warp', 'q_wing', 'q_cannon', 'q_sword', 'q_glitch', 'q_chassis', 'q_emp', 'q_super']], ['超频', ['q_probe', 'q_helm', 'q_field', 'q_wing', 'q_cannon', 'q_sword', 'q_glitch', 'q_chassis', 'n_soulstealer', 'gem', 'q_emp', 'q_super']]];
const P = []; for (let a = 0; a < Q.length; a++) for (let b = 0; b < DECKS.length; b++) P.push([a, b]);
if (!isMainThread) { const ai = makeAI('strong'), per = workerData.per;
  parentPort.on('message', ({ from, n }) => { const res = []; for (let g = from; g < from + n; g++) { const [a, b] = P[Math.floor(g / per)], k = g % per, qf = (k & 1) === 0, rnd = lcg((777 + g) * 2654435761 >>> 0);
    let s = newGame(qf ? [Q[a][1], DECKS[b].cards] : [DECKS[b].cards, Q[a][1]], rnd); while (s.winner === null && s.n <= 70) for (const x of aiTurn(s, { ...ai, rnd })) s = apply(s, x).state;
    const w = s.winner ?? (s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1); res.push([a, b, w < 0 ? .5 : (w === 0) === qf ? 1 : 0]); } parentPort.postMessage(res); });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const per = +(process.argv[2] || 100), W = Q.map(() => Array(DECKS.length).fill(0));
  await farm(new URL(import.meta.url), P.length * per, 15, 20, { per }, r => { for (const [a, b, x] of r) W[a][b] += x; });
  for (let a = 0; a < Q.length; a++) console.log(`${process.env.QV || '现状'} ${Q[a][0]} ${(100 * W[a].reduce((x, y) => x + y) / (per * DECKS.length)).toFixed(1)}%  ` + DECKS.map((d, b) => d.name + ' ' + Math.round(100 * W[a][b] / per)).join(' '));
}
