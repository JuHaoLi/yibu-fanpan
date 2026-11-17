// 下棋的界面：开始界面（选卡组、选对手）→ 组牌界面 → 对局（出牌、换牌、结束回合、电脑回合）→ 结算。
// 规则和卡牌在 chess.js / chess-cards.js；画面、动画和特效在 board3d.js；这里把它们接起来。你永远在左边、先手。
import { CARDS, FACTIONS, DECKS, FKEYS, DECK, deckInsight, BASE_HP, newGame, apply, targets as legal, forecast, aiTurn, frontDepth, factionOf, deckError } from './chess.js';
import { board, GFX } from './board3d.js';
import { AREAS, areaOf, stageOpts, progress } from './campaign.js';
import { LESSON, keepOrder, stepOk, foeTurn } from './tutorial.js';
import { sfx, music, unlock, toggleMute, isMuted, eventSound } from './sound.js';
import * as sound from './sound.js'; // sound.pause / sound.resume：切后台时用（本文件里 pause 这个名字已经是“等一拍”）
progress.load(); const owned = () => progress.data.owned; // 闯关里赢到手的首领牌

const $ = id => document.getElementById(id), wait = s => new Promise(r => setTimeout(r, s * 1000));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const ME = 0, FOE = 1, WHO = ['你', '电脑'];
let S = null, busy = true, sel = -1, mine = null, theirs = null, chain = false; // chain：正在连着自动走好几步，期间不接受别的操作
// 新手教学（脚本在 tutorial.js）：lesson.i 是走到第几步。教学里每一刻只放行那一步要的操作：别的牌没有可放的格子，别的按钮按不动
let lesson = null; const step = () => lesson && S && S.winner === null ? LESSON.steps[lesson.i] : null, line = () => S.turn !== ME ? LESSON.foeSay[S.n / 2 - 1] || '' : step()?.say || '';
const targets = (s, i) => { const all = legal(s, i), st = step(); return !st || s.turn !== ME ? all : st.do === 'play' && s.hand[ME][i] === st.card ? all.filter(t => t === st.t) : []; };
const TKEY = 'yibu-fanpan.tutorial.v1', taught = set => { try { if (set) localStorage.setItem(TKEY, 1); return !!(localStorage.getItem(TKEY) || localStorage.getItem('yibu-fanpan.campaign.v1')); } catch { return true; } }; // 学过、跳过了、或者已经有闯关存档的老玩家：开始界面不再把教学摆在主按钮上
const teach = () => start({ name: '训练卡组', cards: LESSON.mine }, { name: '陪练', cards: LESSON.foe }, LESSON);

// ---------- 卡面 ----------
// 像素数字：玩家要算的数（费用、战力、能量、张数）都用它。返回一段 HTML，颜色跟着所在位置的文字颜色走；倍数只许整数，默认 2 倍，也可以在样式里用 --s 改
const DIGITS = '0123456789+-/', px = (n, s) => `<span class="px" role="img" aria-label="${n}"${s ? ` style="--s:${s}"` : ''}>${[...String(n)].map(ch => `<i style="--g:${DIGITS.indexOf(ch)}"></i>`).join('')}</span>`;
const artCache = {};
// 立绘按原图的整数倍放大才不糊：小个子放大 4 倍、中等 3 倍、大个子 2 倍，在牌上看起来差不多高。返回 [原图取多宽, 多高, 倍数]
const artSize = id => { const f = GFX[id]; if (!f) return [32, 32, 3]; const h = f.h || 60, s = h <= 24 ? 4 : h <= 40 ? 3 : 2; return [Math.ceil(160 / s), Math.ceil(152 / s), s]; };
function art(id) { // 卡面上的图：角色取待机第一帧，脚贴着画布底边；法术和装备用图标包里的图标
  if (artCache[id]) return artCache[id];
  const [w, h] = artSize(id), c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  const img = new Image(), f = GFX[id], done = () => { for (const e of document.querySelectorAll(`canvas[data-art="${id}"]`)) { const x = e.getContext('2d'); x.clearRect(0, 0, w, h); x.drawImage(c, 0, 0); } };
  c.ready = new Promise(ok => { img.onload = () => { if (f) g.drawImage(img, Math.round(f.cell / 2 - w / 2), f.feet - h, w, h, 0, 0, w, h); else g.drawImage(img, 0, 0); done(); ok(); }; img.onerror = ok; }); // 载入界面等的就是它；图坏了也放行，不能卡住进游戏
  img.src = f ? `assets/units/${f.file}_idle.png` : `assets/icons/${id}.png`;
  return artCache[id] = c;
}
const KIND = { unit: '单位', structure: '建筑', spell: '法术', gear: '装备' };
const KW = /(连击|奇袭|偷袭|攻城|嘲讽|圣盾|荆棘|乘风|列阵|渗透|中毒|活力|冻住|禁用|献祭|孵化|狂暴|装备)/g, rich = t => t.replace(KW, '<b class="kw">$1</b>'); // 说明里的关键词加粗
function cardEl(id, tag = 'div') { // 一张牌。类型看轮廓（样式按 unit / structure / spell / gear 裁），所以右上只写种族或“建筑、法术、装备”；移动力是几个折角，不写数字
  const c = CARDS[id], n = c.text.length, e = el(tag, `kcard ${factionOf(id)} ${c.kind}${c.gear ? ' gear' : ''}${n > 40 ? ' mid' : ''}${n > 48 ? ' long' : ''}`);
  const type = c.boss ? '首领牌 · ' + c.title : c.gear ? KIND.gear : KIND[c.kind] + (c.tribe ? ' · ' + c.tribe : ''), [w, h, s] = artSize(id);
  e.innerHTML = `<span class="face"></span><span class="cost"><i>${px(c.cost)}</i></span><b class="nm">${c.name}</b><em class="ty">${c.boss ? '首领' : c.gear ? KIND.gear : c.kind === 'unit' ? c.tribe || '' : KIND[c.kind]}</em><canvas class="art" width="${w}" height="${h}" style="--pw:${w};--ph:${h}${GFX[id] ? `;--ps:${s};--hs:${Math.ceil(s / 2)}` : ''}" data-art="${id}"></canvas><span class="tx">${rich(c.text)}</span>` +
    (c.kind === 'spell' ? '' : `<span class="st" title="战力：既是攻击也是血量">${px(c.str)}</span>` + (c.kind === 'unit' ? `<span class="mv" data-n="${c.move}" title="移动力：打出时能连走 ${c.move} 步">${'<i></i>'.repeat(c.move || 1)}</span>` : ''));
  e.querySelector('canvas').getContext('2d').drawImage(art(id), 0, 0); e.dataset.id = id; e.title = `${c.name}（${type}，${c.cost} 费）：${c.text}`; return e;
}
const byCost = (a, b) => CARDS[a].cost - CARDS[b].cost || (CARDS[a].kind === 'spell') - (CARDS[b].kind === 'spell') || CARDS[a].name.localeCompare(CARDS[b].name, 'zh');
const deckFaction = ids => ids.map(factionOf).find(f => f !== 'n') || 'n';
const phone = matchMedia('(max-height: 540px)'); // 手机横屏的小版式，和 style.css 里那条媒体查询是同一个条件
const mdCard = id => { const c = cardEl(id); c.removeAttribute('title'); if (phone.matches) c.classList.add('md'); return c; }; // 舞台上单独亮出来的一张牌：小屏换成中号，才放得下

// ---------- 卡组：每个阵营一套预设 + 存在浏览器里的自组卡组 ----------
const KEY = 'yibu-fanpan.decks.v1';
const saved = () => { try { return (JSON.parse(localStorage.getItem(KEY)) || []).filter(d => d && !deckError(d.cards, owned())); } catch { return []; } };
const store = list => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 存不了就只在这次打开期间有效 */ } };
let customs = saved(), chosen = 0; // chosen：开始界面上选中的是第几套（先排预设，再排自组）
const allDecks = () => [...DECKS.map(d => ({ ...d, preset: true })), ...customs];

