// 老师用的前瞻工具（只给离线训练用，不能当游戏里的电脑：determinize 用了对面真实的 12 张牌表，只打乱手牌和牌序）。
// 导出：
//   determinize(E, opp, rnd)：E 是我刚结束回合的局面（E.turn === opp）。对面的手牌 + 牌库混洗重发（张数不变），抽牌种子换新的；其余不动
//   candidates(s, net, K[, ai])：轮到我出牌的局面 → 最多 K 个不同的整回合候选 {acts, end}；第 0 个就是大师电脑（mixAI(net,20)）自己的选择
//   qValue(end, me, net, M, oppAI, rnd)：M 次抽样推演对面这一回合，平均"我最后赢"的概率
// 用法（自检）：node tools/lab/lookahead.mjs --selftest
// chess.js 的 plan()/dead()/keyOf 没导出，这里照抄同样逻辑（chess.js 改了这三处要同步）
import { pathToFileURL } from 'node:url';
import { CARDS, newGame, apply, aiTurn, legalPlays, targets } from '../../chess.js';
import { encode, L, scratch, forward, clear, mixAI, initNet } from './net.mjs';
import { pickDeck, lcg } from './play.mjs';

const keyOf = (s, me) => s.left + '|' + s.hand[me].join() + '|' + s.base.join() + '|' + s.core.join() + '|' + s.board.map(u => u ? u.card + u.side + u.str + (u.shield ? 's' : '') + (u.frozen ? 'f' : '') : '').join();
const cost = id => CARDS[id].cost, END = { type: 'end' };
const play = (s, acts) => { for (const a of acts) s = apply(s, a).state; return s; };
const sig = z => 1 / (1 + Math.exp(-z));

export function determinize(E, opp, rnd) {
  const D ={ ...E, hand: E.hand.map(h => [...h]), deck: E.deck.map(d => [...d]), used: E.used.map(u => [...u]), board: E.board.map(u => u && { ...u }), base: [...E.base], mana: [...E.mana], core: [...E.core], rage: [...E.rage], creep: [...E.creep], shade: [...E.shade] };
  const pool = [...D.hand[opp], ...D.deck[opp]], nh = D.hand[opp].length;
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  D.hand[opp] = pool.slice(0, nh); D.deck[opp] = pool.slice(nh);
  let seed = Math.floor(rnd() * 4294967296) >>> 0; if (seed === E.seed) seed = (seed ^ 1) >>> 0; D.seed = seed; // 原种子会泄露后面抽到哪张
  return D;
}

// dead()：现在出不了的牌里最贵的那张（首领牌不换），照 aiTurn
function dead(s, me) { const h = s.hand[me]; let b = -1; h.forEach((id, k) => { if (!CARDS[id].boss && !targets(s, k).length && (b < 0 || cost(id) > cost(h[b]))) b = k; }); return b; }

// plan() 的 top-K 版：同样的整回合组合搜索和附加分，但把所有展开过的节点（含"什么都不打"）收集起来按评分排序
function planAll(s0, me, beamW, value) {
  const all = [], seen = new Set();
  const node = (s, acts, b) => { const k = keyOf(s, me); if (seen.has(k)) return null; seen.add(k);
    const end = s.winner === null ? apply(s, END).state : s, v = (s.winner === me ? 2e6 : s.winner === null ? value(end, me) : value(s, me)) + b, n = { s, acts, b, v, end, k }; all.push(n); return n; };
  node(s0, [], 0); let beam = [{ s: s0, acts: [], b: 0 }];
  for (let d = 0; d < 8 && beam.length; d++) { const next = [];
    for (const n of beam) for (const a of legalPlays(n.s)) { const id = n.s.hand[me][a.i], r = apply(n.s, a).state;
      const b = n.b + 1.2 * (r.left - (n.s.left - cost(id))) + (r.hand[me].length - (n.s.hand[me].length - 1)) - (CARDS[id].hold?.(n.s, me) ? 9 : 0);
      const x = node(r, [...n.acts, a], b); if (x) next.push(x); }
    next.sort((x, y) => y.v - x.v); beam = next.filter(n => n.s.winner === null).slice(0, beamW); }
  return all.sort((x, y) => y.v - x.v);
}

