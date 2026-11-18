// 从普查里挑出同时带着两张牌的对局，按种子原样重放，打印每回合出了什么、城堡血量。看组合到底怎么赢的。
// 用法：node tools/lab/replay.mjs <普查目录> <牌A> <牌B> [局数=3]
import { readFileSync } from 'node:fs';
import { CARDS, COLS, apply, aiTurn, STRONG, newGame } from '../../chess.js';
import { REC } from './census.mjs';

const [dir, A, B, k = '3'] = process.argv.slice(2), meta = JSON.parse(readFileSync(`${dir}/meta.json`)), ids = meta.ids;
const ia = ids.indexOf(A), ib = ids.indexOf(B); if (ia < 0 || ib < 0) throw new Error('普查里没有这张牌');
const buf = readFileSync(`${dir}/games.bin`), all = new Uint32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4 / REC) * REC);
const lcg = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, nm = id => CARDS[id].name, at = t => `${Math.floor(t / COLS)}行${t % COLS}列`;
let shown = 0;
for (let g = 0; g < all.length / REC && shown < +k; g++) {
  const o = g * REC;
  for (const side of [0, 1]) { const d = Array.from(all.subarray(o + side * 12, o + side * 12 + 12)); if (!d.includes(ia) || !d.includes(ib)) continue;
    const decks = [0, 1].map(p => Array.from(all.subarray(o + p * 12, o + p * 12 + 12), i => ids[i])), rnd = lcg(all[o + 26]);
    console.log(`\n=== 第 ${g} 局：带组合的是${side ? '后手' : '先手'}，结果 ${['先手赢', '后手赢', '平'][all[o + 24]]} ===`);
    decks.forEach((d, p) => console.log(`${p ? '后手' : '先手'}：${d.map(nm).join('、')}`));
    let s = newGame(decks, rnd);
    while (s.winner === null && s.n <= 70) { const me = s.turn, line = [];
      for (const x of aiTurn(s, { ...STRONG, rnd })) { if (x.type === 'play') { const id = s.hand[me][x.i]; line.push((id === A || id === B ? '★' : '') + nm(id) + (x.t >= 0 ? '@' + at(x.t) : '')); } else if (x.type === 'swap') line.push('换牌'); s = apply(s, x).state; }
      console.log(`回合${s.n - 1} ${me ? '后手' : '先手'}：${line.join('，') || '（没出牌）'}  → 城堡 ${s.base.join(':')}`); }
    shown++; break; }
}