// ---------- 开始界面 ----------
let mode = 'free', campArea = 'f1'; // 开始界面的两种玩法：自由对战、闯关；campArea 是闯关地图上选中的场地
function home() {
  $('result').hidden = $('builder').hidden = true; $('home').hidden = false; lesson = null; document.body.classList.remove('lesson');
  const list = allDecks(); chosen = Math.min(chosen, list.length - 1);
  $('home').classList.toggle('camp', mode === 'camp'); music('home');
  $('modes').replaceChildren(...[['free', '自由对战'], ['camp', '闯关']].map(([m, t]) => { const b = el('button', 'tab n' + (m === mode ? ' on' : ''), t); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', m === mode); b.onclick = () => { mode = m; home(); }; return b; }));
  if (mode === 'camp') return campHome(list);
  $('play').textContent = taught() ? '开始对局' : '新手教学'; $('play').disabled = false; // 第一次来：金色主按钮是两分钟的教学，不想学可以点旁边的“跳过教学”
  // 选中的那一套是主角：名字、打法、12 个兵按费用列队
  const d = list[chosen], f = deckFaction(d.cards), at = chosen - DECKS.length;
  $('picked').className = f; $('picked').innerHTML = `<b${d.name.length > 6 ? ' class="long"' : ''}>${d.name}</b><em>${d.preset ? '预设' : '自组'} · ${FACTIONS[f].name}</em><p>${d.plan || FACTIONS[f].key || FACTIONS[f].style}</p>`;
  $('lineup').replaceChildren(...[...d.cards].sort(byCost).map(id => cardEl(id)));
  const op = (text, fn, cls = 'link') => { const x = el('button', cls, text); x.onclick = fn; return x; };
  $('homehint').replaceChildren(op(d.preset ? '改编' : '修改', () => build(d.preset ? { name: d.name + ' 改', cards: [...d.cards], at: -1 } : { name: d.name, cards: [...d.cards], at })),
    ...(d.preset ? [] : [op('删除', e => { const b = e.currentTarget; if (b.dataset.sure) { customs.splice(at, 1); store(customs); return home(); } b.dataset.sure = 1; b.textContent = '再点确认'; setTimeout(() => { delete b.dataset.sure; b.textContent = '删除'; }, 2000); }, 'danger')])); // 危险操作两秒内点两下才生效，不弹浏览器的确认框
  $('homehint').append(taught() ? op('教学', teach) : op('跳过教学', () => { taught(true); home(); }));
  // 其余的卡组只是一面旗：每个阵营一组，自组的另成一组
  const flag = (x, i) => { const b = el('button', 'flag ' + deckFaction(x.cards) + (i === chosen ? ' on' : ''), x.name); b.setAttribute('aria-pressed', i === chosen); b.title = x.plan || ''; b.onclick = () => { chosen = i; home(); }; return b; };
  const grp = (cls, name, items) => { const g = el('div', 'grp ' + cls, `<em>${name}</em>`); g.append(...items); return g; };
  $('decklist').replaceChildren(...FKEYS.map(k => grp(k, FACTIONS[k].name, list.map((x, i) => x.preset && x.f === k ? flag(x, i) : null).filter(Boolean))),
    ...(customs.length ? [grp('', '自组', customs.map((x, i) => flag(x, DECKS.length + i)))] : [])); showFlag();
}
const showFlag = () => $('decklist').querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // 小屏上旗排成一行横着滚：选中的那面要在视野里
// 闯关地图：选一个场地，带着一套卡组进去连打五场。进场后卡组锁定；输了原地重打，主动退出则这个场地从头来
function campHome(list) {
  const run = progress.data.run, a = areaOf(run ? run.area : campArea), d = run ? run.deck : list[chosen], at = run ? run.at : 0, st = a.stages[at], open = progress.open(a.key), done = progress.data.done[a.key];
  $('picked').className = a.key;
  $('picked').innerHTML = `<b${a.name.length > 6 ? ' class="long"' : ''}>${a.name}</b><em>${a.key === 'n' ? '中立场地' : FACTIONS[a.key].name + '的场地'} · ${run ? `第 ${at + 1} / ${a.stages.length} 场` : done ? '已通关，可以再打' : '还没进场'}</em><p>${a.intro}</p>` +
    `<ol id="ladder">${a.stages.map((s, i) => `<li class="${run && i < at ? 'done' : run && i === at ? 'now' : ''}${s.boss ? ' boss' : ''}">${s.name}</li>`).join('')}</ol>` +
    `<p class="stage">${run ? `${st.intro}<span>你的城堡 ${px(st.base[0], 2)}　对面的城堡 ${px(st.base[1], 2)}</span>` : open ? '进场之后卡组就锁定了：打完这个场地或者退出之前，不能换也不能改。' : '六个阵营场地都通关之后才开放。'}</p>`;
  $('lineup').replaceChildren(...[...d.cards].sort(byCost).map(id => cardEl(id)));
  $('play').textContent = run ? (st.boss ? '挑战首领' : '开打') : '进场'; $('play').disabled = !open;
  const op = (text, fn, cls = 'link') => { const x = el('button', cls, text); x.onclick = fn; return x; };
  $('homehint').replaceChildren(el('span', '', `${run ? '锁定卡组' : '卡组'}：${d.name}`), run
    ? op('退出场地', e => { const b = e.currentTarget; if (b.dataset.sure) { progress.quit(); return home(); } b.dataset.sure = 1; b.textContent = '再点确认'; setTimeout(() => { delete b.dataset.sure; b.textContent = '退出场地'; }, 2000); }, 'danger') // 退出会清掉这个场地的进度，两秒内点两下才生效
    : op('换卡组', () => { mode = 'free'; home(); }));
  // 七个场地各一面旗：打到哪了、首领牌拿没拿到。进了一个场地，别的旗就点不了
  $('decklist').replaceChildren(...AREAS.map(x => { const g = el('div', 'grp ' + x.key, `<em>${x.key === 'n' ? '中立' : FACTIONS[x.key].name}</em>`), sel = x.key === a.key, got = owned().includes(x.boss);
    const b = el('button', 'flag ' + x.key + (sel ? ' on' : ''), x.name + (run && run.area === x.key ? `　${run.at + 1}/${x.stages.length}` : progress.data.done[x.key] ? '　✓' : '')); b.setAttribute('aria-pressed', sel);
    b.disabled = !!run && run.area !== x.key; b.title = progress.open(x.key) ? x.intro : '六个阵营场地都通关之后才开放'; b.onclick = () => { campArea = x.key; home(); };
    g.append(b, el('small', got ? 'got' : '', got ? `已获得「${CARDS[x.boss].name}」` : '首领牌：未获得')); return g; })); showFlag();
}
function fight() { const run = progress.data.run, a = areaOf(run.area), st = a.stages[run.at]; start(run.deck, { name: `${a.name}·${st.name}`, cards: st.foe }, { ...st, area: a.key, music: st.music || 'battle_' + (1 + (AREAS.indexOf(a) + run.at) % 3) }); } // 打当前这一关
$('newdeck').onclick = () => build({ name: `我的卡组 ${customs.length + 1}`, cards: [], at: -1 });
$('foesel').append(...FKEYS.map(f => { const o = el('option', '', FACTIONS[f].name); o.value = f; return o; }));
$('play').onclick = () => { if (mode === 'camp') { if (!progress.data.run) progress.enter(campArea, allDecks()[chosen]); return fight(); } if (!taught()) return teach(); const d = allDecks()[chosen], v = $('foesel').value, pool = DECKS.filter(x => v === 'any' || x.f === v), foe = pool[Math.floor(Math.random() * pool.length)]; start(d, { name: `${FACTIONS[foe.f].name}·${foe.name}`, cards: foe.cards }); };

// ---------- 组牌界面 ----------
let B = null, tab = 'f1', kind = 'all', cost = 0, query = ''; // cost：0 不限，否则是费用档的下限（1、3、5、7）
function build(d) { B = d; const f = deckFaction(d.cards); tab = f === 'n' ? tab : f; kind = 'all'; cost = 0; query = $('bq').value = ''; $('home').hidden = true; $('builder').hidden = false; $('bname').value = d.name; drawBuilder(); }
function drawBuilder() {
  const f = deckFaction(B.cards), err = deckError(B.cards, owned());
  $('tabs').replaceChildren(...[...FKEYS, 'n'].map(k => { const b = el('button', 'tab ' + k + (k === tab ? ' on' : ''), FACTIONS[k].name); b.disabled = k !== 'n' && f !== 'n' && k !== f; b.title = b.disabled ? `这副卡组已经带了${FACTIONS[f].name}的牌，一副卡组只能用一个阵营` : ''; b.onclick = () => { tab = k; drawBuilder(); }; return b; }));
  $('kinds').replaceChildren(...[['all', '全部'], ['unit', '单位'], ['structure', '建筑'], ['spell', '法术'], ['gear', '装备']].map(([k, t]) => { const b = el('button', `chip k-${k}` + (k === kind ? ' on' : ''), t); b.onclick = () => { kind = k; drawBuilder(); }; return b; })); // k-*：筛选片前头画一个那种牌的小轮廓
  $('tabinfo').textContent = FACTIONS[tab].style + (FACTIONS[tab].key ? `（${FACTIONS[tab].key}）` : '');
  $('costs').replaceChildren(...[[0, '不限'], [1, '1–2'], [3, '3–4'], [5, '5–6'], [7, '7+']].map(([k, t]) => { const b = el('button', 'chip' + (k === cost ? ' on' : ''), t); b.onclick = () => { cost = k; drawBuilder(); }; return b; }));
  const kindOf = c => c.gear ? 'gear' : c.kind, q = query.trim(); // 有搜索词时不分页签：在这副卡组能带的牌里一起找
  const pool = Object.keys(CARDS).filter(k => { const c = CARDS[k]; return !c.token && (q ? (c.faction === 'n' || f === 'n' || c.faction === f) && (c.name + c.text + (c.tribe || '')).includes(q) : c.faction === tab) && (kind === 'all' || kindOf(c) === kind) && (!cost || (c.cost >= cost && (cost === 7 || c.cost <= cost + 1))); }).sort(byCost);
  $('pool').replaceChildren(...pool.map(id => { const b = cardEl(id, 'button'), inDeck = B.cards.includes(id); b.classList.toggle('in', inDeck); b.classList.add('ok'); b.setAttribute('aria-pressed', inDeck);
    if (CARDS[id].boss && !owned().includes(id)) { b.classList.add('locked'); b.disabled = true; b.title = `首领牌：在闯关里击败「${CARDS[id].title} ${CARDS[id].name}」后获得`; return b; } // 没赢到手的首领牌：看得到剪影，拿不了
    b.disabled = !inDeck && B.cards.length >= DECK; b.onclick = () => { B.cards = inDeck ? B.cards.filter(x => x !== id) : [...B.cards, id]; drawBuilder(); }; return b; }));
  if (!pool.length) $('pool').append(el('p', 'lead', '没有符合条件的牌。'));
  $('bcount').innerHTML = '<i class="on"></i>'.repeat(B.cards.length) + '<i></i>'.repeat(Math.max(0, DECK - B.cards.length)) + px(B.cards.length); $('bfaction').textContent = f === 'n' ? '还没选阵营牌' : FACTIONS[f].name; // 12 个卡位：填了几个一眼数得出
  $('bcards').replaceChildren(...[...B.cards].sort(byCost).map(id => { const c = CARDS[id], r = el('button', 'strip ' + factionOf(id), `<i>${px(c.cost)}</i><span>${c.name}</span><small>${c.kind === 'spell' ? `<em>${c.gear ? '装备' : '法术'}</em>` : px(c.str) + (c.kind === 'unit' ? `<u>${'<i></i>'.repeat(c.move)}</u>` : '<em>建筑</em>')}</small>`); r.title = `点一下拿掉。${c.text}`; r.onclick = () => { B.cards = B.cards.filter(x => x !== id); drawBuilder(); }; return r; }));
  const curve = [1, 2, 3, 4, 5, 6, 7, 8].map(n => B.cards.filter(id => Math.min(8, CARDS[id].cost) === n).length);
  $('curve').replaceChildren(...curve.map((n, i) => el('div', 'bar', px(i + 1 + (i === 7 ? '+' : '')) + '<i></i>'.repeat(n)))); // 费用曲线：一张牌一块砖
  const ins = B.cards.length >= 6 ? deckInsight(B.cards) : null, bad = ins ? ins.filter(x => !x.ok) : []; // 体检只列有问题的几条；全过就一行，省得把卡条挤出屏幕
  $('binsight').replaceChildren(...(!ins ? [el('li', '', '选到 6 张以后，这里会帮你看这副牌缺什么。')] : bad.length ? bad.map(x => el('li', 'warn', x.text)) : [el('li', 'ok', '体检全过：制胜手段、前线、解场、费用都够。')])); $('binsight').title = ins ? ins.map(x => (x.ok ? '✓ ' : '！') + x.text).join('\n') : '';
  $('berr').textContent = B.cards.length < DECK ? `再选 ${DECK - B.cards.length} 张。` : err; $('bsave').disabled = !!err;
}
$('bname').oninput = e => { B.name = e.target.value; };
$('bsave').onclick = () => { const d = { name: (B.name || '').trim() || '我的卡组', cards: [...B.cards] }; if (deckError(d.cards, owned())) return; if (B.at >= 0) customs[B.at] = d; else customs.push(d); store(customs); chosen = DECKS.length + (B.at >= 0 ? B.at : customs.length - 1); home(); };
$('bcancel').onclick = home;
$('bclear').onclick = () => { B.cards = []; drawBuilder(); };
$('bq').oninput = e => { query = e.target.value; drawBuilder(); };
$('bfill').onclick = () => { // 随机补满：没选阵营就用当前页签的阵营（在中立页签则随机挑一个），九成从阵营牌里补
  const f = deckFaction(B.cards) !== 'n' ? deckFaction(B.cards) : tab !== 'n' ? tab : FKEYS[Math.floor(Math.random() * FKEYS.length)];
  const free = g => Object.keys(CARDS).filter(k => !CARDS[k].token && !CARDS[k].boss && CARDS[k].faction === g && !B.cards.includes(k)), pick = a => a[Math.floor(Math.random() * a.length)];
  while (B.cards.length < DECK) B.cards.push(pick(free(B.cards.filter(k => CARDS[k].faction === 'n').length < 3 && Math.random() < .3 ? 'n' : f)));
  drawBuilder(); };

// ---------- 把规则里发生的事一件件演出来 ----------
// 节奏只用 board.T 这一张表（和 motion.css 的 --t-* 一一对应）。棋盘上的等待一律走 board.wait：慢放、按住空格加速、命中定格，对界面和棋盘是同一只钟
const T = board.T, E = { out: 'cubic-bezier(.2,.8,.2,1)', in: 'cubic-bezier(.6,0,.9,.4)' }, pause = s => board.wait(s), nap = s => new Promise(r => setTimeout(r, s * 1000));
const read = s => nap(Math.max(.4, s / board.rate()));               // 给人读的停留：加速时也不低于 0.4 秒
const restart = (e, cls) => { e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls); }; // 重新触发一次 CSS 动画
// 演出要用的节点由脚本创建，挂在舞台或 body 上：回合旗带、对方亮牌位、牌库堆、受击描边；拒绝原因、城门过场
const mk = (id, html) => { const e = el('div', '', html); e.id = id; return e; }, stage = $('stage3d'), handEl = $('hand');
const flagEl = mk('flag'), revealEl = mk('reveal'), pileEl = mk('pile'), edgeEl = mk('edge'), whyEl = mk('why'), gateEl = mk('gate', `<i class="l"></i><i class="r"></i><b>一步翻盘<span class="bricks">${'<i></i>'.repeat(12)}</span></b>`), zoomEl = mk('zoom'), dragEl = mk('drag');
stage.append(flagEl, revealEl, pileEl, edgeEl, zoomEl); document.body.append(whyEl, gateEl, dragEl);
const bricks = (bar, k) => [...bar.children].forEach((b, i) => b.classList.toggle('on', i < Math.round(k * bar.children.length))); // 进度：到了几成亮几块砖
// 触屏没有悬停，“看”和“做”要分成两下。touch：上一次点按是不是手指（地址带 ?touch 则一直算，测试用）；armed：已经看过预演、再点一次就打出的那一格
const Q = new URLSearchParams(location.search); let touch = Q.has('touch') || matchMedia('(pointer: coarse)').matches, armed = -1, tileAt = 0, dragAt = 0;
if (!Q.has('touch')) addEventListener('pointerdown', e => { touch = e.pointerType !== 'mouse'; }, true);
let game = 0, V = { hand: [], left: 0, max: 0 }, kt = -1, flagT = 0; // game：第几局（中途退出后，上一局没演完的步骤靠它作废）；V：界面上显示的手牌和能量，出牌时先改它；kt：键盘选中的格子
const underCastle = side => Math.round(board.screen({ base: side }).y - stage.getBoundingClientRect().top + 12); // 某一方城堡血量牌的正下方（舞台内的纵坐标）：旗带和亮牌位挂在这里，不挡血量
function flag(side, title, sub, stay = T.read) { // 回合旗带：轮到谁，就挂在谁的城堡上（血量牌下面）、从那一侧展开，不挡战场中心。只等它展开；之后棋盘照常演，旗带自己停够读的时间再收
  clearTimeout(flagT); flagEl.className = side === ME ? 'mine' : side === FOE ? 'foe' : 'vs'; flagEl.innerHTML = `<b>${title}</b>${sub}`;
  flagEl.style.top = side < 0 ? '' : underCastle(side) + 'px'; void flagEl.offsetWidth; flagEl.classList.add('on');
  flagT = setTimeout(() => flagEl.classList.remove('on'), (T.t3 + Math.max(.4, stay / board.rate())) * 1000); return pause(T.t3);
}
function ghostOf(node, into) { // 一张牌的固定定位替身。手牌的替身留在 #hand 里（沿用那里的卡面样式），原节点直接拿掉，其余手牌随后补位；给了 into 就挂到那里、原节点留着
  const r = node.getBoundingClientRect(), g = node.cloneNode(true), w = node.offsetWidth, h = node.offsetHeight;
  g.className = node.className.replace(/\b(sel|ok|deny|is-\w+)\b/g, '') + ' ghost'; g.tabIndex = -1; g.setAttribute('aria-hidden', 'true'); g.removeAttribute('title');
  g.querySelector('canvas')?.getContext('2d').drawImage(node.querySelector('canvas'), 0, 0);  // 克隆节点不带画布内容，补画一次
  Object.assign(g.style, { left: r.left + r.width / 2 - w / 2 + 'px', top: r.top + r.height / 2 - h / 2 + 'px', width: w + 'px', height: h + 'px' });
  g._p = { x: 0, y: 0, s: r.height / h, r: 0 }; (into || node.parentNode).append(g); if (!into) node.remove(); return g;
}
function fly(g, to, o = {}) { // 替身飞到页面上的一点（to 为空则原地）：越飞越快像掷出去，一路缩小。减少动效时改成原地淡出。等待走棋盘的钟，不等浏览器的动画事件（面板收起时它们不触发）
  if (board.calm) { g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }); return pause(.12); }
  const p = g._p, cx = parseFloat(g.style.left) + g.offsetWidth / 2, cy = parseFloat(g.style.top) + g.offsetHeight / 2, dur = o.dur ?? T.t3;
  const q = { x: to ? to.x - cx : p.x, y: to ? to.y - cy : p.y, s: o.scale ?? .3, r: o.rot ?? -8 }, tf = (a, up = 0) => `translate(${a.x}px, ${a.y - up}px) scale(${a.s}) rotate(${a.r}deg)`;
  const a = g.animate([{ transform: tf(p) }, { transform: tf({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, s: (p.s + q.s) / 2, r: (p.r + q.r) / 2 }, o.arc ?? 32) }, { transform: tf(q), opacity: o.fade ?? 1 }], { duration: dur * 1000, easing: o.ease || E.in, fill: 'forwards' });
  a.playbackRate = board.rate(); g._p = q; return pause(dur);
}
const centerOf = e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
async function throwCard(g, id, t) { // 牌离手：单位牌掷向格子，落地的那一下由 board.add 接上；法术先到舞台上沿亮相，读一拍，再落向目标生效
  const c = CARDS[id], r = stage.getBoundingClientRect();
  if (c.kind !== 'spell') { await fly(g, board.screen(t)); return g.remove(); }
  await fly(g, { x: r.left + r.width / 2, y: r.top + g.offsetHeight * .62 }, { scale: 1.1, rot: 0, arc: 0, ease: E.out }); await read(T.t3);
  await fly(g, t >= 0 ? board.screen(t) : null, { scale: t >= 0 ? .3 : 1.3, rot: 0, arc: 0, fade: 0, dur: T.t2, ease: t >= 0 ? E.in : E.out }); g.remove();
}
async function reveal(e) { // 对方出牌：牌从对方城堡那一侧亮出来，标出目标格，停够读完的时间（字多就多停），再飞进棋盘。亮过的牌缩小留在原位，直到下一张
  const c = CARDS[e.card], n = mdCard(e.card); revealEl.replaceChildren(el('small', '', '电脑打出'), n); revealEl.className = ''; void revealEl.offsetWidth; revealEl.className = 'on';
  revealEl.style.top = Math.max(4, Math.min(underCastle(FOE), stage.clientHeight - revealEl.offsetHeight - 8)) + 'px'; // 舞台矮的时候往上挪：整张牌要放得下
  if (e.tile >= 0) board.mark([e.tile], 0xf06878, c.kind === 'spell' ? 'aim' : 'put');
  await pause(T.t3); await read(Math.min(2.1, T.read + c.text.length * .03));
  if (e.tile >= 0) { const g = ghostOf(n, document.body) /* 挂在 body 上：亮牌位自己带缩放，固定定位的子节点会跟着它跑偏 */; revealEl.className = 'past'; await fly(g, board.screen(e.tile), c.kind === 'spell' ? { fade: 0, rot: 0, arc: 0 } : {}); g.remove(); board.mark([]); } else revealEl.className = 'past';
}
const feed = [];
const log = text => { feed.push(text); if (feed.length > 4) feed.shift(); $('log').replaceChildren(...feed.map(t => Object.assign(document.createElement('div'), { textContent: t }))); }; // 最近四条战报
const tell = text => { const box = $('hint'), st = step(); if (!st || !text) { box.textContent = text; return; } // 教学里提示行是一块告示牌：第几步、这一步的话；纯讲解的步骤带一个“知道了”
  box.replaceChildren(el('small', '', `教学 ${lesson.i + 1} / ${LESSON.steps.length}`), text);
  if (st.do === 'ok' && idle()) { const b = el('button', '', '知道了'); b.onclick = () => { lesson.i++; sync(); }; box.append(b); b.focus({ preventScroll: true }); } };                                       // 现在该做什么
