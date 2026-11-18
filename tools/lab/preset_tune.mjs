// 预设递归调牌的一轮：12 套预设两两对打（每局给双方所有棋子的战力随机 −1/0/+1），
// 测出每套的胜率，以及每张棋子在它那套里"加减 1 点战力，这套胜率变多少"（斜率）；
// 再给超出范围的预设挑牌：优先挑只属于这个阵营、不在别的预设里、斜率大的棋子，每张每轮最多 ±1，调到预计回到中线附近。
// 用法：node tools/lab/preset_tune.mjs <电脑> <每对局数> <线程数> [下限=40] [上限=60] [输出路径=out/lab/preset_round.json] [--apply]
//   --apply：把挑出来的改动直接加进 chess-tune.js；不加就只打印
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CARDS, DECKS, FACTIONS, newGame, apply, aiTurn } from '../../chess.js';
import { makeAI, lcg, farm } from './play.mjs';

const K = DECKS.length, PAIRS = []; for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) PAIRS.push([a, b]);
const piece = k => CARDS[k].kind !== 'spell' && CARDS[k].str !== undefined;
if (!isMainThread) {
  const ai = makeAI(workerData.ai), per = workerData.per;
  parentPort.on('message', ({ from, n }) => { const res = [];
    for (let g = from; g < from + n; g++) { const [a, b] = PAIRS[Math.floor(g / per)], aFirst = (g & 1) === 0, seed = (777 + g) * 2654435761 >>> 0, rnd = lcg(seed), dr = lcg(seed ^ 0x9e3779b9);
      const dl = {}; for (const k of new Set([...DECKS[a].cards, ...DECKS[b].cards])) { if (!piece(k)) continue; let x = Math.floor(dr() * 3) - 1; if (CARDS[k].str <= 1) x = 0; /* 战力 1 的牌只能加不能减，抖了会白送战力、把胜率测高，所以不抖 */ dl[k] = x; CARDS[k].str += x; }
      let s = newGame(aFirst ? [DECKS[a].cards, DECKS[b].cards] : [DECKS[b].cards, DECKS[a].cards], rnd);
      while (s.winner === null && s.n <= 70) for (const x of aiTurn(s, { ...ai, rnd })) s = apply(s, x).state;
      for (const k in dl) CARDS[k].str -= dl[k];
      const w = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1;
      res.push([a, b, w < 0 ? .5 : (w === 0) === aFirst ? 1 : 0, DECKS[a].cards.map(k => dl[k] ?? 0), DECKS[b].cards.map(k => dl[k] ?? 0)]); }
    parentPort.postMessage(res); });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), doApply = args.includes('--apply'), [ai = 'strong', per = '800', W = '20', lo = '40', hi = '60', outPath = 'out/lab/preset_round.json'] = args.filter(x => x !== '--apply'), t0 = Date.now(), games = [];
  await farm(new URL(import.meta.url), PAIRS.length * +per, +W, 20, { ai, per: +per }, r => games.push(...r));
  // 胜率
  const win = Array(K).fill(0), cnt = Array(K).fill(0); for (const [a, b, wa] of games) { win[a] += wa; cnt[a]++; win[b] += 1 - wa; cnt[b]++; }
  const rate = i => 100 * win[i] / cnt[i];
  // 斜率：逻辑回归，每套一个强弱分 + 每套里每张棋子一个斜率
  const sig = z => 1 / (1 + Math.exp(-z)), dk = Array(K).fill(0), sl = DECKS.map(d => d.cards.map(() => 0));
  for (let e = 0; e < 6; e++) for (const [a, b, wa, ja, jb] of games) { let z = dk[a] - dk[b]; ja.forEach((x, i) => (z += sl[a][i] * x)); jb.forEach((x, i) => (z -= sl[b][i] * x));
    const err = sig(z) - wa, lr = .02; dk[a] -= lr * err; dk[b] += lr * err; ja.forEach((x, i) => { if (x) sl[a][i] -= lr * err * x; }); jb.forEach((x, i) => { if (x) sl[b][i] += lr * err * x; }); }
  const pp = x => 25 * x; // 50% 附近，逻辑值 → 百分点
  // 一张牌在几套预设里
  const inPresets = {}; for (const d of DECKS) for (const k of d.cards) inPresets[k] = (inPresets[k] || 0) + 1;
  const { TUNE } = await import('../../chess-tune.js'), plan = [];
  console.log(`${ai}，每对 ${per} 局（战力抖动），${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  for (const i of [...Array(K).keys()].sort((x, y) => rate(y) - rate(x))) { const d = DECKS[i], r = rate(i), name = `${FACTIONS[d.f].name}·${d.name}`;
    const out = r > +hi ? -1 : r < +lo ? 1 : 0; let line = `${r.toFixed(1).padStart(5)}%  ${name}`;
    if (out) { const need = Math.abs(r - 50) * .7; // 每轮只走七成，免得来回晃
      const cand = d.cards.map((k, j) => ({ k, s: pp(sl[i][j]) })).filter(x => piece(x.k) && !CARDS[x.k].boss && !CARDS[x.k].prize && !CARDS[x.k].hand && (out > 0 || CARDS[x.k].str > 1) && x.s > 0)
        .sort((x, y) => (CARDS[x.k].faction === 'n') - (CARDS[y.k].faction === 'n') || inPresets[x.k] - inPresets[y.k] || y.s - x.s);
      let got = 0; const picks = []; for (const c of cand) { if (got >= need) break; if (plan.some(p => p.k === c.k)) continue; picks.push(c); got += c.s; }
      for (const c of picks) plan.push({ k: c.k, d: out, deck: name, s: c.s });
      line += `  → ${out > 0 ? '加' : '减'} ${picks.map(c => `${CARDS[c.k].name}(${CARDS[c.k].str}→${CARDS[c.k].str + out}，每点 ${c.s.toFixed(1)})`).join('、')}，预计 ${out > 0 ? '+' : '−'}${got.toFixed(0)}`; }
    console.log(line); }
  writeFileSync(outPath, JSON.stringify({ ai, per: +per, rates: DECKS.map((d, i) => ({ name: d.name, rate: +rate(i).toFixed(1) })), slopes: DECKS.map((d, i) => d.cards.map((k, j) => [k, +pp(sl[i][j]).toFixed(2)])), plan }, null, 1));
  if (doApply && plan.length) { for (const p of plan) TUNE[p.k] = (TUNE[p.k] || 0) + p.d; const f = new URL('../../chess-tune.js', import.meta.url); writeFileSync(f, readFileSync(f, 'utf8').replace(/export const TUNE = .*;\n/, 'export const TUNE = ' + JSON.stringify(TUNE) + ';\n')); console.log(`已写进 chess-tune.js：${plan.length} 张`); }
}
