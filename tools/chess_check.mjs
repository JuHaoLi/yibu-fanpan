// 下棋规则自检：node tools/chess_check.mjs
// 先逐条验规则和各阵营的独有机制，再让电脑用随机卡组打几千局，确认每张牌都被打出过、全程不出错。
// 平衡统计和数值微调在 tools/chess_tune.mjs。
import assert from 'node:assert/strict';
import { CARDS, FACTIONS, STARTERS, FKEYS, newGame, apply, aiTurn, legalPlays, forecast, frontDepth, deckError, targets, tile, COLS, ROWS, HAND, DECK, BASE_HP, SHADE } from '../chess.js';
import { LESSON, keepOrder, stepOk, foeTurn } from '../tutorial.js';
import { existsSync } from 'node:fs';
import { allIds, idsFor, BOSS } from '../board-pfx.js';
// 像素特效的对照表（board-pfx.js）：表里每个名字在 vendor/pixelfx/fx 里都得有文件；十一位首领各有一套；一场对局要预载的不超过 70 个
{ const miss = allIds().filter(id => !existsSync(new URL(`../vendor/pixelfx/fx/${id}.js`, import.meta.url))); assert.deepEqual(miss, [], '像素特效表里有名字找不到文件');
  for (const k of Object.keys(CARDS).filter(k => CARDS[k].boss)) assert.ok(BOSS[k]?.hit?.length && BOSS[k].cast && BOSS[k].die && BOSS[k].enter, `首领 ${k} 的专属特效不全`);
  assert.ok(idsFor(['f1', 'f4', 'n'], ['B_f4']).length <= 70); }

let seed = 9; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const sh = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ids = Object.keys(CARDS).filter(k => !CARDS[k].token && !CARDS[k].boss), pool = f => ids.filter(k => CARDS[k].faction === f);
const deck = f => [...sh(pool(f)).slice(0, 9), ...sh(pool('n')).slice(0, 3)];
const V = 'neutral_golemstone'; // 测试里的假人：没有能力的石魔像，战力每次自己指定
const put = (s, t, side, card = V, str = CARDS[card].str, extra = {}) => { s.board[t] = { id: s.uid++, side, card, str, frozen: false, shield: !!CARDS[card].shield, ...extra }; return s.board[t]; };
const blank = () => newGame([deck('f1'), deck('f4')], rnd);
const play = (s, card, t) => { s.hand[s.turn][0] = card; s.left = 20; return apply(s, { type: 'play', i: 0, t }); };
const endAs = (s, side) => { s.turn = 1 - side; return apply(s, { type: 'end' }); }; // 轮到 side：先结算回合开始，再各走一步
const at = (r, t) => r.state.board[t];

// ---- 核心规则 ----
{ let s = blank(); put(s, tile(1, 0), 0, V, 5); put(s, tile(2, 0), 1, V, 3); let r = endAs(s, 0); assert.equal(at(r, tile(2, 0)).str, 2, '对撞：5 打 3，赢家剩 2 并占格'); assert.equal(at(r, tile(2, 0)).side, 0); assert.equal(at(r, tile(1, 0)), null);
  s = blank(); put(s, tile(1, 0), 0, V, 3); put(s, tile(2, 0), 1, V, 3); r = endAs(s, 0); assert.ok(!at(r, tile(1, 0)) && !at(r, tile(2, 0)), '打平同归于尽'); }
{ let s = blank(); put(s, tile(1, 1), 0, V, 9); put(s, tile(1, 0), 1, V, 1, { frozen: true }); put(s, tile(1, 2), 1, V, 1, { frozen: true });
  assert.ok(!forecast(s, 0).some(e => e.t === 'attack'), '已经在场上的单位只往前走，不拐去打旁边的'); assert.ok(forecast(s, 0).some(e => e.t === 'move' && e.to === tile(2, 1)));
  put(s, tile(2, 1), 1, V, 1); assert.equal(forecast(s, 0).find(e => e.t === 'attack').to, tile(2, 1), '正前有人就打正前');
  s = blank(); put(s, tile(1, 3), 0); put(s, tile(1, 0), 1, V, 1); put(s, tile(1, 2), 1, V, 1); let r = play(s, 'neutral_jaxi', tile(1, 1)); assert.equal(r.events.find(e => e.t === 'attack').to, tile(1, 2), '冲锋时正前没人：先打靠中间的一侧');
  put(s, tile(2, 1), 1, V, 1); r = play(s, 'neutral_jaxi', tile(1, 1)); assert.equal(r.events.find(e => e.t === 'attack').to, tile(2, 1), '冲锋时正前有人就打正前'); }
{ const s = blank(); put(s, tile(ROWS - 1, 3), 0, V, 4); const r = endAs(s, 0); assert.equal(r.state.base[1], BASE_HP - 4, '走到头按战力打城堡'); assert.equal(at(r, tile(ROWS - 1, 3)), null); }
{ const s = blank(); assert.equal(frontDepth(s, 0), 0, '开局只能放在紧挨城堡的那一行'); put(s, tile(2, 1), 0); assert.equal(frontDepth(s, 0), 2); put(s, tile(ROWS - 1, 0), 0); assert.equal(frontDepth(s, 0), ROWS - 2, '前线最远到对方家门口前一行');
  s.hand[0][0] = V; s.left = 9; const ts = legalPlays(s).filter(a => a.i === 0).map(a => a.t); assert.ok(ts.includes(tile(ROWS - 2, 2)) && !ts.includes(tile(ROWS - 1, 2)) && !ts.includes(tile(2, 1))); }
{ let s = blank(); assert.equal(s.left, 3); s = apply(s, { type: 'end' }).state; assert.equal(s.left, 4, '后手第一回合多 1 点'); for (let i = 0; i < 13; i++) s = apply(s, { type: 'end' }).state; assert.equal(s.mana[0], s.mana[1], '补偿有期限，后面两边能量一样');
  for (const p of [0, 1]) { assert.equal(s.hand[p].length, HAND); assert.equal(s.hand[p].length + s.deck[p].length + s.used[p].length, DECK, '手牌、牌库、这回合用掉的，加起来十二张'); } }
{ assert.equal(deckError(STARTERS.f1), ''); assert.ok(deckError(STARTERS.f1.slice(1))); assert.ok(deckError([...STARTERS.f1.slice(1), STARTERS.f1[1]])); assert.ok(deckError([...STARTERS.f1.slice(1), 'maehv']), '不能混两个阵营'); assert.ok(deckError([...STARTERS.f4.slice(1), 'wraith']), '衍生物不能带');
  for (const f of FKEYS) { assert.equal(deckError(STARTERS[f]), ''); assert.ok(pool(f).length >= 40, `${FACTIONS[f].name} 至少 40 张`); } }

