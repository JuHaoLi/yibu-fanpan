// 实验共用：按名字造电脑、抽卡组、多线程分活。
// 电脑写法："strong" = 现在的最强电脑；"net:<权重文件>[@倍数]" = 整回合搜索 + 价值网络评分；"beam4" 等 = 窄搜索
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { DECKS, STRONG, EVAL, evaluate } from '../../chess.js';
import { randomDeck } from './census.mjs';
import { fromJSON, valueFn, mixAI } from './net.mjs';

export function makeAI(spec) {
  if (spec === 'strong') return { ...STRONG };
  if (/^beam\d+$/.test(spec)) return { deep: true, beam: +spec.slice(4) };
  const m = /^net:([^@]+)(?:@([\d.]+))?(?:#(\d+))?$/.exec(spec); // #n：搜索宽度，默认和最强电脑一样
  if (m) return { beam: m[3] ? +m[3] : STRONG.beam, value: valueFn(fromJSON(readFileSync(m[1], 'utf8')), m[2] ? +m[2] : 10) };
  const x = /^mix:([^@]+)@([\d.]+)(?:#(\d+))?$/.exec(spec); // 手写评分 + 倍数 × 网络 logit；#n 搜索宽度
  if (x) return { ...mixAI(fromJSON(readFileSync(x[1], 'utf8')), +x[2]), ...(x[3] ? { beam: +x[3] } : {}) };
  throw new Error('不认识的电脑：' + spec);
}
// 卡组：四分之一用预设，其余随机合法卡组
export const pickDeck = rnd => rnd() < .25 ? [...DECKS[Math.floor(rnd() * DECKS.length)].cards] : randomDeck(rnd);
export const lcg = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

// 把 total 份活按 chunk 分给 W 个线程，每份做完回调 onPart，全部做完 resolve
export function farm(url, total, W, chunk, data, onPart) {
  return new Promise((ok, no) => { let next = 0, alive = W;
    for (let i = 0; i < W; i++) { const w = new Worker(url, { workerData: data });
      const feed = () => { if (next >= total) { w.terminate(); if (--alive === 0) ok(); return; } const n = Math.min(chunk, total - next); w.postMessage({ from: next, n }); next += n; };
      w.on('message', r => { onPart(r); feed(); }); w.on('error', no); feed(); } });
}
