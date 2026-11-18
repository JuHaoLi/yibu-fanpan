// 组合拟合：把普查/自我对打的胜负拆到单卡、每点战力的斜率、两张组合、三张组合上（逻辑回归，先手优势单独一项，L2，AdaGrad，照 census_fit）。
// 单卡：z = b + Σ先手牌 (w_c + s_c·δ_c) − Σ后手牌 (…)，δ 是抖动；s_c = β_档位(费用 1–3 / 4–5 / 6+) + γ_c（γ 强收缩）。没抖动的数据只拟合 w。
// 配对：固定单卡后学残差 v_ab；三张：候选 = 正配对（pp>0、z≥2.5、同现 ≥1000）组成的三角形里至少两条边合格、三张同现 ≥600 局的三元组，固定单卡+配对后学残差 t_abc。
// 留出 5% 局（固定打乱）报交叉熵；标准误用 Fisher 信息对角线近似 1/sqrt(Σp(1−p)·出现次数)。se、slope_se 都是百分点（logit 的 25 倍），z = 估计 / 标准误。
// 用法：node tools/lab/combo_fit.mjs <输出目录> <普查目录…>   （多个目录 rules 和 ids 必须相同）
//       node tools/lab/combo_fit.mjs --selftest
// 输出：singles.csv pairs.csv triples.csv factions.csv matrix.csv neutral.csv summary.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { CARDS, FACTIONS } from '../../chess.js';

