// 组合普查的分析：把每局的胜负拆到每张牌和每对牌上（逻辑回归，先手优势单独一项），出一份报告。
// 单卡分：这张牌在卡组里，胜率平均变化几个百分点（同组其他牌的影响已经扣掉）。
// 配对分：两张牌同在一副卡组里，比它们各自的单卡分加起来还多（或少）几个百分点。正得多是组合，负得多是互相拖后腿。
// 留出 5% 的对局核对：加上配对项后预测得更准，才说明组合是真的存在，而不是噪声。
// 用法：node tools/lab/census_fit.mjs <普查输出目录>   →  <目录>/report.json、report.md
import { readFileSync, writeFileSync } from 'node:fs';
import { CARDS, FACTIONS } from '../../chess.js';

const dir = process.argv[2] ?? 'out/lab/census', REC = 27;
const meta = JSON.parse(readFileSync(`${dir}/meta.json`)), ids = meta.ids, N = ids.length;
const buf = readFileSync(`${dir}/games.bin`), all = new Uint32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4 / REC) * REC), G = all.length / REC;
const name = i => CARDS[ids[i]]?.name ?? ids[i], fac = i => CARDS[ids[i]]?.faction ?? '?';
const deckF = (o) => { for (let i = 0; i < 12; i++) { const f = fac(all[o + i]); if (f !== 'n') return f; } return 'n'; };

// ---------- 描述统计 ----------
let first = 0, decided = 0, draws = 0, turns = 0; const fm = {}, fw = {}, nb = Array.from({ length: 13 }, () => [0, 0]);
const inDeck = new Float64Array(N), pairN = new Float64Array(N * N);
for (let g = 0; g < G; g++) {
  const o = g * REC, r = all[o + 24]; turns += all[o + 25]; if (r === 2) { draws++; continue; } decided++; if (r === 0) first++;
  for (const [side, off] of [[0, 0], [1, 12]]) { const f = deckF(o + off), F2 = deckF(o + 12 - off), won = r === side ? 1 : 0;
    (fw[f] ??= [0, 0]); fw[f][0] += won; fw[f][1]++; const key = f + '>' + F2; (fm[key] ??= [0, 0]); fm[key][0] += won; fm[key][1]++;
    let k = 0; for (let i = 0; i < 12; i++) { const c = all[o + off + i]; inDeck[c]++; if (fac(c) === 'n') k++; for (let j = 0; j < i; j++) { const d = all[o + off + j], a = Math.min(c, d), b = Math.max(c, d); pairN[a * N + b]++; } }
    nb[k][0] += won; nb[k][1]++; }
}

// ---------- 逻辑回归 ----------
const sig = z => 1 / (1 + Math.exp(-z));
function fit(usePairs, train, epochs = 4, fixed = null) { // fixed：单卡分用现成的、不再动，只学配对（配对 = 单卡解释不了的那部分）
  const w = fixed ? Float64Array.from(fixed) : new Float64Array(N), v = usePairs ? new Float64Array(N * N) : null, gw = new Float64Array(N).fill(1e-8), gv = usePairs ? new Float64Array(N * N).fill(1e-8) : null;
  let b = 0, gb = 1e-8; const lr = .05, l2w = 2e-5, l2v = 3e-3;
  const z = o => { let s = b; for (const [sg, off] of [[1, 0], [-1, 12]]) for (let i = 0; i < 12; i++) { const c = all[o + off + i]; s += sg * w[c]; if (v) for (let j = 0; j < i; j++) { const d = all[o + off + j]; s += sg * v[Math.min(c, d) * N + Math.max(c, d)]; } } return s; };
  for (let e = 0; e < epochs; e++) for (const g of train) { const o = g * REC, y = all[o + 24] === 0 ? 1 : 0, err = sig(z(o)) - y; // 交叉熵的梯度
    gb += err * err; b -= lr * err / Math.sqrt(gb);
    for (const [sg, off] of [[1, 0], [-1, 12]]) for (let i = 0; i < 12; i++) { const c = all[o + off + i]; if (!fixed) { const gr = sg * err + l2w * w[c]; gw[c] += gr * gr; w[c] -= lr * gr / Math.sqrt(gw[c]); }
      if (v) for (let j = 0; j < i; j++) { const d = all[o + off + j], p = Math.min(c, d) * N + Math.max(c, d), gp = sg * err + l2v * v[p]; gv[p] += gp * gp; v[p] -= lr * gp / Math.sqrt(gv[p]); } } }
  const loss = set => { let L = 0; for (const g of set) { const o = g * REC, y = all[o + 24] === 0 ? 1 : 0, p = Math.min(1 - 1e-9, Math.max(1e-9, sig(z(o)))); L -= y * Math.log(p) + (1 - y) * Math.log(1 - p); } return L / set.length; };
  return { w, v, b, loss };
}
const idx = []; for (let g = 0; g < G; g++) if (all[g * REC + 24] !== 2) idx.push(g);
for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(((i * 2654435761) >>> 0) / 4294967296 * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } // 固定顺序打乱
const cut = Math.floor(idx.length * .95), train = idx.slice(0, cut), test = idx.slice(cut);
const m1 = fit(false, train), m2 = fit(true, train, 3, m1.w);
const base = (() => { const p = train.filter(g => all[g * REC + 24] === 0).length / train.length; return -(p * Math.log(p) + (1 - p) * Math.log(1 - p)); })();
const L1 = m1.loss(test), L2 = m2.loss(test);

