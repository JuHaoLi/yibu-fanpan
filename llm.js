// AI 对手：让大模型替电脑走一回合。玩家自己填接口地址、Key 和模型名（存在自己的浏览器里，不经过我们）。
// 提速的做法：一回合只问一次、让模型只回一行编号计划；规则放在固定的开头（给支持缓存的接口吃缓存）；
// 请求在玩家结束回合的那一刻就发出，趁棋盘演出时等回复；超时或出错就用内置电脑，对局不会卡住。
import { CARDS, ROWS, COLS, rowOf, targets, apply, evaluate, aiTurn, frontDepth, STRONG } from './chess.js';

const KEY = 'yibu-fanpan.llm.v1', TIMEOUT = 12000;
const DEFAULT = { on: false, style: 'openai', url: '', key: '', model: '' };
export const cfg = () => { try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULT }; } };
export const save = c => { try { localStorage.setItem(KEY, JSON.stringify({ ...DEFAULT, ...c })); } catch { /* 存不了就算了 */ } };
export const enabled = (c = cfg()) => !!(c.on && c.model && c.url); // 接口地址一律由玩家填，代码里不写死任何外部网址（离线包的体检要求）

// ---------- 给模型的玩法说明（固定不变，放在最前面） ----------
export const PLAYBOOK = `你在玩一个回合制的棋类卡牌游戏，扮演其中一方。目标：把对面城堡的血打到 0（先打到 0 的赢）。
【棋盘】4 路（列 0–3）× 5 行。格子编号 t = 行*4 + 列。双方城堡在棋盘两端。说明里的"深度 d"是离我方城堡的行数：d=0 紧挨我方城堡，d=4 紧挨敌方城堡。我方的兵每回合往 d 增大的方向前进一行，走出 d=4 就进了敌方城门，按自己的战力扣敌方城堡的血，然后离场；敌方的兵反方向走，同理。
【回合】轮到谁，谁先依次结算：建筑生效 → 状态（中毒每回合 −1 战力，活力每回合 +1，暗影格子上的敌人每回合 −1）→ 单位的"回合开始时"能力 → 场上的兵各往前走一步（这些都由系统自动完成）；然后才轮到你用能量出牌。你这一回合可以连续做任意多步：打牌（能量够就行）、换牌（每回合最多一次，换掉的牌从牌库另来一张）、最后结束回合。
【战力】单位的战力既是攻击也是血量。两个兵对撞，互相按对方的战力扣；剩下战力大于 0 的一方占住那一格，打平同归于尽。圣盾挡掉受到的第一次伤害。
【前进规则】场上的兵只往前：正前有敌人就打，没有就走，不拐弯。只有刚打出来、还在冲锋的兵（移动力 ≥ 1）会在打出时走满移动力，并且会拐去打旁边的敌人（顺序：正前 → 靠中间的一侧 → 靠边的一侧）。嘲讽：正前或左右紧挨着带嘲讽的敌人时，必须先打它。
【前线】新兵只能放在我方前线以内的空格：前线是我方最靠前的兵或建筑所在的深度，开局只有 d=0，最远到 d=3。法术不受前线限制；个别单位写着"奇袭"可以放在 d=3 以内任意空格。
【状态】冻住的单位下回合不前进、能力失效；禁用的单位能力永久失效；建筑不会动，不会被冻住、中毒或策反。
【卡牌】单位（出场后站在格子上）、建筑（不动）、法术（立即生效，有的要选目标格，有的不用）、装备（本质是法术，贴在一个友方单位上）。每张牌的费用、战力、移动力、效果写在局面里。
【打法建议】能一回合打穿敌方城堡就直接打穿；每回合尽量把能量花光；手里长期打不出的贵牌可以换掉；别把兵放在会被对面更大战力一换一的格子里；有嘲讽、圣盾的兵适合顶在前面。
【回复格式】只输出一行 JSON，不要任何解释：{"plan":["牌id@格子编号","牌id","swap:牌id","end"]}。
- "牌id@格子编号"：把这张牌打到这个格子（单位、建筑、要选目标的法术、装备都用这种写法；目标是场上的某个单位就写它所在的格子）。
- "牌id"：不需要选格子的法术。
- "swap:牌id"：换掉手里这张牌。
- 步骤按顺序执行，最后一项必须是 "end"。不合法的步骤会被丢掉，后面的由系统代打。
- 每张牌的"可打"一栏给了内置评分最高的几个格子（括号里是评分，越高越好）。优先从里面选，除非你有明确理由。`;

