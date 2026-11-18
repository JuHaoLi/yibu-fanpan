// AI 对手（llm.js）的自检：方案合法、打乱顺序后选择映射正确、各种回复的解析、接口出错一律回退不抛。fetch 用假的，不需要真接口。
// 用法：node tools/llm_check.mjs
const R = new URL('../', import.meta.url).href;
const { DECKS, newGame, apply, aiTurn, STRONG } = await import(R + 'chess.js');
const store = {}; globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
const L = await import(R + 'llm.js');
const { parseChoice, llmTurn, options, order, save, ping } = L;
let bad = 0; const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) bad++; console.log(ok ? '  ok ' : 'FAIL ', name, ok ? '' : `得到 ${JSON.stringify(got)} 期望 ${JSON.stringify(exp)}`); };

console.log('--- parseChoice');
const P = (t, n = 4) => parseChoice(t, n);
eq('纯 JSON', P('{"choice":3,"say":"来吧"}'), { k: 2, say: '来吧' });
eq('思考块', P('<think>方案1 不好，选 2？</think>{"choice":4,"say":"嘿"}'), { k: 3, say: '嘿' });
eq('思考块+无 JSON 应读块外', P('<think>方案1 方案2</think>我选方案3'), { k: 2, say: '' });
eq('<thinking> 标签', P('<thinking>我想选 1</thinking>方案3'), { k: 2, say: '' });
eq('没闭合的思考块（被截断）不该乱认数字', P('<think>先看第 2 路，方案1 风险大'), null);
eq('代码块', P('```json\n{"choice": 2, "say": "稳一手"}\n```'), { k: 1, say: '稳一手' });
eq('中文方案3', P('我选方案3，打穿你！'), { k: 2, say: '' });
eq('中文 方案 三', P('选方案三'), { k: 2, say: '' });
eq('choice 是字符串', P('{"choice":"2","say":"好"}'), { k: 1, say: '好' });
eq('choice 写成 "方案2"', P('{"choice":"方案2","say":"好"}'), { k: 1, say: '好' });
eq('超出范围', P('{"choice":5,"say":"x"}'), null);
eq('0', P('{"choice":0}'), null);
eq('空', P(''), null); eq('null', P(null), null); eq('undefined', P(undefined), null);
eq('全角冒号', P('{"choice"：2，"say"：“好”}'), { k: 1, say: '好' });
eq('中文引号台词', P('{"choice":1,"say":"“看我的”"}'), { k: 0, say: '看我的' });
eq('台词里有换行转义', P('{"choice":1,"say":"第一句\\n第二句"}'), { k: 0, say: '第一句 第二句' });
eq('台词带转义引号', P('{"choice":1,"say":"他说\\"冲\\""}'), { k: 0, say: '他说"冲"' });
eq('台词真换行（JSON 外）', P('{"choice":1,"say":"上半句\n下半句"}'), { k: 0, say: '上半句' });
eq('单引号', P("{'choice': 2, 'say': '好'}"), { k: 1, say: '好' });
eq('台词超长截断', P('{"choice":1,"say":"' + '长'.repeat(60) + '"}').say.length <= 40, true);
eq('只有说明数字', P('第 2 套方案最好'), { k: 1, say: '' });

console.log('--- ask()/llmTurn 异常');
let seed = 9; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
let s = newGame([DECKS[0].cards, DECKS[3].cards], rnd); for (let k = 0; k < 3; k++) for (const a of aiTurn(s, { ...STRONG, rnd })) s = apply(s, a).state;
const opts = options(s); console.log('  方案数', opts.length);
const res = (st, j, txt) => ({ ok: st >= 200 && st < 300, status: st, json: async () => (typeof j === 'function' ? j() : j), text: async () => txt ?? JSON.stringify(j) });
const calls = []; const stub = f => { calls.length = 0; globalThis.fetch = async (u, o) => { calls.push({ u, b: JSON.parse(o.body) }); return f(calls.length, JSON.parse(o.body)); }; };
const run = async (name, expBy, extra = () => true) => { let r; try { r = await llmTurn(s, () => {}); } catch (e) { bad++; console.log('FAIL ', name, '抛出', e.message); return; } const ok = r.by === expBy && extra(r); if (!ok) bad++; console.log(ok ? '  ok ' : 'FAIL ', name, r.by, r.why || '', r.say ? '台词:' + r.say : ''); return r; };
const okOAI = c => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });

