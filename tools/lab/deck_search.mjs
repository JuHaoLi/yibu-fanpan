// 卡组搜索：每个阵营从预设、agent 组的卡组和随机卡组出发，每代把好卡组换掉 1–2 张生出新卡组，留下对 14 套预设打得最好的。
// 双方用同一个电脑，只比卡组；留下的卡组每代都再加打一批，分数越攒越准。最后对每阵营前 3 名和 14 套预设本身重新各打一大批（新种子），只报这批的胜率。
// 用法：node tools/lab/deck_search.mjs <电脑> [代数=12] [线程=20] [输出=out/lab/deck_search.json] [--seeds 卡组.json] [--per 8] [--final 80] [--keep 8] [--kids 16]
//   --seeds：额外起点卡组（JSON 数组，每项 12 个牌 id），不合法的跳过
//   --all：首领牌（每副最多一张）和锦标赛奖励牌也能用（当作都已赢到手），锦标赛 Q1 的两套卡组也进起点和决赛；不加就不用这两种牌
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CARDS, DECKS, FACTIONS, newGame, apply, aiTurn, deckError } from '../../chess.js';
import { makeAI, lcg, farm } from './play.mjs';

const K = DECKS.length, FS = Object.keys(FACTIONS).filter(f => f !== 'n'), ALL = process.argv.includes('--all') || !!workerData?.all;
const OK = k => !CARDS[k].token && (ALL || (!CARDS[k].boss && !CARDS[k].prize)), OWNED = Object.keys(CARDS).filter(k => !CARDS[k].token);
export const POOL = Object.fromEntries([...FS, 'n'].map(f => [f, Object.keys(CARDS).filter(k => OK(k) && CARDS[k].faction === f)]));
export const legal = d => d.every(k => CARDS[k] && OK(k)) && !deckError(d, OWNED);
const factionOf = d => d.map(k => CARDS[k].faction).find(f => f !== 'n') ?? 'n';
const key = d => [...d].sort().join(',');

export function mutate(d, f, rnd) { // 换掉 1–2 张，换进同阵营或中立的牌
  const pool = [...POOL[f], ...POOL.n];
  for (let tries = 0; tries < 50; tries++) {
    const x = [...d], n = rnd() < .5 ? 1 : 2;
    for (let i = 0; i < n; i++) { const out = Math.floor(rnd() * 12); let c; do c = pool[Math.floor(rnd() * pool.length)]; while (x.includes(c)); x[out] = c; }
    if (legal(x)) return x;
  }
  return null;
}
export function randomFor(f, rnd) { // 这个阵营的随机合法卡组，中立 0–6 张
  for (;;) { const k = Math.floor(rnd() * 7), pick = (pool, n) => [...pool].sort(() => rnd() - .5).slice(0, n), d = [...pick(POOL[f], 12 - k), ...pick(POOL.n, k)]; if (legal(d)) return d; }
}