async function show(events, next, g) { // next：这一步之后的局面（抽牌、回合数从它取）；g：开演时是第几局，中途换了局就停
  for (let k = 0; k < events.length; k++) { const e = events[k], nx = events[k + 1]; if (g !== game) return; const snd = eventSound(e, ME); if (snd) sfx(snd); switch (e.t) {
    case 'rage': log('首领发怒了：场上的首领 +3 战力并获得圣盾。'); flag(e.side, '首领发怒', '<span>+3 战力 · 圣盾</span>', T.read * 1.5); await board.rage(e.side); await pause(T.read); break;
    case 'play': log(`${WHO[e.side]}${CARDS[e.card].kind === 'spell' ? '用了' : '打出'}「${CARDS[e.card].name}」` + (CARDS[e.card].kind === 'spell' || e.side === FOE ? `：${CARDS[e.card].text}` : '')); if (e.side === FOE) await reveal(e); break;
    case 'spawn': await board.add(e); if (CARDS[e.card].boss) { const c = CARDS[e.card]; log(`首领登场：${c.title} ${c.name}`); sfx('boss_enter'); flag(e.side, `${c.title} ${c.name}`, '<span>首领登场</span>', T.read * 1.5); // 首领：名号打出来；对面已经发过怒的话，它一落地就是发怒的样子；有出场能力的先摆一个施法的架势
      if (S.rage[e.side]) await board.rage(e.side); if (c.onPlay) await board.cast(e.id); } break;
    case 'move': { const ids = new Set([e.id]), all = [board.move(e.id, e.to)]; // 接连几个互不相干的兵一起迈步（各错开半拍），不排成一条匀速的流水
      while (events[k + 1]?.t === 'move' && !ids.has(events[k + 1].id)) { const m = events[++k]; ids.add(m.id); await pause(T.t1 / 2); all.push(board.move(m.id, m.to)); } await Promise.all(all); break; }
    case 'pull': case 'push': await board.shift(e.id, e.to); break;
    case 'attack': await board.lunge(e.id, e.to); break;
    case 'fx': await board.fx(e); break;
    case 'hurt': board.hurt(e.id, e.n, e.str, e.melee); if (nx?.t !== 'hurt') await pause(T.t2); break; // 同时受伤的数字一起跳，跳完留一拍重的
    case 'buff': board.buff(e.id, e.n, e.str); if (nx?.t !== 'buff') await pause(T.t2); break;
    case 'shield': board.shield(e.id, e.on); await pause(T.t1); break;
    case 'freeze': board.freeze(e.id, true); await pause(T.t1); break;
    case 'thaw': board.freeze(e.id, false); break;
    case 'creep': board.creep(e.tile, e.side); break;
    case 'morph': log(e.why === 'hex' ? `${WHO[e.side]}的一个单位被变成了「${CARDS[e.card].name}」` : e.why === 'convert' ? `「${CARDS[e.card].name}」被策反，现在归${WHO[e.side]}` : `${WHO[e.side]}的蛋孵出了「${CARDS[e.card].name}」`);
      await board.morph(e); if (e.gear) board.gear(e.id, e.gear); if (e.poison) board.status(e.id, 'poison'); if (e.vital) board.status(e.id, 'vital'); if (e.mute) board.status(e.id, 'mute'); break;
    case 'poison': case 'mute': case 'vital': board.status(e.id, e.t); if (nx?.t !== e.t) await pause(T.t1); break;
    case 'gear': board.gear(e.id, e.card); await pause(T.t3); break;
    case 'mana': board.note(`+${e.n} 能量`, '#a8fff8', e.side); if (e.side === ME) { V.left += e.n; drawMana(); } await pause(T.t2); break;
    case 'spend': board.note(`花掉 ${e.n} 能量`, '#a8fff8', e.side); if (e.side === ME) { V.left = Math.max(0, V.left - e.n); drawMana(); } await pause(T.t2); break;
    case 'draw': board.note(`抽 ${e.n} 张牌`, '#fff4a0', e.side); if (e.side === ME) { log(`你抽了 ${e.n} 张牌`); V.hand = [...next.hand[ME]]; drawPile(next); renderHand(); } await pause(T.t3); break;
    case 'swap': if (e.side === FOE) { log('电脑换了一张牌'); board.note('换牌', '#a8fff8', FOE); await pause(T.t3); } break; // 我方换牌的过程在 act() 里：旧牌滑回牌库堆，新牌发过来
    case 'die': { const boss = S.board.find(u => u && u.id === e.id && CARDS[u.card].boss); if (boss) { log(`${CARDS[boss.card].title} ${CARDS[boss.card].name} 倒下了`); await board.die(e.id); } else { board.die(e.id); await pause(T.t3); } break; } // 首领倒下要演完：慢放、三连炸
    case 'base': if (e.id !== undefined) await board.storm(e.id, 1 - e.side, e.from); if (e.side === ME) restart(edgeEl, 'on'); await board.base(e.side, -e.n, e.hp); log(`${WHO[e.side]}的城堡 −${e.n}，还剩 ${e.hp}`); break;
    case 'heal': await board.base(e.side, e.n, e.hp); break;
    case 'turn': await flag(e.side, e.side === ME ? '你的回合' : '电脑的回合', `<span>第 ${Math.floor(next.n / 2) + 1} 回合</span>` + (e.side === ME ? `<span class="m">能量 ${px(e.mana, 3)}</span>` : ''), e.side === ME ? T.read : T.t4);
      if (e.side === ME) { V.left = e.mana; V.max = next.mana[ME]; drawMana(); }
      for (const u of S.board) if (u && u.side === e.side && CARDS[u.card].boss && CARDS[u.card].onTurn && !u.mute && !u.frozen) await board.cast(u.id); break; // 首领有“回合开始时”的能力：先摆施法的架势，效果随后                     // 轮到我：能量在这一刻回满
  } }
}
async function act(a) { // 执行一步。先回应：牌立刻离手、能量立刻扣掉、其余手牌补位；后演出：棋盘上的过程播完，再换成新局面
  if (!S || S.winner !== null) return; if (S.turn === ME && step() && !stepOk(step(), S, a)) return tell(line()); // 教学：不是这一步要的操作，不动，把话再说一遍
  const g = game, me = S.turn === ME, r = apply(S, a), node = me && a.type !== 'end' ? cardsIn()[a.i] : null, id = node && S.hand[ME][a.i];
  if (kt >= 0) board.point(-1);                    // 键盘留下的格子光标收掉
  busy = true; sel = -1; kt = -1; armed = -1; board.path([]); board.tags([]); board.ghost(null); board.mark([]); board.dim(false); $('tip').style.display = 'none'; whyEl.classList.remove('on'); drawMana(0); if (me || !lesson) tell(''); // 教学里对面行动时那句解说留着
  if (me) revealEl.className = '';                 // 我开始行动了：对方上一张亮过的牌收起来
  const keys = node && document.activeElement === node;                // 用键盘出的牌：出完焦点落到手里的下一张，不丢
  if (node && a.type === 'play') { const gh = ghostOf(node); V.hand.splice(a.i, 1); V.left -= CARDS[id].cost; drawMana(); renderHand(); if (keys) cardsIn()[Math.min(a.i, V.hand.length - 1)]?.focus(); await throwCard(gh, id, a.t); }
  else if (node) { const gh = ghostOf(node); V.hand.splice(a.i, 1); renderHand(); await fly(gh, centerOf(pileEl), { scale: .35, rot: 0, arc: 16, dur: T.t2 }); gh.remove(); // 换牌：旧牌滑回牌库堆
    V.hand = [...r.state.hand[ME]]; drawPile(r.state); renderHand(); await pause(T.t3); }                                                                          // 牌库顶上那张发到手里
  else if (me && a.type === 'end') { const n = r.state.hand[ME].length - V.hand.length; V.hand = [...r.state.hand[ME]]; drawPile(r.state); renderHand(); if (n > 0) await pause(T.t2 + n * .07); } // 回合末补牌：缺几张发几张
  else renderHand();
  await show(r.events, r.state, g); if (g !== game) return; S = r.state; busy = false; if (lesson && me) lesson.i++; sync(); // 教学：我这一步做完了，脚本往下走一步
  if (S.winner !== null) { busy = true; renderHand(); await board.ruin(S.winner === ME ? FOE : ME); if (g === game) finish(); } // 被攻破的城堡先塌下去，再出结算
}
async function endTurn() {
  if (!S || busy || chain || S.turn !== ME || S.winner !== null) return; const g = game;
  await act({ type: 'end' });                       // 结束回合：电脑的兵先各走一步
  while (g === game && S.winner === null && S.turn === FOE) { const list = lesson ? foeTurn(S) : aiTurn(S); await pause(T.t4);   // 对方“想一下”
    for (const a of list) { if (g !== game || S.winner !== null) break; await act(a); if (a.type !== 'end') await pause(T.t3); } } // 两步之间留一口气
}