// ---- 各阵营的独有机制 ----
{ let s = blank(), r; // 圣辉：圣盾、列阵、守护
  put(s, tile(1, 0), 0, V, 2, { shield: true }); put(s, tile(2, 0), 1, V, 9); r = endAs(s, 0); assert.equal(at(r, tile(1, 0)).str, 2, '圣盾挡下对撞的伤害'); assert.equal(at(r, tile(1, 0)).shield, false); assert.equal(at(r, tile(2, 0)).str, 7);
  s = blank(); put(s, tile(1, 1), 1, V, 9, { shield: true }); r = play(s, 'f1s_smite', tile(1, 1)); assert.equal(at(r, tile(1, 1)).str, 9, '圣盾也挡法术'); assert.equal(at(r, tile(1, 1)).shield, false);
  const strOf = (r, card) => r.state.board.find(u => u && u.card === card).str, alone = strOf(play(blank(), 'f1_friendsguard', tile(0, 1)), 'f1_friendsguard');
  s = blank(); put(s, tile(0, 0), 0); put(s, tile(1, 1), 0); r = play(s, 'f1_friendsguard', tile(0, 1)); assert.equal(strOf(r, 'f1_friendsguard'), alone + 2, '列阵：相邻两个友军 +2');
  s = blank(); put(s, tile(0, 1), 0, V, 3); put(s, tile(1, 1), 0, 'warden', 9); s.turn = 1; r = play(s, 'ballista', tile(ROWS - 1, 1)); assert.equal(at(r, tile(0, 1)).str, 2, '守护：身前的卫士替他挡一半'); }
{ let s = blank(), r; // 深渊：影灵、暗影地格、相邻倒下、献祭
  put(s, tile(1, 0), 0); r = play(s, 'f4_swarm', tile(1, 1)); assert.equal(at(r, tile(0, 1))?.card, 'wraith', '影灵群在身后再放一只');
  s = blank(); s.creep[tile(2, 2)] = 0; put(s, tile(2, 2), 1, V, 3, { frozen: true }); r = endAs(s, 0); assert.equal(at(r, tile(2, 2)).str, 2, '站在对方暗影上的单位每回合掉 1 点');
  s = blank(); put(s, tile(1, 1), 0, 'priestess', 4, { frozen: true }); put(s, tile(1, 2), 0, V, 1); put(s, tile(2, 2), 1, V, 9); r = endAs(s, 0); assert.equal(at(r, tile(1, 2))?.card, 'wraith', '祭司旁边有人倒下就补一只影灵');
  s = blank(); put(s, tile(1, 1), 0, 'priestess', 4, { frozen: true }); put(s, tile(1, 2), 0, 'wraith', 1); put(s, tile(2, 2), 1, V, 9); r = endAs(s, 0); assert.ok(!at(r, tile(1, 2)) || at(r, tile(1, 2)).side === 1, '祭司：影灵自己倒下不再补影灵，那一格能被打空'); assert.equal(CARDS.f1s_rally.cost, 6, '集结号 6 费');
  s = blank(); put(s, tile(0, 0), 0, V, 3); const b0 = CARDS.f4_bloodbaronette.str; r = play(s, 'f4_bloodbaronette', tile(0, 1)); assert.equal(at(r, tile(0, 0)), null); assert.equal(at(r, tile(0, 1)).str, b0 + 6, '献祭：吃掉 3 战力的友军，自己 +6');
  s = blank(); put(s, tile(ROWS - 1, 0), 0, 'dancer', 3); r = endAs(s, 0); assert.equal(r.state.base[1], BASE_HP - 5, '影舞者进城 3 点，倒下再 2 点'); }
{ let s = blank(), r; // 巨兽：成长、孵化、荆棘、狂暴
  put(s, tile(0, 0), 0, 'walker', 2); r = endAs(s, 0); assert.equal(at(r, tile(1, 0)).str, 3, '回合开始时成长，然后前进');
  s = blank(); put(s, tile(0, 0), 0, 'f5_egg', 2, { timer: 2 }); r = endAs(s, 0); assert.equal(at(r, tile(0, 0)).card, 'f5_egg'); r = endAs(r.state, 0); assert.equal(at(r, tile(0, 0)).card, 'tk_hatch', '蛋两回合后孵出来'); assert.equal(at(r, tile(0, 0)).str, 5);
  s = blank(); put(s, tile(1, 0), 0, V, 3); put(s, tile(2, 0), 1, 'f5_mandrake', 4); r = endAs(s, 0); assert.equal(at(r, tile(2, 0)).str, 3, '荆棘：攻击者先掉 2 点，剩 1 点再对撞'); assert.equal(at(r, tile(1, 0)), null);
  s = blank(); put(s, tile(1, 1), 1, 'f5_rancour', 5); r = play(s, 'f1s_smite', tile(1, 1)); assert.equal(at(r, tile(1, 1)).str, 3, '狂暴：挨 4 点还活着，+2');
  s = blank(); put(s, tile(1, 0), 0, V, 2); put(s, tile(2, 3), 0, V, 2); r = play(s, 'f5s_stampede', -1); assert.ok(at(r, tile(2, 0)) && at(r, tile(3, 3)), '兽群奔袭：所有单位立刻各走一步'); }
{ let s = blank(), r; // 霜原：冻结、渗透、冰墙
  put(s, tile(1, 1), 1, V, 9); put(s, tile(1, 0), 1, V, 9); r = play(s, 'north', tile(0, 1)); assert.ok(at(r, tile(1, 1)).frozen && !at(r, tile(1, 0)).frozen, '冰翼法师只冻相邻的');
  s = blank(); put(s, tile(3, 1), 1, V, 9, { frozen: true }); r = endAs(s, 1); assert.equal(at(r, tile(3, 1)).str, 9, '被冻住的这回合不动'); assert.equal(at(r, tile(3, 1)).frozen, false);
  s = blank(); put(s, tile(3, 0), 0); const shallow = play(blank(), 'f6_ravager', tile(0, 1)).events.filter(e => e.t === 'buff').length; r = play(s, 'f6_ravager', tile(3, 1)); assert.equal(shallow, 0); assert.ok(r.events.some(e => e.t === 'buff' && e.n === 4), '渗透：放在对方半场才加战力');
  s = blank(); put(s, tile(1, 1), 1, V, 5, { frozen: true }); const d0 = CARDS.dryad.str; r = play(s, 'dryad', tile(0, 1)); assert.equal(at(r, tile(1, 1)).card, 'dryad', '冰树精打冻住的敌人先多 3 点'); assert.equal(at(r, tile(1, 1)).str, d0 - 2);
  s = blank(); put(s, tile(1, 1), 0); r = play(s, 'f6s_wall', tile(1, 1)); assert.equal(at(r, tile(1, 0))?.card, 'icewall'); assert.equal(at(r, tile(1, 2))?.card, 'icewall'); }
{ let s = blank(), r; // 中立和通用
  put(s, tile(3, 2), 1, V, 9); r = play(s, 'grapple', tile(0, 2)); assert.ok(r.events.some(e => e.t === 'pull' && e.to === tile(1, 2)), '钩锁手把最远的敌人拽到面前');
  s = blank(); put(s, tile(1, 2), 1, 'colossus', 9); put(s, tile(2, 1), 1, V, 1); put(s, tile(1, 1), 0, V, 3); assert.equal(forecast(s, 0).find(e => e.t === 'attack').to, tile(1, 2), '嘲讽：旁边有镇关巨像就必须先打它');
  s = blank(); put(s, tile(2, 0), 1, V, 1); put(s, tile(1, 1), 1, V, 9); r = play(s, 'lancer', tile(0, 0)); assert.ok(!r.events.some(e => e.t === 'attack' && e.to === tile(1, 1)), '破阵骑士不拐弯');
  for (const [k, c] of Object.entries(CARDS)) { assert.ok(c.name && c.text && c.faction, k); if (c.kind !== 'spell') assert.ok(c.str > 0 && c.sp, k); } }