const REC = 27, PAIR_N = 1000, EDGE_Z = 2.5, TRI_N = 600, LR = .05, L2W = 2e-5, L2G = 1e-2, L2V = 500, L2T = 1000;
// 配对/三张的 L2 是"每个参数一份"的先验（每次更新按 λ/出现次数 摊开），λ 按 census2 留出交叉熵选：照 census_fit 的每次更新 3e-3 时配对让留出变差（.5369→.5396），λ=500 时 →.5278
const sig = x => 1 / (1 + Math.exp(-x)), pp = x => +(100 * (sig(x) - .5)).toFixed(2), r2 = x => +x.toFixed(2);
const tierOf = c => (c >= 6 ? 2 : c >= 4 ? 1 : 0);
const q = v => (v === undefined || v === null || (typeof v === 'number' && !isFinite(v)) ? '' : // 只在留出/平局里出现的牌 Fisher=0 → se=Infinity，写空，免得下游 JSON 坏掉
 /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (path, head, rows) => writeFileSync(path, [head.join(','), ...rows.map(r => head.map(h => q(r[h])).join(','))].join('\n') + '\n');

export function load(dirs) {
  const metas = dirs.map(d => JSON.parse(readFileSync(`${d}/meta.json`)));
  for (const [i, m] of metas.entries()) {
    if (m.rules !== metas[0].rules) throw new Error(`规则版本不一致：${dirs[0]}=${metas[0].rules}，${dirs[i]}=${m.rules}`);
    if (JSON.stringify(m.ids) !== JSON.stringify(metas[0].ids)) throw new Error(`牌表 ids 不一致：${dirs[i]}`);
  }
  const bufs = dirs.map(d => readFileSync(`${d}/games.bin`)), gs = bufs.map(b => Math.floor(b.length / 4 / REC)), G = gs.reduce((a, b) => a + b, 0);
  const all = new Uint32Array(G * REC), jit = new Int8Array(G * 24), out = Buffer.from(all.buffer), jout = Buffer.from(jit.buffer); let at = 0, hasJ = false;
  dirs.forEach((d, k) => { bufs[k].copy(out, at * REC * 4, 0, gs[k] * REC * 4); // 复制一份：小文件的 Buffer 不保证 4 字节对齐
    if (metas[k].jitter && existsSync(`${d}/jitter.bin`)) { const jb = readFileSync(`${d}/jitter.bin`); jb.copy(jout, at * 24, 0, Math.min(jb.length, gs[k] * 24)); hasJ = true; }
    at += gs[k]; });
  const N = metas[0].ids.length, playSum = new Float64Array(N), playCnt = new Float64Array(N);
  for (const m of metas) for (let i = 0; i < N; i++) { playSum[i] += m.playSum?.[i] ?? 0; playCnt[i] += m.playCnt?.[i] ?? 0; }
  return { ids: metas[0].ids, rules: metas[0].rules, ai: [...new Set(metas.map(m => m.ai))].join('+'), all, jit, G, hasJ, playSum, playCnt };
}

export function fitAll({ ids, rules, ai, all, jit, G, hasJ, playSum, playCnt }, outDir) {
  const t0 = Date.now(), N = ids.length, C = i => CARDS[ids[i]], name = i => C(i)?.name ?? ids[i], fac = i => C(i)?.faction ?? '?';
  const T = Uint8Array.from(ids, (_, i) => tierOf(C(i)?.cost ?? 0)), SG = [1, -1], OFF = [0, 12];
  const deckF = o => { for (let i = 0; i < 12; i++) { const f = fac(all[o + i]); if (f !== 'n') return f; } return 'n'; };
  // ---------- 描述统计 + 同现次数（全部局，含平局）----------
  let first = 0, decided = 0, draws = 0, turns = 0; const fw = {}, fm = {}, nb = Array.from({ length: 13 }, () => [0, 0]);
  const inDeck = new Float64Array(N), pairN = new Float64Array(N * N);
  for (let g = 0; g < G; g++) {
    const o = g * REC, r = all[o + 24]; turns += all[o + 25];
    for (const off of OFF) for (let i = 0; i < 12; i++) { const c = all[o + off + i]; inDeck[c]++; for (let j = 0; j < i; j++) { const d = all[o + off + j]; pairN[Math.min(c, d) * N + Math.max(c, d)]++; } }
    if (r === 2) { draws++; continue; } decided++; if (r === 0) first++;
    for (const side of [0, 1]) { const off = OFF[side], f = deckF(o + off), f2 = deckF(o + 12 - off), won = r === side ? 1 : 0;
      (fw[f] ??= [0, 0])[0] += won; fw[f][1]++; (fm[f + '>' + f2] ??= [0, 0])[0] += won; fm[f + '>' + f2][1]++;
      let k = 0; for (let i = 0; i < 12; i++) if (fac(all[o + off + i]) === 'n') k++; nb[k][0] += won; nb[k][1]++; }
  }
  // ---------- 训练 / 留出：去掉平局，固定打乱，留 5% ----------
  const idx = []; for (let g = 0; g < G; g++) if (all[g * REC + 24] !== 2) idx.push(g);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(((i * 2654435761) >>> 0) / 4294967296 * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const cut = Math.floor(idx.length * .95), train = idx.slice(0, cut), test = idx.slice(cut), Y = g => (all[g * REC + 24] === 0 ? 1 : 0);
  const bce = zf => { let L = 0; for (const g of test) { const p = Math.min(1 - 1e-9, Math.max(1e-9, sig(zf(g)))); L -= Y(g) ? Math.log(p) : Math.log(1 - p); } return L / test.length; };
  const pf = train.reduce((a, g) => a + Y(g), 0) / train.length, baseline = bce(() => Math.log(pf / (1 - pf))); // 只先手：训练集的先手率，在留出上算（和其余三项同一把尺子）
  // ---------- 单卡 + 斜率 ----------
  const w = new Float64Array(N), gam = new Float64Array(N), beta = new Float64Array(3), gw = new Float64Array(N).fill(1e-8), gg = new Float64Array(N).fill(1e-8), gbt = new Float64Array(3).fill(1e-8);
  let b = 0, gb = 1e-8;
  const zS = g => { const o = g * REC; let s = b; for (let h = 0; h < 2; h++) for (let i = 0; i < 12; i++) { const c = all[o + OFF[h] + i], d = jit[g * 24 + OFF[h] + i]; s += SG[h] * (w[c] + (d ? d * (beta[T[c]] + gam[c]) : 0)); } return s; };
  const bt = new Float64Array(3);
  for (let e = 0; e < 4; e++) for (const g of train) { const lr = LR / (1 + e); // 每轮学习率减半到三分之一，压住 AdaGrad 末尾的抖动
   
    const o = g * REC, err = sig(zS(g)) - Y(g); gb += err * err; b -= lr * err / Math.sqrt(gb); bt.fill(0);
    for (let h = 0; h < 2; h++) for (let i = 0; i < 12; i++) { const c = all[o + OFF[h] + i], d = jit[g * 24 + OFF[h] + i], e1 = SG[h] * err;
      const gr = e1 + L2W * w[c]; gw[c] += gr * gr; w[c] -= lr * gr / Math.sqrt(gw[c]);
      if (d) { const g2 = e1 * d + L2G * gam[c]; gg[c] += g2 * g2; gam[c] -= lr * g2 / Math.sqrt(gg[c]); bt[T[c]] += e1 * d; } }
    if (hasJ) for (let t = 0; t < 3; t++) if (bt[t]) { gbt[t] += bt[t] * bt[t]; beta[t] -= lr * bt[t] / Math.sqrt(gbt[t]); }
  }
  const zs = new Float64Array(G); for (let g = 0; g < G; g++) zs[g] = zS(g);
  const Ls = bce(g => zs[g]);
  // ---------- 配对残差（单卡固定）----------
  const v = new Float64Array(N * N), gv = new Float64Array(N * N).fill(1e-8);
  const zP = g => { const o = g * REC; let s = zs[g]; for (let h = 0; h < 2; h++) for (let i = 0; i < 12; i++) { const c = all[o + OFF[h] + i]; for (let j = 0; j < i; j++) { const d = all[o + OFF[h] + j]; s += SG[h] * v[Math.min(c, d) * N + Math.max(c, d)]; } } return s; };
  for (let e = 0; e < 3; e++) for (const g of train) { const lr = LR / (1 + e); const o = g * REC, err = sig(zP(g)) - Y(g);
    for (let h = 0; h < 2; h++) for (let i = 0; i < 12; i++) { const c = all[o + OFF[h] + i]; for (let j = 0; j < i; j++) { const d = all[o + OFF[h] + j], p = Math.min(c, d) * N + Math.max(c, d), gp = SG[h] * err + L2V * v[p] / pairN[p]; gv[p] += gp * gp; v[p] -= lr * gp / Math.sqrt(gv[p]); } } }
  const zp = new Float64Array(G); for (let g = 0; g < G; g++) zp[g] = zP(g);
  const Lp = bce(g => zp[g]);
  // ---------- Fisher 信息（单卡、斜率、配对）----------
  const iw = new Float64Array(N), ig = new Float64Array(N), iv = new Float64Array(N * N);
  for (const g of train) { const o = g * REC, a = sig(zs[g]), pa = a * (1 - a), c2 = sig(zp[g]), pb = c2 * (1 - c2);
    for (const off of OFF) for (let i = 0; i < 12; i++) { const c = all[o + off + i], d = jit[g * 24 + off + i]; iw[c] += pa; ig[c] += pa * d * d; for (let j = 0; j < i; j++) { const e = all[o + off + j]; iv[Math.min(c, e) * N + Math.max(c, e)] += pb; } } }
  for (let p = 0; p < N * N; p++) if (pairN[p]) iv[p] += L2V; // 后验信息 = Fisher + 先验（L2）
  const se = x => (x > 0 ? 1 / Math.sqrt(x) : Infinity);
  // ---------- 三张候选 ----------
  const good = new Uint8Array(N * N), adj = Array.from({ length: N }, () => []);
  for (let a = 0; a < N; a++) for (let c = a + 1; c < N; c++) { const p = a * N + c; if (pairN[p] >= PAIR_N && v[p] > 0 && v[p] / se(iv[p]) >= EDGE_Z) { good[p] = 1; adj[a].push(c); adj[c].push(a); } }
  const cand = new Set(); // 三张键 a·N²+b·N+c（a<b<c）；从共享顶点出发的两条合格边 = 至少两条边合格
  for (let a = 0; a < N; a++) { const nbr = adj[a]; for (let i = 0; i < nbr.length; i++) for (let j = i + 1; j < nbr.length; j++) { const t = [a, nbr[i], nbr[j]].sort((x, y) => x - y); cand.add((t[0] * N + t[1]) * N + t[2]); } }
  const tri = [...cand].map(k => [Math.floor(k / (N * N)), Math.floor(k / N) % N, k % N]);
  const head = new Int32Array(N * N).fill(-1), nxt = new Int32Array(tri.length); // 按前两张建链表：每副牌只查 66 对
  tri.forEach(([a, b2], k) => { nxt[k] = head[a * N + b2]; head[a * N + b2] = k; });
  const mark = new Uint8Array(N), scan = (g, f) => { const o = g * REC; for (let h = 0; h < 2; h++) { const dk = Array.from(all.subarray(o + OFF[h], o + OFF[h] + 12)).sort((x, y) => x - y);
    for (const c of dk) mark[c] = 1; for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) for (let k = head[dk[i] * N + dk[j]]; k >= 0; k = nxt[k]) if (mark[tri[k][2]]) f(k, h); for (const c of dk) mark[c] = 0; } };
  const triN = new Float64Array(tri.length); if (tri.length) for (let g = 0; g < G; g++) scan(g, k => triN[k]++);
  const keep = new Int32Array(tri.length).fill(-1), kept = []; tri.forEach((t, k) => { if (triN[k] >= TRI_N) { keep[k] = kept.length; kept.push(k); } });
  const tS = new Uint32Array(G + 1), tL = []; // 每局出现的三张：下标·2 + 哪一边
  for (let g = 0; g < G; g++) { tS[g] = tL.length; if (kept.length) scan(g, (k, h) => { if (keep[k] >= 0) tL.push(keep[k] * 2 + h); }); } tS[G] = tL.length;
  const tv = new Float64Array(kept.length), gt = new Float64Array(kept.length).fill(1e-8), it = new Float64Array(kept.length);
  const zT = g => { let s = zp[g]; for (let x = tS[g]; x < tS[g + 1]; x++) s += SG[tL[x] & 1] * tv[tL[x] >> 1]; return s; };
  for (let e = 0; e < 3; e++) for (const g of train) { const lr = LR / (1 + e); if (tS[g] === tS[g + 1]) continue; const err = sig(zT(g)) - Y(g);
    for (let x = tS[g]; x < tS[g + 1]; x++) { const k = tL[x] >> 1, gr = SG[tL[x] & 1] * err + L2T * tv[k] / triN[kept[k]]; gt[k] += gr * gr; tv[k] -= lr * gr / Math.sqrt(gt[k]); } }
  for (const g of train) { const p = sig(zT(g)); for (let x = tS[g]; x < tS[g + 1]; x++) it[tL[x] >> 1] += p * (1 - p); } it.forEach((_, k) => (it[k] += L2T));
  const Lt = bce(zT);
  // ---------- 输出 ----------
  const wbar = (() => { let a = 0, n = 0; for (let i = 0; i < N; i++) { a += w[i] * inDeck[i]; n += inDeck[i]; } return a / n; })(); // 以平均每张牌为零点
  const ffac = cs => cs.map(fac).find(f => f !== 'n') ?? 'n';
  const singles = ids.map((id, i) => { const c = C(i) ?? {}, s = beta[T[i]] + gam[i], sw = se(iw[i]), sg2 = se(ig[i]);
    return { id, name: name(i), faction: fac(i), kind: c.kind, cost: c.cost, str: c.str, boss: c.boss ? 1 : 0, prize: c.prize ? 1 : 0, pp: pp(w[i] - wbar), se: r2(25 * sw), z: r2((w[i] - wbar) / sw), games: inDeck[i],
      slope_pp: hasJ && ig[i] > 0 ? r2(25 * s) : '', slope_se: hasJ && ig[i] > 0 ? r2(25 * sg2) : '', play_delta: playCnt[i] ? r2(playSum[i] / playCnt[i]) : '' }; }).filter(x => x.games > 0).sort((a, b) => b.pp - a.pp);
  const pairs = []; for (let a = 0; a < N; a++) for (let c = a + 1; c < N; c++) { const p = a * N + c; if (pairN[p] < PAIR_N) continue; const s2 = se(iv[p]);
    pairs.push({ a: ids[a], b: ids[c], name_a: name(a), name_b: name(c), faction: ffac([a, c]), pp: pp(v[p]), se: r2(25 * s2), z: r2(v[p] / s2), games: pairN[p] }); }
  pairs.sort((x, y) => y.pp - x.pp);
  const triples = kept.map((k, j) => { const [a, b2, c] = tri[k], vs = v[a * N + b2] + v[a * N + c] + v[b2 * N + c], s2 = se(it[j]);
    return { a: ids[a], b: ids[b2], c: ids[c], name_a: name(a), name_b: name(b2), name_c: name(c), faction: ffac([a, b2, c]), pp: pp(tv[j]), se: r2(25 * s2), z: r2(tv[j] / s2), games: triN[k],
      pair_sum_pp: pp(vs), total_pp: pp(w[a] + w[b2] + w[c] - 3 * wbar + vs + tv[j]) }; }).sort((x, y) => y.pp - x.pp);
  const rate = ([a, n]) => (n ? +(100 * a / n).toFixed(1) : null);
  mkdirSync(outDir, { recursive: true });
  const H = (o, k) => o[k] ? Object.keys(o[k]) : [];
  csv(`${outDir}/singles.csv`, 'id,name,faction,kind,cost,str,boss,prize,pp,se,z,games,slope_pp,slope_se,play_delta'.split(','), singles);
  csv(`${outDir}/pairs.csv`, 'a,b,name_a,name_b,faction,pp,se,z,games'.split(','), pairs);
  csv(`${outDir}/triples.csv`, 'a,b,c,name_a,name_b,name_c,faction,pp,se,z,games,pair_sum_pp,total_pp'.split(','), triples);
  csv(`${outDir}/factions.csv`, ['faction', 'name', 'win', 'games'], Object.entries(fw).map(([f, x]) => ({ faction: f, name: FACTIONS[f]?.name ?? (f === 'n' ? '纯中立' : f), win: rate(x), games: x[1] })).sort((a, b) => b.win - a.win));
  csv(`${outDir}/matrix.csv`, ['faction', 'vs', 'win', 'games'], Object.entries(fm).map(([k, x]) => { const [f, vs] = k.split('>'); return { faction: f, vs, win: rate(x), games: x[1] }; }));
  csv(`${outDir}/neutral.csv`, ['k', 'win', 'decks'], nb.map((x, k) => ({ k, win: rate(x), decks: x[1] })));
  const summary = { games: G, rules, ai, jitter: hasJ, firstWin: rate([first, decided]), draws: rate([draws, G]), avgTurns: +(turns / G).toFixed(1),
    heldOut: { baseline: +baseline.toFixed(5), singles: +Ls.toFixed(5), pairs: +Lp.toFixed(5), triples: +Lt.toFixed(5) }, test: test.length,
    slopeTier: hasJ ? [...beta].map(x => r2(25 * x)) : null, nPairs: pairs.length, nTripleCand: tri.length, nTriples: triples.length, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 1));
  return { summary, singles, pairs, triples };
}