// ---------- 对局界面 ----------
function arrowsOf(events, onlyId) { // 从一串事件里取出每个单位的第一个动作，画成箭头
  const seen = new Set(), pos = new Map(), out = [];
  S.board.forEach((u, t) => { if (u) pos.set(u.id, { t, side: u.side }); });
  for (const e of events) {
    if (e.t === 'spawn') pos.set(e.id, { t: e.tile, side: e.side });
    if (!['move', 'attack', 'base'].includes(e.t) || e.id === undefined) continue;
    const p = pos.get(e.id); if (!p) continue;
    if (onlyId === undefined ? !seen.has(e.id) : e.id === onlyId) out.push(e.t === 'base' ? { from: e.from, to: 'base', side: p.side, kind: 'base' } : { from: e.from, to: e.to, side: p.side, kind: e.t });
    seen.add(e.id); if (e.t === 'move') pos.set(e.id, { t: e.to, side: p.side });
  }
  return out;
}
const cardsIn = () => [...handEl.children].filter(e => !e.classList.contains('ghost')); // 手里真正的牌（不算正在飞走的替身）
const anim = (e, frames, dur, delay = 0) => { e.animate(frames, { duration: dur * 1000, delay: delay * 1000, easing: E.out, fill: 'backwards' }).playbackRate = board.rate(); };
const idle = () => !busy && !chain && S.turn === ME && S.winner === null;                // 现在轮到我、可以操作
function renderHand() { // 手牌就地对账：节点常驻，按牌的 id 增删，其余只改类名——过渡、补位、键盘焦点都靠这个
  const old = cardsIn(), was = new Map(old.map(e => [e, e.getBoundingClientRect().left])), fresh = [];
  const nodes = V.hand.map(id => { const k = old.findIndex(e => e.dataset.id === id); if (k >= 0) return old.splice(k, 1)[0];
    const e = cardEl(id, 'button'); e.setAttribute('aria-label', e.title || CARDS[id].name); e.removeAttribute('title'); e.onclick = () => { if (performance.now() - dragAt > 400) pick(cardsIn().indexOf(e)); }; fresh.push(e); return e; }); // 刚拖完松手带出来的那一下点击不算
  for (const e of old) e.remove();
  nodes.forEach((e, i) => { if (handEl.children[i] !== e) handEl.insertBefore(e, handEl.children[i] || null); });
  const on = idle(), from = pileEl.getBoundingClientRect(), st = step(); handEl.classList.toggle('is-waiting', !on); handEl.classList.toggle('is-picking', on && sel >= 0);
  nodes.forEach((e, i) => { // 三种不可用分开标：能量不够 is-short；出得起但没有目标 is-notarget；不是我的回合或正在演出，整手 is-waiting
    const c = CARDS[V.hand[i]], short = on && c.cost > V.left, ok = on && !short && targets(S, i).length > 0, r = e.getBoundingClientRect(), k = fresh.indexOf(e);
    e.classList.toggle('here', on && sel < 0 && !!st && st.card === V.hand[i]); // 教学：该点的那张牌头上有个金色箭头
    e.classList.toggle('ok', ok); e.classList.toggle('is-short', short); e.classList.toggle('is-notarget', on && !short && !ok); e.classList.toggle('sel', on && i === sel); e.setAttribute('aria-pressed', on && i === sel); e.setAttribute('aria-disabled', !on);
    if (k >= 0) anim(e, board.calm ? [{ opacity: 0 }, { opacity: 1 }] : [{ translate: `${from.left - r.left}px ${from.top - r.top}px`, scale: .4, opacity: 0 }, { opacity: 1, offset: .3 }, { translate: '0 0', scale: 1, opacity: 1 }], board.calm ? .12 : T.t3, k * .07); // 新牌从牌库堆发过来
    else if (!board.calm && Math.abs(was.get(e) - r.left) > 1) anim(e, [{ translate: `${was.get(e) - r.left}px 0` }, { translate: '0 0' }], T.t2); });                                                                     // 留下的牌滑去补位
  $('swap').disabled = !on || S.swapped || sel < 0 || !!st && (st.do !== 'swap' || V.hand[sel] !== st.card); $('swap').classList.toggle('is-want', !$('swap').disabled && !!st);
  $('end').disabled = !on || !!st && st.do !== 'end'; $('auto').disabled = !on || !!lesson;
  $('swap').textContent = S.swapped ? '已换过' : '换牌'; $('swap').title = S.swapped ? '这回合已经换过一张了' : '先选一张手牌，再点这里把它换成牌库顶上那张（快捷键 C）'; $('end').title = '快捷键 E';
  $('end').classList.toggle('is-done', !$('end').disabled && !V.hand.some((_, i) => targets(S, i).length)); // 没有能出的牌了：结束回合按钮开始催你
  const z = on && sel >= 0 ? V.hand[sel] : ''; if (zoomEl.dataset.id !== z) { zoomEl.dataset.id = z; zoomEl.className = z ? 'on' : ''; const c = z && mdCard(z); if (c) c.classList.add('md'); zoomEl.replaceChildren(...(c ? [c] : [])); } // 小屏上手牌只管认和点：选中的那张在舞台左边放大成全文（显示与否由样式按屏幕高度定）
}
function drawMana(cost = 0) { // 能量：十二颗水晶常驻，只换类名。cost 是选中的牌要花几点——出得起就让那几颗慢闪，出不起就把缺的几颗标红
  const m = $('mana'); if (!m.querySelector('.gems')) m.innerHTML = `<span class="lbl">能量</span><span class="num"></span><span class="max"></span><div class="gems">${'<i></i>'.repeat(12)}</div>`;
  const num = m.querySelector('.num'), was = +num.dataset.n, lack = Math.max(0, cost - V.left);
  if (was !== V.left) { num.dataset.n = V.left; num.innerHTML = px(V.left); restart(num, 'tick'); }
  const mx = m.querySelector('.max'); if (+mx.dataset.n !== V.max) { mx.dataset.n = V.max; mx.innerHTML = px('/' + V.max, 2); }
  m.querySelectorAll('.gems i').forEach((g, k) => { const on = k < V.left, shown = k < Math.max(V.max, V.left + lack), flip = shown && g.classList.contains('on') !== on && !isNaN(was);
    g.className = (!shown ? 'none' : on ? 'on' : 'off') + (shown && !on && k < V.left + lack ? ' lack' : '') + (on && cost && !lack && k >= V.left - cost ? ' cost' : '');
    if (flip) { g.style.animationDelay = Math.abs(on ? k - was : was - 1 - k) * 40 + 'ms'; g.classList.add(on ? 'gain' : 'pop'); } }); // 花掉从右往左一颗颗碎，回满从左往右一颗颗亮
}
function drawPile(s = S) { // 牌库堆：下一张牌正面朝上——全程没有随机，下一张是什么本来就该摆在明处。换牌、补牌都从这里发
  const id = s.deck[ME][0]; if (!id || (pileEl.dataset.id === id && pileEl.children.length)) return; const c = CARDS[id]; pileEl.dataset.id = id; pileEl.className = factionOf(id); pileEl.title = `牌库下一张：${c.name}（${c.cost} 费）${c.text}`;
  pileEl.replaceChildren(el('small', '', '下一张'), cardEl(id).querySelector('canvas'), el('b', '', c.name), el('span', 'c', `<i>${px(c.cost, 2)}</i>`));
}
function syncBoard() { // 棋盘上跟着局面走的东西：前线、城堡血量、对面下回合的意图（连同它们加起来要打掉我方城堡几点）
  for (const p of [0, 1]) { board.front(p, frontDepth(S, p)); board.setBase(p, Math.max(0, S.base[p])); }
  const fc = S.turn === ME && S.winner === null ? forecast(S, FOE) : [], n = fc.reduce((a, e) => a + (e.t === 'base' && e.side === ME ? e.n : 0), 0);
  board.intents(arrowsOf(fc), n, n >= S.base[ME]); board.dim(sel >= 0);
}
function sync() {
  V = { hand: [...S.hand[ME]], left: S.turn === ME ? S.left : S.mana[ME], max: S.mana[ME] }; drawMana(sel >= 0 ? CARDS[V.hand[sel]].cost : 0);
  $('foe').innerHTML = `电脑<span class="who"> · ${theirs.name}</span>　能量 ${px(S.mana[FOE], 2)}　手牌 ${px(S.hand[FOE].length, 2)}`;
  $('deckn').textContent = `你的卡组：${mine.name}`;
  drawPile(); syncBoard(); renderHand();
  tell(S.winner !== null ? '' : lesson ? line() : S.turn !== ME ? `电脑在行动… 按住${touch ? '画面' : '空格'}可以加速。` : busy ? '' : sel < 0 ? `轮到你：点一张手牌${touch ? '' : '（或按 1–4）'}，再点亮起的格子。流动的箭头是对面下回合要做的事。` : hint());
}
const why = c => step() && step().card !== S.hand[ME][sel] ? '先照提示来' : c.cost > S.left ? `差 ${c.cost - S.left} 点能量` : c.kind === 'spell' ? '没有合适的目标' : '没有可放的格子'; // 这张牌为什么现在打不出
const hint = () => { if (lesson) return line(); const c = CARDS[S.hand[ME][sel]], ts = targets(S, sel); return !ts.length ? `「${c.name}」打不出：${why(c)}。${S.swapped ? '' : touch ? '可以换掉它。' : '可以换掉它（C）。'}` : ts[0] === -1 ? `「${c.name}」：${touch ? '再点一次这张牌，或把它拖到场上施放。' : '再点一次或按回车施放。'}` : `「${c.name}」：${touch ? '点亮起的格子看结果，再点一次打出，或直接拖过去。' : '点亮起的格子（或方向键选格、回车打出）。'}${c.kind === 'spell' ? '' : c.anywhere ? '奇袭：不受前线限制。' : '只能放在你的前线以内。'}`; };
function deny(e, text) { // 短促的拒绝：牌左右一抖，原因写在牌的正上方，不弹窗
  sfx('card_deny'); restart(e, 'deny'); e.addEventListener('animationend', () => e.classList.remove('deny'), { once: true }); const r = e.getBoundingClientRect(); whyEl.textContent = text; whyEl.style.left = r.left + r.width / 2 + 'px'; whyEl.style.top = r.top + 'px'; restart(whyEl, 'on'); clearTimeout(whyEl._t); whyEl._t = setTimeout(() => whyEl.classList.remove('on'), T.read * 2000);
}
function pick(i) {
  const e = cardsIn()[i]; if (!e || !S || S.winner !== null) return;
  if (!idle()) return deny(e, S.turn !== ME ? '还没轮到你' : '等这一步演完');
  const c = CARDS[S.hand[ME][i]], all = targets(S, i);
  if (sel === i && all[0] === -1) return act({ type: 'play', i, t: -1 }); // 不需要目标的法术：再点一次施放
  sel = sel === i ? -1 : i; kt = -1; sfx('card_pick'); unpreview(); whyEl.classList.remove('on');
  if (sel >= 0 && !all.length) deny(e, why(c));                          // 打不出也照样选中（这样才能换掉它），但先说清楚为什么
  const foe = c.kind === 'spell' && c.target === 'foe';                  // 指向敌人的法术：绯红准星；其余：青绿角标
  board.mark(sel < 0 ? [] : all.filter(t => t >= 0), foe ? 0xf06878 : 0x68f0b0, foe ? 'aim' : 'put'); board.dim(sel >= 0); drawMana(sel < 0 ? 0 : c.cost); renderHand(); tell(sel < 0 ? lesson ? line() : touch ? '点一张手牌。' : '点一张手牌，或按 1–4。' : hint());
}
function preview(t) { // 预演：这张牌打在这里会怎么走，谁受伤多少、谁会倒下、城堡掉几点——后果先于操作
  const id = S.hand[ME][sel], unit = CARDS[id].kind !== 'spell', ev = apply(S, { type: 'play', i: sel, t }).events, hit = new Map(), gone = new Set(), base = [0, 0], tags = [];
  for (const e of ev) {
    if (e.t === 'hurt' || e.t === 'buff') { const h = hit.get(e.id) || { n: 0 }; h.n += e.t === 'hurt' ? -e.n : e.n; h.tile = e.tile; hit.set(e.id, h); }
    else if (e.t === 'base') { base[e.side] += e.n; if (e.id !== undefined) gone.add(e.id); }                 // 冲进城门的兵是离场，不算倒下
    else if (e.t === 'die' && !gone.has(e.id)) hit.set(e.id, { ...(hit.get(e.id) || { n: 0 }), tile: e.tile, dead: true }); }
  for (const h of hit.values()) { if (h.n) tags.push({ tile: h.tile, text: (h.n > 0 ? '+' : '') + h.n, color: h.n > 0 ? '#68f0b0' : '#f06878' }); if (h.dead) tags.push({ tile: h.tile, text: 'dead', color: '#ece4d0' }); }
  base.forEach((n, side) => { if (n) tags.push({ base: side, text: '-' + n, color: '#f06878' }); });
  board.path(unit ? arrowsOf(ev, S.uid) : []); board.ghost(unit ? id : null, ME, t); board.tags(tags);
}
const unpreview = () => { armed = -1; board.path([]); board.tags([]); board.ghost(null); };
function tapAway(t) { // 触屏上点了别处：先收预演；没有预演可收、点的又不是单位，就把选中的牌放回去
  const had = armed >= 0, u = t >= 0 && S.board[t]; unpreview(); tipAt(t);
  if (sel >= 0 && idle()) { if (had || u) tell(hint()); else pick(sel); }
}
board.onTile(t => { tileAt = performance.now(); if (!S) return; // 鼠标有悬停，预演早就看过了，点一下就打出；手指没有悬停：第一下看预演，再点同一格才打出
  const can = idle() && sel >= 0 && targets(S, sel).includes(t);
  if (can && (!touch || armed === t)) return act({ type: 'play', i: sel, t });
  if (!touch) return; if (!can) return tapAway(t);
  armed = t; preview(t); tipAt(t); const c = CARDS[S.hand[ME][sel]]; tell(`再点一次这一格，${c.kind === 'spell' ? '用' : '打出'}「${c.name}」；点别处取消。`);
});
stage.addEventListener('click', e => { if (touch && S && e.target.tagName === 'CANVAS' && performance.now() - tileAt > 300) tapAway(-1); }); // 点在棋盘外的空地上（场景没报格子）
function tipAt(t) { // 这一格上的单位是什么、身上有什么（连同这一格的暗影）。鼠标悬停时出，手指点一下也出
  const tip = $('tip'), u = t >= 0 && S ? S.board[t] : null, dark = t >= 0 && S && S.creep[t] >= 0 ? `<br>这一格有${WHO[S.creep[t]]}的暗影：站在上面的敌人每回合 −1` : '';
  if (u || dark) { const c = u && CARDS[u.card]; tip.innerHTML = (u ? `<b>${c.name}</b>${c.tribe ? `〔${c.tribe}〕` : ''}（${WHO[u.side]}）战力 ${u.str}${u.shield ? ' · 有圣盾' : ''}${u.frozen ? ' · 冻住了（不前进，能力暂时失效）' : ''}${u.poison ? ' · 中毒（每回合 −1）' : ''}${u.vital ? ' · 活力（每回合 +1）' : ''}${u.mute ? ' · 能力被禁用' : ''}${u.timer !== undefined ? ` · 还要 ${u.timer} 个回合孵出` : ''}<br>${u.mute || u.frozen ? `<s>${c.text}</s>` : rich(c.text)}${u.gear ? `<br><b>${CARDS[u.gear].name}</b>：${CARDS[u.gear].text.replace(/^装备：一个友方单位.*?获得「/, '').replace(/」。$/, '')}` : ''}` : '空格子') + dark; tip.style.display = 'block'; const r = stage.getBoundingClientRect(), p = board.screen(t), x = p.x - r.left, y = p.y - r.top; // 锚在格子上而不是跟着鼠标跑；正在看预演时放到格子下方，不盖住被瞄准的单位和头上的结果标记
    const zl = zoomEl.offsetWidth ? zoomEl.getBoundingClientRect().right - r.left + 8 : 0; // 小屏左边可能正摆着放大的牌：说明让到它右边
    tip.style.left = Math.min(r.width - 256, Math.max(zl, x < r.width / 2 ? x + 48 : x - 288)) + 'px'; tip.style.top = Math.max(0, Math.min(handTop() - r.top - tip.offsetHeight, sel >= 0 || y < 152 ? y + 40 : y - 104)) + 'px'; } // 舞台矮的时候：上面放不下（会盖住顶上那排字）就放到格子下方；再往下是手牌，不许压进去
  else tip.style.display = 'none';
}
board.onHover(t => {
  if (touch && t < 0) return;                       // 手指一抬，场景会报“离开了”：钉住的说明和预演不跟着收，点别处才收
  tipAt(t); if (!S || !idle() || sel < 0) return;
  if (t >= 0 && targets(S, sel).includes(t)) preview(t); else if (armed < 0) unpreview();
});
$('end').onclick = endTurn;
const swapSel = () => { if (S && idle() && !S.swapped && sel >= 0) act({ type: 'swap', i: sel }); };
$('swap').onclick = swapSel;
$('auto').onclick = async () => { if (!S || !idle() || lesson) return; const g = game; chain = true; try { for (const a of aiTurn(S)) { if (g !== game || S.winner !== null || a.type === 'end') break; await act(a); await pause(T.t2); } } finally { chain = false; } if (g === game && S.winner === null) endTurn(); };
// ---------- 拖牌：按住一张手牌拖到亮起的格子上，途中就是预演，松手打出；拖回石桌上松手等于没拖（牌保持选中）。点按的流程不变 ----------
let drag = null;
const handTop = () => stage.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(stage).getPropertyValue('--hand-zone')) || 0); // 手牌占着的那一截以上才算“场上”
function tileNear(x, y) { // 离这一点最近的可放格子。只拿 board.screen 量，不碰场景内部；比大半格还远就不算
  const a = board.screen(0), b = board.screen(board.cols); let best = -1, min = Math.hypot(a.x - b.x, a.y - b.y) * .7;
  for (const t of targets(S, sel)) { if (t < 0) continue; const p = board.screen(t), d = Math.hypot(p.x - x, p.y - y); if (d < min) { min = d; best = t; } }
  return best;
}
handEl.addEventListener('pointerdown', e => { const c = e.target.closest('.kcard'); if (c && !c.classList.contains('ghost') && e.isPrimary && !e.button) drag = { c, id: e.pointerId, x: e.clientX, y: e.clientY, on: false, t: -1 }; });
addEventListener('pointermove', e => { const d = drag; if (!d || e.pointerId !== d.id) return; // 听在窗口上：鼠标甩得快，第一下移动就可能已经出了手牌区
  if (!d.on) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 12 || !S || !idle()) return;      // 挪出 12px 才算拖：手指点一下难免带一点滑
    const i = cardsIn().indexOf(d.c); if (i >= 0 && sel !== i) pick(i); if (i < 0 || sel !== i || !targets(S, i).length) return void (drag = null); // 打不出的牌拖不动（为什么打不出，pick 已经说了）
    d.on = true; try { d.c.setPointerCapture(e.pointerId); } catch { /* 抓不住指针也照常拖 */ } dragEl.className = 'on ' + factionOf(V.hand[i]); dragEl.replaceChildren(cardEl(V.hand[i]).querySelector('canvas'), el('b', '', CARDS[V.hand[i]].name)); }
  const x = e.clientX, y = e.clientY - (e.pointerType === 'mouse' ? 0 : 40), t = tileNear(x, y);       // 手指会挡住要放的格子：落点比指尖高一截
  dragEl.style.translate = `${Math.round(x - dragEl.offsetWidth / 2)}px ${Math.round(y + 16)}px`; d.cast = y < handTop(); // 小牌挂在落点下面：上面要留给预演（虚影、伤害数字）
  if (t !== d.t) { d.t = t; if (t >= 0) { armed = t; preview(t); } else unpreview(); }
});
const drop = e => { const d = drag; if (!d || e.pointerId !== d.id) return; drag = null; if (!d.on) return; dragEl.className = ''; dragAt = performance.now();
  const to = !S || !idle() || sel < 0 || e.type !== 'pointerup' ? null : d.t >= 0 ? d.t : d.cast && targets(S, sel)[0] === -1 ? -1 : null; // 不用选目标的法术：拖到场上松手就施放
  if (to !== null) return act({ type: 'play', i: sel, t: to }); unpreview(); if (S && idle() && sel >= 0) tell(hint());
};
addEventListener('pointerup', drop); addEventListener('pointercancel', drop);
stage.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse' && S && S.turn === FOE && S.winner === null) board.speed(3); }); // 手机上没有空格键：电脑行动时按住画面加速
for (const k of ['pointerup', 'pointercancel']) addEventListener(k, e => { if (e.pointerType !== 'mouse') board.speed(1); });
let quitT = 0;
$('quit').onclick = e => { const b = e.currentTarget; if (!S || S.winner !== null || b.dataset.arm) { clearTimeout(quitT); delete b.dataset.arm; b.textContent = '放弃'; return leave(); }
  b.dataset.arm = 1; b.textContent = '再点放弃'; quitT = setTimeout(() => { delete b.dataset.arm; b.textContent = '放弃'; }, 2000); }; // 两秒内再点一下才真的放弃