{ let s = blank(), r; // 岚影：连击、奇袭、偷袭、咒印、分身、变形
  put(s, tile(2, 1), 1, V, 9); r = play(s, 'f2_ace', tile(0, 1)); assert.equal(at(r, tile(2, 1)).str, 9, '连击：这回合第一张牌不触发'); s = r.state; r = play(s, 'f2_ace', tile(0, 1)); assert.equal(at(r, tile(2, 1)).str, 7, '连击：第二张牌触发');
  r = endAs(r.state, 1); assert.equal(r.state.plays, 0, '换回合后连击重新计数');
  s = blank(); s.hand[0][0] = 'f2_support'; s.left = 9; let ts = legalPlays(s).filter(a => a.i === 0).map(a => a.t); assert.ok(ts.includes(tile(ROWS - 2, 3)) && !ts.includes(tile(ROWS - 1, 3)), '奇袭：不受前线限制，但进不了对方家门口那一行');
  s = blank(); s.hand[0][0] = 'f2_support'; s.left = 9; put(s, tile(3, 1), 1, V, 9); r = play(s, 'f2_support', tile(2, 1)); assert.ok(at(r, tile(2, 1)) && !r.events.some(e => e.t === 'attack' || e.t === 'move'), '奇袭（落地不动）：赤蝎落地不走也不打');
  s = blank(); s.hand[0][0] = 'f2_seenoevil'; s.left = 9; put(s, tile(3, 1), 1, V, 9); r = play(s, 'f2_seenoevil', tile(2, 1)); assert.equal(r.events.filter(e => e.t === 'attack').length, 1, '奇袭（最多一格）：无目剑客落地能打一下');
  s = blank(); s.hand[0][0] = 'B_f2'; s.left = 12; r = play(s, 'B_f2', tile(1, 1)); assert.ok(at(r, tile(2, 1)) && !at(r, tile(3, 1)), '奇袭（最多一格）：两步的胧落地也只走一格');
  s = blank(); put(s, tile(1, 0), 0); put(s, tile(1, 2), 1, V, 9, { frozen: true }); const k0 = CARDS.f2_katara.str; r = play(s, 'f2_katara', tile(1, 1)); const side = r.state.board.find(u => u && u.card === 'f2_katara'); assert.ok(r.events.some(e => e.t === 'attack' && e.to === tile(1, 2)), '走一步后从侧面打'); assert.equal(at(r, tile(1, 2)).str, 9 - 2 - k0, '偷袭：侧面先多 2 点'); assert.ok(!side);
  s = blank(); put(s, tile(1, 0), 0, 'f2_xho', 2); put(s, tile(3, 3), 1, V, 9); r = play(s, 'gem', tile(3, 3)); assert.equal(at(r, tile(1, 0)).str, 3, '咒印：每施放一张法术 +1');
  // 四风法师：在场期间每放满 4 张法术，打对方城堡 4 次、每次 1 点；前 3 张不动，第 8 张再来一轮；战力手定为 4
  assert.equal(CARDS.f2_mage4winds.str, 4); assert.equal(CARDS.f2_mage4winds.cost, 4);
  s = blank(); put(s, tile(1, 0), 0, 'f2_mage4winds', 4); 
  for (let k = 1; k <= 8; k++) { put(s, tile(3, 3), 1, V, 9); r = play(s, 'gem', tile(3, 3)); s = r.state; const hits = r.events.filter(e => e.t === 'base' && e.side === 1);
    assert.equal(hits.length, k % 4 ? 0 : 4, `四风法师：第 ${k} 张法术`); assert.ok(hits.every(e => e.n === 1)); assert.equal(s.base[1], BASE_HP - 4 * Math.floor(k / 4)); }
  s = blank(); put(s, tile(1, 1), 0, V, 8); r = play(s, 'f2s_clone', tile(1, 1)); assert.equal(at(r, tile(0, 1))?.card, V, '影分身放在身后'); assert.equal(at(r, tile(0, 1)).str, 5, '分身战力最多 5');
  s = blank(); put(s, tile(2, 2), 1, 'kolossus', 12); r = play(s, 'f2s_seal', tile(2, 2)); assert.equal(at(r, tile(2, 2)).card, 'tk_paper'); assert.equal(at(r, tile(2, 2)).str, 1, '纸鹤封印：变成 1 战力的纸鹤');
  s = blank(); put(s, tile(2, 0), 1, V, 5); put(s, tile(2, 3), 1, V, 5); put(s, tile(3, 0), 1, V, 5); r = play(s, 'f2s_fire', tile(2, 0)); assert.equal(at(r, tile(2, 3)).str, 2, '火遁打一整横排'); assert.equal(at(r, tile(3, 0)).str, 5); }
{ let s = blank(), r; // 沙海：吹退、放逐、乘风、建筑流、顺风
  put(s, tile(2, 1), 1, V, 5); r = play(s, 'f3_rae', tile(0, 1)); assert.equal(at(r, tile(3, 1))?.str, 5, '吹退一格'); assert.equal(at(r, tile(2, 1)), null);
  s = blank(); put(s, tile(ROWS - 1, 1), 1, V, 5); r = play(s, 'f3_rae', tile(0, 1)); assert.equal(at(r, tile(ROWS - 1, 1)).str, 3, '退不动：改为 2 点伤害');
  s = blank(); put(s, tile(1, 2), 1, V, 5); put(s, tile(ROWS - 1, 2), 1, V, 5); r = play(s, 'f3s_banish', tile(1, 2)); assert.ok(at(r, tile(ROWS - 2, 2)) && !at(r, tile(1, 2)), '放逐：吹回家门口，那格有人就停在前一格');
  s = blank(); put(s, tile(0, 0), 0, 'f3_windshriek', 2); r = endAs(s, 0); assert.ok(at(r, tile(2, 0)), '乘风：一回合走两步');
  s = blank(); put(s, tile(0, 0), 0, 'f3_obelyskredsand', 3); put(s, tile(0, 3), 0, 'icewall', 3); const d0 = CARDS.f3_dunecaster.str; r = play(s, 'f3_dunecaster', tile(0, 1)); assert.equal(at(r, tile(0, 1)).str, d0 + 4, '每有一座建筑 +2');
  s = blank(); put(s, tile(0, 0), 0, 'f3_trifectaperfecta', 1); r = endAs(s, 0); assert.equal(r.state.left, r.state.mana[0] + 1, '聚能水晶：每回合多 1 点能量');
  s = blank(); put(s, tile(1, 1), 0, V, 3); put(s, tile(1, 2), 0, V, 3); r = play(s, 'f3_windgiver', tile(0, 1)); assert.ok(at(r, tile(2, 1)) && at(r, tile(1, 2)), '赐风者：只推同一路的友军'); }
{ let s = blank(), r; // 装备
  put(s, tile(1, 1), 0, V, 3); r = play(s, 'g_bow', tile(1, 1)); assert.equal(at(r, tile(1, 1)).gear, 'g_bow'); assert.equal(at(r, tile(1, 1)).str, 4, '猎弓 +1');
  s = r.state; put(s, tile(4, 1), 1, V, 9, { frozen: true }); r = endAs(s, 0); assert.equal(at(r, tile(4, 1)).str, 7, '猎弓：回合开始时射 2 点'); assert.equal(at(r, tile(2, 1)).gear, 'g_bow', '装备跟着单位走');
  s = blank(); put(s, tile(1, 1), 0, V, 3, { gear: 'g_bow' }); r = play(s, 'g_shield', tile(1, 1)); assert.equal(at(r, tile(1, 1)).gear, 'g_shield', '新装备换掉旧的'); s = r.state; s.hand[0][0] = 'g_shield'; s.left = 9; assert.ok(!legalPlays(s).some(a => a.i === 0), '同一件装备不能再贴一次');
  s = blank(); put(s, tile(1, 2), 1, V, 9, { gear: 'g_shield' }); put(s, tile(2, 1), 1, V, 1); put(s, tile(1, 1), 0, V, 3); assert.equal(forecast(s, 0).find(e => e.t === 'attack').to, tile(1, 2), '塔盾给的嘲讽生效');
  s = blank(); put(s, tile(1, 1), 0, V, 2, { gear: 'g_bomb' }); put(s, tile(2, 1), 1, V, 9); put(s, tile(1, 2), 1, V, 9, { frozen: true }); r = endAs(s, 0); assert.equal(at(r, tile(2, 1)).str, 4, '火药桶：倒下时相邻敌人各 3 点'); assert.equal(at(r, tile(1, 2)).str, 6);
  s = blank(); put(s, tile(0, 0), 0, V, 3, { gear: 'g_bow' }); put(s, tile(0, 2), 0, V, 3); r = play(s, 'n_artificer', tile(0, 1)); assert.equal(at(r, tile(0, 0)).str, 6, '工匠：带装备的 +3'); assert.equal(at(r, tile(0, 2)).str, 4); }