// ---------- 报告 ----------
const pp = x => +(100 * (sig(x) - .5)).toFixed(1); // 逻辑值 → 从 50% 出发的胜率变化（百分点）
const wbar = (() => { let a = 0, n = 0; for (let i = 0; i < N; i++) { a += m1.w[i] * inDeck[i]; n += inDeck[i]; } return a / n; })(); // 单卡分以平均每张牌为零点
const playAvg = i => meta.playCnt[i] ? meta.playSum[i] / meta.playCnt[i] : null;
const singles = ids.map((_, i) => ({ id: ids[i], name: name(i), f: fac(i), cost: CARDS[ids[i]]?.cost, pp: pp(m1.w[i] - wbar), games: inDeck[i], playDelta: playAvg(i) && +playAvg(i).toFixed(2), plays: meta.playCnt[i] })).filter(x => x.games > 0).sort((a, b) => b.pp - a.pp);
const pairs = []; for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) { const n = pairN[a * N + b]; if (n < 1500) continue; const x = m2.v[a * N + b], se = 2 / Math.sqrt(n);
  pairs.push({ a: ids[a], b: ids[b], names: name(a) + ' + ' + name(b), f: fac(a) === 'n' ? fac(b) : fac(a), pp: pp(x), z: +(x / se).toFixed(1), games: n }); }
pairs.sort((p, q) => q.pp - p.pp);
const rate = ([w, n]) => n ? +(100 * w / n).toFixed(1) : null;
const fname = f => FACTIONS[f]?.name ?? f;
const report = { dir, games: G, rules: meta.rules, ai: meta.ai, firstWin: rate([first, decided]), draws: rate([draws, G]), avgTurns: +(turns / G).toFixed(1),
  heldOut: { baseline: +base.toFixed(4), singles: +L1.toFixed(4), singlesPairs: +L2.toFixed(4) },
  faction: Object.fromEntries(Object.entries(fw).map(([f, x]) => [f, rate(x)])), matrix: Object.fromEntries(Object.entries(fm).map(([k, x]) => [k, [rate(x), x[1]]])),
  neutralCount: nb.map((x, k) => ({ k, win: rate(x), decks: x[1] })), singles, pairsTop: pairs.slice(0, 60), pairsBottom: pairs.slice(-30).reverse() };
writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 1));
const md = [`# 组合普查报告`, ``, `${G} 局，规则版本 ${meta.rules}，电脑 ${JSON.stringify(meta.ai)}。先手胜率 ${report.firstWin}%，平局 ${report.draws}%，平均 ${report.avgTurns} 回合。`, ``,
  `留出对局的预测误差（越小越准）：只看先手 ${report.heldOut.baseline}，加单卡 ${report.heldOut.singles}，再加配对 ${report.heldOut.singlesPairs}。`, ``,
  `## 阵营胜率`, ...Object.entries(report.faction).sort((a, b) => b[1] - a[1]).map(([f, x]) => `- ${fname(f)}：${x}%`), ``,
  `## 中立牌张数和胜率`, ...report.neutralCount.map(x => `- ${x.k} 张：${x.win}%（${x.decks} 副）`), ``,
  `## 单卡：最强 30`, `| 牌 | 阵营 | 费 | 换掉一张平均牌后胜率变化 | 打出时评分涨 | 出现局数 |`, `|---|---|---|---|---|---|`,
  ...singles.slice(0, 30).map(x => `| ${x.name} | ${fname(x.f)} | ${x.cost} | ${x.pp} | ${x.playDelta} | ${x.games} |`), ``,
  `## 单卡：最弱 30`, `| 牌 | 阵营 | 费 | 换掉一张平均牌后胜率变化 | 打出时评分涨 | 出现局数 |`, `|---|---|---|---|---|---|`,
  ...singles.slice(-30).reverse().map(x => `| ${x.name} | ${fname(x.f)} | ${x.cost} | ${x.pp} | ${x.playDelta} | ${x.games} |`), ``,
  `## 组合：最强 40（同在一副卡组时多出来的胜率）`, `| 组合 | 阵营 | 多出百分点 | 显著度 z | 同时出现局数 |`, `|---|---|---|---|---|`,
  ...pairs.slice(0, 40).map(p => `| ${p.names} | ${fname(p.f)} | ${p.pp} | ${p.z} | ${p.games} |`), ``,
  `## 互相拖后腿：最差 20`, `| 组合 | 阵营 | 百分点 | z | 局数 |`, `|---|---|---|---|---|`, ...pairs.slice(-20).reverse().map(p => `| ${p.names} | ${fname(p.f)} | ${p.pp} | ${p.z} | ${p.games} |`)];
writeFileSync(`${dir}/report.md`, md.join('\n'));
console.log(md.slice(0, 22).join('\n'));