// ---------- 把局面写成一段紧凑的话 ----------
const flags = u => [u.frozen && '冻', u.shield && '盾', u.poison && '毒', u.vital && '活', u.mute && '禁', u.timer !== undefined && `蛋${u.timer}`, u.gear && `装「${CARDS[u.gear].name}」`].filter(Boolean).join(',');
const kindName = c => c.kind === 'structure' ? '建筑' : c.kind === 'spell' ? (c.target === 'ally' ? '装备/增益' : '法术') : '单位';
export function describe(s) {
  const me = s.turn, legend = new Set(), L = [];
  const cell = t => { const u = s.board[t], sh = s.creep[t] >= 0 ? `影${s.creep[t] === me ? '我' : '敌'}` : ''; if (!u) return `t${t} ${sh || '空'}`; legend.add(u.card); const c = CARDS[u.card]; return `t${t} ${u.side === me ? '我' : '敌'}「${c.name}」${u.str}${flags(u) ? '(' + flags(u) + ')' : ''}${sh ? ' ' + sh : ''}`; };
  L.push(`第 ${Math.ceil(s.n / 2)} 回合。能量 ${s.left}（本回合可用）。城堡血量：我 ${s.base[me]}/${s.cap[me]}，敌 ${s.base[1 - me]}/${s.cap[1 - me]}。我的牌库还剩 ${s.deck[me].length} 张。本回合${s.swapped ? '已经换过牌，不能再换' : '还可以换一次牌'}。我的前线：新兵最远放到 d=${frontDepth(s, me)}。`);
  L.push('棋盘（每行是一个深度 d，从我方城堡到敌方城堡；每格写 t编号）：');
  for (let d = 0; d < ROWS; d++) { const r = me ? ROWS - 1 - d : d; L.push(`d${d}: ` + [...Array(COLS).keys()].map(c => cell(r * COLS + c)).join(' | ')); }
  const base = evaluate(s, me), hand = s.hand[me];
  L.push('我的手牌：');
  hand.forEach((id, i) => { const c = CARDS[id], ts = targets(s, i); legend.add(id);
    let pos = c.cost > s.left ? '能量不够，现在打不出' : !ts.length ? '现在没有合法的格子' : ts.map(t => [t, evaluate(apply(s, { type: 'play', i, t }).state, me) - base]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, v]) => (t < 0 ? '直接打' : 't' + t) + (v > 1e5 ? '(直接获胜)' : `(${v >= 0 ? '+' : ''}${v.toFixed(1)})`)).join(' ');
    L.push(`- ${id}「${c.name}」${kindName(c)} 费${c.cost}${c.kind === 'spell' ? '' : ` 战力${c.str} 移动${c.move}`}：${c.text} 可打：${pos}`); });
  const extra = [...legend].filter(id => !hand.includes(id) && CARDS[id].text && CARDS[id].text !== '没有能力。');
  if (extra.length) L.push('场上其他单位的效果：' + extra.map(id => `「${CARDS[id].name}」${CARDS[id].text}`).join(' '));
  return L.join('\n');
}

