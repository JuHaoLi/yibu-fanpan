// 奇袭对照实验：每张奇袭牌 × 两种落地规则（0 = 落地不动，1 = 最多一格）× 三档战力（削弱前的原值 −1 / 原值 / +1），各打若干局，
// 和"同一个位置换成一张普通牌"的对照组比胜率，看每个组合偏强还是偏弱。带牌的一方用岚影 + 随机中立，对面随机卡组，座位随机。
// 用法：node tools/lab/ambush.mjs <电脑> <每格局数> <线程数>   →  out/lab/ambush.json
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CARDS, deckError, newGame, apply, aiTurn } from '../../chess.js';
import { randomDeck } from './census.mjs';
import { makeAI, lcg, farm } from './play.mjs';

export const AMB = { f2_support: 2, f2_deathphantom: 2, f2_onyxjaguar: 3, f2_seenoevil: 3, f2_supekuta: 3, f2_shidaimk2: 3 }; // 削弱前的原战力
const IDS = Object.keys(AMB), CELLS = [{ ctl: true }]; for (const id of IDS) for (const land of [0, 1]) for (const d of [-1, 0, 1]) CELLS.push({ id, land, d });
const ALL = Object.keys(CARDS);
if (!isMainThread) {
  const ai = makeAI(workerData.ai), per = workerData.per;
  parentPort.on('message', ({ from, n }) => { const res = [];
    for (let g = from; g < from + n; g++) { const cell = CELLS[Math.floor(g / per)], seed = (424242 + g) * 2654435761 >>> 0, rnd = lcg(seed), dr = lcg(seed ^ 0x5bd1e995);
      let mine; for (;;) { mine = randomDeck(dr, 'f2').filter(k => !(k in AMB)); while (mine.length > 11) mine.splice(Math.floor(dr() * mine.length), 1); // 先去掉所有奇袭牌，留 11 张
        const pool = cell.ctl ? ALL.filter(k => !(k in AMB) && !CARDS[k].token && !CARDS[k].boss && (CARDS[k].faction === 'f2' || CARDS[k].faction === 'n') && !mine.includes(k)) : null;
        while (mine.length < 11) { const k = pool ? pool[Math.floor(dr() * pool.length)] : null; if (!k) break; if (!mine.includes(k)) mine.push(k); }
        const slot = cell.ctl ? pool.filter(k => !mine.includes(k))[Math.floor(dr() * (pool.length - 11))] : cell.id; mine.push(slot); if (mine.length === 12 && !deckError(mine, ALL)) break; }
      const foe = randomDeck(dr), first = dr() < .5, c = cell.ctl ? null : CARDS[cell.id], keep = c && [c.str, c.land];
      if (c) { c.str = Math.max(1, AMB[cell.id] + cell.d); c.land = cell.land; }
      let s = newGame(first ? [mine, foe] : [foe, mine], rnd); const seat = first ? 0 : 1;
      while (s.winner === null && s.n <= 70) for (const x of aiTurn(s, { ...ai, rnd })) s = apply(s, x).state;
      if (c) { c.str = keep[0]; c.land = keep[1]; }
      const w = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1;
      res.push([Math.floor(g / per), w < 0 ? .5 : w === seat ? 1 : 0]); }
    parentPort.postMessage(res); });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ai = 'strong', per = '2000', W = '8'] = process.argv.slice(2), P = +per, win = CELLS.map(() => 0), cnt = CELLS.map(() => 0), t0 = Date.now();
  await farm(new URL(import.meta.url), CELLS.length * P, +W, 50, { ai, per: P }, r => { for (const [k, v] of r) { win[k] += v; cnt[k]++; } });
  const rate = k => win[k] / cnt[k], ctl = rate(0), se = Math.sqrt(.25 / P) * 100 * Math.SQRT2;
  const rows = CELLS.slice(1).map((c, i) => ({ ...c, name: CARDS[c.id].name, str: Math.max(1, AMB[c.id] + c.d), pp: +(100 * (rate(i + 1) - ctl)).toFixed(1) }));
  mkdirSync('out/lab', { recursive: true }); writeFileSync('out/lab/ambush.json', JSON.stringify({ ai, per: P, control: ctl, se, rows }, null, 1));
  console.log(`${ai}，每格 ${P} 局，${((Date.now() - t0) / 1000).toFixed(0)} 秒；对照组胜率 ${(100 * ctl).toFixed(1)}%，每格误差约 ±${(1.96 * se).toFixed(1)} 个百分点`);
  for (const id of IDS) console.log(CARDS[id].name.padEnd(5), ...[0, 1].map(land => (land ? '最多一格：' : '落地不动：') + rows.filter(r => r.id === id && r.land === land).map(r => `力${r.str} ${r.pp > 0 ? '+' : ''}${r.pp}`).join('  ')));
}