// ---------- 键盘：1–4 选牌，方向键在能放的格子之间挪，回车打出（无目标法术直接施放），C 换牌，E 结束回合，Esc 取消；按住空格加速 ----------
const inGame = () => S && $('home').hidden && $('builder').hidden && $('result').hidden;
function nudge(dr, dc) { // 方向键选格子：第一次按落在最靠前、最靠中间的那格；之后往按的方向找最近的一格
  const ts = targets(S, sel).filter(t => t >= 0), rc = t => [Math.floor(t / board.cols), t % board.cols], mid = (board.cols - 1) / 2; if (!ts.length) return;
  if (kt < 0) kt = ts.reduce((a, b) => { const [ra, ca] = rc(a), [rb, cb] = rc(b); return rb > ra || (rb === ra && Math.abs(cb - mid) < Math.abs(ca - mid)) ? b : a; });
  else { const [r0, c0] = rc(kt), far = t => { const [r, c] = rc(t); return Math.abs(r - r0) + Math.abs(c - c0); }, nx = ts.filter(t => { const [r, c] = rc(t); return (r - r0) * dr + (c - c0) * dc > 0; }).sort((a, b) => far(a) - far(b))[0]; if (nx !== undefined) kt = nx; }
  board.point(kt);
}
addEventListener('keydown', e => {
  if (!inGame() || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); if (!e.repeat) board.speed(3); return; }          // 按住空格：全部补间和等待三倍速（亮牌的阅读停留有下限）
  if (e.repeat) return; const n = +e.key, k = e.key.toLowerCase(), dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (n >= 1 && n <= cardsIn().length) { cardsIn()[n - 1].focus(); pick(n - 1); }
  else if (k === 'escape') { $('tip').style.display = 'none'; if (sel >= 0 && idle()) pick(sel); }
  else if (k === 'e') endTurn(); else if (k === 'c') swapSel();
  else if (sel >= 0 && idle() && (dir || k === 'enter')) { e.preventDefault(); const ts = targets(S, sel); // 回车：无目标法术直接施放；有格子光标就打在那里；还没有光标就先给一个
    if (dir) nudge(...dir); else if (ts[0] === -1) act({ type: 'play', i: sel, t: -1 }); else if (ts.includes(kt)) act({ type: 'play', i: sel, t: kt }); else nudge(0, 0); }
});
addEventListener('keyup', e => { if (e.key === ' ') { board.speed(1); if (inGame()) e.preventDefault(); } });
addEventListener('blur', () => board.speed(1));

