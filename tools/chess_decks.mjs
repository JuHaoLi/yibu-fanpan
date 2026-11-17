// 预设卡组互打：每两套各打若干局（轮流先手），看每套的总胜率，防止某一套预设明显太强或太弱。
// 用法：node tools/chess_decks.mjs [每对局数=40]
import { DECKS, FACTIONS, newGame, apply, aiTurn, deckError, deckInsight } from '../chess.js';
const per = +(process.argv[2] ?? 40); let seed = 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const win = DECKS.map(() => 0), tot = DECKS.map(() => 0);
for (let a = 0; a < DECKS.length; a++) for (let b = a + 1; b < DECKS.length; b++) for (let g = 0; g < per; g++) {
  const first = g % 2 ? b : a, second = g % 2 ? a : b; let s = newGame([DECKS[first].cards, DECKS[second].cards], rnd);
  while (s.winner === null && s.n <= 70) for (const x of aiTurn(s)) s = apply(s, x).state;
  if (s.winner === null) continue; tot[a]++; tot[b]++; win[s.winner === 0 ? first : second]++;
}
for (const [i, d] of DECKS.entries()) { const bad = deckInsight(d.cards).filter(x => !x.ok).length; console.log(`${(100 * win[i] / tot[i]).toFixed(0).padStart(3)}%  ${FACTIONS[d.f].name}·${d.name}${deckError(d.cards) ? '  不合法！' : ''}${bad ? `  体检有 ${bad} 条提醒` : ''}`); }