{ let s = blank(), r; // 中毒、禁用、策反
  put(s, tile(2, 1), 1, V, 5, { frozen: true }); r = play(s, 'f2_keshraifanblade', tile(0, 1)); assert.equal(at(r, tile(2, 1)).poison, true); r = endAs(r.state, 1); assert.equal(at(r, tile(2, 1)).str, 4, '中毒：自己的回合开始时 −1'); s = blank(); put(s, tile(3, 3), 1, V, 5, { poison: true, frozen: true }); r = endAs(s, 0); assert.equal(at(r, tile(3, 3)).str, 5, '对方的回合不掉');
  s = blank(); put(s, tile(1, 2), 1, 'colossus', 9); put(s, tile(2, 1), 1, V, 1); put(s, tile(1, 1), 0, V, 3); s.board[tile(1, 2)].mute = true; assert.equal(forecast(s, 0).find(e => e.t === 'attack').to, tile(2, 1), '被禁用的镇关巨像不再嘲讽');
  s = blank(); put(s, tile(3, 0), 1, 'walker', 2, { gear: 'g_bow' }); r = play(s, 'f1s_purge', tile(3, 0)); assert.ok(at(r, tile(3, 0)).mute && !at(r, tile(3, 0)).gear, '净化：能力没了，装备掉了'); r = endAs(r.state, 1); assert.equal(r.state.board.find(u => u && u.card === 'walker').str, 2, '被禁用的行地兽不再成长');
  s = blank(); put(s, tile(2, 2), 1, V, 3); put(s, tile(2, 3), 1, V, 5); r = play(s, 'f5s_tame', tile(2, 2)); assert.equal(at(r, tile(2, 2)).side, 0, '驯兽：换边'); s = r.state; s.hand[0][0] = 'f5s_tame'; s.left = 9; assert.ok(!legalPlays(s).some(a => a.i === 0), '战力超过 3 的驯不了'); }

{ let s = blank(), r; // 种族联动
  put(s, tile(0, 0), 0, 'drake', 5); put(s, tile(0, 3), 0, 'n_dragonling', 3); put(s, tile(1, 1), 0, V, 3); r = play(s, 'n_dragonspeaker', tile(0, 1)); assert.equal(at(r, tile(0, 0)).str, 7, '龙语者：其他龙各 +2'); assert.equal(at(r, tile(0, 3)).str, 5); assert.equal(at(r, tile(1, 1)).str, 3, '不是龙的不加');
  s = blank(); put(s, tile(0, 0), 0, 'squire', 2); put(s, tile(0, 3), 0, 'brome', 2); const k0 = CARDS.n_knightlord.str; r = play(s, 'n_knightlord', tile(0, 1)); assert.equal(r.events.find(e => e.t === 'buff').n, 2, '骑士团长：每有一个其他骑士 +1');
  assert.equal(CARDS.drake.tribe, '龙'); assert.equal(CARDS.neutral_golemstone.tribe, '魔像'); }

{ let s = blank(), r; // 按规则书补的：冻住时能力失效、活力、回合开始的阶段顺序
  put(s, tile(1, 0), 0, V, 3); put(s, tile(2, 0), 1, 'f5_mandrake', 4, { frozen: true }); r = endAs(s, 0); assert.equal(at(r, tile(2, 0)).str, 1, '被冻住的曼德拉草没有荆棘：3 打 4 剩 1');
  s = blank(); put(s, tile(1, 1), 0, V, 3); r = play(s, 'n_vigor', tile(1, 1)); assert.ok(at(r, tile(1, 1)).vital); r = endAs(r.state, 0); assert.equal(at(r, tile(2, 1)).str, 4, '活力：回合开始时 +1');
  s = blank(); put(s, tile(2, 2), 1, V, 5, { vital: true }); r = play(s, 'f4s_seed', tile(2, 2)); assert.ok(at(r, tile(2, 2)).poison && !at(r, tile(2, 2)).vital, '中毒顶掉活力'); s = r.state; s.turn = 1; r = play(s, 'n_vigor', tile(2, 2)); assert.ok(at(r, tile(2, 2)).vital && !at(r, tile(2, 2)).poison, '活力解毒');
  s = blank(); put(s, tile(0, 1), 0, 'f3_obelyskgoldenflame', 4); put(s, tile(1, 1), 0, V, 2, { poison: true }); put(s, tile(2, 1), 1, V, 2, { frozen: true }); r = endAs(s, 0); assert.equal(at(r, tile(2, 1))?.side, 0, '建筑先生效：金焰碑先把 2 战力的敌人射掉，友军才走得进去'); assert.equal(at(r, tile(2, 1)).str, 1, '然后才结算中毒：2 战力的友军剩 1'); }