const show = ({ summary: s, singles, pairs, triples }) => {
  const h = s.heldOut; console.log(`${s.games} 局，规则 ${s.rules}，先手胜率 ${s.firstWin}%，平局 ${s.draws}%，${s.seconds} 秒`);
  console.log(`留出交叉熵：只先手 ${h.baseline} / +单卡 ${h.singles} / +配对 ${h.pairs} / +三张 ${h.triples}；配对 ${s.nPairs} 对，三张候选 ${s.nTripleCand}、入选 ${s.nTriples}；每点战力（按费用档）${s.slopeTier ? s.slopeTier.join(' / ') + ' 百分点' : '无抖动'}`);
  console.log('单卡前 8：' + singles.slice(0, 8).map(x => `${x.name} ${x.pp}(z${x.z})`).join('，'));
  console.log('单卡后 5：' + singles.slice(-5).reverse().map(x => `${x.name} ${x.pp}(z${x.z})`).join('，'));
  console.log('配对前 8：' + pairs.slice(0, 8).map(x => `${x.name_a}+${x.name_b} ${x.pp}(z${x.z})`).join('，'));
  console.log('三张前 8：' + triples.slice(0, 8).map(x => `${x.name_a}+${x.name_b}+${x.name_c} ${x.pp}(z${x.z}，合计 ${x.total_pp})`).join('，'));
};

