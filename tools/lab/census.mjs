// 组合普查：随机组出大量合法卡组（一个阵营 + 0–12 张中立，首领牌最多一张，奖励牌也算中立），两边都用最强电脑对打，
// 把每局的两副牌、胜负、种子存下来（种子能把这一局原样重放），再顺手记每张牌打出那一步局面评分涨了多少。
// 用法：node tools/lab/census.mjs [局数=200000] [线程数=核数-1] [输出目录=out/lab/census] [电脑=strong] [抖动=0]
// 抖动=1：每局给两副牌里每张棋子的战力随机 −1/0/+1（同一局两边同一张牌一样），记进 jitter.bin（每局 24 个 int8，和牌的位置对应），用来测"1 点战力值多少胜率"
// 输出：games.bin（每局 27 个 uint32：先手 12 张牌、后手 12 张牌、结果 0 先手赢 / 1 后手赢 / 2 平、回合数、种子）、meta.json
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makeAI } from './play.mjs';
import { CARDS, DECK, STRONG, EVAL, newGame, apply, aiTurn, evaluate, deckError } from '../../chess.js';

export const IDS = Object.keys(CARDS).filter(k => !CARDS[k].token);
const IX = Object.fromEntries(IDS.map((k, i) => [k, i]));
export const REC = 27;
const ALL = IDS; // 全部牌都当成已获得
const lcg = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const FS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
const POOL = Object.fromEntries([...FS, 'n'].map(f => [f, IDS.filter(k => CARDS[k].faction === f)]));

export function randomDeck(rnd, fixF = null) { // 阵营均匀抽（fixF 指定阵营）；中立张数 0–12 均匀抽（12 张就是纯中立）
  const f = fixF ?? FS[Math.floor(rnd() * FS.length)], k = Math.floor(rnd() * (DECK + 1));
  for (;;) {
    const pick = (pool, n) => { const a = [...pool]; for (let i = 0; i < n; i++) { const j = i + Math.floor(rnd() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
    const d = [...pick(POOL[f], DECK - k), ...pick(POOL.n, k)];
    if (!deckError(d, ALL)) return d; // 不合法（两张首领）就重抽
  }
}

// 一局：返回 [结果, 回合数]，并把每次出牌的局面评分变化记进 sum/cnt
export function playGame(seed, d0, d1, sum, cnt, ai = STRONG) {
  const rnd = lcg(seed); let s = newGame([d0, d1], rnd), turns = 0;
  while (s.winner === null && s.n <= 70) {
    const me = s.turn;
    for (const x of aiTurn(s, { ...ai, rnd })) {
      if (x.type === 'play' && sum) { const id = s.hand[me][x.i], before = evaluate(s, me, EVAL), r = apply(s, x).state; // 评分里赢一局是 1e6，截到 ±30
        const dv = Math.max(-30, Math.min(30, evaluate(r, me, EVAL) - before)); sum[IX[id]] += dv; cnt[IX[id]]++; s = r; }
      else s = apply(s, x).state;
    }
    turns++;
  }
  const res = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : 2;
  return [res, turns];
}

if (!isMainThread && workerData?.census) { // 只在普查自己的线程里接活（别的脚本 import 这个文件时不接）
  const ai = makeAI(workerData.ai || 'strong'), jit = workerData.jitter;
  parentPort.on('message', ({ from, n, base }) => {
    const jo = new Int8Array(n * 24), out = new Uint32Array(n * REC), sum = new Float64Array(IDS.length), cnt = new Uint32Array(IDS.length);
    for (let g = 0; g < n; g++) {
      const seed = (base + from + g) * 2654435761 >>> 0, rnd = lcg(seed ^ 0x9e3779b9), d0 = randomDeck(rnd), d1 = randomDeck(rnd);
      const dl = {}; if (jit) for (const k of new Set([...d0, ...d1])) { const c = CARDS[k]; if (c.kind === 'spell' || c.str === undefined) continue; let x = Math.floor(rnd() * 3) - 1; if (c.str + x < 1) x = 0; dl[k] = x; c.str += x; }
      const [res, turns] = playGame(seed, d0, d1, sum, cnt, ai), o = g * REC;
      for (const k in dl) CARDS[k].str -= dl[k]; [...d0, ...d1].forEach((k, i) => (jo[g * 24 + i] = dl[k] ?? 0));
      d0.forEach((k, i) => (out[o + i] = IX[k])); d1.forEach((k, i) => (out[o + 12 + i] = IX[k])); out[o + 24] = res; out[o + 25] = turns; out[o + 26] = seed;
    }
    parentPort.postMessage({ out, sum, cnt, jo }, [out.buffer, jo.buffer]);
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) { // 被别的脚本 import 时不跑
  const G = +(process.argv[2] ?? 200000), W = +(process.argv[3] ?? Math.max(1, availableParallelism() - 1)), dir = process.argv[4] ?? 'out/lab/census', AI = process.argv[5] ?? 'strong', JIT = process.argv[6] === '1', CHUNK = 200;
  mkdirSync(dir, { recursive: true });
  const fd = openSync(`${dir}/games.bin`, 'w'), fj = openSync(`${dir}/jitter.bin`, 'w'), sum = new Float64Array(IDS.length), cnt = new Float64Array(IDS.length), t0 = Date.now();
  const rules = createHash('sha1').update(readFileSync(new URL('../../chess-cards.js', import.meta.url))).update(readFileSync(new URL('../../chess.js', import.meta.url))).update(readFileSync(new URL('../../chess-tune.js', import.meta.url))).digest('hex').slice(0, 12);
  let next = 0, done = 0, alive = W; const base = 1;
  const meta = () => writeFileSync(`${dir}/meta.json`, JSON.stringify({ games: done, rules, ai: AI, jitter: JIT, ids: IDS, playSum: [...sum], playCnt: [...cnt], seconds: (Date.now() - t0) / 1000 }));
  for (let i = 0; i < W; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { census: true, ai: AI, jitter: JIT } });
    const feed = () => { if (next >= G) { w.terminate(); if (--alive === 0) { closeSync(fd); closeSync(fj); meta(); console.log(`完成 ${done} 局，${((Date.now() - t0) / 1000).toFixed(0)} 秒，规则版本 ${rules}`); } return; } const n = Math.min(CHUNK, G - next); w.postMessage({ from: next, n, base }); next += n; };
    w.on('message', r => { writeSync(fd, new Uint8Array(r.out.buffer)); writeSync(fj, new Uint8Array(r.jo.buffer)); for (let k = 0; k < IDS.length; k++) { sum[k] += r.sum[k]; cnt[k] += r.cnt[k]; } done += r.out.length / REC;
      if (done % 20000 < CHUNK) { meta(); console.log(`${done}/${G} 局，${((Date.now() - t0) / 1000).toFixed(0)} 秒`); } feed(); });
    w.on('error', e => { console.error(e); process.exit(1); });
    feed();
  }
}