// ---------- 开局与结束 ----------
async function curtain(fn) { // 过场：两扇城门合上 → 门后换界面（载入也在这时做，至少关满半秒）→ 城门打开。界面之间不再一帧硬切
  gateEl.className = 'shut'; await nap(T.t3 + .05); try { await Promise.all([fn(), nap(T.t4)]); } finally { gateEl.className = ''; } await nap(T.t2);
}
const leave = () => curtain(() => { game++; busy = true; clearTimeout(flagT); flagEl.className = revealEl.className = ''; pileEl.replaceChildren(); board.clear(); for (const p of [0, 1]) board.setBase(p, BASE_HP); home(); }); // 回开始界面：这一局没演完的步骤作废
async function start(d, foe, stage = null) { // stage：闯关里的这一关（带城堡血量、开局摆的东西）；自由对战是 null
  const g = ++game; mine = d; theirs = foe; busy = true; camp = stage;
  const bar = gateEl.querySelector('.bricks'), need = [...new Set([...mine.cards, ...theirs.cards, ...(stage?.setup || []).map(x => x.card), ...Object.keys(CARDS).filter(k => CARDS[k].token)])]; let n = 0;
  try { await curtain(async () => { $('home').hidden = $('result').hidden = true; feed.length = 0; log(`你用「${mine.name}」，电脑用「${theirs.name}」。`); tell(''); bricks(bar, 0);
    await Promise.all(need.map(t => board.preload([t]).then(() => bricks(bar, ++n / need.length)))); if (g !== game) return; // 一种角色一种角色地载，城门上的砖跟着亮
    board.clear(); board.theme?.(stage?.area || deckFaction(theirs.cards)); lesson = stage?.lesson ? { i: 0 } : null; document.body.classList.toggle('lesson', !!lesson); S = newGame([mine.cards, theirs.cards], lesson ? keepOrder : Math.random, stage ? stageOpts(stage) : {}); for (const [t, u] of S.board.entries()) if (u) board.add({ ...u, tile: t }); sel = -1; V = { hand: [], left: 0, max: 0 }; handEl.replaceChildren(); revealEl.className = ''; syncBoard(); }); } // 场景趁城门关着换装（按场地，自由对战按对手的阵营）：开门时不会先露出上一套再跳变
  catch (e) { console.error(e); if (g === game) { game++; home(); $('homehint').append(el('span', '', '没载入成功，检查网络后再试。')); } return; } // 图没载下来（手机上网络说断就断）：回开始界面说一声，不把人晾在空棋盘上
  finally { bricks(bar, 0); }
  if (g !== game) return; music(stage?.music || 'battle_' + (1 + Math.floor(Math.random() * 3))); if (stage?.boss) sfx('boss_enter'); board.intro(); busy = false; sync(); // 首领战放它自己的曲子                                   // 城门打开：镜头推进来，四张起手牌从牌库堆发到手里
  flag(-1, `${mine.name}<i>对</i>${theirs.name}`, `<span>${stage?.boss ? '首领战 · ' : ''}第 1 回合 · 你先手</span>`, T.read * 2); // 开局只有这一条：对阵双方和谁先手
}
function finish() { // 结算：底色淡入、胜负盖章、统计随后；按钮最后才出现并可点，免得刚才还在点棋盘的手误触
  const won = S.winner === ME, r = $('result'), bs = [...r.querySelectorAll('button')]; music(won ? 'win' : 'lose'); $('verdict').textContent = won ? '你赢了' : '你输了'; $('verdict').className = won ? 'win' : 'lose';
  $('summary').textContent = `${mine.name} 对 ${theirs.name}，打了 ${Math.ceil(S.n / 2)} 个回合\n你的城堡 ${Math.max(0, S.base[ME])} / ${S.cap[ME]}　　电脑的城堡 ${Math.max(0, S.base[FOE])} / ${S.cap[FOE]}`;
  const rw = $('reward'); rw.replaceChildren(); $('again').textContent = '再来一局'; $('tohome').textContent = '回城'; after = null;
  if (camp?.lesson) { if (won) { taught(true); $('verdict').textContent = '学会了'; $('summary').textContent = LESSON.done; $('again').textContent = '去闯关'; after = () => { mode = 'camp'; leave(); }; $('tohome').textContent = '自由对战'; } else after = teach; } // 教学打完：主按钮带去闯关
  else if (camp) { // 闯关：赢了往下走一关（打赢首领就拿到首领牌），输了原地重打
    if (won) { const area = areaOf(progress.data.run.area), res = progress.win(); $('verdict').textContent = res.cleared ? '场地通关' : '过关';
      if (res.card) rw.append(el('p', '', `获得首领牌「${CARDS[res.card].title} ${CARDS[res.card].name}」，可以放进${res.card === 'B_final' || CARDS[res.card].faction === 'n' ? '任何' : FACTIONS[CARDS[res.card].faction].name + '的'}卡组（一副最多一张）。`), mdCard(res.card));
      $('again').textContent = res.cleared ? '回地图' : '下一关'; after = res.cleared ? leave : () => fight(); $('tohome').textContent = '回地图'; if (res.cleared) $('tohome').hidden = true; void area; }
    else { $('again').textContent = '重打'; after = () => fight(); $('tohome').textContent = '回地图'; } }
  r.hidden = false; restart(r, 'in'); for (const b of bs) b.disabled = true; nap(T.read + T.t2).then(() => { for (const b of bs) b.disabled = false; if (!r.hidden) $('again').focus(); });
}
let camp = null, after = null; // camp：正在打的闯关关卡；after：结算后主按钮要做的事（下一关、重打、回地图）
$('again').onclick = () => { $('tohome').hidden = false; (after || (() => start(mine, theirs)))(); }; $('tohome').onclick = () => { $('tohome').hidden = false; leave(); };
// 自动测试用：地址带 ?timer 时把对局状态露出来，可以直接摆一个局面再演一步
if (new URLSearchParams(location.search).has('timer')) window.__t = { CARDS, board, state: () => S, view: () => V, lesson: () => lesson && lesson.i, teach, act, start, pick, endTurn, async setup(fn) { board.clear(); fn(S); await board.preload(S.board.filter(Boolean).map(u => u.card)); for (const [t, u] of S.board.entries()) if (u) { await board.add({ ...u, tile: t }); if (u.gear) board.gear(u.id, u.gear); } sel = -1; busy = false; sync(); } };
// 声音：浏览器要等玩家第一次点按之后才允许出声；按钮统一一个点击声；静音开关记在浏览器里
let heard = false; const wake = () => { heard = true; unlock(); }; addEventListener('pointerdown', wake, { once: true }); addEventListener('keydown', wake, { once: true });
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled && !b.classList.contains('kcard')) sfx('ui_click'); });
const mutes = [...document.querySelectorAll('.mute')], drawMute = () => { for (const b of mutes) { b.textContent = isMuted() ? '声音关' : '声音开'; b.setAttribute('aria-pressed', isMuted()); } }; // 开始界面和对局里各有一个，状态一起变
// 切到后台就停声音，回来接着放。早先的试玩版是拿静音开关顶的，并在本地记了一笔；unhush 把那一笔消掉，免得老玩家一直是静音
const BG = 'yibu-fanpan.bgmute', unhush = () => { try { if (localStorage.getItem(BG)) { localStorage.removeItem(BG); if (isMuted()) toggleMute(); } } catch { /* 存不了就算了 */ } };
for (const b of mutes) b.onclick = () => { toggleMute(); drawMute(); }; setTimeout(() => { unhush(); drawMute(); }, 600);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { board.speed(1); sound.pause(); }
  else { sound.resume(); drawMute(); if (heard) { unlock(); addEventListener('pointerdown', unlock, { once: true }); } } // 有的手机要等下一次点按才肯重新出声
});