// ---------- 把模型的回复变成一串合法动作 ----------
export function parsePlan(text) { // 容忍前后的废话、思考块和代码围栏：只认 "plan": [...]
  const m = /"plan"\s*:\s*(\[[^\]]*\])/.exec(String(text || '')); if (!m) return null;
  try { const a = JSON.parse(m[1]); return Array.isArray(a) ? a.map(String) : null; } catch { return null; }
}
// 照着计划一步步走：碰到第一个不合法的就停，后面的交给内置电脑；计划没写 end 就补上。返回 { acts, bad }（bad 是被丢掉的那一步，没有就是 null）
export function runPlan(s0, plan) {
  let s = s0; const me = s.turn, acts = []; let bad = null;
  for (const tok of plan.slice(0, 12)) {
    if (s.winner !== null) break;
    let a = null; const t = tok.trim();
    if (t === 'end') { acts.push({ type: 'end' }); return { acts, bad }; }
    if (t.startsWith('swap:')) { const i = s.hand[me].indexOf(t.slice(5)); if (i >= 0 && !s.swapped && s.deck[me].length) a = { type: 'swap', i }; }
    else { const [id, at] = t.split('@'), i = s.hand[me].indexOf(id), tile = at === undefined ? -1 : Number(at); if (i >= 0 && Number.isInteger(tile) && targets(s, i).includes(tile)) a = { type: 'play', i, t: tile }; }
    if (!a) { bad = tok; break; }
    try { s = apply(s, a).state; acts.push(a); } catch { bad = tok; break; }
  }
  if (s.winner === null) acts.push(...aiTurn(s, STRONG)); // 计划被丢掉一截或没写 end：从这里起交给内置电脑（它总以 end 收尾）
  return { acts, bad };
}

// ---------- 发请求 ----------
async function ask(c, user, signal) {
  const anth = c.style === 'anthropic', base = c.url.replace(/\/+$/, '');
  const r = await fetch(anth ? `${base}/v1/messages` : `${base}/chat/completions`, { method: 'POST', signal,
    headers: anth ? { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : { 'content-type': 'application/json', ...(c.key ? { authorization: 'Bearer ' + c.key } : {}) },
    body: JSON.stringify(anth ? { model: c.model, max_tokens: 160, system: [{ type: 'text', text: PLAYBOOK, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: user }] }
      : { model: c.model, max_tokens: 160, messages: [{ role: 'system', content: PLAYBOOK }, { role: 'user', content: user }] }) });
  if (!r.ok) throw new Error(`接口返回 ${r.status}：${(await r.text()).slice(0, 120)}`);
  const j = await r.json(); return anth ? (j.content || []).map(x => x.text || '').join('') : j.choices?.[0]?.message?.content || '';
}
const why = e => e.name === 'AbortError' ? `超过 ${TIMEOUT / 1000} 秒没回` : e instanceof TypeError ? '连不上接口（地址不对，或这个接口不允许网页直接调用）' : e.message;

// 让模型走这一回合：永远返回一串能走通的动作；note(text) 用来把“代打了”这类情况告诉玩家
export async function llmTurn(s, note = () => {}) {
  const c = cfg(), ac = new AbortController(), t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const text = await ask(c, describe(s), ac.signal), plan = parsePlan(text);
    if (!plan) { note('AI 的回复读不懂，这回合由内置电脑代打。'); return aiTurn(s, STRONG); }
    const { acts, bad } = runPlan(s, plan); if (bad) note(`AI 的计划里「${bad}」走不通，从这一步起由内置电脑代打。`); return acts;
  } catch (e) { note(`AI 没能出招（${why(e)}），这回合由内置电脑代打。`); return aiTurn(s, STRONG); }
  finally { clearTimeout(t); }
}
// 设置页的“测试连接”：发一个很小的请求，报告耗时
export async function ping(c) {
  const t0 = performance.now(), ac = new AbortController(), t = setTimeout(() => ac.abort(), TIMEOUT);
  try { await ask(c, '回复 {"plan":["end"]} 即可。', ac.signal); return { ok: true, ms: Math.round(performance.now() - t0) }; } catch (e) { return { ok: false, why: why(e) }; } finally { clearTimeout(t); }
}