if (!isMainThread) {
  const ai = makeAI(workerData.ai), { decks, per, gen } = workerData;
  parentPort.on('message', ({ from, n }) => { const res = [];
    for (let g = from; g < from + n; g++) {
      const ci = Math.floor(g / (K * per)), r = g % (K * per), p = Math.floor(r / per), j = r % per, first = (j & 1) === 0;
      const rnd = lcg(((gen * 7919 + ci) * 104729 + p * 131 + j) * 2654435761 >>> 0), mine = decks[ci], theirs = DECKS[p].cards;
      let s = newGame(first ? [mine, theirs] : [theirs, mine], rnd);
      while (s.winner === null && s.n <= 70) for (const x of aiTurn(s, { ...ai, rnd })) s = apply(s, x).state;
      const w = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1;
      res.push([ci, p, w < 0 ? .5 : (w === 0) === first ? 1 : 0]);
    }
    parentPort.postMessage(res); });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] !== '--selftest') {
  const args = process.argv.slice(2).filter(x => x !== '--all'), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
  const seedFile = opt('--seeds', null), PER = +opt('--per', 8), FINAL = +opt('--final', 80), KEEP = +opt('--keep', 8), KIDS = +opt('--kids', 16);
  const [ai, G = '12', W = '20', outPath = 'out/lab/deck_search.json'] = args, rnd = lcg(20261119), t0 = Date.now(), url = new URL(import.meta.url);
  const extra = seedFile && existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, 'utf8')).filter(legal) : [];
  const cupDecks = ALL ? (await import('../../cup.js')).ROSTER.find(r => r.key === 'q1').decks.filter(d => legal(d.cards)) : [];
  const entry = (d, from) => ({ d, from, w: 0, n: 0, vs: Array(K).fill(0), vn: Array(K).fill(0) }), seen = new Set();
  const groups = FS.map(f => { const pop = [];
    const add = (d, from) => { if (!seen.has(key(d))) { seen.add(key(d)); pop.push(entry(d, from)); } };
    for (const d of DECKS) if (d.f === f && legal(d.cards)) add([...d.cards], '预设·' + d.name);
    for (const d of extra) if (factionOf(d) === f) add(d, 'agent');
    for (const d of cupDecks) if (factionOf(d.cards) === f) add([...d.cards], '锦标赛·' + d.name);
    while (pop.length < KEEP + KIDS) add(randomFor(f, rnd), '随机');
    return { f, pop }; });
  const score = x => (x.w + 1) / (x.n + 2);
  async function run(list, per, gen) {
    await farm(url, list.length * K * per, +W, 8, { ai, decks: list.map(x => x.d), per, gen, all: ALL }, res => { for (const [ci, p, s] of res) { const x = list[ci]; x.w += s; x.n++; x.vs[p] += s; x.vn[p]++; } });
  }
  for (let gen = 0; gen <= +G; gen++) {
    if (gen > 0) for (const g of groups) { const top = g.pop.slice(0, KEEP); g.pop = top;
      for (let i = 0, tries = 0; i < KIDS && tries < KIDS * 20; tries++) { const par = top[Math.min(Math.floor(rnd() * rnd() * top.length), top.length - 1)], d = mutate(par.d, g.f, rnd); // 偏向挑排前面的当父本
        if (d && !seen.has(key(d))) { seen.add(key(d)); g.pop.push(entry(d, '变异')); i++; } } }
    await run(groups.flatMap(g => g.pop), PER, gen);
    for (const g of groups) g.pop.sort((a, b) => score(b) - score(a));
    console.log(`第 ${gen} 代（${((Date.now() - t0) / 60000).toFixed(1)} 分钟）：` + groups.map(g => `${FACTIONS[g.f].name} ${(100 * score(g.pop[0])).toFixed(1)}%`).join('  '));
  }
  // 决赛：每阵营前 3 名 + 14 套预设，新种子重打，只用这批结果
  const fin = [...groups.flatMap(g => g.pop.slice(0, 3).map(x => ({ ...entry(x.d, x.from), f: g.f, prior: score(x) }))), ...DECKS.map(d => ({ ...entry([...d.cards], '预设·' + d.name), f: d.f, preset: d.name })), ...cupDecks.map(d => ({ ...entry([...d.cards], '锦标赛·' + d.name), f: d.f, preset: '锦标赛·' + d.name }))];
  await run(fin, FINAL, 9999);
  const show = x => { const p = x.w / x.n, ci = 1.96 * Math.sqrt(p * (1 - p) / x.n); return { faction: FACTIONS[x.f].name, from: x.from, preset: x.preset || null, rate: +(100 * p).toFixed(1), ci: +(100 * ci).toFixed(1), games: x.n,
    cards: x.d, names: x.d.map(k => `${CARDS[k].name}(${CARDS[k].cost})`), vs: Object.fromEntries(DECKS.map((d, i) => [d.name, +(100 * x.vs[i] / x.vn[i]).toFixed(1)])) }; };
  const out = fin.map(show).sort((a, b) => b.rate - a.rate);
  writeFileSync(outPath, JSON.stringify({ ai, gens: +G, per: PER, final: FINAL, minutes: +((Date.now() - t0) / 60000).toFixed(1), decks: out }, null, 1));
  console.log(`\n决赛（每套对 14 套预设各 ${FINAL} 局）：`);
  for (const x of out) console.log(`${x.rate.toFixed(1).padStart(5)}% ± ${x.ci}  ${x.faction}  ${x.preset ? '【预设】' + x.preset : x.from}  ${x.names.join('、')}`);
  console.log(`写进 ${outPath}`);
}

// 自检：node tools/lab/deck_search.mjs --selftest
if (isMainThread && process.argv[2] === '--selftest') {
  const r = lcg(1);
  for (const f of FS) { const d = randomFor(f, r); if (!legal(d) || d.length !== 12) throw new Error('随机卡组不合法 ' + f);
    for (let i = 0; i < 50; i++) { const m = mutate(d, f, r); if (m && (!legal(m) || m.filter(k => !d.includes(k)).length > 2)) throw new Error('变异不合法或换太多 ' + f); } }
  if (DECKS.some(d => d.cards.some(k => CARDS[k].boss || CARDS[k].prize))) console.log('注意：有预设用了首领/奖励牌，会被当作不合法跳过');
  console.log('自检通过');
}
