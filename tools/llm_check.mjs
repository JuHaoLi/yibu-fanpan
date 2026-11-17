// AI 对手（llm.js）的自检：局面说明、计划解析、计划校验与回退、请求格式、出错回退。不需要真的接口：fetch 用假的。
// 用法：node tools/llm_check.mjs
import assert from 'node:assert/strict';
import { CARDS, DECKS, newGame, apply, legalPlays, aiTurn } from '../chess.js';
const store = {}; globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
const { cfg, save, enabled, describe, parsePlan, runPlan, llmTurn, ping, PLAYBOOK } = await import('../llm.js');

let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const deckOf = f => DECKS.find(d => d.f === f).cards, fresh = (a = 'f1', b = 'f4') => { let s = newGame([deckOf(a), deckOf(b)], rnd); s = apply(s, { type: 'end' }).state; return s; }; // 走一个 end，轮到后手（side 1，AI 的位置）

// 局面说明：有棋盘、手牌、可打格子；不泄露对方手牌
{ const s = fresh(); const t = describe(s);
  assert.match(t, /d0: /); assert.match(t, /d4: /); assert.match(t, /我的手牌/); assert.match(t, /可打：/);
  for (const id of s.hand[1]) assert.ok(t.includes(id), '自己的手牌应在说明里');
  const only = s.hand[0].filter(id => !s.hand[1].includes(id)); for (const id of only) assert.ok(!t.includes(id) && !t.includes(CARDS[id].name), '不能泄露对方手牌 ' + id); }

// 解析：容忍围栏、思考块、前后废话；读不懂给 null
assert.deepEqual(parsePlan('{"plan":["a@3","end"]}'), ['a@3', 'end']);
assert.deepEqual(parsePlan('<think>想想 {"plan": ["x"]}</think>\n```json\n{"plan": ["a@3", "swap:b", "end"]}\n```'.replace('{"plan": ["x"]}', '')), ['a@3', 'swap:b', 'end']);
assert.equal(parsePlan('我觉得应该结束回合'), null); assert.equal(parsePlan('{"plan":"end"}'), null); assert.equal(parsePlan(undefined), null);

// 校验与回退：任何计划（含乱写的）走出来的动作都能依次走通，并且以 end 收尾或已分胜负
const play = (s, acts) => { for (const a of acts) s = apply(s, a).state; return s; };
for (let g = 0; g < 200; g++) {
  const s = fresh(['f1', 'f2', 'f3', 'f4', 'f5', 'f6'][g % 6], ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'][(g + 2) % 6]);
  const ids = [...s.hand[1], 'nope', ...s.hand[0]], toks = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => { const id = ids[Math.floor(rnd() * ids.length)], k = rnd(); return k < .2 ? 'swap:' + id : k < .5 ? id : `${id}@${Math.floor(rnd() * 24) - 2}`; });
  if (rnd() < .5) toks.push('end');
  const { acts } = runPlan(s, toks), end = play(s, acts);
  assert.ok(end.winner !== null || acts.at(-1).type === 'end', '要么分胜负要么以 end 收尾'); assert.ok(end.winner !== null || end.turn === 0, 'end 之后轮到对方');
}
// 一个确定的例子：合法的第一步被保留，坏的一步被报出来
{ const s = fresh(), p = legalPlays(s)[0], id = s.hand[1][p.i], { acts, bad } = runPlan(s, [`${id}@${p.t}`, 'zzz@1', 'end']);
  assert.deepEqual(acts[0], p); assert.equal(bad, 'zzz@1'); assert.equal(acts.at(-1).type, 'end'); }
{ const s = fresh(), { acts, bad } = runPlan(s, ['end']); assert.deepEqual(acts, [{ type: 'end' }]); assert.equal(bad, null); }

// 请求：两种接口的地址、头、体；回复能读；出错回退到内置电脑
const calls = []; const stub = fn => { globalThis.fetch = async (url, o) => { calls.push({ url, o, body: JSON.parse(o.body) }); return fn(); }; };
const ok = j => ({ ok: true, status: 200, json: async () => j, text: async () => '' }), err = st => ({ ok: false, status: st, json: async () => ({}), text: async () => '坏了' });
const s = fresh(), p0 = legalPlays(s)[0], id0 = s.hand[1][p0.i], good = `{"plan":["${id0}@${p0.t}","end"]}`, notes = [], note = x => notes.push(x);
save({ on: true, style: 'openai', url: 'https://x.test/v1/', key: 'sk-1', model: 'm1' }); assert.ok(enabled());
stub(() => ok({ choices: [{ message: { content: good } }] }));
let acts = await llmTurn(s, note); assert.deepEqual(acts[0], p0); assert.equal(notes.length, 0);
assert.equal(calls.at(-1).url, 'https://x.test/v1/chat/completions'); assert.equal(calls.at(-1).o.headers.authorization, 'Bearer sk-1'); assert.equal(calls.at(-1).body.messages[0].content, PLAYBOOK); assert.ok(calls.at(-1).body.max_tokens <= 200);
save({ on: true, style: 'anthropic', url: 'https://a.test', key: 'k2', model: 'claude-haiku-5-5' });
stub(() => ok({ content: [{ type: 'text', text: good }] }));
acts = await llmTurn(s, note); assert.deepEqual(acts[0], p0);
assert.equal(calls.at(-1).url, 'https://a.test/v1/messages'); assert.equal(calls.at(-1).o.headers['x-api-key'], 'k2'); assert.equal(calls.at(-1).o.headers['anthropic-dangerous-direct-browser-access'], 'true'); assert.equal(calls.at(-1).body.system[0].cache_control.type, 'ephemeral');
stub(() => err(500)); acts = await llmTurn(s, note); assert.deepEqual(acts, aiTurn(s)); assert.match(notes.at(-1), /代打/);
stub(() => ok({ content: [{ type: 'text', text: '随便聊聊' }] })); acts = await llmTurn(s, note); assert.deepEqual(acts, aiTurn(s)); assert.match(notes.at(-1), /读不懂/);
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; acts = await llmTurn(s, note); assert.deepEqual(acts, aiTurn(s)); assert.match(notes.at(-1), /连不上/);
stub(() => ok({ content: [{ type: 'text', text: '{"plan":["end"]}' }] })); const pg = await ping(cfg()); assert.ok(pg.ok && pg.ms >= 0);
stub(() => err(401)); assert.equal((await ping(cfg())).ok, false);
assert.ok(!enabled({ on: true, style: 'openai', url: '', model: 'm' }) && !enabled({ on: true, style: 'anthropic', model: 'm' }) && !enabled({ on: false, style: 'anthropic', url: 'u', model: 'm' }));
console.log('AI 对手自检通过：局面说明、解析、200 局乱写计划的校验回退、两种接口的请求格式、出错回退。提示词约', PLAYBOOK.length, '字，局面说明约', describe(s).length, '字。');
