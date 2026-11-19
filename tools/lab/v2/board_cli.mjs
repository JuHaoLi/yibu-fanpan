// agent 下棋用的无头浏览器：在无头 Chromium 里开真正的游戏页面（board.html?timer），通过页面露出的 window.__t 读局面、出牌；对手是页面里的大师电脑。
// 不装任何东西：Chromium 用 ms-playwright 缓存里的 chrome-headless-shell，node 自带的 WebSocket 走 CDP。浏览器静音（--mute-audio）。
// 用法（都在仓库根目录跑）：
//   node tools/lab/v2/board_cli.mjs serve [--net 网络.json] [--port 8772] [--log 目录]   常驻：静态服务 + 无头浏览器 + 控制口；--net 换掉页面加载的大师网络
//   node tools/lab/v2/board_cli.mjs new <我的卡组> <对面卡组>   开一局（卡组 = 预设名，或 12 个牌 id 用英文逗号连）；你永远先手
//   node tools/lab/v2/board_cli.mjs state                     看局面：棋盘、手牌、能出的牌（编号）、引擎给的几套整回合方案
//   node tools/lab/v2/board_cli.mjs play <编号>                出一张（编号来自 state 里的"能出的牌"）
//   node tools/lab/v2/board_cli.mjs swap <手牌序号>             换掉一张手牌（每回合一次）
//   node tools/lab/v2/board_cli.mjs plan <方案号>               照引擎的某套方案走完这回合（含结束回合）
//   node tools/lab/v2/board_cli.mjs end                       结束回合，等电脑走完，返回新局面
//   node tools/lab/v2/board_cli.mjs decks                     列出预设卡组
// 每局结束把记录（双方卡组、每一步、胜负）写进 --log 目录（默认 out/agent/games）。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { CARDS, DECKS, apply, legalPlays, rowOf, colOf, ROWS, deckError } from '../../../chess.js';
import { situation, options, optionText } from '../../../llm.js';

const ROOT = resolve(new URL('../../../', import.meta.url).pathname), argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = +opt('--port', 8772), cmd = argv[0];
const DKEY = 'yibu-fanpan.diff.v1';

// ---------- 客户端：把命令发给常驻的 serve ----------
if (cmd !== 'serve') {
  const q = new URLSearchParams({ a: argv.slice(1).filter(x => !x.startsWith('--')).join(' ') });
  try { const r = await fetch(`http://127.0.0.1:${PORT}/${cmd || 'state'}?${q}`); console.log(await r.text()); process.exit(r.ok ? 0 : 1); }
  catch { console.log(`连不上控制口 ${PORT}：先在另一个终端跑 node tools/lab/v2/board_cli.mjs serve`); process.exit(1); }
}

// ---------- 常驻：静态服务 ----------
const NET = opt('--net', null), LOG = opt('--log', 'out/agent/games'), WEB = PORT + 1, DBG = PORT + 2;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/board.html';
  const f = NET && p === '/assets/ai/net-g5.json' ? resolve(NET) : join(ROOT, p);
  if (!f.startsWith(ROOT) && f !== resolve(NET || '')) { res.writeHead(403); return res.end(); }
  if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(WEB, '127.0.0.1');

