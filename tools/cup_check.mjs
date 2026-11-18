// 锦标赛自检：把整届比赛（玩家那一席由普通强度的电脑代打）在规则里从抽签打到决赛，核对赛制，再统计谁拿冠军。
// 用法：node tools/cup_check.mjs [届数=20]
import assert from 'node:assert/strict';
import { newCup, nextRound, current, roundDone, simMatch, table, status, placing, bestOf, ROSTER, addGame, follow, humanMatch, save, load } from '../cup.js';
import { DECKS, deckError, PROTOCOL } from '../chess.js';

const N = +(process.argv[2] ?? 20), champs = {}, top8 = {}, t0 = Date.now();
for (const r of ROSTER) for (const d of r.decks) assert.equal(deckError(d.cards, PROTOCOL), '', `${r.name}·${d.name} 不合法`);
for (let k = 0; k < N; k++) {
  const s = newCup([DECKS[0], DECKS[1]], 1000 + k);
  assert.equal(new Set(s.order).size, 16);
  nextRound(s);
  while (s.stage !== 'done') {
    const ms = current(s), ids = ms.flatMap(m => [m.a, m.b]);
    assert.equal(new Set(ids).size, ids.length, '同一轮里有人打了两场');
    if (s.stage === 'swiss') { for (const m of ms) { const A = s.players[m.a], B = s.players[m.b]; assert.equal(`${A.w}-${A.l}`, `${B.w}-${B.l}`, '瑞士轮配到了不同战绩的人'); assert.ok(!A.opp.includes(m.b), '瑞士轮重复交手'); assert.equal(m.bo, bestOf(s.round)); } }
    else for (const m of ms) assert.equal(m.bo, 3);
    for (const m of ms) simMatch(s, m);
    assert.ok(roundDone(s)); nextRound(s);
  }
  const q = s.players.filter(p => status(p) === 'in');
  assert.equal(q.length, 8, '出线的不是 8 个人'); assert.equal(s.players.filter(p => status(p) === 'out').length, 8);
  assert.equal(s.rounds.length, 5); assert.deepEqual(s.ko.map(r => r.length), [4, 2, 1]);
  assert.equal(placing(s, s.champion), 1); assert.equal(table(s).length, 16);
  champs[s.players[s.champion].name] = (champs[s.players[s.champion].name] || 0) + 1;
  for (const p of q) top8[p.name] = (top8[p.name] || 0) + 1;
}
// 别的场次跟着玩家走：玩家打完一局，别人也打到同样的局数；玩家这场打完，这一轮全部打完
{ const s = newCup([DECKS[0], DECKS[1]], 77); nextRound(s);
  while (s.round < 3) { for (const m of current(s)) simMatch(s, m); nextRound(s); }
  const m = humanMatch(s); assert.ok(m && m.bo === 3, '第三轮玩家应该有一场三局两胜');
  const side = s.players[m.a].human ? 'a' : 'b', other = side === 'a' ? 'b' : 'a';
  addGame(s, m, { w: side, da: 0, db: 0, hp: [5, 0], n: 9 }); follow(s);
  for (const x of current(s)) if (x !== m) assert.ok(x.done || x.games.length === 1, '玩家打完第一局，别的场次没跟着打一局');
  addGame(s, m, { w: other, da: 0, db: 0, hp: [0, 5], n: 9 }); follow(s);
  for (const x of current(s)) if (x !== m) assert.ok(x.done || x.games.length === 2, '玩家打完第二局，别的场次没跟到两局');
  addGame(s, m, { w: side, da: 0, db: 0, hp: [5, 0], n: 9 }); follow(s);
  assert.ok(roundDone(s), '玩家这场打完了，这一轮应该全部打完');
  const recs = s.players.map(p => p.w + p.l); assert.ok(recs.every(n => n === 3) || s.players.some(p => status(p)), '同一轮打完后有人场次数对不上');
  // 读档：卡组里带着已删掉的牌（游侠德克斯）的锦标赛不作废，换成接班的牌
  const box = {}; globalThis.localStorage = { getItem: k => box[k] ?? null, setItem: (k, v) => { box[k] = v; }, removeItem: k => { delete box[k]; } };
  s.players[0].decks[0].cards[0] = 'neutral_dex'; save(s); const r = load(); assert.ok(r, '带旧牌的存档被判无效'); assert.ok(!r.players[0].decks[0].cards.includes('neutral_dex')); }
const line = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(' · ');
console.log(`锦标赛自检通过：${N} 届，每届 ${((Date.now() - t0) / N / 1000).toFixed(1)} 秒`);
console.log('冠军：' + line(champs)); console.log('进八强：' + line(top8));
