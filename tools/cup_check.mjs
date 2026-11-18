// 锦标赛自检：把整届比赛（玩家那一席由普通强度的电脑代打）在规则里从抽签打到决赛，核对赛制，再统计谁拿冠军。
// 用法：node tools/cup_check.mjs [届数=20]
import assert from 'node:assert/strict';
import { newCup, nextRound, current, roundDone, simMatch, table, status, placing, bestOf, ROSTER } from '../cup.js';
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
const line = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(' · ');
console.log(`锦标赛自检通过：${N} 届，每届 ${((Date.now() - t0) / N / 1000).toFixed(1)} 秒`);
console.log('冠军：' + line(champs)); console.log('进八强：' + line(top8));
