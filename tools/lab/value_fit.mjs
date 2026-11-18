// 估值模型校准：用"战力随机 ±1"的普查（census.mjs 抖动=1）反推每种能力实际值多少战力。
// 第一步：逻辑回归，每张牌一个强弱分，外加"1 点战力值多少"（按费用分三档各一个斜率）。
// 第二步：每张棋子的"公平战力" = 现在的战力 − 它多出来的强弱分 ÷ 斜率。
// 第三步：拿公平战力回头拟合估值公式：公平战力 ≈ 基线(费用, 步数) + 基线修正 − Σ 估值 × (1 + 效果修正 + 触发修正)。
//        修正项带岭回归（样本少的效果不乱跳）。首领、奖励牌、衍生物是手填的，不参与。
// 用法：node tools/lab/value_fit.mjs <普查目录>  →  <目录>/value.json、value.md
import { readFileSync, writeFileSync } from 'node:fs';
import { CARDS } from '../../chess.js';
import { TUNE } from '../../chess-tune.js';

const dir = process.argv[2], REC = 27, meta = JSON.parse(readFileSync(`${dir}/meta.json`)), ids = meta.ids, N = ids.length;
const gb = readFileSync(`${dir}/games.bin`), all = new Uint32Array(gb.buffer, gb.byteOffset, Math.floor(gb.length / 4 / REC) * REC), G = all.length / REC;
const jb = readFileSync(`${dir}/jitter.bin`), jit = new Int8Array(jb.buffer, jb.byteOffset, G * 24);
const tier = c => c.cost <= 3 ? 0 : c.cost <= 5 ? 1 : 2, TIER = ['1–3 费', '4–5 费', '6 费以上'], tierOf = Int8Array.from(ids, k => tier(CARDS[k]));
const sig = z => 1 / (1 + Math.exp(-z));

// ---------- 第一步：每张牌的强弱分 + 每档"1 点战力值多少" ----------
const w = new Float64Array(N), gw = new Float64Array(N).fill(1e-8), beta = new Float64Array(3).fill(.1), gbeta = new Float64Array(3).fill(1e-8); let b = 0, gB = 1e-8;
const idx = []; for (let g = 0; g < G; g++) if (all[g * REC + 24] !== 2) idx.push(g);
for (let e = 0; e < 5; e++) for (const g of idx) { const o = g * REC; let z = b;
  for (let i = 0; i < 24; i++) { const c = all[o + i], sg = i < 12 ? 1 : -1; z += sg * (w[c] + beta[tierOf[c]] * jit[g * 24 + i]); }
  const err = sig(z) - (all[o + 24] === 0 ? 1 : 0); gB += err * err; b -= .05 * err / Math.sqrt(gB);
  for (let i = 0; i < 24; i++) { const c = all[o + i], sg = i < 12 ? 1 : -1, d = jit[g * 24 + i];
    const gr = sg * err + 2e-5 * w[c]; gw[c] += gr * gr; w[c] -= .05 * gr / Math.sqrt(gw[c]);
    if (d) { const t = tierOf[c], gt = sg * err * d; gbeta[t] += gt * gt; beta[t] -= .01 * gt / Math.sqrt(gbeta[t]); } } }
const inDeck = new Float64Array(N); for (const g of idx) for (let i = 0; i < 24; i++) inDeck[all[g * REC + i]]++;
let wbar = 0, wn = 0; for (let i = 0; i < N; i++) { wbar += w[i] * inDeck[i]; wn += inDeck[i]; } wbar /= wn;
const pp = x => 100 * (sig(x) - .5);

// ---------- 第二步：公平战力 ----------
const baseline = (cost, move) => [2 * (cost - 1), 1.75 * cost - 2.5, 1.5 * cost - 3.5, 1.25 * cost - 4][move];
const lift = (cost, move) => cost <= 3 ? 0 : cost <= 5 ? 1 : cost === 6 ? (move ? 2 : 1) : cost === 7 ? 2 : 4;
const pieces = ids.map((k, i) => ({ k, i, c: CARDS[k] })).filter(x => x.c && x.c.kind !== 'spell' && !x.c.boss && !x.c.prize && !x.c.token && x.c.parts && inDeck[x.i] > Math.min(1000, G / 20) && !x.c.hatch);
for (const x of pieces) { const c = x.c; x.base = c.kind === 'unit' ? baseline(c.cost, c.move) + lift(c.cost, c.move) : c.cost + 2; x.val = c.parts.reduce((a, p) => a + p[1] * p[2], 0);
  x.score = pp(w[x.i] - wbar); x.fair = c.str - (w[x.i] - wbar) / beta[tierOf[x.i]]; x.tune = TUNE[x.k] || 0; }