{ let s = blank(), r; // 对照 Stormbound 卡牌表补的能力类型
  put(s, tile(ROWS - 1, 0), 0, 'n_grenadier', 2); r = endAs(s, 0); assert.equal(r.state.base[1], BASE_HP - 5, '攻城：进城多 3 点');
  s = blank(); put(s, tile(1, 0), 0, 'n_grenadier', 2); put(s, tile(2, 0), 1, 'icewall', 4); r = endAs(s, 0); assert.equal(at(r, tile(2, 0)).side, 0, '攻城：打建筑先多 3 点，4 战力的冰墙被 2 战力的掷弹兵拆掉'); assert.equal(at(r, tile(2, 0)).str, 1);
  s = blank(); put(s, tile(1, 0), 0, 'n_soulstealer', 5); put(s, tile(2, 0), 1, V, 4); r = endAs(s, 0); assert.equal(at(r, tile(2, 0)).str, 5, '斩弱：比自己弱的直接消灭，自己不掉战力');
  s = blank(); put(s, tile(1, 0), 0, 'f1_windbladecommander', 4); put(s, tile(2, 0), 1, V, 7); r = endAs(s, 0); assert.equal(at(r, tile(2, 0)).side, 0, '屠强：先打 4 点，7 变 3，再 4 打 3'); assert.equal(at(r, tile(2, 0)).str, 1);
  s = blank(); put(s, tile(1, 0), 0, 'f5_general', 5); put(s, tile(2, 0), 1, V, 2); r = endAs(s, 0); assert.equal(at(r, tile(2, 0)).str, 5, '打完还活着 +2：5 打 2 剩 3，再 +2');
  s = blank(); put(s, tile(1, 0), 0, 'f5_ragnoramk2', 8); put(s, tile(2, 0), 1, V, 2); r = endAs(s, 0); assert.equal(at(r, tile(3, 0))?.str, 6, '打完还活着再往前走一步');
  s = blank(); put(s, tile(0, 0), 1, V, 3, { frozen: true }); put(s, tile(1, 2), 1, V, 6, { frozen: true }); const sn = CARDS.f4_siren.str; put(s, tile(1, 0), 0); r = play(s, 'f4_deathknell', tile(1, 1)); assert.ok(at(r, tile(1, 2)), '丧钟只消灭战力不超过 2 的');
  s = blank(); put(s, tile(1, 0), 0); put(s, tile(0, 1), 1, V, 6, { frozen: true }); r = play(s, 'f4_siren', tile(1, 1)); assert.equal(at(r, tile(0, 1)).str, 5, '吸取：敌人 −1'); assert.ok(r.events.some(e => e.t === 'buff' && e.n === 1), '自己 +1');
  s = blank(); s.hand[0] = ['n_gambler', 'squire', 'squire', 'squire']; s.left = 9; r = apply(s, { type: 'play', i: 0, t: tile(0, 0) }); assert.equal(r.state.hand[0].length, 4, '抽牌：打出后手牌补回 4 张'); assert.equal(r.state.hand[0].length + r.state.deck[0].length + r.state.used[0].length, DECK, '手牌、牌库、这回合用掉的，加起来还是 12 张');
  s = blank(); s.hand[0] = ['f2_heartofthesonghai']; s.left = 9; r = apply(s, { type: 'play', i: 0, t: tile(0, 0) }); assert.equal(at(r, tile(0, 0)).str, CARDS.f2_heartofthesonghai.str + 5, '最后一张牌 +5');
  s = blank(); s.hand[0][0] = 'f6_general'; s.left = 9; r = apply(s, { type: 'play', i: 0, t: tile(0, 0) }); assert.equal(r.state.left, 0, '霜后花光能量'); assert.ok(r.events.some(e => e.t === 'buff' && e.n === 6), '剩 3 点能量 → +6');
  s = blank(); r = play(s, 'f1_general', tile(0, 1)); assert.equal(at(r, tile(0, 1)).str, CARDS.f1_general.str + 3, '贴着城堡放 +3');
  s = blank(); put(s, tile(0, 0), 0, 'f3_obelyskgoldenflame', 4); put(s, tile(3, 0), 1, V, 9, { frozen: true }); r = play(s, 'f3_general', tile(0, 1)); assert.equal(at(r, tile(3, 0)).str, 7, '筑城官：相邻的金焰碑立刻再射一次');
  s = blank(); put(s, tile(2, 1), 1, V, 9); r = play(s, 'f6s_confine', tile(2, 1)); assert.equal(at(r, tile(2, 1)).str, 4, '冰牢：压到 4'); assert.ok(at(r, tile(2, 1)).frozen);
  s = blank(); put(s, tile(0, 2), 1, V, 5); put(s, tile(1, 2), 1, V, 5); r = play(s, 'f1s_bulwark', -1); assert.equal(at(r, tile(0, 2)), null, '固守：只打贴着你城堡的'); assert.equal(at(r, tile(1, 2)).str, 5);
  s = blank(); put(s, tile(0, 0), 0, 'f3_buildcommon', 5); r = endAs(s, 0); assert.equal(at(r, tile(0, 0)).str, 3, '流沙塔每回合 −2'); }