export function candidates(s, net, K, ai = mixAI(net, 20)) {
  const me = s.turn, a0 = aiTurn(s, { ...ai, rnd: () => .5 }), e0 = play(s, a0); // 满强度时 rnd 只用来判斩杀，不影响选择
  const c0 = { acts: a0, end: e0 }; if (e0.winner === me || K <= 1) return [c0]; // 能斩杀就只给这一个
  const out = [c0], used = new Set([keyOf(e0, me)]); // 按回合结束后的局面去重：落点不同、被对面前进挤成一样的算同一个
  let t = s; const head = []; const i = dead(t, me); if (!t.swapped && i >= 0 && t.deck[me].length) { head.push({ type: 'swap', i }); t = apply(t, head[0]).state; } // 开头换牌照 aiTurn
  for (const n of planAll(t, me, ai.beam, ai.value)) { if (out.length >= K) break; const k = keyOf(n.end, me); if (used.has(k)) continue; used.add(k);
    out.push({ acts: [...head, ...n.acts, ...(n.s.winner === null ? [END] : [])], end: n.end }); }
  return out;
}

const W = new WeakMap(); // 每个网络一份工作内存
const over = F => F.winner !== null || F.n > 70; // 70 回合打满就按城堡血量判
const judge = (F, me) => F.winner !== null ? (F.winner === me ? 1 : 0) : F.base[me] > F.base[1 - me] ? 1 : F.base[me] < F.base[1 - me] ? 0 : .5;
export function qValue(end, me, net, M, oppAI, rnd) {
  if (over(end)) return judge(end, me);
  let w = W.get(net); if (!w) W.set(net, w = { w: scratch(net), e: new Int16Array(L) });
  const opp = 1 - me; let q = 0;
  for (let m = 0; m < M; m++) { let F = determinize(end, opp, rnd); for (const x of aiTurn(F, { ...oppAI, rnd })) F = apply(F, x).state;
    if (over(F)) q += judge(F, me); else { encode(F, opp, w.e); const z = forward(net, w.e, w.w); clear(w.w); q += 1 - sig(z); } }
  return q / M;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--selftest')) {
  const assert = (c, m) => { if (!c) throw new Error('自检失败：' + m); };
  const net = initNet(lcg(7)), ai = mixAI(net, 20), rnd = lcg(99), ms = a => [...a].sort().join();
  let checked = 0, cands = 0;
  for (let g = 0; g < 3; g++) { const dr = lcg(1000 + g); let s = newGame([pickDeck(dr), pickDeck(dr)], lcg(2000 + g));
    while (s.winner === null && s.n <= 14) { const me = s.turn, cs = candidates(s, net, 5, ai);
      assert(JSON.stringify(cs[0].acts) === JSON.stringify(aiTurn(s, { ...ai, rnd: Math.random })), '第 0 个候选和 aiTurn 不一致');
      const ks = cs.map(c => keyOf(c.end, me)); assert(new Set(ks).size === ks.length, '候选有重复');
      for (const c of cs) { assert(JSON.stringify(play(s, c.acts)) === JSON.stringify(c.end), '候选的 end 和动作对不上'); const q = qValue(c.end, me, net, 2, { deep: true, beam: 4 }, rnd); assert(q >= 0 && q <= 1, 'Q 越界 ' + q); }
      if (cs[0].end.winner === null) { const o = { deep: true, beam: 4 }; assert(qValue(cs[0].end, me, net, 2, o, lcg(5 + s.n)) === qValue(cs[0].end, me, net, 2, o, lcg(5 + s.n)), '同一组随机数要给同一个 Q（teacher 靠这个让各候选共用抽样）'); }
      cands += cs.length;
      const E = cs[0].end; if (E.winner === null) { const opp = E.turn, D = determinize(E, opp, rnd);
        assert(ms([...D.hand[opp], ...D.deck[opp]]) === ms([...E.hand[opp], ...E.deck[opp]]), '对面牌的多重集合变了');
        assert(D.hand[opp].length === E.hand[opp].length && D.deck[opp].length === E.deck[opp].length, '张数变了');
        assert(D.seed !== E.seed, 'seed 没换'); assert(JSON.stringify(D.hand[me]) === JSON.stringify(E.hand[me]) && JSON.stringify(D.board) === JSON.stringify(E.board), '我方或场面被动了'); checked++; }
      s = cs[0].end; } }
  assert(checked > 10 && cands > checked, '样本太少');
  console.log(`检查了 ${checked} 个回合，平均 ${(cands / checked).toFixed(1)} 个候选`); console.log('自检通过');
}