save({ style: 'openai', url: 'https://x.test/v1/', key: 'k', model: 'm1' });
stub((n, b) => b.thinking ? res(400, { error: 'unknown field thinking' }) : res(200, okOAI('{"choice":2,"say":"重试成功"}')));
await run('400 后去掉 thinking 重发', 'llm', r => calls.length === 2 && !!calls[0].b.thinking && !calls[1].b.thinking);
calls.length = 0; await run('记住了：第二回合直接不带 thinking', 'llm', () => calls.length === 1 && !calls[0].b.thinking);
save({ style: 'openai', url: 'https://y.test/v1', key: 'k', model: 'm2' });
stub(() => res(400, { error: 'bad model' })); await run('两次都 400', 'fallback', r => calls.length === 2 && /400/.test(r.why));
stub(() => res(429, { error: 'rate' })); await run('429', 'fallback', r => /429/.test(r.why));
stub(() => res(500, null, '<html>oops</html>')); await run('500 HTML', 'fallback');
stub(() => res(200, { choices: [{ message: { content: null } }] })); await run('content null', 'fallback');
stub(() => res(200, { choices: [] })); await run('choices 空', 'fallback');
stub(() => res(200, {})); await run('空对象', 'fallback');
stub(() => res(200, null)); await run('json 是 null', 'fallback');
stub(() => res(200, () => { throw new SyntaxError('Unexpected token <'); })); await run('200 但不是 JSON', 'fallback');
stub(() => res(200, { choices: [{ message: { content: [{ type: 'text', text: '{"choice":3}' }] } }] })); await run('content 是分段数组', 'llm');
stub(() => res(200, { choices: [{ message: { content: '', reasoning_content: '想了很久' }, finish_reason: 'length' }] })); await run('只有思考', 'fallback', r => /思考/.test(r.why));
stub(() => { throw new TypeError('Failed to fetch'); }); await run('连不上', 'fallback', r => /连不上/.test(r.why));
stub(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }); await run('超时', 'fallback', r => /秒/.test(r.why));

save({ style: 'anthropic', url: 'https://a.test', key: 'k', model: 'claude' });
stub(() => res(200, { content: [{ type: 'thinking', thinking: '方案1' }, { type: 'text', text: '{"choice":2,"say":"好的"}' }], stop_reason: 'end_turn' }));
await run('Anthropic 格式（带 thinking 块）', 'llm', r => calls[0].u === 'https://a.test/v1/messages' && !calls[0].b.thinking && r.say === '好的');
stub(() => res(400, { error: 'x' })); await run('Anthropic 400 不重试', 'fallback', () => calls.length === 1);
stub(() => res(200, { content: null })); await run('Anthropic content null', 'fallback');
stub(() => res(200, { type: 'error', error: { message: 'overloaded' } })); await run('Anthropic 200 但 error', 'fallback');

// ping 也不能抛
stub(() => res(200, null)); try { const p = await ping({ style: 'openai', url: 'https://z.test', model: 'm' }); console.log('  ok  ping json null →', p.ok, p.msg.slice(0, 40)); } catch (e) { bad++; console.log('FAIL ping 抛出', e.message); }
// 真实超时：fetch 永不返回，但监听 signal
// 方案：30 局随机预设，每套都合法、end 等于执行结果、第 1 套 = 困难电脑、按假模型选的第 k 个执行的正是提示词里第 k 行
console.log('--- options()');
{ const { CARDS: CC } = await import(R + 'chess.js'); let turns = 0, wrong = 0, pickK = 1, lastPrompt = ''; const J = x => JSON.stringify(x);
  globalThis.fetch = async (u, o) => { lastPrompt = JSON.parse(o.body).messages.at(-1).content; return res(200, okOAI(`{"choice":${pickK}}`)); };
  save({ style: 'openai', url: 'https://x.test/v1', key: 'k', model: 'm' });
  for (let g = 0; g < 30; g++) { let t = newGame([DECKS[g % DECKS.length].cards, DECKS[(g * 5 + 3) % DECKS.length].cards], rnd);
    for (let n = 0; n < 50 && t.winner === null; n++) { const os = options(t); turns++;
      if (J(os[0].acts) !== J(aiTurn(t, { ...STRONG }))) wrong++;
      for (const op of os) { try { let e = t; for (const a of op.acts) e = apply(e, a).state; if (J(e) !== J(op.end)) wrong++; } catch { wrong++; } }
      let pick = os[0];
      if (os.length > 1) { pickK = 1 + Math.floor(rnd() * os.length); const got = await llmTurn(t); pick = os[order(t, os.length)[pickK - 1]]; if (J([...got]) !== J(pick.acts) || !lastPrompt.includes(`方案${pickK}：`)) wrong++; }
      for (const a of pick.acts) t = apply(t, a).state; } }
  if (wrong) bad++; console.log(wrong ? `FAIL  方案检查 ${wrong} 处不对` : `  ok  ${turns} 个回合的方案全部合法、映射正确`); }
console.log(bad ? `\n${bad} 项不通过` : '\n全部通过'); process.exit(bad ? 1 : 0);