{ let s, r; // 闯关：开局选项、首领牌、发怒、组牌限制
  s = newGame([deck('f1'), deck('f4')], rnd, { base: [12, 8], setup: [{ side: 1, card: 'colossus', tile: tile(ROWS - 1, 1), str: 5 }], boss: 1, hand: [[], ['B_f4']] });
  assert.deepEqual(s.base, [12, 8]); assert.equal(s.board[tile(ROWS - 1, 1)].card, 'colossus', '开局摆在场上的东西');
  s = newGame([deck('f1'), [...deck('f4').slice(1), 'B_f4']], rnd, { hand: [[], ['B_f4']], boss: 1 }); assert.ok(s.hand[1].includes('B_f4'), '首领牌保证在对面起手里');
  // 首领牌加过费（cost = lair + 1 或 2）：首领关里首领一方打自己的首领按原费用 lair，扣的也是 lair；别的对局里谁打都按 cost
  for (const k of Object.keys(CARDS).filter(k => CARDS[k].boss)) assert.ok([1, 2, 3].includes(CARDS[k].cost - CARDS[k].lair), `${k} 的加费应是 1–3`); // 潘腾之进击的巨屌 2026-11-19 热补丁加到 3
  { const c = CARDS.B_f4, idx = g => g.hand[1].indexOf('B_f4'); let g = newGame([deck('f1'), [...deck('f4').slice(1), 'B_f4']], rnd, { hand: [[], ['B_f4']], boss: 1 }); g.turn = 1; g.left = c.lair;
    assert.ok(targets(g, idx(g)).length, '首领关：首领一方能量够原费用就能打出首领'); assert.equal(apply(g, { type: 'play', i: idx(g), t: targets(g, idx(g))[0] }).state.left, 0, '扣的是原费用');
    g = newGame([deck('f1'), [...deck('f4').slice(1), 'B_f4']], rnd, { hand: [[], ['B_f4']] }); g.turn = 1; g.left = c.cost - 1; assert.equal(targets(g, idx(g)).length, 0, '普通对局：差 1 点能量打不出首领牌'); g.left = c.cost; assert.ok(targets(g, idx(g)).length); }
  s = newGame([deck('f1'), deck('f4')], rnd, { base: [10, 10], boss: 1 }); put(s, tile(3, 1), 1, 'B_f4', 8); put(s, tile(ROWS - 1, 0), 0, V, 5); r = endAs(s, 0); assert.ok(r.state.rage[1], '首领一方的城堡掉到一半：发怒'); assert.equal(at(r, tile(3, 1)).str, 11, '发怒 +3'); assert.ok(at(r, tile(3, 1)).shield);
  s = blank(); put(s, tile(3, 1), 1, 'B_f4', 8); put(s, tile(2, 3), 1, V, 1); s.turn = 0; r = play(s, 'gem', tile(2, 3)); assert.equal(at(r, tile(3, 1)).str, 10, '厄古：友军倒下 +2');
  s = blank(); put(s, tile(1, 0), 0, V, 3); put(s, tile(1, 3), 0, V, 3); r = play(s, 'B_f1', tile(0, 1)); assert.ok(at(r, tile(1, 0)).shield && at(r, tile(1, 3)).shield, '奥瑞安：全队圣盾');
  s = blank(); put(s, tile(2, 0), 1, V, 9); put(s, tile(3, 3), 1, V, 9); put(s, tile(1, 2), 0); r = play(s, 'B_f6', tile(1, 1)); assert.ok(at(r, tile(2, 0)).frozen && at(r, tile(3, 3)).frozen, '伊蕾娜：冻住所有敌方单位');
  s = blank(); put(s, tile(2, 0), 1, V, 2); put(s, tile(3, 3), 1, V, 9); put(s, tile(3, 1), 1, V, 4); r = play(s, 'B_final', tile(0, 1)); assert.equal(at(r, tile(2, 0)).side, 0); assert.equal(at(r, tile(3, 1)).side, 0, '莱金：最弱的两个变成你的'); assert.equal(at(r, tile(3, 3)).side, 1);
  assert.ok(deckError([...STARTERS.f1.slice(1), 'B_f1']), '没赢到手的首领牌不能带'); assert.equal(deckError([...STARTERS.f1.slice(1), 'B_f1'], ['B_f1']), '', '赢到手就能带'); assert.ok(deckError([...STARTERS.f1.slice(2), 'B_f1', 'B_n1'], ['B_f1', 'B_n1']), '一副最多一张首领牌'); }
{ let s = blank(); put(s, tile(1, 1), 0, 'B_n1', 7); put(s, tile(2, 1), 1, V, 12); let r = endAs(s, 0); assert.equal(at(r, tile(1, 1)), null, '李俊昊撞上比自己强的：同归于尽'); assert.equal(at(r, tile(2, 1)), null); assert.ok(r.events.some(e => e.t === 'fx' && e.k === 'swords'), '万剑归宗特效');
  s = blank(); put(s, tile(1, 1), 0, 'B_n1', 7); put(s, tile(2, 1), 1, V, 3); r = endAs(s, 0); assert.equal(at(r, tile(2, 1))?.str, 4, '弱的照常对撞');
  s = blank(); put(s, tile(2, 1), 0, 'B_n1', 7); put(s, tile(3, 1), 1, V, 9); r = endAs(s, 1); assert.equal(at(r, tile(2, 1)), null, '被更强的打也同归'); assert.equal(at(r, tile(3, 1)), null); }

// ---- 电脑用随机卡组打几千局：不出错、不变量成立、每张牌都被打出过 ----
const fs = FKEYS, played = new Set(), spawned = new Set(), seen = new Set(); let games = 0, draws = 0, first = 0, turns = 0;
for (let g = 0; g < 4000; g++) {
  const d = [deck(fs[g % fs.length]), deck(fs[Math.floor(g / fs.length) % fs.length])]; let s = newGame(d, rnd);
  while (s.winner === null && s.n <= 70) for (const a of aiTurn(s)) {
    const r = apply(s, a); s = r.state;
    for (const e of r.events) { seen.add(e.t); if (e.t === 'play') played.add(e.card); if (e.t === 'spawn' || e.t === 'morph') spawned.add(e.card); }
    for (const u of s.board) if (u) assert.ok(u.str > 0, '场上不该有战力为 0 的单位');
    for (const p of [0, 1]) { assert.ok(s.hand[p].length <= HAND); assert.equal(s.hand[p].length + s.deck[p].length + s.used[p].length, DECK, '手牌、牌库、这回合用掉的，加起来十二张'); }
    assert.ok(s.left >= 0);
  }
  games++; turns += s.n; if (s.winner === null) draws++; else if (s.winner === 0) first++;
}
const never = ids.filter(k => !played.has(k)), tokens = Object.keys(CARDS).filter(k => CARDS[k].token && !spawned.has(k));
// 试玩反馈后改的规则：嘲讽堵城门、暗影有期限、吹退对建筑改成伤害、换牌从牌库随机来一张、乘风的兵出场也走两步
{ let s = blank(), r; put(s, tile(0, 1), 0, 'f1_kingsguard', 3); put(s, tile(0, 0), 1, V, 2); r = endAs(s, 1); assert.equal(r.state.base[0], BASE_HP, '嘲讽：挨着它的敌人不能进城门'); assert.equal(at(r, tile(0, 1)).str, 1, '嘲讽：只能转过来打它'); assert.ok(r.events.some(e => e.t === 'taunt'));
  s = blank(); put(s, tile(0, 3), 0, 'f1_kingsguard', 3); put(s, tile(0, 0), 1, V, 2); r = endAs(s, 1); assert.equal(r.state.base[0], BASE_HP - 2, '嘲讽：隔着一路的管不着');
  s = blank(); put(s, tile(0, 1), 0, 'f1_kingsguard', 3, { frozen: true }); put(s, tile(0, 0), 1, V, 2); r = endAs(s, 1); assert.equal(r.state.base[0], BASE_HP - 2, '嘲讽：被冻住时不算数');
  s = blank(); put(s, tile(2, 1), 1, V, 9); put(s, tile(1, 3), 0, V, 1); r = play(s, 'f4_ooz', tile(1, 1)); assert.equal(r.state.creep[tile(2, 1)], 0, '暗影：铺在相邻的格子上'); s = r.state; s.board.forEach((u, t) => { if (u && u.side === 0) s.board[t] = null; });
  for (let k = 1; k <= SHADE; k++) { r = endAs(s, 0); s = r.state; assert.equal(at(r, tile(2, 1)).str, 9 - k, `暗影：第 ${k} 个回合掉 1 点`); }
  assert.equal(s.creep[tile(2, 1)], -1, `暗影：留 ${SHADE} 个回合就散`); assert.ok(r.events.some(e => e.t === 'creep' && e.side === -1));
  s = blank(); put(s, tile(2, 1), 1, 'colossus', 5); r = play(s, 'f3_rae', tile(0, 1)); assert.equal(at(r, tile(2, 1)).str, 3, '吹退：建筑吹不动，改为受 2 点');
  s = blank(); put(s, tile(4, 1), 1, V, 5); r = play(s, 'f3_rae', tile(0, 1)); assert.equal(at(r, tile(4, 1)).str, 3, '吹退：贴着自己城堡的退不动，改为受 2 点');
  s = blank(); s.turn = 0; const before = [...s.hand[0]], out = before[1]; r = apply(s, { type: 'swap', i: 1 }); assert.ok(!r.state.hand[0].includes(out) && r.state.used[0].includes(out), '换牌：换掉的那张这回合不在牌库里'); assert.equal(r.state.hand[0].length, HAND); assert.ok(!before.includes(r.state.hand[0][HAND - 1]), '换牌：换来的是牌库里的一张');
  const a = newGame([deck('f1'), deck('f4')], () => .11), b = newGame([[...a.hand[0], ...a.deck[0]], [...a.hand[1], ...a.deck[1]]], () => .97); const run = g => { let x = g, seq = []; for (let k = 0; k < 6; k++) { x = apply(x, { type: 'play', i: 0, t: legalPlays(x).find(p => p.i === 0)?.t ?? -9 }).state; x = apply(x, { type: 'end' }).state; x = apply(x, { type: 'end' }).state; seq.push(x.hand[0].join()); } return seq.join('|'); };
  let same = true; try { same = run(a) === run(b); } catch { same = false; } assert.ok(!same, '抽牌是随机的：种子不同，抽到的牌不同');
  for (const k of ['f3_windshriek', 'f3_sirocco', 'f3_zephyr', 'n_windrunner']) assert.equal(CARDS[k].move, 2, '乘风的兵出场也走两步');
  s = blank(); r = play(s, 'f3_windshriek', tile(0, 2)); assert.ok(at(r, tile(2, 2)), '乘风：出场走两步'); r = endAs(r.state, 0); assert.ok(at(r, tile(4, 2)), '乘风：之后每个回合也走两步'); }