// ---------- 第三步：拟合估值公式 ----------
const keyName = { flag: '词条', onPlay: '出场时', onTurn: '每回合开始', onAttack: '攻击时', onDeath: '倒下时', onAfter: '打完还活着', onHurt: '狂暴', onSpell: '每放法术', onAllyDeath: '友军倒下时', onNearDeath: '相邻倒下', combo: '连击' };
const EK = [...new Set(pieces.flatMap(x => x.c.parts.map(p => p[0])))], TK = [...new Set(pieces.flatMap(x => x.c.parts.map(p => p[3])))].filter(t => t !== 'flag');
const BK = [...new Set(pieces.map(x => x.c.kind === 'unit' ? `单位 ${x.c.cost} 费` : '建筑'))], MK = ['步0', '步1', '步2', '步3'];
const cols = [...EK.map(k => ['e', k]), ...TK.map(k => ['t', k]), ...BK.map(k => ['b', k]), ...MK.slice(1).map(k => ['m', k])], P = cols.length, col = Object.fromEntries(cols.map((c, j) => [c.join(':'), j]));
const lam = cols.map(([t]) => t === 'e' ? 3 : t === 't' ? 3 : 1); // 岭回归：修正项默认是 0，证据不够就不动
const feats = x => { const f = new Float64Array(P), c = x.c;
  for (const [k, v, m, on] of c.parts) { const vm = v * m; f[col['e:' + k]] -= vm; if (on !== 'flag') f[col['t:' + on]] -= vm; }
  f[col['b:' + (c.kind === 'unit' ? `单位 ${c.cost} 费` : '建筑')]] += 1; if (c.kind === 'unit' && c.move) f[col['m:步' + c.move]] += 1; return f; };
function solve(list) { // 岭回归的正规方程，高斯消元
  const A = Array.from({ length: P }, () => new Float64Array(P)), y = new Float64Array(P);
  for (const x of list) { const f = feats(x), r = x.fair - (x.base - x.val); for (let i = 0; i < P; i++) { if (!f[i]) continue; y[i] += f[i] * r; for (let j = 0; j < P; j++) A[i][j] += f[i] * f[j]; } }
  for (let i = 0; i < P; i++) A[i][i] += lam[i];
  const M = A.map((r, i) => [...r, y[i]]); for (let i = 0; i < P; i++) { let p = i; for (let r = i + 1; r < P; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r; [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < P; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let j = i; j <= P; j++) M[r][j] -= f * M[i][j]; } } return M.map((r, i) => r[P] / r[i]); }
const sol = solve(pieces);
// 交叉验证：分 5 份，每次用 4 份拟合、预测没见过的那 1 份，看新公式对"没参与拟合的牌"准不准
let cvErr = 0; for (let f = 0; f < 5; f++) { const s5 = solve(pieces.filter((_, i) => i % 5 !== f)); for (const x of pieces.filter((_, i) => i % 5 === f)) { const fx = feats(x); let d = 0; for (let j = 0; j < P; j++) d += fx[j] * s5[j]; cvErr += (x.fair - (x.base - x.val + d)) ** 2; } }
const rmsCV = Math.sqrt(cvErr / pieces.length);
const coef = Object.fromEntries(cols.map((c, j) => [c.join(':'), sol[j]]));
const newVal = x => x.c.parts.reduce((a, [k, v, m, on]) => a + v * m * (1 + coef['e:' + k] + (on === 'flag' ? 0 : coef['t:' + on])), 0);
const newBase = x => x.base + coef['b:' + (x.c.kind === 'unit' ? `单位 ${x.c.cost} 费` : '建筑')] + (x.c.kind === 'unit' && x.c.move ? coef['m:步' + x.c.move] : 0);
for (const x of pieces) { x.predOld = x.base - x.val; x.predNew = newBase(x) - newVal(x); x.strNew = Math.max(1, Math.min(15, Math.round(x.predNew))); }
const rms = f => Math.sqrt(pieces.reduce((a, x) => a + (x.fair - f(x)) ** 2, 0) / pieces.length);