function selftest() { // 假普查：40 张牌，已知 牌0 +0.5、牌1+牌2 +0.4、牌3+4+5 +0.6、每点战力 +0.3 logit
  const dir = new URL('../../out/lab/combo_fit_selftest', import.meta.url).pathname, ids = Object.keys(CARDS).filter(k => !CARDS[k].token && CARDS[k].kind === 'unit' && CARDS[k].str !== undefined).slice(0, 40), N = ids.length, G = 60000;
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, base = ids.map(() => (rnd() - .5) * .2);
  base[0] = .5; const all = new Uint32Array(G * REC), jit = new Int8Array(G * 24);
  const f = (dk, js) => { const has = new Set(dk); let s = 0; dk.forEach((c, i) => (s += base[c] + .3 * js[i])); if (has.has(1) && has.has(2)) s += .4; if (has.has(3) && has.has(4) && has.has(5)) s += .6; return s; };
  const deal = () => { const a = [...Array(N).keys()]; for (let i = 0; i < 12; i++) { const j = i + Math.floor(rnd() * (N - i)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, 12); };
  for (let g = 0; g < G; g++) { const d0 = deal(), e1 = deal();
    const dl = ids.map(() => Math.floor(rnd() * 3) - 1), j0 = d0.map(c => dl[c]), j1 = e1.map(c => dl[c]), z = .1 + f(d0, j0) - f(e1, j1), o = g * REC;
    d0.forEach((c, i) => { all[o + i] = c; jit[g * 24 + i] = j0[i]; }); e1.forEach((c, i) => { all[o + 12 + i] = c; jit[g * 24 + 12 + i] = j1[i]; });
    all[o + 24] = rnd() < .01 ? 2 : rnd() < sig(z) ? 0 : 1; all[o + 25] = 20; all[o + 26] = g; }
  mkdirSync(dir + '/a', { recursive: true }); mkdirSync(dir + '/b', { recursive: true });
  writeFileSync(dir + '/a/games.bin', all); writeFileSync(dir + '/a/jitter.bin', jit);
  const meta = { games: G, rules: 'fake', ai: 'fake', jitter: true, ids, playSum: ids.map(() => 0), playCnt: ids.map(() => 0) };
  writeFileSync(dir + '/a/meta.json', JSON.stringify(meta)); writeFileSync(dir + '/b/games.bin', all.subarray(0, REC * 10)); writeFileSync(dir + '/b/meta.json', JSON.stringify({ ...meta, rules: 'other' }));
  assert.throws(() => load([dir + '/a', dir + '/b']), /规则版本不一致/);
  const r = fitAll(load([dir + '/a']), dir + '/out'); show(r);
  assert.equal(r.singles[0].id, ids[0], '牌0 应该排第一'); assert.ok(r.singles[0].z > 5);
  assert.ok(r.pairs.findIndex(p => p.a === ids[1] && p.b === ids[2]) < 3 && r.pairs[0].pp > 0, '配对 1+2 应该在前 3');
  const ti = r.triples.findIndex(t => t.a === ids[3] && t.b === ids[4] && t.c === ids[5]); assert.ok(ti >= 0 && ti < 3 && r.triples[ti].pp > 0 && r.triples[ti].total_pp > 10, `三张 3+4+5 应该在前 3（${ti}）`);
  const h = r.summary.heldOut; assert.ok(h.singles < h.baseline && h.triples < h.pairs, '留出交叉熵：单卡应好于只先手、三张应好于配对'); // 假数据只有 1 对真配对、780 个配对参数，配对项在留出上略差是正常的噪声
  assert.ok(r.summary.slopeTier.some(x => x > 4) && r.singles.every(x => x.slope_pp === '' || Math.abs(x.slope_pp - 7.5) < 5), '斜率应该接近 7.5 百分点');
  const head = readFileSync(dir + '/out/singles.csv', 'utf8').split('\n')[0]; assert.equal(head, 'id,name,faction,kind,cost,str,boss,prize,pp,se,z,games,slope_pp,slope_se,play_delta');
  assert.equal(q('a,"b'), '"a,""b"');
  console.log('自检通过');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--selftest') selftest();
  else { const [out, ...dirs] = process.argv.slice(2); if (!out || !dirs.length) { console.error('用法：node tools/lab/combo_fit.mjs <输出目录> <普查目录…>'); process.exit(1); } show(fitAll(load(dirs), out)); }
}