// 试玩反馈第二批：乘风的兵打完还站在原地时第二步照样走；冲锋的兵同理；放逐吹不动改为 4 点伤害
{ let s = blank(), r; put(s, tile(1, 0), 0, 'f3_windshriek', 5); put(s, tile(2, 0), 1, 'f4_husk', 1); r = endAs(s, 0); assert.ok(at(r, tile(2, 0)) && at(r, tile(2, 0)).side === 0, '乘风：对面倒下后原地冒出影灵，第二步接着把它打掉并占住那一格'); assert.equal(r.events.filter(e => e.t === 'attack').length, 2);
  s = blank(); put(s, tile(1, 0), 0, 'f3_windshriek', 9); put(s, tile(2, 0), 1, V, 3, { shield: true }); r = endAs(s, 0); assert.equal(at(r, tile(2, 0)).str, 3, '乘风：第一下被圣盾挡了（自己挨 3），第二下照样打，赢了占格'); assert.equal(at(r, tile(2, 0)).side, 0);
  s = blank(); put(s, tile(1, 0), 0, 'f3_windshriek', 3); put(s, tile(2, 0), 0, V, 9); put(s, tile(3, 0), 1, V, 3, { shield: true }); r = endAs(s, 0); assert.ok(at(r, tile(1, 0)), '乘风：被自己人挡住就原地等，不出手');
  s = blank(); put(s, tile(1, 2), 1, 'f4_husk', 1); r = play(s, 'f5_brundlbeast', tile(0, 2)); assert.ok(at(r, tile(1, 2)) && at(r, tile(1, 2)).side === 0, '冲锋：两步的兵打掉面前的敌人，原地冒出的影灵用第二步打掉');
  s = blank(); put(s, tile(4, 1), 1, V, 9); r = play(s, 'f3s_banish', tile(4, 1)); assert.equal(at(r, tile(4, 1)).str, 5, '放逐：已经在自己家门口的吹不动，改为受 4 点');
  s = blank(); put(s, tile(2, 1), 1, 'colossus', 9); r = play(s, 'f3s_banish', tile(2, 1)); assert.equal(at(r, tile(2, 1)).str, 5, '放逐：建筑吹不动，改为受 4 点');
  s = blank(); put(s, tile(2, 1), 1, V, 9); r = play(s, 'f3s_banish', tile(2, 1)); assert.equal(at(r, tile(4, 1)).str, 9, '放逐：吹得动的吹回家门口，不掉血'); }