// ---------- 报告 ----------
const effRows = EK.map(k => { const ps = pieces.flatMap(x => x.c.parts.filter(p => p[0] === k)); const v0 = ps.reduce((a, p) => a + p[1], 0) / ps.length;
  return { k, n: new Set(pieces.filter(x => x.c.parts.some(p => p[0] === k)).map(x => x.k)).size, old: +v0.toFixed(2), fix: +coef['e:' + k].toFixed(2), neu: +(v0 * (1 + coef['e:' + k])).toFixed(2) }; }).sort((a, b) => Math.abs(b.fix * b.old) - Math.abs(a.fix * a.old));
const trigRows = TK.map(k => ({ k, name: keyName[k] ?? k, fix: +coef['t:' + k].toFixed(2), n: pieces.filter(x => x.c.parts.some(p => p[3] === k)).length }));
const baseRows = [...BK.map(k => [k, coef['b:' + k]]), ...MK.slice(1).map(k => [k, coef['m:' + k]])].map(([k, v]) => ({ k, fix: +v.toFixed(2), n: pieces.filter(x => (x.c.kind === 'unit' ? `单位 ${x.c.cost} 费` : '建筑') === k || (k.startsWith('步') && x.c.kind === 'unit' && 'm:步' + x.c.move === 'm:' + k)).length }));
const moved = pieces.map(x => ({ name: x.c.name, now: x.c.str, neu: x.strNew, fair: +x.fair.toFixed(1), score: +x.score.toFixed(1), tune: x.tune })).filter(x => x.neu !== x.now).sort((a, b) => Math.abs(b.neu - b.now) - Math.abs(a.neu - a.now));
const out = { games: G, beta: [...beta].map((v, t) => ({ tier: TIER[t], logit: +v.toFixed(3), pp: +(25 * v).toFixed(2) })), rmsOld: +rms(x => x.predOld).toFixed(2), rmsNow: +rms(x => x.c.str).toFixed(2), rmsNew: +rms(x => x.predNew).toFixed(2), rmsCV: +rmsCV.toFixed(2), pieces: pieces.length, all: pieces.map(x => ({ id: x.k, name: x.c.name, now: x.c.str, fair: +x.fair.toFixed(2), old: +x.predOld.toFixed(2), neu: +x.predNew.toFixed(2), score: +x.score.toFixed(1), tune: x.tune })), effects: effRows, triggers: trigRows, base: baseRows, moved, coef };
writeFileSync(`${dir}/value.json`, JSON.stringify(out, null, 1));
const md = [`# 估值模型校准`, ``, `${G} 局（战力随机 ±1），${pieces.length} 张棋子参与拟合。`, ``, `## 1 点战力值多少胜率`, ...out.beta.map(x => `- ${x.tier}：约 ${x.pp} 个百分点`), ``,
  `## 公式和公平战力差多少（越小越准，单位：点战力）`, `- 只用公式、不加自动微调：${out.rmsOld}`, `- 现在的实际战力（公式 + 自动微调）：${out.rmsNow}`, `- 新公式、不加自动微调：${out.rmsNew}`, `- 新公式，换成没参与拟合的牌来考（5 折交叉验证）：${out.rmsCV}`, ``,
  `## 效果和词条：估值修正（按影响大小排）`, `| 能力 | 张数 | 现在估值 | 修正 | 新估值 |`, `|---|---|---|---|---|`, ...effRows.map(r => `| ${r.k} | ${r.n} | ${r.old} | ${r.fix > 0 ? '+' : ''}${Math.round(r.fix * 100)}% | ${r.neu} |`), ``,
  `## 触发时机：估值修正`, `| 时机 | 张数 | 修正 |`, `|---|---|---|`, ...trigRows.map(r => `| ${r.name} | ${r.n} | ${r.fix > 0 ? '+' : ''}${Math.round(r.fix * 100)}% |`), ``,
  `## 基线修正（点战力）`, `| 档 | 张数 | 修正 |`, `|---|---|---|`, ...baseRows.map(r => `| ${r.k} | ${r.n} | ${r.fix > 0 ? '+' : ''}${r.fix} |`), ``,
  `## 换新公式（自动微调清零）后战力会变的棋子：${moved.length} 张`, `| 牌 | 现在 | 新公式 | 公平战力 | 单卡分 | 现在的自动微调 |`, `|---|---|---|---|---|---|`, ...moved.map(x => `| ${x.name} | ${x.now} | ${x.neu} | ${x.fair} | ${x.score} | ${x.tune} |`)];
writeFileSync(`${dir}/value.md`, md.join('\n'));
console.log(md.slice(0, 14).join('\n'));