// ---------- 无头浏览器（CDP） ----------
const SHELL = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
const bin = process.env.CHROME || SHELL;
const chrome = spawn(bin, ['--headless', '--mute-audio', '--no-first-run', '--disable-gpu', `--remote-debugging-port=${DBG}`, `--user-data-dir=${join(ROOT, 'out/agent/chrome')}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill()); for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
let ws; for (let k = 0; k < 50 && !ws; k++) { try { const t = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json(); const pg = t.find(x => x.type === 'page'); if (pg) ws = pg.webSocketDebuggerUrl; } catch { } if (!ws) await new Promise(r => setTimeout(r, 200)); }
if (!ws) { console.error('无头浏览器没起来：' + bin); process.exit(1); }
const sock = new WebSocket(ws), pend = new Map(); let seq = 0;
await new Promise((ok, bad) => { sock.onopen = ok; sock.onerror = bad; });
sock.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const cdp = (method, params = {}) => new Promise(ok => { const id = ++seq; pend.set(id, ok); sock.send(JSON.stringify({ id, method, params })); });
const js = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
const load = async () => { await cdp('Page.enable'); await cdp('Page.navigate', { url: `http://127.0.0.1:${WEB}/board.html?timer` });
  for (let k = 0; k < 150; k++) { if (await js('!!window.__t').catch(() => false)) return; await new Promise(r => setTimeout(r, 200)); } throw new Error('页面 20 秒没准备好'); };
await cdp('Page.enable'); await cdp('Page.navigate', { url: `http://127.0.0.1:${WEB}/board.html` }); await new Promise(r => setTimeout(r, 500));
await js(`localStorage.setItem('${DKEY}', 'master')`); await load(); // 难度定在大师，再开测试模式

// ---------- 对局 ----------
const NAME = Object.fromEntries(DECKS.map(d => [d.name, d]));
const deckOf = a => { if (NAME[a]) return { name: a, cards: [...NAME[a].cards] }; const c = a.split(',').map(x => x.trim()).filter(Boolean);
  if (c.length !== 12 || c.some(k => !CARDS[k])) throw new Error(`卡组「${a}」不是预设名，也不是 12 个牌 id`);
  const err = deckError(c, Object.keys(CARDS)); if (err) throw new Error('卡组不合法：' + err); return { name: '自组卡组', cards: c }; }; // 首领、奖励牌当作都已经赢到手
let rec = null;
const S = async () => JSON.parse(await js('JSON.stringify(__t.state())'));
const pos = (t, me) => t < 0 ? '' : `${colOf(t) + 1}路d${me ? ROWS - 1 - rowOf(t) : rowOf(t)}`;
const describe = (s, a, me = s.turn) => a.type === 'swap' ? `换掉「${CARDS[s.hand[me][a.i]].name}」` : `${CARDS[s.hand[me][a.i]].kind === 'spell' ? '施放' : '打出'}「${CARDS[s.hand[me][a.i]].name}」${a.t < 0 ? '' : '到 ' + pos(a.t, me)}`;
async function view() {
  const s = await S(); if (!rec) return '还没开局：先 new <我的卡组> <对面卡组>';
  if (s.winner !== null) return over(s);
  if (s.turn !== 0) return '电脑还在走，过一会儿再 state';
  const plays = legalPlays(s), opts = options(s);
  return [situation(s).replace('（AI 方）', '').replaceAll('玩家', '电脑'), '',
    '能出的牌（play 编号）：' + (plays.length ? plays.map((a, k) => `[${k}] ${describe(s, a)}`).join('；') : '没有'),
    s.swapped ? '' : '换牌（swap 手牌序号，每回合一次）：' + s.hand[0].map((id, i) => `${i}=「${CARDS[id].name}」`).join(' '),
    '引擎方案（plan 方案号；方案1 = 满强度电脑自己会这么走）：', ...opts.map((o, i) => optionText(s, o, i, Math.max(...opts.map(x => x.end.winner === null ? 0 : -1e9))).replace(/引擎评分（和最好的比）.*$/, '').replaceAll('玩家', '电脑')),
  ].filter(Boolean).join('\n'); }
function over(s) { const r = s.winner === 0 ? '你赢了' : '你输了';
  if (rec && !rec.done) { rec.done = true; rec.winner = s.winner; rec.turns = s.n; rec.base = s.base; mkdirSync(join(ROOT, LOG), { recursive: true });
    writeFileSync(join(ROOT, LOG, `${rec.t0}.json`), JSON.stringify(rec, null, 1)); }
  return `对局结束：${r}（第 ${Math.ceil(s.n / 2)} 回合，城堡 你 ${s.base[0]} : 电脑 ${s.base[1]}）。记录已写进 ${LOG}/${rec?.t0}.json`; }
async function step(a) { const s = await S(); if (s.winner !== null) return over(s); if (s.turn !== 0) throw new Error('不是你的回合');
  rec.moves.push({ n: s.n, a, text: a.type === 'end' ? '结束回合' : describe(s, a) }); apply(s, a); // apply 不合法会抛错
  await js(`__t.act(${JSON.stringify(a)})`); }
async function endTurn() { const s0 = await S(); rec.moves.push({ n: s0.n, a: { type: 'end' }, text: '结束回合' });
  const before = await js(`document.querySelector('#log')?.innerText || ''`);
  await js('__t.endTurn()'); for (let k = 0; k < 600; k++) { const s = await S(); if (s.winner !== null || s.turn === 0) break; await new Promise(r => setTimeout(r, 100)); }
  const after = await js(`document.querySelector('#log')?.innerText || ''`), news = after.startsWith(before) ? after.slice(before.length).trim() : after.split('\n').slice(-4).join('\n'); // 战报：电脑这回合干了什么
  return (news ? `电脑这回合：${news.replace(/\n+/g, '；')}\n\n` : '') + await view(); }
const H = {
  async new(a) { const [x, y] = a.split(' '); const d0 = deckOf(x), d1 = deckOf(y); await load(); await js('__t.board.speed(16)');
    await js(`__t.start(${JSON.stringify(d0)}, ${JSON.stringify(d1)})`); for (let k = 0; k < 300; k++) { if (await js('!!__t.state()')) break; await new Promise(r => setTimeout(r, 100)); }
    rec = { t0: new Date().toISOString().replace(/[:.]/g, '-'), net: NET || 'assets/ai/net-g5.json', mine: d0, theirs: d1, moves: [], done: false }; await new Promise(r => setTimeout(r, 1500)); return view(); },
  state: view,
  async play(a) { const s = await S(), p = legalPlays(s)[+a]; if (!p) throw new Error(`没有编号 ${a} 的出法，先 state 看能出的牌`); await step(p); return view(); },
  async swap(a) { await step({ type: 'swap', i: +a }); return view(); },
  async plan(a) { const s = await S(), o = options(s)[+a - 1]; if (!o) throw new Error(`没有方案 ${a}`); for (const x of o.acts) { if (x.type === 'end') break; await step(x); } return (await S()).winner !== null ? view() : endTurn(); },
  end: endTurn,
  decks: async () => DECKS.map(d => `「${d.name}」（${d.f}）：${d.plan || ''} ${d.cards.join(',')}`).join('\n'),
};
let busy = Promise.resolve();
createServer((req, res) => { const u = new URL(req.url, 'http://x'), k = u.pathname.slice(1), a = u.searchParams.get('a') || '';
  busy = busy.then(async () => { try { if (!H[k]) throw new Error('不认识的命令：' + k); const out = await H[k](a); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(out); } // 先算完再写头：出错时才能改回 400
    catch (e) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('出错：' + e.message); } }); }).listen(PORT, '127.0.0.1');
console.log(`就绪：控制口 ${PORT}，页面 http://127.0.0.1:${WEB}/board.html?timer，大师网络 ${NET || 'assets/ai/net-g5.json'}`);