// 闯关存档：每个场地各记各的进度和卡组；通关阵营场地得一枚徽章（重复通关不再给）；集齐六枚无主之地才开；旧存档（只有一个进行中的场地）读得进来
{ const { progress, BADGES, AREAS, stageOpts } = await import('../campaign.js'), deck = { name: '测试', cards: STARTERS.f1 }, clear = k => { let r; progress.enter(k, deck); for (let i = 0; i < 5; i++) r = progress.win(k); return r; };
  progress.data = { runs: {}, done: {}, owned: [] }; assert.equal(progress.open('n'), false, '没有徽章进不了无主之地'); assert.ok(progress.open('f3'));
  progress.enter('f2', deck); let r = clear('f1'); assert.ok(r.cleared && r.badge && r.card === 'B_f1'); assert.equal(progress.badges(), 1); assert.ok(!progress.data.runs.f1 && progress.data.runs.f2.at === 0, '一个场地通关不动别的场地的进度');
  r = clear('f1'); assert.ok(r.cleared && !r.badge && !r.card, '再通关一次不重复给徽章和首领牌'); progress.quit('f2'); assert.ok(!progress.data.runs.f2);
  for (const k of BADGES.slice(1, 5)) clear(k); assert.equal(progress.open('n'), false, '五枚还不够'); clear(BADGES[5]); assert.ok(progress.open('n'), '六枚集齐，无主之地开放');
  progress.enter('n', deck); for (let i = 0; i < 4; i++) r = progress.win('n'); assert.ok(!r.cleared && progress.data.runs.n.at === 4, '四个小首领打完才轮到最终首领'); r = progress.win('n'); assert.ok(r.cleared && !r.badge && r.card === 'B_final');
  globalThis.localStorage = { getItem: () => JSON.stringify({ run: { area: 'f3', at: 2, deck }, done: { f1: true }, owned: ['B_f1', '不存在'] }), setItem() {} };
  progress.load(); assert.equal(progress.data.runs.f3.at, 2, '旧存档里进行中的场地读得进来'); assert.equal(progress.badges(), 1); assert.deepEqual(progress.data.owned, ['B_f1']); delete globalThis.localStorage;
  // 存档里类型不对（徽章写成数组、首领牌写成字符串、进度写成小数）：读进来要能用，徽章不能在下一次保存时丢
  { const mem = {}; globalThis.localStorage = { getItem: () => mem.campaign ?? null, setItem: (k, v) => { mem.campaign = v; } };
    mem.campaign = JSON.stringify({ runs: { f1: { deck, at: 1.5 }, f2: { deck, at: 1 } }, done: [], owned: 'B_f1' });
    progress.data = { runs: {}, done: {}, owned: [] }; progress.load();
    assert.ok(!progress.data.runs.f1, '进度不是整数的场地不读进来'); assert.equal(progress.data.runs.f2.at, 1, '好的那条照读');
    assert.deepEqual(progress.data.owned, [], '首领牌写成字符串就当没有'); assert.ok(Array.isArray(progress.data.owned));
    progress.enter('f2', deck); for (let i = 0; i < 5; i++) progress.win('f2');
    progress.load(); assert.equal(progress.badges(), 1, '徽章写成数组时，通关后也要真的存下来');
    // 没有这场进度的时候 win 不该抛异常（存档被别的标签页清掉、手改过存档）
    progress.quit('f2'); const none = progress.win('f2');
    assert.deepEqual(none, { card: null, cleared: false, badge: false }, '没有进行中的场地时 win 返回空结果');
    assert.deepEqual(progress.win('不存在的场地'), { card: null, cleared: false, badge: false }, '不存在的场地也不抛');
    delete globalThis.localStorage; }
  // 删掉的牌（chess.js 的 RETIRED）：存档里锁定的卡组还带着它的，读进来换成接班的那张；带着根本不认识的牌的进度不读
  { const { RETIRED, upgrade } = await import('../chess.js'); for (const [old, now] of Object.entries(RETIRED)) { assert.ok(!CARDS[old], `${old} 已经删了，不该还在牌表里`); assert.ok(CARDS[now], `${old} 的接班牌 ${now} 不存在`); }
    const old = { name: '旧', cards: STARTERS.f1.map((c, i) => (i ? c : 'neutral_dex')) }; globalThis.localStorage = { getItem: () => JSON.stringify({ runs: { f1: { deck: old, at: 2 }, f2: { deck: { name: '坏', cards: ['没有这张牌'] }, at: 1 } }, done: {}, owned: [] }), setItem() {} };
    progress.load(); assert.ok(progress.data.runs.f1.deck.cards.includes('neutral_jaxi') && !progress.data.runs.f1.deck.cards.includes('neutral_dex'), '锁定卡组里的旧牌换成接班的'); assert.equal(deckError(progress.data.runs.f1.deck.cards), ''); assert.ok(!progress.data.runs.f2, '带着不认识的牌的进度不读');
    assert.deepEqual(upgrade(['neutral_dex', 'neutral_jaxi']), ['neutral_dex', 'neutral_jaxi'], '接班的牌已经在卡组里就不换（免得重复）'); delete globalThis.localStorage; }
  // 卡组代码：48 个字符，转回来还是那 12 张；没有两张牌撞同一个散列（撞了就给新牌换个 id）；删掉的牌的旧代码换成接班的；乱写的认不出来
  { const { DECKS, RETIRED, deckCode, fromCode, codeTable } = await import('../chess.js');
    assert.deepEqual([...codeTable().values()].filter(v => v.length > 1), [], '两张牌的卡组代码撞了');
    for (const d of DECKS) { const c = deckCode(d.cards); assert.match(c, /^[\w-]{48}$/); assert.deepEqual(fromCode(` ${c}\n`).sort(), [...d.cards].sort(), `${d.name} 的卡组代码转不回来`); assert.equal(deckCode([...d.cards].reverse()), c, '同一副牌顺序不同，代码一样'); }
    const withOld = STARTERS.f1.map((c, i) => (i ? c : Object.keys(RETIRED)[0])); assert.ok(fromCode(deckCode(withOld)).includes(Object.values(RETIRED)[0]), '旧代码里删掉的牌换成接班的');
    for (const bad of ['', 'abc', 'A'.repeat(48), deckCode(DECKS[0].cards).slice(1), '<script>'.repeat(6)]) assert.equal(fromCode(bad), null, `不该认出来：${bad}`); }
  // 每个首领关的对手卡组里必须真的有那张首领牌，开局也得在对面手里（永冻隘口以前换错了牌，首领一直不出现）
  for (const a of AREAS) { const boss = a.stages.find(s => s.boss); if (!boss) continue;
    assert.ok(boss.foe.includes(boss.boss), `${a.name}：首领牌 ${boss.boss} 不在对手卡组里`);
    assert.equal(boss.foe.length, DECK, `${a.name}：首领关对手还是十二张牌`);
    const g = newGame([STARTERS.f1, boss.foe], rnd, stageOpts(boss)); assert.ok(g.hand[1].includes(boss.boss), `${a.name}：首领牌要在对面起手里`); }
}
// 新手教学的脚本：每一步都合法，对面照脚本走，最后是玩家赢；文案里写死的数字和局面对得上
{ let s = newGame([LESSON.mine, LESSON.foe], keepOrder, { base: LESSON.base, ordered: true }), i = 0; const go = a => { s = apply(s, a).state; };
  while (s.winner === null) {
    if (s.turn === 1) { for (const a of foeTurn(s)) go(a); continue; }
    const st = LESSON.steps[i], no = `教学第 ${i + 1} 步`; assert.ok(st, '教学的步骤走完了还没分出胜负'); i++;
    if (i === 3) assert.equal(s.board[tile(2, 1)]?.str, 1, no + '：钩锁手 3 对 2 打赢，剩 1，站在第三列');
    if (i === 6) assert.equal(s.base[1], 3, no + '：蛮角兽进门后对面剩 3');
    if (i === 8) assert.equal(s.board[tile(4, 1)]?.card, 'n_golemrune', no + '：符文魔像挡在钩锁手正前方');
    if (i === 10) assert.equal(s.board[tile(4, 1)]?.side, 0, no + '：钩锁手走到了对面门口');
    if (st.do === 'ok') continue;
    const h = s.hand[0].indexOf(st.card), a = st.do === 'end' ? { type: 'end' } : st.do === 'swap' ? { type: 'swap', i: h } : { type: 'play', i: h, t: st.t };
    if (st.do !== 'end') assert.ok(h >= 0, `${no}：手里没有「${st.card}」`);
    if (st.do === 'play') assert.ok(targets(s, h).includes(st.t), `${no}：「${CARDS[st.card].name}」打不到那一格`);
    if (st.do === 'swap') assert.ok(CARDS[st.card].cost > s.left, no + '：要换掉的那张确实出不起');
    assert.ok(stepOk(st, s, a) && !stepOk(st, s, { type: st.do === 'end' ? 'swap' : 'end' }), no + '：只放行这一步要的操作'); go(a);
  }
  assert.equal(s.winner, 0, '教学关最后是玩家赢'); assert.equal(i, LESSON.steps.length, '教学的每一步都用上了'); assert.equal(LESSON.foeSay.length, LESSON.foePlays.length);
}
console.log(`自检通过。共 ${Object.keys(CARDS).length} 张牌（可带 ${ids.length} 张）：` + fs.map(f => `${FACTIONS[f].name} ${pool(f).length}`).join('，') + `，中立 ${pool('n').length}`);
console.log(`${games} 局随机卡组：先手胜 ${(100 * first / (games - draws)).toFixed(0)}%，70 回合未分胜负 ${draws} 局，平均 ${(turns / games).toFixed(1)} 回合`);
console.log(`电脑从没打出过的牌 ${never.length} 张：${never.map(k => CARDS[k].name).join('、') || '无'}；没出现过的衍生物：${tokens.map(k => CARDS[k].name).join('、') || '无'}`);
console.log('出现过的事件种类：' + [...seen].sort().join(' '));
