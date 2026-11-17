// 下棋的卡牌：六个阵营各 40 张（单位、建筑、法术），外加中立牌（含所有阵营都能用的装备）和衍生物。
// 每张牌的能力由下面的“效果”拼出来；单位的战力不手填，而是按“费用和移动力的基线 − 能力的估值”算出来，
// 再由 tools/chess_tune.mjs 用电脑对打的结果逐张微调（调整量记在 chess-tune.js）。
// 基线来自 Stormbound wiki 上 1 级白板单位的规律：0 移动 ≈ 2×(费用−1)，每多 1 点移动力约少 2 点战力。
import { TUNE } from './chess-tune.js';

export function build(H) {
  const { COLS, ROWS, tile, rowOf, colOf, fwd, depth, inb, adj4, adj8, foes, pals, isUnit, fx, buff, shift, summon, hitBase, mend, freeze, shieldUp, creep, hurt, zap, kill, step, morph, poison, vitalize, mute, convert, draw, hitBase: _hb, BASE_HP } = H;
  const cards = {}; let F = 'n'; // 正在登记哪个阵营
  const units = (s, side) => s.board.map((u, t) => u && u.side === side && isUnit(u) ? t : -1).filter(t => t >= 0);
  const enemies = (s, side) => s.board.map((u, t) => u && u.side !== side ? t : -1).filter(t => t >= 0);
  const ahead = (s, side, t, unitOnly) => { for (let x = t + fwd(side) * COLS; inb(x); x += fwd(side) * COLS) if (s.board[x] && s.board[x].side !== side && (!unitOnly || isUnit(s.board[x]))) return x; return -1; };
  const lane = (s, side, col) => [...Array(ROWS)].map((_, r) => tile(r, col)).filter(x => s.board[x] && s.board[x].side !== side);
  const deep = (side, t) => depth(side, rowOf(t)) > (ROWS - 1) / 2;   // 在对方半场
  const bless = (s, ev, card, from, ts, n) => { ts = ts.filter(x => isUnit(s.board[x])); if (!ts.length) return; fx(ev, 'bless', card, from, ts); for (const x of ts) buff(s, ev, x, n); };
  const chillAll = (s, ev, card, from, ts) => { ts = ts.filter(x => isUnit(s.board[x]) && !s.board[x].frozen); if (!ts.length) return; fx(ev, 'frost', card, from, ts); ts.forEach(x => freeze(s, ev, x)); };
  const taint = (s, ev, card, from, ts, side) => { ts = ts.filter(x => inb(x) && s.creep[x] !== side); if (!ts.length) return; fx(ev, 'shade', card, from, ts); ts.forEach(x => creep(s, ev, x, side)); };
  const name = id => cards[id].name;
  // 吹退：把敌人朝它自己家的方向推一格（离得远的先推）；吹不动的——建筑，或者身后没有空格的单位——改为挨 2 点
  const blow = (s, ev, card, from, ts, side) => { ts = ts.filter(x => inb(x) && s.board[x] && s.board[x].side !== side).sort((a, b) => depth(side, rowOf(b)) - depth(side, rowOf(a))); if (!ts.length) return; fx(ev, 'gust', card, from, ts);
    for (const x of ts) { const b = x + fwd(side) * COLS, u = s.board[x]; if (!u || u.side === side) continue; if (isUnit(u) && inb(b) && !s.board[b]) shift(s, ev, x, b, 'push'); else hurt(s, ev, x, 2); } };
  // 让这些格子里的单位各立刻走一步，靠前的先走
  const march = (s, ev, side, ts) => { for (const k of ts.filter(x => isUnit(s.board[x])).sort((a, b) => depth(side, rowOf(b)) - depth(side, rowOf(a)) || colOf(a) - colOf(b)).map(x => s.board[x].id)) { const x = s.board.findIndex(u => u && u.id === k); if (x >= 0 && !s.board[x].frozen && s.winner === null) step(s, ev, x); } };
  const structs = (s, side) => s.board.map((u, t) => u && u.side === side && !isUnit(u) ? t : -1).filter(t => t >= 0);
  const banishTo = (s, side, t) => { for (let d = 0; d < ROWS; d++) { const x = tile(side ? d : ROWS - 1 - d, colOf(t)); if (x === t) return -1; if (!s.board[x]) return x; } return -1; }; // 对方家门口往回数，第一个空格；已经在最里面就吹不动
  const firstInLane = (s, side, col) => { for (let d = 0; d < ROWS; d++) { const x = tile(side ? ROWS - 1 - d : d, col); if (s.board[x] && s.board[x].side !== side) return x; } return -1; }; // 从自己家数过去，这一路的第一个敌人

  // ---------- 效果：[说明, 估值（折合多少点战力）, 做什么] ----------
  const E = {
    shot: n => [`对本路前方第一个敌人造成 ${n} 点伤害`, .9 * n, (s, ev, u, t) => { const x = ahead(s, u.side, t); if (x >= 0) zap(s, ev, u.card, t, [x], n, 'bolt'); }],
    nova: n => [`相邻的敌人各受 ${n} 点伤害`, 1.4 * n, (s, ev, u, t) => zap(s, ev, u.card, t, foes(s, u.side, adj4(t)), n, 'nova')],
    ring: n => [`周围一圈的敌人各受 ${n} 点伤害`, 2 * n, (s, ev, u, t) => zap(s, ev, u.card, t, foes(s, u.side, adj8(t)), n, 'nova')],
    blast: n => [`相邻的所有单位和建筑各受 ${n} 点伤害，敌我都算`, n, (s, ev, u, t) => zap(s, ev, u.card, t, adj4(t), n, 'nova')],
    beam: n => [`本路所有敌人各受 ${n} 点伤害`, 1.3 * n, (s, ev, u, t) => zap(s, ev, u.card, t, lane(s, u.side, colOf(t)), n, 'beam')],
    aid: n => [`相邻的友军各 +${n} 战力`, 1.3 * n, (s, ev, u, t) => bless(s, ev, u.card, t, pals(s, u.side, adj4(t)), n)],
    aidAll: n => [`你的其他单位各 +${n} 战力`, 2.4 * n, (s, ev, u, t) => bless(s, ev, u.card, t, units(s, u.side).filter(x => x !== t), n)],
    aidFront: n => [`正前方一格的友军 +${n} 战力`, .7 * n, (s, ev, u, t) => bless(s, ev, u.card, t, pals(s, u.side, [t + fwd(u.side) * COLS]), n)],
    rank: n => [`列阵：相邻每有一个友军，自己 +${n} 战力`, 1.2 * n, (s, ev, u, t) => buff(s, ev, t, n * pals(s, u.side, adj4(t)).length)],
    horde: n => [`场上每有一个其他友方单位，自己 +${n} 战力`, 1.8 * n, (s, ev, u, t) => buff(s, ev, t, n * (units(s, u.side).length - 1))],
    lone: n => [`四周没有友军时，自己 +${n} 战力`, .6 * n, (s, ev, u, t) => { if (!pals(s, u.side, adj4(t)).length) buff(s, ev, t, n); }],
    infiltrate: n => [`渗透：放在对方半场时，自己 +${n} 战力`, .45 * n, (s, ev, u, t) => { if (deep(u.side, t)) buff(s, ev, t, n); }],
    heal: n => [`你的城堡 +${n} 血`, .6 * n, (s, ev, u, t) => { if (s.base[u.side] < s.cap[u.side]) fx(ev, 'heal', u.card, t, [{ base: u.side }]); mend(s, ev, u.side, n); }],
    burn: n => [`对方城堡受 ${n} 点伤害`, 1.7 * n, (s, ev, u, t) => { fx(ev, 'bolt', u.card, t, [{ base: 1 - u.side }]); hitBase(s, ev, 1 - u.side, n); }],
    chill: () => ['冻住相邻的敌方单位', 2, (s, ev, u, t) => chillAll(s, ev, u.card, t, foes(s, u.side, adj4(t)))],
    chillFront: () => ['冻住本路前方第一个敌方单位', 1.2, (s, ev, u, t) => { const x = ahead(s, u.side, t, true); if (x >= 0) chillAll(s, ev, u.card, t, [x]); }],
    chillLane: () => ['冻住本路所有敌方单位', 2.4, (s, ev, u, t) => chillAll(s, ev, u.card, t, lane(s, u.side, colOf(t)))],
    spawn: (card, str, where = 'behind') => [() => `在${{ behind: '身后一格', front: '正前方一格', sides: '左右两侧', here: '原地' }[where]}${where === 'sides' ? '各放' : '放'}一${cards[card].kind === 'structure' ? '座' : '只'} ${str} 战力的${name(card)}`, (where === 'sides' ? 2 : 1) * (str + .4), (s, ev, u, t) => {
      const ts = (where === 'behind' ? [t - fwd(u.side) * COLS] : where === 'front' ? [t + fwd(u.side) * COLS] : where === 'here' ? [t] : [t - 1, t + 1].filter(x => inb(x) && rowOf(x) === rowOf(t))).filter(x => inb(x) && !s.board[x]);
      if (ts.length) { fx(ev, 'summon', u.card, t, ts); ts.forEach(x => summon(s, ev, u.side, card, x, str)); } }],
    ward: () => ['相邻的友军各获得圣盾', 2.6, (s, ev, u, t) => { const ts = pals(s, u.side, adj4(t)).filter(x => !s.board[x].shield); if (ts.length) { fx(ev, 'bless', u.card, t, ts); ts.forEach(x => shieldUp(s, ev, x)); } }],
    pull: () => ['把本路前方最远的敌方单位拽到自己面前', .8, (s, ev, u, t) => { const f = t + fwd(u.side) * COLS; let far = -1; for (let x = f; inb(x); x += fwd(u.side) * COLS) if (s.board[x] && s.board[x].side !== u.side && isUnit(s.board[x])) far = x; if (far >= 0 && far !== f && inb(f) && !s.board[f]) { fx(ev, 'bolt', u.card, t, [far]); shift(s, ev, far, f, 'pull'); } }],
    push: n => [`把正前方的敌人砸 ${n} 点伤害，并击退一格`, .8 * n + .4, (s, ev, u, t) => { const f = t + fwd(u.side) * COLS, b = f + fwd(u.side) * COLS; if (!foes(s, u.side, [f]).length) return; const id = s.board[f].id; zap(s, ev, u.card, t, [f], n, 'slash'); if (s.board[f] && s.board[f].id === id && isUnit(s.board[f]) && inb(b) && !s.board[b]) shift(s, ev, f, b, 'push'); }],
    taint: () => ['在脚下留下暗影（留 3 个回合）', .6, (s, ev, u, t) => taint(s, ev, u.card, t, [t], u.side)],
    taintAdj: () => ['在脚下和相邻的格子留下暗影（留 3 个回合）', 1.5, (s, ev, u, t) => taint(s, ev, u.card, t, [t, ...adj4(t)], u.side)],
    grow: n => [`自己 +${n} 战力`, 2 * n, (s, ev, u, t) => buff(s, ev, t, n)],
    mana: n => [`获得 ${n} 点能量`, 1.6 * n, (s, ev, u) => { s.left += n; ev.push({ t: 'mana', side: u.side, n }); }],
    gust: () => ['把本路前方第一个敌人吹退一格；吹不动的（建筑，或者它身后没有空格）改为受 2 点伤害', 1.1, (s, ev, u, t) => { const x = ahead(s, u.side, t); if (x >= 0) blow(s, ev, u.card, t, [x], u.side); }],
    gale: () => ['把本路的所有敌人各吹退一格；吹不动的（建筑，或者身后没有空格）改为受 2 点伤害', 2, (s, ev, u, t) => blow(s, ev, u.card, t, lane(s, u.side, colOf(t)), u.side)],
    gustAdj: () => ['把相邻的敌人各吹退一格；吹不动的（建筑，或者身后没有空格）改为受 2 点伤害', 1.6, (s, ev, u, t) => blow(s, ev, u.card, t, adj4(t), u.side)],
    tailwind: () => ['你这一路上的其他友方单位各立刻走一步', 1.4, (s, ev, u, t) => { const ts = units(s, u.side).filter(x => x !== t && colOf(x) === colOf(t)); if (ts.length) { fx(ev, 'bless', u.card, t, ts); march(s, ev, u.side, ts); } }],
    build: n => [`你每有一座建筑，自己 +${n} 战力`, .9 * n, (s, ev, u, t) => buff(s, ev, t, n * structs(s, u.side).length)],
    aidStruct: n => [`你的建筑各 +${n} 战力`, .8 * n, (s, ev, u, t) => { const ts = structs(s, u.side); if (ts.length) { fx(ev, 'bless', u.card, t, ts); ts.forEach(x => buff(s, ev, x, n)); } }],
    hex: () => [() => `把本路前方第一个敌方单位变成 1 战力的${name('tk_paper')}`, 5, (s, ev, u, t) => { const x = ahead(s, u.side, t, true); if (x >= 0) { fx(ev, 'bolt', u.card, t, [x]); morph(s, ev, x, 'tk_paper', 1, 'hex'); } }],
    forge: () => ['相邻的友军各 +1 战力，带着装备的再 +2', 1.8, (s, ev, u, t) => { const ts = pals(s, u.side, adj4(t)).filter(x => isUnit(s.board[x])); if (!ts.length) return; fx(ev, 'bless', u.card, t, ts); for (const x of ts) buff(s, ev, x, s.board[x].gear ? 3 : 1); }],
    income: () => ['获得 1 点能量', 4, (s, ev, u) => { s.left += 1; ev.push({ t: 'mana', side: u.side, n: 1 }); }],
    venom: () => ['让本路前方第一个敌方单位中毒：它每个回合开始时 −1 战力', 1.6, (s, ev, u, t) => { const x = ahead(s, u.side, t, true); if (x >= 0 && !s.board[x].poison) { fx(ev, 'bolt', u.card, t, [x]); poison(s, ev, x); } }],
    venomAdj: () => ['让相邻的敌方单位中毒：它们每个回合开始时 −1 战力', 2.6, (s, ev, u, t) => { const ts = foes(s, u.side, adj4(t)).filter(x => isUnit(s.board[x]) && !s.board[x].poison); if (ts.length) { fx(ev, 'nova', u.card, t, ts); ts.forEach(x => poison(s, ev, x)); } }],
    vitalAdj: () => ['相邻的友方单位获得活力：每个回合开始时 +1 战力，中的毒也解了', 2.6, (s, ev, u, t) => { const ts = pals(s, u.side, adj4(t)).filter(x => isUnit(s.board[x]) && !s.board[x].vital); if (ts.length) { fx(ev, 'bless', u.card, t, ts); ts.forEach(x => vitalize(s, ev, x)); } }],
    silence: () => ['禁用本路前方第一个敌人的能力，它的装备也掉了', 1.8, (s, ev, u, t) => { const x = ahead(s, u.side, t); if (x >= 0 && !s.board[x].mute) { fx(ev, 'bolt', u.card, t, [x]); mute(s, ev, x); } }],
    silenceAdj: () => ['禁用相邻敌人的能力，它们的装备也掉了', 2.6, (s, ev, u, t) => { const ts = foes(s, u.side, adj4(t)).filter(x => !s.board[x].mute); if (ts.length) { fx(ev, 'nova', u.card, t, ts); ts.forEach(x => mute(s, ev, x)); } }],
    kin: (tb, n) => [`你的其他${tb}各 +${n} 战力`, 1.5 * n, (s, ev, u, t) => bless(s, ev, u.card, t, units(s, u.side).filter(x => x !== t && cards[s.board[x].card].tribe === tb), n)],
    pack: (tb, n) => [`你每有一个其他的${tb}，自己 +${n} 战力`, n, (s, ev, u, t) => buff(s, ev, t, n * units(s, u.side).filter(x => x !== t && cards[s.board[x].card].tribe === tb).length)],
    // —— 下面这一批能力类型是对照 Stormbound 的卡牌表归纳出来的（只取玩法，名字、文字和数值都是我们自己的）——
    draw: n => [`抽 ${n} 张牌（手牌最多 4 张）`, 1.2 * n, (s, ev, u) => draw(s, ev, u.side, n)],
    last: n => [`打出它之后手里没有别的牌的话，自己 +${n} 战力`, .45 * n, (s, ev, u, t) => { if (!s.hand[u.side].length) buff(s, ev, t, n); }],
    pour: k => [`花光剩下的能量，每花 1 点自己 +${k} 战力`, 3, (s, ev, u, t) => { const n = s.left; if (n > 0) { s.left = 0; ev.push({ t: 'spend', side: u.side, n }); buff(s, ev, t, k * n); } }],
    homeguard: n => [`贴着你的城堡放的话，自己 +${n} 战力`, .5 * n, (s, ev, u, t) => { if (depth(u.side, rowOf(t)) === 0) buff(s, ev, t, n); }],
    byStruct: n => [`挨着友方建筑放的话，自己 +${n} 战力`, .5 * n, (s, ev, u, t) => { if (pals(s, u.side, adj4(t)).some(x => !isUnit(s.board[x]))) buff(s, ev, t, n); }],
    rouse: () => ['相邻的友方建筑立刻再生效一次', 1.6, (s, ev, u, t) => { for (const x of pals(s, u.side, adj4(t)).filter(x => !isUnit(s.board[x]))) { const w = s.board[x], f = w && w.side === u.side && !w.mute && cards[w.card].onTurn; if (f) { fx(ev, 'bless', u.card, t, [x]); f(s, ev, w, x); } } }],
    drain: n => [`从相邻的敌方单位身上各吸走 ${n} 点战力`, 2 * n, (s, ev, u, t) => { const ts = foes(s, u.side, adj4(t)).filter(x => isUnit(s.board[x])); if (!ts.length) return; const got = ts.reduce((a, x) => a + Math.min(n, s.board[x].str), 0); fx(ev, 'drain', u.card, ts[0], [t]); ts.forEach(x => hurt(s, ev, x, n)); if (s.board[t] === u) buff(s, ev, t, got); }],
    cull: n => [`消灭周围一圈战力不超过 ${n} 的敌方单位`, 1.2 * n + .6, (s, ev, u, t) => { const ts = foes(s, u.side, adj8(t)).filter(x => isUnit(s.board[x]) && s.board[x].str <= n); if (ts.length) { fx(ev, 'slash', u.card, t, ts); ts.forEach(x => s.board[x] && kill(s, ev, x)); } }],
    raze: n => [`周围一圈的敌方建筑各受 ${n} 点伤害`, .3 * n, (s, ev, u, t) => zap(s, ev, u.card, t, foes(s, u.side, adj8(t)).filter(x => !isUnit(s.board[x])), n, 'nova')],
    selfBase: n => [`你自己的城堡受 ${n} 点伤害`, -1.1 * n, (s, ev, u, t) => { fx(ev, 'drain', u.card, t, [{ base: u.side }]); _hb(s, ev, u.side, n); }],
    decay: n => [`自己 −${n} 战力`, -.6 * n, (s, ev, u, t) => hurt(s, ev, t, n)],
    aidLane: n => [`这一路上在它前面的友方单位各 +${n} 战力`, 1.5 * n, (s, ev, u, t) => bless(s, ev, u.card, t, units(s, u.side).filter(x => colOf(x) === colOf(t) && depth(u.side, rowOf(x)) > depth(u.side, rowOf(t))), n)],
    advance: () => ['再往前走一步（前面有人就不走）', 2, (s, ev, u, t) => { const f = t + fwd(u.side) * COLS; if (!inb(f)) { _hb(s, ev, 1 - u.side, u.str, u.id, t); kill(s, ev, t); } else if (!s.board[f]) shift(s, ev, t, f, 'move'); }],
    chillNear: () => ['冻住离你的城堡最近的那个敌方单位', 2, (s, ev, u, t) => { const ts = enemies(s, u.side).filter(x => isUnit(s.board[x]) && !s.board[x].frozen); if (ts.length) chillAll(s, ev, u.card, t, [ts.reduce((a, b) => depth(u.side, rowOf(b)) < depth(u.side, rowOf(a)) ? b : a)]); }],
    // —— 首领牌专用的效果 ——
    wardAll: () => ['你的其他单位全部获得圣盾', 5, (s, ev, u, t) => { const ts = units(s, u.side).filter(x => x !== t && !s.board[x].shield); if (ts.length) { fx(ev, 'bless', u.card, t, ts); ts.forEach(x => shieldUp(s, ev, x)); } }],
    tempest: n => [`周围一圈的敌人各受 ${n} 点伤害；这回合你在它之前每打过一张牌，再多 1 点`, 2 * n + 2, (s, ev, u, t) => zap(s, ev, u.card, t, foes(s, u.side, adj8(t)), n + s.plays, 'nova')],
    rouseAll: () => ['你的每一座建筑立刻再生效一次', 4, (s, ev, u, t) => { for (const k of structs(s, u.side).map(x => s.board[x].id)) { const x = s.board.findIndex(w => w && w.id === k), w = s.board[x], f = w && !w.mute && cards[w.card].onTurn; if (f) { fx(ev, 'bless', u.card, t, [x]); f(s, ev, w, x); } } }],
    chillEvery: () => ['冻住所有敌方单位', 5, (s, ev, u, t) => chillAll(s, ev, u.card, t, enemies(s, u.side))],
    scorch: n => [`所有敌方单位各受 ${n} 点伤害`, 4 * n, (s, ev, u, t) => zap(s, ev, u.card, t, enemies(s, u.side).filter(x => isUnit(s.board[x])), n, 'storm')],
    silenceEvery: () => ['禁用所有敌方单位的能力，它们的装备也掉了', 5, (s, ev, u, t) => { const ts = enemies(s, u.side).filter(x => isUnit(s.board[x]) && !s.board[x].mute); if (ts.length) { fx(ev, 'nova', u.card, t, ts); ts.forEach(x => mute(s, ev, x)); } }],
    enthrall: n => [`把战力最低的 ${n} 个敌方单位变成你的`, 3 * n, (s, ev, u, t) => { const ts = enemies(s, u.side).filter(x => isUnit(s.board[x]) && !cards[s.board[x].card].boss).sort((a, b) => s.board[a].str - s.board[b].str).slice(0, n); if (ts.length) { fx(ev, 'bless', u.card, t, ts); ts.forEach(x => convert(s, ev, x, u.side)); } }],
    feast: () => ['献祭：消灭相邻战力最低的一个友军，自己获得它战力的两倍', 0, (s, ev, u, t) => { const ts = pals(s, u.side, adj4(t)).filter(x => isUnit(s.board[x])); if (!ts.length) return; const x = ts.reduce((a, b) => s.board[b].str < s.board[a].str ? b : a), n = s.board[x].str; fx(ev, 'drain', u.card, x, [t]); kill(s, ev, x); if (s.board[t] === u) buff(s, ev, t, n * 2); }],
  };
  const K = { // “攻击时”的效果
    cleave: n => [`目标两侧的敌人各受 ${n} 点伤害`, 1.1 * n, (s, ev, u, from, to) => zap(s, ev, u.card, from, foes(s, u.side, Math.abs(to - from) === COLS ? [to - 1, to + 1].filter(x => inb(x) && rowOf(x) === rowOf(to)) : [to - COLS, to + COLS]), n, 'slash')],
    pierce: n => [`目标身后一格的敌人也受 ${n} 点伤害`, .7 * n, (s, ev, u, from, to) => { const b = to + (to - from); if (inb(b) && (Math.abs(to - from) === COLS || rowOf(b) === rowOf(to))) zap(s, ev, u.card, from, foes(s, u.side, [b]), n, 'beam'); }],
    shatter: n => [`目标被冻住的话，先对它造成 ${n} 点伤害`, .6 * n, (s, ev, u, from, to) => { if (s.board[to] && s.board[to].frozen) zap(s, ev, u.card, from, [to], n, 'frost'); }],
    flank: n => [`偷袭：从侧面打敌人的话，先对它造成 ${n} 点伤害`, .5 * n, (s, ev, u, from, to) => { if (rowOf(from) === rowOf(to)) zap(s, ev, u.card, from, [to], n, 'slash'); }],
    venom: () => ['让目标中毒：它每个回合开始时 −1 战力', 1.2, (s, ev, u, from, to) => poison(s, ev, to)],
    slayer: n => [`目标比自己强的话，先对它造成 ${n} 点伤害`, .6 * n, (s, ev, u, from, to) => { if (s.board[to] && s.board[to].str > u.str) zap(s, ev, u.card, from, [to], n, 'slash'); }],
    execute: () => ['目标是比自己弱的单位的话，直接消灭它，自己不受伤', 2, (s, ev, u, from, to) => { if (isUnit(s.board[to]) && s.board[to].str < u.str) { fx(ev, 'slash', u.card, from, [to]); kill(s, ev, to); } }],
    rage: n => [`自己先 +${n} 战力`, 1.4 * n, (s, ev, u, from) => buff(s, ev, from, n)],
    shatterKill: () => ['目标是被冻住的单位的话，直接消灭它，自己不受伤', 2, (s, ev, u, from, to) => { if (isUnit(s.board[to]) && s.board[to].frozen) { fx(ev, 'frost', u.card, from, [to]); kill(s, ev, to); } }],
    leech: n => [`你的城堡 +${n} 血`, .8 * n, (s, ev, u, from) => { if (s.base[u.side] < s.cap[u.side]) fx(ev, 'heal', u.card, from, [{ base: u.side }]); mend(s, ev, u.side, n); }],
  };
  // 什么时候触发
  const P = e => ({ on: 'onPlay', pre: '出场时，', e }), D = e => ({ on: 'onDeath', pre: '倒下时，', e, k: .7 }), T = e => ({ on: 'onTurn', pre: '你的每个回合开始时，', e }), A = e => ({ on: 'onAttack', pre: '攻击时，', e }), W = e => ({ on: 'onHurt', pre: '狂暴：受伤后还活着的话，', e, k: .6 });
  const C = e => ({ on: 'onPlay', pre: '连击：这回合你已经打过别的牌的话，', e: [e[0], e[1], (s, ev, u, t) => { if (s.plays > 0) e[2](s, ev, u, t); }], k: .6 });
  const R = e => ({ on: 'onAfter', pre: '打完还活着的话，', e, k: .8 });
  const O = e => ({ on: 'onAllyDeath', pre: '每有一个友方单位倒下，', e });
  const S = e => ({ on: 'onSpell', pre: '你每施放一张法术，', e, k: .8 });
  const flag = (key, val, text, cost) => ({ flag: [key, val], text, cost });
  const GUARD = flag('guard', true, '身后一格的友军被能力或法术打中时，替他挡一半', .5), TAUNT = flag('taunt', true, '嘲讽：正前方或左右挨着它的敌人必须先打它，也不能从它身边进城门', .8), FIXED = flag('fixed', true, '冲锋时只沿自己这一路往前，不拐去打旁边的敌人', 0),
    SHIELD = flag('shield', true, '圣盾：挡下受到的第一次伤害', 2), THORNS = n => flag('thorns', n, `荆棘：攻击它的敌人先受 ${n} 点伤害`, 1.1 * n);
  const AMBUSH = flag('anywhere', true, '奇袭：可以放在前线之外的任何空格（对方家门口那一行除外）', 1.6), SWIFT = flag('swift', true, '乘风：每个回合开始时走两步（别的兵只走一步）', 2);
  const SIEGE = n => flag('siege', n, `攻城：打建筑和城堡时多造成 ${n} 点伤害`, .7 * n);
  const MOURN = (text, cost, fn) => ({ raw: c => { c.onNearDeath = fn; }, text: '相邻的格子里有单位倒下时，' + text, cost });

  // ---------- 登记卡牌 ----------
  const baseline = (cost, move) => [2 * (cost - 1), 1.75 * cost - 2.5, 1.5 * cost - 3.5, 1.25 * cost - 4][move];
  function compile(c, abil) {
    const texts = []; let val = 0;
    for (const a of abil) {
      if (a.flag) { c[a.flag[0]] = a.flag[1]; texts.push(() => a.text); val += a.cost; continue; }
      if (a.raw) { a.raw(c); texts.push(() => a.text); val += a.cost; continue; }
      const [tx, v, fn] = a.e, prev = c[a.on]; texts.push(Object.assign(() => typeof tx === 'function' ? tx() : tx, { pre: a.pre })); val += v * (a.k ?? 1);
      c[a.on] = prev ? (...args) => { prev(...args); fn(...args); } : fn;
    }
    c.texts = texts; return val;
  }
  const put = (id, c, raw) => { c.faction = F; c.str = Math.max(1, Math.min(15, Math.round(raw) + (TUNE[id] || 0))); cards[id] = c; };
  // 贵的单位身板再加一截：对照 Stormbound 的牌表，我们 4 费以上的单位能力占得太多、战力偏低，花了大价钱却站不住
  const lift = (cost, move) => cost <= 3 ? 0 : cost <= 5 ? 1 : cost === 6 ? (move ? 2 : 1) : cost === 7 ? 2 : 4;
  function unit(id, nm, sp, cost, move, abil = []) { const c = { name: nm, kind: 'unit', cost, move, sp }; put(id, c, baseline(cost, move) + lift(cost, move) - compile(c, abil)); }
  function struct(id, nm, sp, cost, abil = []) { const c = { name: nm, kind: 'structure', cost, move: 0, sp }; put(id, c, cost + 2 - compile(c, abil)); }
  function egg(id, nm, sp, cost, str, card, turns, hatchStr) { cards[id] = { name: nm, kind: 'structure', cost, move: 0, sp, str, faction: F, hatch: { card, turns, str: hatchStr }, texts: [() => `孵化：${turns} 个回合后变成一只 ${hatchStr} 战力的${name(card)}`] }; }
  // 首领牌：闯关里击败首领才能拿到，战力手填（明显比同费的牌高），不参与自动调数值；title 是它的称号
  function bossUnit(id, title, nm, sp, cost, move, str, abil) { const c = { name: nm, title, kind: 'unit', cost, move, sp, str, boss: true, faction: F }; compile(c, abil); cards[id] = c; }
  function token(id, nm, sp, abil = []) { const c = { name: nm, kind: 'unit', cost: 0, move: 0, sp, token: true, str: 1, faction: F }; compile(c, abil); cards[id] = c; }
  function spell(id, nm, cost, target, text, cast, can) { cards[id] = { name: nm, kind: 'spell', cost, target, text, can, faction: F, cast: (s, ev, side, t) => cast(s, ev, side, t, id) }; }
  const castle = side => ({ base: side }); // 法术从自己的城堡放出去
  // 装备：一种特殊的法术，贴在一个友方单位身上，直到它倒下。abil 用和单位一样的写法（不能用“出场时”）
  function gear(id, nm, cost, bonus, abil) { const c = { name: nm, kind: 'spell', gear: true, cost, target: 'ally', faction: F, bonus }; compile(c, abil); cards[id] = c;
    c.can = (s, side, t) => s.board[t].gear !== id;
    c.cast = (s, ev, side, t) => { const u = s.board[t]; u.gear = id; fx(ev, 'bless', id, castle(side), [t]); ev.push({ t: 'gear', id: u.id, tile: t, card: id }); if (bonus) buff(s, ev, t, bonus); }; }
  const home = side => [...Array(COLS)].map((_, c) => tile(side ? ROWS - 1 : 0, c));

  // ======== 圣辉骑士团：圣盾、列阵、守城 ========
  F = 'f1';
  token('tk_knight', '银卫', 'f1_tank');
  unit('squire', '银卫侍从', 'f1_silverguardsquire', 2, 0);
  unit('f1_sunwisp', '曦光灵', 'f1_sunwisp', 2, 1, [P(E.heal(1))]);
  unit('f1_fiz', '光灵菲兹', 'f1_fiz', 2, 0, [P(E.aidFront(2))]);
  unit('f1_slo', '守誓石卫', 'f1_slo', 2, 0, [GUARD]);
  unit('f1_friendsguard', '同袍卫士', 'f1_friendsguard', 2, 1, [P(E.rank(1))]);
  unit('f1_shieldforger', '铸盾匠', 'f1_shieldforger', 3, 0, [P(E.ward())]);
  unit('f1_sunstonemaiden', '日石侍女', 'f1_sunstonemaiden', 3, 1, [P(E.heal(2))]);
  unit('f1_spellbladeadept', '咒刃学徒', 'f1_spellbladeadept', 3, 1, [P(E.shot(2))]);
  unit('f1_silvermanevanguard', '银鬃先锋', 'f1_silvermanevanguard', 3, 1, [SHIELD]);
  unit('f1_warblade', '战刃军士', 'f1_warblade', 3, 1, [P(E.aid(1))]);
  unit('f1_kingsguard', '王庭卫士', 'f1_kingsguard', 3, 0, [TAUNT]);
  unit('lion', '苍蓝雄狮', 'f1_azuritelion', 4, 2, [P(E.rank(1))]);
  unit('sunriser', '曦光使', 'f1_sunriser', 4, 0, [P(E.heal(2))]);
  unit('ballista', '穿云弓手', 'f1_backlinearcher', 4, 0, [P(E.beam(2))]);
  unit('f1_sunbreaker', '破晓者', 'f1_sunbreaker', 4, 1, [P(E.nova(1))]);
  unit('f1_peacekeeper', '和平卫士', 'f1_peacekeeper', 4, 1, [SHIELD, GUARD]);
  unit('f1_caster', '圣辉法师', 'f1_caster', 4, 0, [P(E.aidAll(1))]);
  unit('f1_ranged', '圣辉射手', 'f1_ranged', 4, 0, [P(E.shot(3))]);
  unit('f1_auroralioness', '极光母狮', 'f1_auroralioness', 4, 2, [D(E.aid(2))]);
  unit('brome', '圣骑士', 'f1_bromemk2', 5, 0, [P(E.aid(2))]);
  unit('lancer', '破阵骑士', 'f1_sunforgelancer', 5, 3, [FIXED]);
  unit('f1_sunstonetemplar', '日石圣殿骑士', 'f1_sunstonetemplar', 5, 1, [A(K.leech(1))]);
  unit('f1_radiantdragoon', '辉光龙骑', 'f1_radiantdragoon', 5, 2, [SHIELD]);
  unit('f1_sunbreakguardian', '破晓守卫', 'f1_sunbreakguardian', 5, 0, [TAUNT, SHIELD]);
  unit('f1_grandmasterzir', '宗师齐尔', 'f1_grandmasterzir', 6, 1, [D(E.spawn('tk_knight', 4, 'here'))]);
  unit('f1_elyxstormblade', '风暴之刃艾莉克丝', 'f1_elyxstormblade', 6, 2, [P(E.aidAll(1))]);
  unit('f1_solarius', '索拉里斯', 'f1_solarius', 6, 0, [P(E.aid(1)), T(E.heal(1))]);
  unit('f1_kaisergladiator', '皇家角斗士', 'f1_kaisergladiator', 7, 1, [A(K.cleave(2))]);
  unit('f1_solpontiff', '日冕教宗', 'f1_solpontiff', 8, 1, [P(E.aidAll(2)), P(E.heal(2))]);
  struct('colossus', '镇关巨像', 'f1_ironcliffeguardian', 3, [TAUNT]);
  struct('f1_ironcliffemonument', '铁崖丰碑', 'f1_ironcliffemonument', 4, [T(E.aid(1))]);
  struct('f1_buildminion', '圣泉', 'f1_buildminion', 3, [T(E.heal(1))]);
  unit('f1_archdeacon', '大执事', 'f1_archdeacon', 4, 0, [P(E.silence())]);
  spell('f1s_purge', '净化', 2, 'foe', '禁用一个敌方单位或建筑的能力，它的装备也掉了。', (s, ev, side, t, id) => { fx(ev, 'bolt', id, castle(side), [t]); mute(s, ev, t); }, (s, side, t) => !s.board[t].mute);
  unit('f1_general', '守城将军', 'f1_general', 4, 0, [TAUNT, P(E.homeguard(3))]);
  unit('f1_windbladecommander', '风刃统帅', 'f1_windbladecommander', 5, 1, [A(K.slayer(4))]);
  struct('f1_buildcommon', '祝福圣坛', 'f1_buildcommon', 4, [T(E.aidLane(1))]);
  spell('f1s_bulwark', '固守', 4, 'none', '贴着你城堡的敌方单位各受 5 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), home(side).filter(x => s.board[x] && s.board[x].side !== side), 5, 'beam'), (s, side) => home(side).some(x => s.board[x] && s.board[x].side !== side));
  spell('holy', '圣光祝福', 4, 'none', '你的所有单位各 +2 战力。', (s, ev, side, t, id) => bless(s, ev, id, castle(side), units(s, side), 2), (s, side) => units(s, side).length > 0);
  spell('f1s_shield', '圣盾术', 2, 'ally', '一个友方单位获得圣盾：挡下受到的第一次伤害。', (s, ev, side, t, id) => { fx(ev, 'bless', id, castle(side), [t]); shieldUp(s, ev, t); }, (s, side, t) => !s.board[t].shield);
  spell('f1s_smite', '惩戒', 3, 'foe', '对一个敌方单位或建筑造成 4 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), [t], 4, 'bolt'));
  spell('f1s_heal', '治疗之光', 2, 'none', '你的城堡 +4 血，不超过开局的血量。', (s, ev, side, t, id) => { fx(ev, 'heal', id, castle(side), [castle(side)]); mend(s, ev, side, 4); }, (s, side) => s.base[side] < s.cap[side]);
  spell('f1s_rally', '集结号', 6, 'none', '在你家门口的每个空格放一只 2 战力的银卫。', (s, ev, side, t, id) => { const ts = [...Array(COLS)].map((_, c) => tile(side ? ROWS - 1 : 0, c)).filter(x => !s.board[x]); fx(ev, 'summon', id, castle(side), ts); ts.forEach(x => summon(s, ev, side, 'tk_knight', x, 2)); }, (s, side) => [...Array(COLS)].some((_, c) => !s.board[tile(side ? ROWS - 1 : 0, c)]));
  spell('f1s_judge', '天罚', 6, 'foe', '目标所在那一路的所有敌人各受 4 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), lane(s, side, colOf(t)), 4, 'beam'));
  spell('f1s_bless', '列阵祝福', 3, 'ally', '一个友方单位 +2 战力，它相邻的友军各 +1。', (s, ev, side, t, id) => { bless(s, ev, id, castle(side), [t], 2); bless(s, ev, id, t, pals(s, side, adj4(t)), 1); });

  // ======== 深渊：影灵、倒下时的效果、暗影地格、献祭 ========
  F = 'f4';
  token('wraith', '影灵', 'f4_miniminion'); token('tk_demon', '残魔', 'f4_horror');
  unit('f4_swarm', '影灵群', 'f4_miniminion', 2, 0, [P(E.spawn('wraith', 1, 'behind'))]);
  unit('f4_crawler', '深渊爬虫', 'f4_crawler', 2, 1, [D(E.taint())]);
  unit('f4_husk', '空壳', 'f4_husk', 2, 0, [D(E.spawn('wraith', 1, 'here'))]);
  unit('f4_gor', '小恶魔戈尔', 'f4_gor', 2, 1, [D(E.nova(1))]);
  unit('f4_ooz', '淤泥怪', 'f4_ooz', 2, 0, [P(E.taintAdj())]);
  unit('assassin', '夜哀刺客', 'f4_nightsorrow', 3, 1, [A(K.execute())]);
  unit('f4_gloomchaser', '逐暗者', 'f4_gloomchaser', 3, 1, [P(E.spawn('wraith', 1, 'behind'))]);
  unit('f4_nightfiend', '夜魔', 'f4_nightfiend', 3, 1, [D(E.burn(1))]);
  unit('f4_bloodbaronette', '血男爵夫人', 'f4_bloodbaronette', 3, 0, [P(E.feast())]);
  unit('f4_phantasm', '幻魇', 'f4_phantasm', 3, 2, [D(E.spawn('wraith', 1, 'here'))]);
  unit('f4_skullcaster', '颅骨术士', 'f4_skullcaster', 3, 0, [P(E.shot(4)), P(E.selfBase(1))]);
  unit('f4_remora', '影鮣', 'f4_remora', 3, 1, [A(K.leech(1))]);
  unit('priestess', '血月祭司', 'f4_bloodmoon', 4, 0, [MOURN('在那一格放一只 1 战力的影灵（影灵自己倒下不算）', 2, (s, ev, w, x, t, u) => { if (!s.board[t] && u.card !== 'wraith') { fx(ev, 'summon', w.card, x, [t]); summon(s, ev, w.side, 'wraith', t, 1); } })]); // 影灵倒下不再补影灵：不然祭司身边的格子永远打不空
  unit('dancer', '影舞者', 'f4_shadowdancer', 4, 1, [D(E.burn(2))]);
  unit('f4_abyssiansentinel', '深渊哨兵', 'f4_abyssiansentinel', 4, 0, [TAUNT, D(E.spawn('wraith', 2, 'here'))]);
  unit('f4_darkspine', '暗棘元素', 'f4_darkspine', 4, 1, [P(E.taintAdj())]);
  unit('f4_arachne', '蛛后', 'f4_arachne', 4, 1, [D(E.spawn('wraith', 1, 'sides'))]);
  unit('f4_plaguedr', '瘟疫医生', 'f4_plaguedr', 4, 0, [P(E.nova(2))]);
  unit('f4_moonrider', '月骑', 'f4_moonrider', 4, 2, [D(E.taint())]);
  unit('maehv', '深渊女巫', 'f4_maehvmk2', 5, 0, [P(E.ring(2))]);
  unit('f4_blacksolus', '黑色孤星', 'f4_blacksolus', 5, 1, [A(K.leech(1)), D(E.taint())]);
  unit('f4_nocturn', '夜曲', 'f4_nocturn', 5, 1, [D(E.spawn('wraith', 3, 'here'))]);
  unit('f4_desolater', '荒芜者', 'f4_desolater', 5, 2, [P(E.burn(1))]);
  unit('f4_fallenaspect', '堕落化身', 'f4_fallenaspect', 5, 1, [P(E.beam(3)), P(E.selfBase(2))]);
  unit('juggernaut', '深渊巨像', 'f4_juggernaut', 6, 1, [P(E.horde(1))]);
  unit('f4_megafiend', '巨型魔', 'f4_megafiend', 6, 1, [D(E.ring(2))]);
  unit('f4_demonofeternity', '永恒之魔', 'f4_demonofeternity', 6, 1, [D(E.spawn('tk_demon', 4, 'here'))]);
  unit('reaper', '九月收割者', 'f4_reaperninemoons', 7, 2, [D(E.spawn('wraith', 3, 'here'))]);
  unit('f4_grandmastervariax', '宗师瓦里亚克斯', 'f4_grandmastervariax', 8, 1, [P(E.spawn('wraith', 3, 'sides')), P(E.taintAdj())]);
  unit('f4_pitstrider', '毒牙行者', 'f4_pitstrider', 3, 1, [A(K.venom())]);
  spell('f4s_seed', '瘟疫之种', 2, 'foe', '让一个敌方单位和它相邻的敌方单位中毒：每个回合开始时 −1 战力。', (s, ev, side, t, id) => { const ts = [t, ...foes(s, side, adj4(t))].filter(x => isUnit(s.board[x])); fx(ev, 'bolt', id, castle(side), ts); ts.forEach(x => poison(s, ev, x)); }, (s, side, t) => isUnit(s.board[t]));
  unit('f4_furosa', '血怒小鬼', 'f4_furosa', 2, 2, [D(E.selfBase(1))]);
  unit('f4_underworldbrute', '冥界蛮兵', 'f4_underworldbrute', 4, 2, [P(E.selfBase(2))]);
  unit('f4_siren', '塞壬', 'f4_siren', 4, 1, [P(E.drain(1))]);
  unit('f4_deathknell', '丧钟', 'f4_deathknell', 4, 0, [P(E.cull(2))]);
  spell('f4s_price', '血的代价', 4, 'foe', '消灭一个战力不超过 7 的敌方单位或建筑，你自己的城堡受 3 点伤害。', (s, ev, side, t, id) => { fx(ev, 'bolt', id, castle(side), [t]); kill(s, ev, t); _hb(s, ev, side, 3); }, (s, side, t) => s.board[t].str <= 7 && s.base[side] > 3);
  struct('f4_daemongate', '魔门', 'f4_daemongate', 4, [T(E.spawn('wraith', 1, 'front'))]);
  struct('f4_buildminion', '暗影祭坛', 'f4_buildminion', 3, [P(E.taintAdj()), MOURN('对方城堡受 1 点伤害', 2, (s, ev, w, x, t) => { fx(ev, 'bolt', w.card, x, [{ base: 1 - w.side }]); hitBase(s, ev, 1 - w.side, 1); })]);
  struct('f4_buildlegendary', '灵魂熔炉', 'f4_buildlegendary', 5, [T(E.burn(1))]);
  spell('siphon', '灵魂虹吸', 3, 'foe', '对一个敌方单位或建筑造成 3 点伤害，你的城堡 +1 血。', (s, ev, side, t, id) => { zap(s, ev, id, castle(side), [t], 3, 'drain'); mend(s, ev, side, 1); });
  spell('f4s_swarm', '影灵涌现', 3, 'none', '在你家门口的每个空格放一只 1 战力的影灵。', (s, ev, side, t, id) => { const ts = [...Array(COLS)].map((_, c) => tile(side ? ROWS - 1 : 0, c)).filter(x => !s.board[x]); fx(ev, 'summon', id, castle(side), ts); ts.forEach(x => summon(s, ev, side, 'wraith', x, 1)); }, (s, side) => [...Array(COLS)].some((_, c) => !s.board[tile(side ? ROWS - 1 : 0, c)]));
  spell('f4s_ritual', '黑暗献祭', 2, 'ally', '消灭一个友方单位，对方城堡受到它战力一半的伤害（向上取整）。', (s, ev, side, t, id) => { const n = Math.ceil(s.board[t].str / 2); fx(ev, 'drain', id, t, [castle(1 - side)]); kill(s, ev, t); hitBase(s, ev, 1 - side, n); });
  spell('f4s_shadow', '蔓延暗影', 3, 'foe', '对一个敌人造成 2 点伤害，并在它脚下和相邻的格子留下暗影（留 3 个回合）。', (s, ev, side, t, id) => { zap(s, ev, id, castle(side), [t], 2, 'bolt'); taint(s, ev, id, t, [t, ...adj4(t)], side); });
  spell('f4s_plague', '瘟疫', 5, 'none', '所有敌方单位和建筑各受 1 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), enemies(s, side), 1, 'storm'), (s, side) => enemies(s, side).length > 0);
  spell('f4s_doom', '末日审判', 6, 'foe', '对一个敌方单位或建筑造成 7 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), [t], 7, 'bolt'));
  spell('f4s_pact', '恶魔契约', 1, 'none', '你的城堡 −2 血，获得 2 点能量。', (s, ev, side, t, id) => { fx(ev, 'drain', id, castle(side), [castle(side)]); hitBase(s, ev, side, 2); s.left += 2; ev.push({ t: 'mana', side, n: 2 }); }, (s, side) => s.base[side] > 2);

  // ======== 巨兽：成长、孵化、荆棘、狂暴 ========
  F = 'f5';
  token('tk_hatch', '幼兽', 'f5_gro'); token('tk_rex', '远古巨兽', 'f5_dreadnaught');
  unit('f5_silitharyoung', '幼蜥', 'f5_silitharyoung', 2, 1, [W(E.grow(1))]);
  unit('f5_minibeast', '小兽', 'f5_minibeast', 2, 0, [T(E.grow(1))]);
  unit('f5_gibblegup', '咕噜兽', 'f5_gibblegup', 2, 0, [THORNS(1)]);
  unit('f5_unstableflump', '躁动绒球', 'f5_unstableflump', 2, 1, [D(E.blast(2))]);
  unit('f5_kujata', '库佳塔', 'f5_kujata', 2, 0, [P(E.mana(1))]);
  unit('walker', '行地兽', 'f5_earthwalker', 3, 1, [T(E.grow(1))]);
  unit('f5_ragebinder', '缚怒者', 'f5_ragebinder', 3, 0, [P(E.aid(1))]);
  unit('f5_pteryx', '翼手龙', 'f5_pteryx', 3, 2, [P(E.lone(2))]);
  unit('f5_molokihuntress', '莫洛基女猎手', 'f5_molokihuntress', 3, 1, [W(E.shot(2))]);
  unit('f5_mandrake', '曼德拉草', 'f5_mandrake', 3, 0, [THORNS(2)]);
  unit('f5_flumposaur', '绒球龙', 'f5_flumposaur', 3, 1, [D(E.spawn('tk_hatch', 2, 'here'))]);
  unit('f5_rancour', '积怨兽', 'f5_rancour', 3, 1, [W(E.grow(2))]);
  unit('veteran', '蜥甲老兵', 'f5_silitharveteran', 4, 1, [THORNS(1)]);
  unit('gazer', '太初凝视者', 'f5_primordialgazer', 4, 0, [P(E.aidFront(3))]);
  unit('f5_catalystquillbeast', '棘刺兽', 'f5_catalystquillbeast', 4, 1, [THORNS(2)]);
  unit('f5_firebreather', '喷火兽', 'f5_firebreather', 4, 0, [T(E.shot(1))]);
  unit('f5_grimrock', '嶙峋岩兽', 'f5_grimrock', 4, 0, [TAUNT, T(E.grow(1))]);
  unit('f5_thraex', '斗兽', 'f5_thraex', 4, 1, [A(K.cleave(1))]);
  unit('f5_brundlbeast', '蛮角兽', 'f5_brundlbeast', 4, 2);
  unit('f5_omniseer', '全视者', 'f5_omniseer', 4, 0, [P(E.vitalAdj())]);
  unit('warbeast', '曼卡托战兽', 'f5_mankatorwarbeast', 5, 2);
  unit('f5_lavalasher', '熔岩鞭手', 'f5_lavalasher', 5, 1, [P(E.nova(2))]);
  unit('f5_ankylos', '甲龙', 'f5_ankylos', 5, 0, [TAUNT, THORNS(2)]);
  unit('f5_visionar', '维森纳', 'f5_visionar', 5, 1, [W(E.grow(2))]);
  unit('bronto', '巨龙兽', 'f5_megabrontodon', 6, 0, [D(E.blast(3))]);
  unit('elder', '蜥甲长老', 'f5_silitharelder', 6, 1, [T(E.grow(1))]);
  unit('f5_rex', '霸王龙', 'f5_rex', 6, 1, [A(K.cleave(2))]);
  unit('kolossus', '山岳巨兽', 'f5_kolossus', 7, 0);
  unit('f5_unstableleviathan', '躁动利维坦', 'f5_unstableleviathan', 7, 1, [D(E.ring(3))]);
  unit('f5_grandmasterkraigon', '宗师克雷贡', 'f5_grandmasterkraigon', 8, 1, [T(E.grow(2))]);
  unit('f5_oxalaia', '毒刺龙', 'f5_oxalaia', 4, 0, [P(E.venomAdj())]);
  spell('f5s_tame', '驯兽', 5, 'foe', '把一个战力不超过 3 的敌方单位变成你的。', (s, ev, side, t, id) => { fx(ev, 'bless', id, castle(side), [t]); convert(s, ev, t, side); }, (s, side, t) => isUnit(s.board[t]) && s.board[t].str <= 3);
  unit('f5_vindicator', '复仇兽', 'f5_vindicator', 4, 1, [A(K.rage(2))]);
  unit('f5_general', '兽王', 'f5_general', 5, 1, [R(E.grow(2))]);
  unit('f5_juggernaut', '撞城巨角', 'f5_juggernaut', 6, 2, [SIEGE(3)]);
  unit('f5_ragnoramk2', '拉格诺拉', 'f5_ragnoramk2', 7, 1, [R(E.advance())]);
  egg('f5_egg', '巨兽蛋', 'f5_egg', 2, 2, 'tk_hatch', 2, 5);
  egg('f5_egg2', '远古之蛋', 'f5_egg_ancient', 4, 3, 'tk_rex', 3, 11);
  struct('f5_buildminion', '孵化场', 'f5_buildminion', 5, [T(E.spawn('tk_hatch', 2, 'front'))]);
  spell('grow', '巨化', 4, 'ally', '一个友方单位 +4 战力。', (s, ev, side, t, id) => bless(s, ev, id, castle(side), [t], 4));
  spell('f5s_roar', '咆哮', 3, 'none', '你的所有单位各 +1 战力。', (s, ev, side, t, id) => bless(s, ev, id, castle(side), units(s, side), 1), (s, side) => units(s, side).length > 0);
  spell('f5s_feral', '野性', 2, 'ally', '一个友方单位 +2 战力。', (s, ev, side, t, id) => bless(s, ev, id, castle(side), [t], 2));
  spell('f5s_slam', '地裂', 4, 'foe', '对一个敌人和它相邻的敌人各造成 2 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), [t, ...foes(s, side, adj4(t))], 2, 'nova'));
  spell('f5s_devour', '吞噬', 3, 'foe', '对一个敌方单位或建筑造成 3 点伤害；把它打倒了的话，你的所有单位各 +1 战力。', (s, ev, side, t, id) => { const k = s.board[t].id; zap(s, ev, id, castle(side), [t], 3, 'slash'); if (!s.board.some(u => u && u.id === k)) bless(s, ev, id, castle(side), units(s, side), 1); });
  spell('f5s_stampede', '兽群奔袭', 5, 'none', '你的所有单位立刻各走一步。', (s, ev, side, t, id) => { const ids = units(s, side).sort((a, b) => depth(side, rowOf(b)) - depth(side, rowOf(a)) || colOf(a) - colOf(b)).map(x => s.board[x].id); fx(ev, 'bless', id, castle(side), units(s, side)); for (const k of ids) { const x = s.board.findIndex(u => u && u.id === k); if (x >= 0 && !s.board[x].frozen && s.winner === null) step(s, ev, x); } }, (s, side) => units(s, side).length > 0);
  spell('f5s_lick', '舔舐伤口', 2, 'ally', '一个友方单位 +2 战力，你的城堡 +1 血。', (s, ev, side, t, id) => { bless(s, ev, id, castle(side), [t], 2); mend(s, ev, side, 1); });

  // ======== 霜原：冻结、渗透、冰墙 ========
  F = 'f6';
  token('cub', '幼狼', 'f6_spiritwolf'); token('tk_whelp', '雏龙', 'neutral_monsterdragonhawk'); token('tk_treant', '霜木傀儡', 'f6_treant');
  struct('icewall', '冰墙', 'f6_bonechillbarrier', 2);
  unit('fox', '逐雪狐', 'f6_snowchaser', 2, 1, [P(E.infiltrate(2))]);
  unit('f6_snowman', '雪人', 'f6_snowman', 2, 0, [TAUNT]);
  unit('f6_icy', '小冰灵', 'f6_icy', 2, 0, [P(E.chillFront())]);
  unit('f6_bur', '冰原伯尔', 'f6_bur', 2, 1, [P(E.infiltrate(3))]);
  unit('f6_evilcrystalwisp', '晶灵', 'f6_evilcrystalwisp', 2, 0, [D(E.chill())]);
  unit('north', '冰翼法师', 'f6_greatwhitenorth', 3, 0, [P(E.chill())]);
  unit('ronin', '独行剑客', 'f6_freeblade', 3, 1, [P(E.lone(3))]);
  unit('f6_sleetdasher', '霰行者', 'f6_sleetdasher', 3, 2, [A(K.shatter(2))]);
  unit('f6_icehornet', '冰蜂', 'f6_icehornet', 3, 2, [P(E.infiltrate(2))]);
  unit('f6_frostbitehawker', '霜噬猎鹰', 'f6_frostbitehawker', 3, 1, [P(E.shot(1)), P(E.chillFront())]);
  unit('f6_kindredhunter', '同族猎手', 'f6_kindredhunter', 3, 1, [A(K.shatter(3))]);
  unit('f6_wolfraven', '狼鸦', 'f6_wolfraven', 3, 1, [P(E.chillFront())]);
  unit('dryad', '冰树精', 'f6_icedryad', 4, 1, [A(K.shatter(3))]);
  unit('f6_crystalbeetle', '晶甲虫', 'f6_crystalbeetle', 4, 1, [SHIELD]);
  unit('f6_arcticrhyno', '极地犀', 'f6_arcticrhyno', 4, 2, [R(E.advance())]);
  unit('f6_snowrippler', '裂雪兽', 'f6_snowrippler', 4, 1, [P(E.nova(1)), P(E.chillFront())]);
  unit('f6_huldra', '胡尔德拉', 'f6_huldra', 4, 0, [P(E.aid(1)), P(E.chill())]);
  unit('f6_ravager', '掠夺者', 'f6_ravager', 4, 1, [P(E.infiltrate(4))]);
  unit('f6_ghostseraphim', '幽灵炽天使', 'f6_ghostseraphim', 4, 0, [P(E.chillLane())]);
  unit('f6_waterbear', '水熊', 'f6_waterbear', 4, 1, [D(E.chill())]);
  unit('fenrir', '芬里尔战将', 'f6_fenrirwarmaster', 5, 1, [D(E.spawn('cub', 3, 'here'))]);
  unit('f6_tundraguardian', '冻原守卫', 'f6_tundraguardian', 5, 0, [TAUNT, P(E.chill())]);
  unit('f6_snowwyvern', '雪翼龙', 'f6_snowwyvern', 5, 2, [P(E.shot(2))]);
  unit('f6_fenrirwerewolf', '芬里尔狼人', 'f6_fenrirwerewolf', 5, 2, [P(E.infiltrate(4))]);
  unit('f6_vanarsentinel', '霜原哨卫', 'f6_vanarsentinel', 5, 1, [SHIELD]);
  unit('drake', '霜龙', 'f6_frostdrake', 6, 1, [P(E.chillLane())]);
  unit('f6_draugarlord', '霜木领主', 'f6_draugarlord', 6, 1, [D(E.spawn('tk_treant', 5, 'here'))]);
  unit('f6_whitewyvern', '白翼龙', 'f6_whitewyvern', 6, 2, [P(E.chillFront()), P(E.shot(2))]);
  unit('f6_seismicelemental', '地震元素', 'f6_seismicelemental', 7, 1, [P(E.ring(2))]);
  unit('f6_grandmasterembla', '宗师恩布拉', 'f6_grandmasterembla', 8, 1, [P(E.spawn('icewall', 3, 'sides')), P(E.chill())]);
  unit('f6_ynuytwarlock', '霜巫', 'f6_ynuytwarlock', 4, 0, [P(E.silenceAdj())]);
  spell('f6s_amnesia', '冰封记忆', 3, 'foe', '冻住一个敌方单位，并禁用它的能力。', (s, ev, side, t, id) => { chillAll(s, ev, id, castle(side), [t]); mute(s, ev, t); }, (s, side, t) => isUnit(s.board[t]) && !s.board[t].mute);
  unit('f6_circulus', '环流精', 'f6_circulus', 4, 1, [P(E.mana(2))]);
  unit('f6_general', '霜后', 'f6_general', 6, 1, [P(E.pour(2))]);
  unit('f6_motherofdrakes', '龙母', 'f6_motherofdrakes', 6, 0, [P(E.spawn('tk_whelp', 2, 'sides'))]);
  spell('f6s_confine', '冰牢', 3, 'foe', '把一个敌方单位的战力压到 4（本来不到 4 的不变），并冻住它。', (s, ev, side, t, id) => { const u = s.board[t]; fx(ev, 'frost', id, castle(side), [t]); if (u.str > 4) { ev.push({ t: 'hurt', tile: t, id: u.id, n: u.str - 4, str: 4 }); u.str = 4; } freeze(s, ev, t); }, (s, side, t) => isUnit(s.board[t]) && (s.board[t].str > 4 || !s.board[t].frozen));
  struct('f6_blazingspines', '冰棘', 'f6_blazingspines', 3, [THORNS(2)]);
  struct('f6_gravitywell', '引力井', 'f6_gravitywell', 4, [T(E.chillNear())]);
  spell('chill', '寒流', 3, 'foe', '冻住目标所在那一路的所有敌方单位：它们下回合不前进，能力也暂时失效。', (s, ev, side, t, id) => chillAll(s, ev, id, castle(side), lane(s, side, colOf(t))));
  spell('f6s_shard', '冰锥', 2, 'foe', '对一个敌人造成 3 点伤害；它被冻住的话改为 6 点。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), [t], s.board[t].frozen ? 6 : 3, 'frost'));
  spell('f6s_blizzard', '暴风雪', 6, 'none', '所有敌方单位各受 1 点伤害并被冻住。', (s, ev, side, t, id) => { const ts = enemies(s, side); zap(s, ev, id, castle(side), ts, 1, 'storm'); ts.forEach(x => freeze(s, ev, x)); }, (s, side) => enemies(s, side).length > 0);
  spell('f6s_wall', '冰封之墙', 3, 'ally', '在一个友方单位的左右两侧各放一堵 3 战力的冰墙。', (s, ev, side, t, id) => { const ts = [t - 1, t + 1].filter(x => inb(x) && rowOf(x) === rowOf(t) && !s.board[x]); fx(ev, 'summon', id, castle(side), ts); ts.forEach(x => summon(s, ev, side, 'icewall', x, 3)); }, (s, side, t) => [t - 1, t + 1].some(x => inb(x) && rowOf(x) === rowOf(t) && !s.board[x]));
  spell('f6s_mark', '霜之印记', 2, 'ally', '一个友方单位 +2 战力；它在对方半场的话改为 +4。', (s, ev, side, t, id) => bless(s, ev, id, castle(side), [t], deep(side, t) ? 4 : 2));
  spell('f6s_avalanche', '雪崩', 4, 'none', '所有被冻住的敌方单位各受 4 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), enemies(s, side).filter(x => s.board[x].frozen), 4, 'frost'), (s, side) => enemies(s, side).some(x => s.board[x].frozen));
  spell('f6s_mist', '霜雾', 1, 'foe', '冻住一个敌方单位。', (s, ev, side, t, id) => chillAll(s, ev, id, castle(side), [t]), (s, side, t) => isUnit(s.board[t]) && !s.board[t].frozen);

  // ======== 岚影：连击、奇袭、偷袭、咒印（法术联动） ========
  F = 'f2';
  token('tk_paper', '纸鹤', 'f2_orizuru'); token('tk_panda', '小熊猫', 'f2_panddo');
  unit('f2_melee', '岚影足轻', 'f2_melee', 2, 1, [C(E.grow(1))]);
  unit('f2_xho', '符灵', 'f2_xho', 2, 0, [S(E.grow(1))]);
  unit('f2_ace', '火花鼠', 'f2_ace', 2, 1, [C(E.shot(2))]);
  unit('f2_katara', '苦无手', 'f2_katara', 2, 1, [A(K.flank(2))]);
  unit('f2_spellthief', '窃咒者', 'f2_spellthief', 2, 0, [C(E.mana(1))]);
  unit('f2_ranged', '手里剑忍', 'f2_ranged', 3, 0, [P(E.shot(2)), C(E.shot(2))]);
  unit('f2_support', '赤蝎', 'f2_support', 3, 1, [AMBUSH]);
  unit('f2_lanternfox', '灯笼狐', 'f2_lanternfox', 3, 1, [S(E.aid(1))]);
  unit('f2_sparrowhawk', '雀鹰忍', 'f2_sparrowhawk', 3, 2, [A(K.flank(2))]);
  unit('f2_caster', '符咒师', 'f2_caster', 3, 0, [S(E.shot(2))]);
  unit('f2_tank', '赤甲武者', 'f2_tank', 3, 0, [TAUNT, P(E.lone(2))]);
  unit('f2_deathphantom', '无常', 'f2_deathphantom', 3, 1, [AMBUSH, D(E.nova(1))]);
  unit('f2_pandabear', '熊猫武僧', 'f2_pandabear', 3, 1, [D(E.spawn('tk_panda', 2, 'here'))]);
  unit('f2_kindling', '炎环舞者', 'f2_kindling', 4, 0, [P(E.nova(1)), C(E.nova(1))]);
  unit('f2_mage4winds', '四风法师', 'f2_mage4winds', 4, 0, [S(E.burn(1))]);
  unit('f2_onnabugeisha', '女武者', 'f2_onnabugeisha', 4, 1, [A(K.flank(3))]);
  unit('f2_onyxjaguar', '玄豹', 'f2_onyxjaguar', 4, 2, [AMBUSH]);
  unit('f2_flareslinger', '火铳手', 'f2_flareslinger', 4, 0, [P(E.shot(4))]);
  unit('f2_hammonnladeseeker', '寻刃者', 'f2_hammonnladeseeker', 4, 1, [C(E.grow(3))]);
  unit('f2_sekitori', '关取力士', 'f2_sekitori', 4, 0, [TAUNT, P(E.push(2))]);
  unit('f2_seenoevil', '无目剑客', 'f2_seenoevil', 4, 1, [AMBUSH, A(K.flank(3))]);
  unit('f2_geomancer', '地脉师', 'f2_geomancer', 5, 0, [S(E.aidAll(1))]);
  unit('f2_demononi', '鬼面', 'f2_demononi', 5, 1, [C(E.ring(2))]);
  unit('f2_stormkage', '风暴上忍', 'f2_stormkage', 5, 2, [A(K.flank(3))]);
  unit('f2_supekuta', '幽刃', 'f2_supekuta', 5, 1, [AMBUSH, P(E.nova(2))]);
  unit('f2_eclipseasura', '蚀日修罗', 'f2_eclipseasura', 6, 1, [P(E.ring(1)), C(E.ring(2))]);
  unit('f2_firewyrm', '火龙', 'f2_firewyrm', 6, 2, [P(E.beam(2))]);
  unit('f2_grandmasterzendo', '宗师禅道', 'f2_grandmasterzendo', 7, 1, [P(E.aid(1)), S(E.grow(2))]);
  unit('f2_eternitypainter', '永恒画师', 'f2_eternitypainter', 7, 0, [P(E.hex())]);
  unit('f2_shidaimk2', '四代目', 'f2_shidaimk2', 8, 1, [AMBUSH, P(E.ring(3))]);
  unit('f2_keshraifanblade', '毒扇忍', 'f2_keshraifanblade', 3, 1, [P(E.venom())]);
  unit('f2_kibeholder', '影缚者', 'f2_kibeholder', 4, 0, [C(E.silenceAdj())]);
  unit('f2_heartofthesonghai', '岚影之心', 'f2_heartofthesonghai', 2, 0, [P(E.last(5))]);
  unit('f2_masteroftaikwai', '太极宗师', 'f2_masteroftaikwai', 5, 1, [THORNS(3)]);
  spell('f2s_refill', '蓄势', 2, 'none', '把手牌补满到 4 张。', (s, ev, side) => draw(s, ev, side, 4), (s, side) => s.hand[side].length < 4);
  struct('f2_buildcommon', '手里剑架', 'f2_buildcommon', 4, [T(E.nova(1))]);
  struct('f2_buildlegendary', '影之祠', 'f2_buildlegendary', 5, [S(E.spawn('tk_paper', 2, 'front'))]);
  spell('f2s_stance', '起手式', 1, 'none', '获得 1 点能量。（算打出一张牌，能接连击、能触发咒印）', (s, ev, side) => { s.left += 1; ev.push({ t: 'mana', side, n: 1 }); });
  spell('f2s_shuriken', '手里剑', 2, 'foe', '对一个敌人造成 2 点伤害。连击：这回合你已经打过别的牌的话，改为 4 点。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), [t], s.plays > 0 ? 4 : 2, 'bolt'));
  spell('f2s_dash', '疾走', 2, 'ally', '一个友方单位 +1 战力，并立刻走两步。', (s, ev, side, t, id) => { bless(s, ev, id, castle(side), [t], 1); const k = s.board[t].id; for (let i = 0; i < 2; i++) { const x = s.board.findIndex(u => u && u.id === k); if (x >= 0) march(s, ev, side, [x]); } });
  spell('f2s_clone', '影分身', 3, 'ally', '在一个友方单位旁边的空格放一个它的分身，战力和它一样，最多 5。', (s, ev, side, t, id) => { const u = s.board[t], x = [t - fwd(side) * COLS, ...[t - 1, t + 1].filter(x => inb(x) && rowOf(x) === rowOf(t)), t + fwd(side) * COLS].find(x => inb(x) && !s.board[x]); fx(ev, 'summon', id, t, [x]); summon(s, ev, side, u.card, x, Math.min(5, u.str)); }, (s, side, t) => adj4(t).some(x => !s.board[x]));
  spell('f2s_chain', '连环斩', 4, 'foe', '对一个敌人造成 3 点伤害；这回合你在它之前每打过一张牌，再多 2 点。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), [t], 3 + 2 * s.plays, 'slash'));
  spell('f2s_seal', '纸鹤封印', 5, 'foe', '把一个敌方单位变成 1 战力的纸鹤。', (s, ev, side, t, id) => { fx(ev, 'bolt', id, castle(side), [t]); morph(s, ev, t, 'tk_paper', 1, 'hex'); }, (s, side, t) => isUnit(s.board[t]) && s.board[t].card !== 'tk_paper');
  spell('f2s_fire', '火遁·横扫', 5, 'foe', '目标所在那一横排的所有敌人各受 3 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), enemies(s, side).filter(x => rowOf(x) === rowOf(t)), 3, 'beam'));

  // ======== 沙海：方尖碑（建筑流）、风（吹退与推进）、遗物 ========
  F = 'f3';
  token('tk_dervish', '沙灵', 'f3_dervish'); token('tk_iron', '铁沙灵', 'f3_irondervish');
  unit('f3_pax', '沙蝎', 'f3_pax', 2, 1, [P(E.byStruct(1))]);
  unit('f3_miniscarab', '小圣甲虫', 'f3_miniscarab', 2, 0, [D(E.spawn('tk_dervish', 1, 'here'))]);
  unit('f3_rae', '沙尘精', 'f3_rae', 2, 0, [P(E.gust())]);
  unit('f3_dunecaster', '沙丘术士', 'f3_dunecaster', 2, 0, [P(E.build(2))]);
  unit('f3_windshriek', '啸风鸟', 'f3_windshriek', 3, 2, [SWIFT]);
  unit('f3_aymarahealer', '筑碑祭司', 'f3_aymarahealer', 3, 0, [P(E.aidStruct(2))]);
  unit('f3_orbweaver', '织沙者', 'f3_orbweaver', 3, 1, [P(E.spawn('tk_dervish', 1, 'behind'))]);
  unit('f3_badlandsscout', '荒地斥候', 'f3_badlandsscout', 3, 2, [P(E.aidLane(1))]);
  unit('f3_pyromancer', '炎术士', 'f3_pyromancer', 3, 0, [P(E.shot(3))]);
  unit('f3_windgiver', '赐风者', 'f3_windgiver', 3, 0, [P(E.tailwind())]);
  unit('f3_sandhowler', '沙嚎兽', 'f3_sandhowler', 3, 1, [P(E.gust())]);
  unit('f3_falcius', '碑卫法尔修', 'f3_falcius', 4, 1, [P(E.build(2))]);
  unit('f3_windslicer', '裂风者', 'f3_windslicer', 4, 1, [P(E.gustAdj())]);
  unit('f3_insightcaster', '洞察术士', 'f3_insightcaster', 4, 0, [P(E.aidStruct(1)), P(E.shot(2))]);
  unit('f3_duskweaver', '织暮者', 'f3_duskweaver', 4, 0, [T(E.aidStruct(1))]);
  unit('f3_sirocco', '热风', 'f3_sirocco', 4, 2, [SWIFT, D(E.gustAdj())]);
  unit('f3_anubis', '胡狼卫', 'f3_anubis', 4, 0, [TAUNT, P(E.build(1))]);
  unit('f3_ishtarhunter', '逐风猎手', 'f3_ishtarhunter', 5, 1, [P(E.shot(2)), P(E.gust())]);
  unit('f3_sakkak', '萨卡克', 'f3_sakkak', 5, 1, [D(E.spawn('tk_iron', 3, 'here'))]);
  unit('f3_scarabtera', '巨甲虫', 'f3_scarabtera', 5, 0, [TAUNT, D(E.spawn('tk_dervish', 2, 'sides'))]);
  unit('f3_nimbus', '雨云', 'f3_nimbus', 5, 0, [T(E.spawn('tk_dervish', 1, 'front'))]);
  unit('f3_zephyr', '泽菲尔', 'f3_zephyr', 5, 2, [SWIFT, P(E.gust())]);
  unit('f3_dreamshaper', '塑梦者', 'f3_dreamshaper', 6, 0, [P(E.aidStruct(2)), P(E.aid(1))]);
  unit('f3_keeperofages', '岁月守护者', 'f3_keeperofages', 6, 0, [TAUNT, T(E.heal(1))]);
  unit('f3_ciphyronmk2', '风王赛弗隆', 'f3_ciphyronmk2', 7, 1, [P(E.gale())]);
  unit('f3_zodiac', '黄道巨像', 'f3_zodiac', 8, 1, [P(E.spawn('tk_iron', 4, 'sides')), P(E.build(1))]);
  unit('f3_curseddervish', '咒沙灵', 'f3_curseddervish', 3, 1, [D(E.venomAdj())]);
  spell('f3s_curse', '沙之诅咒', 2, 'foe', '禁用一个敌方单位或建筑的能力，它的装备也掉了；你每有一座建筑，再对它造成 1 点伤害。', (s, ev, side, t, id) => { fx(ev, 'bolt', id, castle(side), [t]); mute(s, ev, t); const n = structs(s, side).length; if (n && s.board[t]) hurt(s, ev, t, n); });
  unit('f3_general', '筑城官', 'f3_general', 3, 0, [P(E.rouse())]);
  unit('f3_windstriker', '风击者', 'f3_windstriker', 4, 1, [P(E.byStruct(3))]);
  unit('f3_incinera', '炎灵', 'f3_incinera', 5, 2, [SIEGE(3)]);
  struct('f3_buildcommon', '流沙塔', 'f3_buildcommon', 2, [T(E.decay(2))]);
  struct('f3_obelyskredsand', '红沙碑', 'f3_obelyskredsand', 3, [T(E.spawn('tk_dervish', 1, 'front'))]);
  struct('f3_trifectaperfecta', '聚能水晶', 'f3_trifectaperfecta', 3, [T(E.income())]);
  struct('f3_obelyskgoldenflame', '金焰碑', 'f3_obelyskgoldenflame', 4, [T(E.shot(2))]);
  struct('f3_obelyskduskwind', '暮风碑', 'f3_obelyskduskwind', 4, [T(E.gust())]);
  struct('f3_deathobelysk', '亡者碑', 'f3_deathobelysk', 4, [TAUNT, D(E.ring(2))]);
  struct('f3_lavastormobelysk', '熔岩碑', 'f3_lavastormobelysk', 5, [T(E.nova(2))]);
  struct('f3_endlessobelysk', '无尽碑', 'f3_endlessobelysk', 5, [T(E.spawn('tk_dervish', 3, 'front'))]);
  spell('f3s_tailwind', '顺风', 2, 'ally', '一个友方单位 +1 战力，并立刻走一步。', (s, ev, side, t, id) => { bless(s, ev, id, castle(side), [t], 1); march(s, ev, side, [t]); });
  spell('f3s_fortify', '筑沙', 2, 'none', '你的建筑各 +3 战力。', (s, ev, side, t, id) => { const ts = structs(s, side); fx(ev, 'bless', id, castle(side), ts); ts.forEach(x => buff(s, ev, x, 3)); }, (s, side) => structs(s, side).length > 0);
  spell('f3s_sandstorm', '沙暴', 3, 'foe', '把目标所在那一路的所有敌人各吹退一格；吹不动的（建筑，或者身后没有空格）改为受 2 点伤害。', (s, ev, side, t, id) => blow(s, ev, id, castle(side), lane(s, side, colOf(t)), side));
  spell('f3s_banish', '放逐', 4, 'foe', '把一个敌人沿着它那一路吹回它家门口（那一格有人就停在最近的空格）；吹不动的（建筑，或者它身后没有空格）改为受 4 点伤害。', (s, ev, side, t, id) => { const to = isUnit(s.board[t]) ? banishTo(s, side, t) : -1; fx(ev, 'gust', id, castle(side), [t]); if (to >= 0) shift(s, ev, t, to, 'push'); else hurt(s, ev, t, 4); });
  spell('f3s_starfall', '星陨', 6, 'none', '每一路离你最近的那个敌人各受 4 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), [...Array(COLS)].map((_, c) => firstInLane(s, side, c)).filter(x => x >= 0), 4, 'storm'), (s, side) => enemies(s, side).length > 0);
  gear('f3g_boots', '风行之靴', 2, 1, [SWIFT]);
  gear('f3g_scarab', '黄金圣甲虫', 3, 2, [D(E.spawn('tk_iron', 3, 'here'))]);

  // ======== 中立：哪个阵营都能带 ========
  F = 'n';
  token('tk_mini', '小贾克西', 'neutral_minijax');
  unit('neutral_dex', '游侠德克斯', 'neutral_dex', 2, 1);
  unit('n_militia', '民兵', 'neutral_mercmelee1', 1, 0);                                   // 1 费的兵：前几个回合能把零头能量花掉
  unit('n_courier', '信使', 'neutral_mercmelee2', 1, 1, [D(E.selfBase(1))]);
  unit('neutral_jaxi', '贾克西', 'neutral_jaxi', 2, 1, [D(E.spawn('tk_mini', 1, 'here'))]);
  unit('general', '火镰客', 'f2_tier2general', 3, 2);
  unit('warden', '铁壁卫士', 'neutral_primusshieldmaster', 3, 0, [GUARD]);
  unit('martyr', '殉道祭司', 'neutral_healingmystic', 3, 1, [D(E.aid(2))]);
  unit('grapple', '钩锁手', 'neutral_syvrel', 3, 1, [P(E.pull())]);
  unit('neutral_golemstone', '石魔像', 'neutral_golemstone', 3, 0);
  unit('neutral_sai', '剑客赛', 'neutral_sai', 3, 1, [R(E.grow(2))]);
  unit('neutral_silverbeak', '银喙', 'neutral_silverbeak', 3, 1, [P(E.heal(1))]);
  unit('noshrak', '雷枪手', 'f3_grandmasternoshrak', 4, 1, [A(K.pierce(2))]);
  unit('maul', '重锤手', 'neutral_goldenhammer', 4, 1, [P(E.push(2))]);
  unit('neutral_rook', '佣兵鲁克', 'neutral_rook', 4, 1);
  unit('neutral_giantcrab', '巨蟹', 'neutral_giantcrab', 4, 0, [TAUNT]);
  unit('neutral_golemsteel', '钢魔像', 'neutral_golemsteel', 5, 0);
  unit('neutral_bastion', '堡垒卫士', 'neutral_bastion', 5, 0, [GUARD, P(E.aid(1))]);
  unit('neutral_thunderhorn', '雷角兽', 'neutral_thunderhorn', 5, 1, [A(K.cleave(1))]);
  unit('neutral_bloodletter', '放血者', 'neutral_bloodletter', 5, 2, [P(E.shot(2)), A(K.leech(1))]);
  unit('neutral_moltengolem', '熔岩魔像', 'neutral_moltengolem', 6, 0, [D(E.blast(2))]);
  unit('neutral_astralcrusader', '星界十字军', 'neutral_astralcrusader', 7, 2);
  unit('tyrant', '天陨暴君', 'boss_skyfalltyrant', 8, 1, [A(K.cleave(3))]);
  unit('n_arrow', '哨箭手', 'neutral_arrowwhistler', 3, 0, [T(E.shot(1))]);
  unit('n_windrunner', '逐风者', 'neutral_windrunner', 3, 2, [SWIFT, FIXED]);
  unit('n_artificer', '工匠', 'neutral_artificer', 3, 0, [P(E.forge())]);
  unit('n_ironclad', '铁甲兵', 'neutral_ironclad', 4, 0, [TAUNT, THORNS(1)]);
  unit('n_rejuvenator', '回春师', 'neutral_rejuvenator', 4, 0, [T(E.heal(1))]);
  unit('n_bonereaper', '拾骨者', 'neutral_bonereaper', 5, 1, [MOURN('自己 +2 战力', 2, (s, ev, w, x) => buff(s, ev, x, 2))]);
  unit('n_harmony', '和声', 'boss_harmony', 5, 0, [S(E.heal(1))]);
  unit('n_kron', '重锤克隆', 'boss_kron', 6, 1, [P(E.push(3))]);
  unit('n_vampire', '血族', 'boss_vampire', 6, 1, [A(K.leech(2))]);
  unit('n_spelleater', '噬咒者', 'boss_spelleater', 6, 1, [S(E.grow(2))]);
  unit('n_chaosknight', '混沌骑士', 'boss_chaosknight', 7, 1, [A(K.cleave(2)), A(K.pierce(2))]);
  unit('n_shadowlord', '影主', 'boss_shadowlord', 7, 1, [D(E.cull(3))]);
  unit('n_paragon', '圣像', 'boss_paragon', 8, 0, [TAUNT, T(E.aid(1))]);
  unit('n_widow', '白寡妇', 'neutral_whitewidow', 3, 1, [THORNS(1), A(K.venom())]);
  unit('n_abjudicator', '裁决者', 'neutral_abjudicator', 3, 0, [P(E.silence())]);
  spell('n_turn', '策反', 6, 'foe', '把一个战力不超过 4 的敌方单位变成你的。', (s, ev, side, t, id) => { fx(ev, 'bless', id, castle(side), [t]); convert(s, ev, t, side); }, (s, side, t) => isUnit(s.board[t]) && s.board[t].str <= 4);
  unit('n_gambler', '赌徒', 'neutral_gambler', 3, 0, [P(E.draw(1))]);
  unit('n_grenadier', '掷弹兵', 'neutral_mercgrenadier', 4, 1, [SIEGE(3)]);
  unit('n_breach', '破城手', 'neutral_boulderbreach', 4, 1, [P(E.raze(4))]);
  unit('n_soulstealer', '夺魂者', 'boss_soulstealer', 5, 1, [A(K.execute())]);
  unit('n_herbalist', '药师', 'neutral_bloodstonealchemist', 3, 0, [P(E.vitalAdj())]);
  spell('n_vigor', '生命之泉', 2, 'ally', '一个友方单位获得活力：每个回合开始时 +1 战力，中的毒也解了。', (s, ev, side, t, id) => { fx(ev, 'bless', id, castle(side), [t]); vitalize(s, ev, t); }, (s, side, t) => !s.board[t].vital);
  // 种族联动：龙、魔像、骑士（种族名单在文件末尾的 TRIBE 里）
  unit('n_dragonling', '幼龙', 'neutral_monsterdragonhawk', 2, 1, [P(E.pack('龙', 2))]);
  unit('n_dragonspeaker', '龙语者', 'neutral_sapphireseer', 4, 0, [P(E.kin('龙', 2))]);
  struct('n_roost', '龙巢', 'neutral_beastcavern', 4, [T(E.kin('龙', 1))]);
  unit('n_golemrune', '符文魔像', 'neutral_golemrunesand', 4, 0, [P(E.pack('魔像', 2))]);
  unit('n_golemsmith', '魔像匠师', 'neutral_geargrinder', 3, 0, [P(E.kin('魔像', 2))]);
  unit('n_diamond', '钻石魔像', 'neutral_diamondgolem', 6, 0, [TAUNT]);
  unit('n_bannerman', '掌旗官', 'neutral_mercsworndefender', 3, 1, [P(E.kin('骑士', 1))]);
  unit('n_knightlord', '骑士团长', 'neutral_goldenjusticar', 5, 1, [P(E.pack('骑士', 1))]);
  // 装备：贴在一个友方单位身上，直到它倒下
  gear('g_sword', '阔剑', 2, 2, [A(K.cleave(1))]);
  gear('g_spear', '长枪', 2, 1, [A(K.pierce(2))]);
  gear('g_shield', '塔盾', 2, 2, [TAUNT]);
  gear('g_thorn', '荆棘甲', 2, 1, [THORNS(2)]);
  gear('g_ring', '生命戒指', 2, 1, [A(K.leech(1))]);
  gear('g_bomb', '火药桶', 2, 0, [D(E.nova(3))]);
  gear('g_bow', '猎弓', 3, 1, [T(E.shot(2))]);
  gear('g_banner', '战旗', 3, 1, [T(E.aid(1))]);
  spell('sword', '利刃', 3, 'ally', '一个友方单位 +3 战力。', (s, ev, side, t, id) => bless(s, ev, id, castle(side), [t], 3));
  spell('gem', '蓝宝石', 4, 'foe', '对一个敌方单位或建筑造成 5 点伤害。', (s, ev, side, t, id) => zap(s, ev, id, castle(side), [t], 5, 'bolt'));
  spell('potion', '血瓶', 2, 'none', '你的城堡 +3 血，不超过开局的血量。', (s, ev, side, t, id) => { fx(ev, 'heal', id, castle(side), [castle(side)]); mend(s, ev, side, 3); }, (s, side) => s.base[side] < s.cap[side]);
  spell('n_scroll', '蓄能卷轴', 1, 'none', '获得 2 点能量。', (s, ev, side) => { s.left += 2; ev.push({ t: 'mana', side, n: 2 }); });

  // ======== 首领牌：闯关模式里每个场地的首领，击败后获得。角色是之前没用过的“将军”和首领图 ========
  F = 'f1'; bossUnit('B_f1', '三环圣者', '奥瑞安', 'f1_scintilla', 7, 1, 9, [SHIELD, P(E.wardAll()), T(E.heal(1))]);
  F = 'f2'; bossUnit('B_f2', '千刃', '胧', 'f2_altgeneral', 6, 2, 6, [AMBUSH, P(E.tempest(2))]);
  F = 'f3'; bossUnit('B_f3', '砂之王', '赫鲁', 'f3_altgeneraltier2', 7, 1, 8, [P(E.rouseAll()), P(E.build(2))]);
  F = 'f4'; bossUnit('B_f4', '噬魂巨怪', '厄古', 'f4_abomination', 7, 1, 8, [P(E.spawn('wraith', 2, 'sides')), O(E.grow(2)), D(E.burn(3))]);
  F = 'f5'; bossUnit('B_f5', '蛮荒之主', '格鲁姆', 'f5_tier2general', 8, 1, 11, [T(E.grow(2)), A(K.cleave(3)), R(E.advance())]);
  F = 'f6'; bossUnit('B_f6', '霜冕', '伊蕾娜', 'f6_altgeneral', 7, 1, 8, [P(E.chillEvery()), A(K.shatterKill())]);
  F = 'n';
  bossUnit('B_n1', '影刃宗师', '李俊昊', 'boss_shinkagezendo', 6, 1, 7, [T(E.scorch(1))]);
  bossUnit('B_n2', '六臂默者', '王嘉伟', 'boss_dissonance', 7, 0, 12, [TAUNT, P(E.silenceEvery())]);
  bossUnit('B_n3', '霜暴巨兽', '戈尔', 'boss_borealjuggernaut', 8, 1, 14, [SIEGE(4)]);
  bossUnit('B_n4', '赤翼龙使', '潘腾之进击的巨屌', 'boss_skurge', 7, 2, 7, [P(E.spawn('tk_whelp', 4, 'sides')), P(E.kin('龙', 2))]);
  bossUnit('B_final', '糖果暴君', '团团', 'boss_candypanda', 8, 1, 12, [P(E.enthrall(2)), T(E.spawn('tk_panda', 3, 'behind'))]);

  // 种族：只是一个标签，本身没有效果；有的牌会给同族加成
  const TRIBE = {
    龙: ['B_n4', 'tk_whelp', 'f6_motherofdrakes', 'drake', 'f6_snowwyvern', 'f6_whitewyvern', 'f2_firewyrm', 'f5_pteryx', 'f5_rex', 'f5_oxalaia', 'bronto', 'n_dragonling'],
    魔像: ['neutral_golemstone', 'neutral_golemsteel', 'neutral_moltengolem', 'f3_zodiac', 'n_paragon', 'juggernaut', 'n_golemrune', 'n_diamond'],
    骑士: ['squire', 'tk_knight', 'f1_kingsguard', 'lancer', 'brome', 'f1_sunstonetemplar', 'f1_silvermanevanguard', 'f1_radiantdragoon', 'warden', 'neutral_bastion', 'n_ironclad', 'n_chaosknight', 'neutral_astralcrusader', 'n_bannerman', 'n_knightlord'],
  };
  for (const [tb, list] of Object.entries(TRIBE)) for (const k of list) cards[k].tribe = tb;
  // 把每张牌的说明拼出来（衍生物的名字要等全部登记完才知道）
  for (const c of Object.values(cards)) if (c.texts) {
    const parts = []; let last = null;
    for (const f of c.texts) { const m = /^(列阵|渗透|偷袭|攻城)：(.*)$/.exec(f()), body = m ? m[2] : f(), pre = f.pre || '';
      if (pre && pre === last) parts[parts.length - 1] += '，并且' + body; else parts.push((m ? m[1] + '：' : '') + pre + body); last = pre || null; }
    c.text = c.gear ? `装备：一个友方单位${c.bonus ? ` +${c.bonus} 战力，并` : ''}获得「${parts.join('；')}」。` : parts.length ? parts.join('；') + '。' : c.token ? '衍生物，不能放进卡组。' : '没有能力。'; delete c.texts;
  }

  const factions = {
    f1: { name: '圣辉骑士团', key: '圣盾 · 列阵 · 守城', style: '金甲骑士。圣盾能挡一次伤害，站在一起的人互相加战力，还能给城堡回血。' },
    f2: { name: '岚影', key: '连击 · 奇袭 · 偷袭 · 咒印', style: '忍者。一回合连着出几张牌有额外效果；有的兵能直接放到敌人身边，从侧面下手；每放一张法术，场上的人跟着起反应。' },
    f3: { name: '沙海', key: '方尖碑 · 风 · 遗物', style: '沙漠里的建造者。方尖碑不会动，但每回合都在干活；风能把敌人吹回去、把自己人送上去；遗物是给单位戴的装备。' },
    f4: { name: '深渊', key: '影灵 · 倒下时 · 暗影 · 献祭', style: '成群的影灵。很多牌倒下时才生效；暗影地格会让站在上面的敌人每回合掉血，留 3 个回合。' },
    f5: { name: '巨兽', key: '成长 · 孵化 · 荆棘 · 狂暴', style: '大块头。有的每回合变强，有的要先孵蛋，有的谁碰谁受伤。' },
    f6: { name: '霜原', key: '冻结 · 渗透 · 冰墙', style: '把对面的兵冻在原地（被冻住的下回合不前进，能力也暂时失效），用冰墙挡路，再把兵放进对方半场拿加成。' },
    n: { name: '中立', key: '', style: '哪个阵营的卡组都能带。这里还有装备牌：贴在一个友方单位身上，直到它倒下；一个单位只带一件，新的会换掉旧的。部分单位有种族（龙、魔像、骑士），有的牌会给同族加成。' },
  };
  const starters = { // 每个阵营一套预设卡组
    f1: ['squire', 'f1_silvermanevanguard', 'f1_warblade', 'lion', 'ballista', 'brome', 'f1_sunbreakguardian', 'f1_grandmasterzir', 'colossus', 'holy', 'f1s_shield', 'warden'],
    f2: ['f2_melee', 'f2_katara', 'f2_ace', 'f2_support', 'f2_lanternfox', 'f2_sparrowhawk', 'f2_kindling', 'f2_onyxjaguar', 'f2_demononi', 'f2_grandmasterzendo', 'f2s_shuriken', 'f2s_clone'],
    f3: ['f3_pax', 'f3_rae', 'f3_dunecaster', 'f3_orbweaver', 'f3_windshriek', 'f3_obelyskredsand', 'f3_obelyskgoldenflame', 'f3_falcius', 'f3_sakkak', 'f3_dreamshaper', 'f3s_tailwind', 'f3s_sandstorm'],
    f4: ['f4_swarm', 'f4_crawler', 'assassin', 'f4_gloomchaser', 'priestess', 'dancer', 'f4_darkspine', 'maehv', 'juggernaut', 'reaper', 'f4s_shadow', 'siphon'],
    f5: ['f5_silitharyoung', 'f5_minibeast', 'walker', 'f5_mandrake', 'veteran', 'gazer', 'f5_ankylos', 'elder', 'kolossus', 'f5_egg', 'grow', 'f5s_devour'],
    f6: ['fox', 'f6_icy', 'north', 'f6_icehornet', 'dryad', 'f6_ravager', 'fenrir', 'drake', 'icewall', 'chill', 'f6s_shard', 'f6s_mark'],
  };
  // 按打法组好的预设卡组，每个阵营两套。组法照 Stormbound 玩家总结的经验：至少有一种制胜手段（快攻、直伤、成长），
  // 有能推进前线的兵，有解场的牌，4 费以上的不超过 4 张，低费牌是核心（一回合多出几张通常比出一张大的强）。
  const decks = [
    { f: 'f1', name: '铁壁列阵', plan: '抱团成长：圣盾挡刀，列阵和祝福把一小队人越养越大，靠雄狮冲线收尾。', cards: ['n_militia', 'squire', 'f1_fiz', 'f1_friendsguard', 'f1_spellbladeadept', 'f1_silvermanevanguard', 'f1_warblade', 'f1s_smite', 'lion', 'f1_sunbreaker', 'f1_radiantdragoon', 'f1_archdeacon'] },
    { f: 'f1', name: '骑士冲锋', plan: '种族快攻：铺一排骑士，掌旗官和团长给同族加成，破阵骑士和龙骑直冲城门。', cards: ['n_militia', 'squire', 'neutral_dex', 'f1s_shield', 'n_bannerman', 'f1_kingsguard', 'f1_silvermanevanguard', 'f1s_smite', 'lancer', 'n_knightlord', 'f1_radiantdragoon', 'f1s_rally'] },
    { f: 'f2', name: '连击快攻', plan: '低费连击：一回合连出三四张小牌触发连击，用抽牌续手，不给对面喘气。', cards: ['f2s_stance', 'f2_melee', 'f2_ace', 'f2_katara', 'f2_support', 'f2s_shuriken', 'n_gambler', 'f2_sparrowhawk', 'f2_deathphantom', 'f2_seenoevil', 'f2_supekuta', 'f2_hammonnladeseeker'] },
    { f: 'f2', name: '咒印法术', plan: '法术联动：场上留着带咒印的人，每放一张法术他们就变强、放箭或给全队加战力。', cards: ['f2s_stance', 'f2_melee', 'f2_xho', 'f2s_shuriken', 'f2s_dash', 'f2_caster', 'f2_lanternfox', 'f2_pandabear', 'f2_support', 'f2s_clone', 'f2_buildlegendary', 'f2_kibeholder'] },
    { f: 'f3', name: '方尖碑', plan: '建筑流：先立碑，碑越多人越强；筑城官让碑多干一次活，水晶提供额外能量。', cards: ['f3_dunecaster', 'f3_rae', 'f3_pax', 'f3_obelyskredsand', 'f3_trifectaperfecta', 'f3_general', 'f3_orbweaver', 'n_militia', 'f3_obelyskgoldenflame', 'f3_falcius', 'f3_endlessobelysk', 'f3_dreamshaper'] },
    { f: 'f3', name: '顺风突袭', plan: '速度加吹退：乘风的兵一回合走两步，顺风再推一把，挡路的用风吹开或吹伤。', cards: ['n_courier', 'f3_pax', 'f3_windslicer', 'f3s_tailwind', 'f3_orbweaver', 'f3_windshriek', 'f3_sandhowler', 'f3_scarabtera', 'f3s_sandstorm', 'f3_windstriker', 'f3_ishtarhunter', 'f3_zephyr'] },
    { f: 'f4', name: '影灵海', plan: '铺场：满地影灵，拿它们献祭、喂祭司，最后用按人头加战力的巨像收尾。', cards: ['n_militia', 'f4_swarm', 'f4_husk', 'f4_crawler', 'f4_gor', 'f4_gloomchaser', 'f4s_swarm', 'siphon', 'priestess', 'f4_arachne', 'f4_daemongate', 'juggernaut'] },
    { f: 'f4', name: '毒与暗影', plan: '消耗直伤：中毒和暗影慢慢磨掉对面的兵，倒下时烧城堡的单位一点点把血磨光。', cards: ['n_militia', 'f4_furosa', 'f4_ooz', 'f4s_seed', 'f4_pitstrider', 'f4_nightfiend', 'siphon', 'f4s_shadow', 'f4_darkspine', 'dancer', 'f4_moonrider', 'f4_megafiend'] },
    { f: 'f5', name: '越养越大', plan: '成长：每回合自己变强的兵加上活力和巨化，拖得越久越占便宜。', cards: ['f5_omniseer', 'f5_vindicator', 'f5_silitharyoung', 'f5_thraex', 'n_vigor', 'warbeast', 'f5_rancour', 'f5s_devour', 'f5_grimrock', 'grow', 'f5_general', 'elder'] },
    { f: 'f5', name: '荆棘反击', plan: '防守反击：荆棘和嘲讽让对面撞得头破血流，再用霸王龙横扫收尾。', cards: ['f5_firebreather', 'f5_catalystquillbeast', 'f5_unstableflump', 'f5_silitharyoung', 'g_thorn', 'f5_mandrake', 'f5_ragebinder', 'f5s_devour', 'n_ironclad', 'f5s_slam', 'f5_ankylos', 'f5_rex'] },
    { f: 'f6', name: '冰封控制', plan: '控制：把对面冻在原地（能力也失效），再用专打冻结目标的牌清场。', cards: ['f6_wolfraven', 'f6_icy', 'fox', 'f6_bur', 'f6s_shard', 'north', 'f6_kindredhunter', 'chill', 'dryad', 'f6_ghostseraphim', 'f6_tundraguardian', 'drake'] },
    { f: 'f6', name: '渗透与龙', plan: '突进：把兵放进对方半场拿渗透加成，龙语者给一群龙加战力，两步冲城。', cards: ['f6_sleetdasher', 'f6_bur', 'fox', 'n_dragonling', 'f6_snowman', 'icewall', 'f6s_mark', 'f6_icehornet', 'n_dragonspeaker', 'f6_snowwyvern', 'f6_crystalbeetle', 'f6_whitewyvern'] },
  ];
  return { cards, factions, starters, decks };
}