// ---------- 手机上的杂事 ----------
const dock = () => (phone.matches ? document.querySelector('main > header') : $('btns')).append($('auto')); phone.addEventListener('change', dock); dock(); // 小屏的石桌只放得下换牌和结束回合：托管挪到顶上那排系统按钮里
$('side').onclick = () => $('side').classList.toggle('open');                                      // 小屏只留最近一条战报，点一下展开四条（大屏上这块不接收点按）
document.addEventListener('click', e => { if (touch && $('rules').open && !$('rules').contains(e.target)) $('rules').open = false; }); // 触屏上点别处就收起规则
document.addEventListener('gesturestart', e => e.preventDefault());                                // iOS 的双指缩放手势：样式里的 touch-action 之外再拦一道。不挂 touchmove 监听——那会拖慢列表滚动
document.addEventListener('contextmenu', e => { if (touch && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault(); }); // 长按不出菜单

// ---------- 进游戏 ----------
// 模块到齐算七成（那一段由 board.html 里的小脚本按“到了几个脚本”走）；开始界面要用的图——像素数字、选中那套卡组的十二张立绘——到齐了才开门
(async () => { const boot = window.__boot, need = [new Promise(ok => { const i = new Image(); i.onload = i.onerror = ok; i.src = 'assets/ui/digits-pad.png'; }), ...allDecks()[chosen].cards.map(id => art(id).ready)]; let n = 0;
  boot?.stop(); await Promise.all(need.map(p => p.then(() => boot?.set(.7 + .3 * ++n / need.length))));
  home(); const b = $('boot'); if (b) { b.classList.add('done'); setTimeout(() => b.remove(), 300); } })();
