// TD(λ) 训练局面价值网络 + 老师（搜索）目标。数据是 selfplay.mjs 的 pos.bin + pos_gid.bin（可给多个目录 = 回放缓冲），老师数据是 teacher.mjs 的 search.bin。
// 用法：node tools/lab/train2.mjs <输出权重.json> <轮数> --pos <目录1,目录2,…> [--from 旧权重.json] [--target 目标网络.json] [--lambda 0.7]
//         [--search <search.bin,…>] [--search-weight 1] [--lr 1e-3] [--hidden 64,32] [--stage1 1] [--report out.json]
//       node tools/lab/train2.mjs --selftest
// pos.bin 每条 L+3 个 int16：encode(s, me) + [结果 1 赢/0 输/2 平, 回合计数, me]；pos_gid.bin 每条一个 uint32（局在 games.bin 的行号）。
// λ 回报：(目录, gid, me) 串成一条序列（文件顺序 = 回合顺序），从后往前 G_last = z，G_t = (1−λ)·V(s_{t+1}) + λ·G_{t+1}，V = 目标网络的 sigmoid。
// 目标网络用"两段式"：给了 --target，开训前用它算一次 λ 回报，之后不变；没给，先用 z 训 --stage1 轮，再用刚训出的网络算一次 λ 回报（只算这一次），训完剩下的轮数。
// 老师数据 search.bin 每条 L+1 个 int16，最后一个是 round(Q×10000)，软标签交叉熵，权重 --search-weight。
// 考卷：按局（目录 + gid 的哈希）留 3%，同一局所有记录同进同出；老师数据按条留 3%。数据整块放在一个 Int16Array 里，不建每条的 JS 对象。
import { readFileSync, writeFileSync, statSync, mkdirSync, openSync, readSync, closeSync, realpathSync, writeSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { L, KEYS, initNet, scratch, forward, backward, clear, toJSON, fromJSON, encode } from './net.mjs';
import { lcg } from './play.mjs';

export const R = L + 3, RS = L + 1;
const sig = z => 1 / (1 + Math.exp(-z)), clip = p => Math.min(1 - 1e-7, Math.max(1e-7, p)), bce = (y, p) => -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
// 文件直接读进大数组的第 at 个元素处：不经过 readFileSync（它超过 2 GiB 就报错，还要多占一份内存）
const readInto = (f, arr, at, bytes) => { const u = new Uint8Array(arr.buffer, arr.byteOffset + at * arr.BYTES_PER_ELEMENT, bytes), fd = openSync(f, 'r'); let o = 0;
  try { for (let k; o < bytes && (k = readSync(fd, u, o, Math.min(1 << 30, bytes - o), null)) > 0;) o += k; } finally { closeSync(fd); }
  if (o !== bytes) throw new Error(`${f} 只读到 ${o}/${bytes} 字节`); };
// 目录的身份 = 真实路径的哈希：考卷划分不随 --pos 里目录的先后变（上一轮的目录这一轮排第二，考卷还是同一批局，不会混进上一代训过的局）
export const dirKey = d => { let h = 0x811c9dc5; for (const ch of realpathSync(d)) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return h >>> 0; };

// 串序列：nxt[i] = 同一局同一方的下一条记录，没有就 −1（nxt[i] 总在 i 后面）
export function linkNext(dir, gid, me) { const n = gid.length, nxt = new Int32Array(n).fill(-1), last = new Map();
  for (let i = 0; i < n; i++) { const k = (dir[i] * 4294967296 + gid[i]) * 2 + me[i], j = last.get(k); if (j !== undefined) nxt[j] = i; last.set(k, i); } return nxt; }
// λ 回报，从后往前一遍
export function lambdaReturns(nxt, z, V, lam, G = new Float32Array(z.length)) {
  for (let i = z.length - 1; i >= 0; i--) { const j = nxt[i]; G[i] = j < 0 ? z[i] : (1 - lam) * V[j] + lam * G[j]; } return G; }
// 这一局进不进考卷（约 3%）：目录身份（dirKey）+ gid 的哈希
export const heldOut = (d, g) => { let h = Math.imul(g ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(d + 1, 0xc2b2ae35); h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 16; return (h >>> 0) % 100 < 3; };

export function loadPos(dirs) {
  const cnt = dirs.map(d => { const b = statSync(`${d}/pos.bin`).size, g = statSync(`${d}/pos_gid.bin`).size;
    if (b % (2 * R)) throw new Error(`${d}/pos.bin 大小 ${b} 不是 ${2 * R} 的倍数（每条 L+3=${R} 个 int16）`);
    if (g !== b / 2 / R * 4) throw new Error(`${d}：pos.bin ${b / 2 / R} 条，pos_gid.bin ${g / 4} 条，对不上`); return b / 2 / R; });
  const n = cnt.reduce((a, b) => a + b, 0), data = new Int16Array(n * R), gid = new Uint32Array(n), dir = new Uint16Array(n);
  let o = 0; dirs.forEach((d, k) => { readInto(`${d}/pos.bin`, data, o * R, cnt[k] * R * 2); readInto(`${d}/pos_gid.bin`, gid, o, cnt[k] * 4); dir.fill(k, o, o + cnt[k]); o += cnt[k]; });
  return { n, data, gid, dir, keys: Uint32Array.from(dirs, dirKey) };
}
function loadSearch(files) {
  const cnt = files.map(f => { const b = statSync(f).size; if (b % (2 * RS)) throw new Error(`${f} 大小 ${b} 不是 ${2 * RS} 的倍数`); return b / 2 / RS; });
  const n = cnt.reduce((a, b) => a + b, 0), data = new Int16Array(n * RS); let o = 0;
  files.forEach((f, k) => { readInto(f, data, o * RS, cnt[k] * RS * 2); o += cnt[k]; }); return { n, data };
}

function main(args) {
  const opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const posDirs = (opt('--pos') ?? '').split(',').filter(Boolean), from = opt('--from'), targetFile = opt('--target'), LAM = +(opt('--lambda') ?? .7),
    sFiles = (opt('--search') ?? '').split(',').filter(Boolean), SW = +(opt('--search-weight') ?? 1), LR = +(opt('--lr') ?? 1e-3),
    HID = (opt('--hidden') ?? '64,32').split(',').map(Number), STAGE1 = +(opt('--stage1') ?? 1), reportFile = opt('--report'), [outFile, epochs] = args;
  if (!outFile || !(+epochs > 0) || !posDirs.length) throw new Error('用法：node tools/lab/train2.mjs <输出权重.json> <轮数> --pos <目录,…> [...]');
  const target = targetFile ? fromJSON(readFileSync(targetFile, 'utf8')) : null; // 牌表不一致时 fromJSON 抛错退出
  const t0 = Date.now(), sec = () => +((Date.now() - t0) / 1000).toFixed(1);
  const { n: P, data, gid, dir, keys } = loadPos(posDirs), S = sFiles.length ? loadSearch(sFiles) : { n: 0, data: new Int16Array(0) };
  const z = new Float32Array(P), me = new Uint8Array(P), test = new Uint8Array(P), games = new Set();
  for (let i = 0; i < P; i++) { const y = data[i * R + L]; z[i] = y === 2 ? .5 : y; me[i] = data[i * R + L + 2]; test[i] = heldOut(keys[dir[i]], gid[i]); games.add(dir[i] * 4294967296 + gid[i]); }
  const nxt = linkNext(dir, gid, me);
  const rnd = lcg(12345), posTest = [], train = [];
  for (let i = 0; i < P; i++) (test[i] ? posTest : train).push(i);
  const sTest = []; for (let i = 0; i < S.n; i++) (rnd() < .03 ? sTest : train).push(P + i); // 老师数据按条留考卷
  const trainIdx = Uint32Array.from(train); train.length = 0;
  const net = from ? fromJSON(readFileSync(from, 'utf8')) : initNet(lcg(7), ...HID), w = scratch(net);
  const posE = i => data.subarray(i * R, i * R + L), sE = i => S.data.subarray(i * RS, i * RS + L), sQ = i => S.data[i * RS + L] / 10000;
  const prob = (nt, e) => { const p = sig(forward(nt, e, w)); clear(w); return p; };
  // 目标：先是 z；算 λ 回报时整份数据前向一遍
  let G = Float32Array.from(z), tgtTag = 'z';
  const relabel = (nt, tag) => { const ts = Date.now(), V = new Float32Array(P), ws = scratch(nt); for (let i = 0; i < P; i++) { V[i] = sig(forward(nt, posE(i), ws)); clear(ws); }
    G = lambdaReturns(nxt, z, V, LAM); tgtTag = tag; console.log(`用${tag}算 λ=${LAM} 回报：${((Date.now() - ts) / 1000).toFixed(1)} 秒`); };
  if (target) relabel(target, '目标网络');
  const zero = () => Object.fromEntries(KEYS.map(k => [k, new Float32Array(net[k].length)]));
  const Gr = zero(), M = zero(), Vv = zero(), B = 256, b1 = .9, b2 = .999, eps = 1e-8, wd = 1e-5; let step = 0;
  function evalSets() { let lo = 0, lt = 0, hit = 0, nn = 0, ls = 0;
    for (const i of posTest) { const p = clip(prob(net, posE(i))); lo += bce(z[i], p); lt += bce(G[i], p); if (z[i] !== .5) { hit += (p > .5) === (z[i] === 1) ? 1 : 0; nn++; } }
    for (const a of sTest) { const i = a - P; ls += bce(sQ(i), clip(prob(net, sE(i)))); }
    const m = posTest.length, f = x => +x.toFixed(5); return { testBceOutcome: m ? f(lo / m) : null, testAcc: nn ? f(hit / nn) : null, testBceTarget: m ? f(lt / m) : null, testBceSearch: sTest.length ? f(ls / sTest.length) : null }; }
  const zm = posTest.reduce((a, i) => a + z[i], 0) / (posTest.length || 1), base = posTest.length ? bce(zm, zm) : NaN;
  console.log(`${P} 条局面（${games.size} 局），老师 ${S.n} 条；训练 ${trainIdx.length}，考卷 ${posTest.length} 条局面 + ${sTest.length} 条老师；只猜平均数的误差 ${base.toFixed(4)}`);
  const rep = { records: P, games: games.size, search: S.n, epochs: [], lambda: LAM, from, target: targetFile, mode: target ? 'target' : 'two-stage', stage1: target ? 0 : STAGE1 };
  for (let ep = 0; ep < +epochs; ep++) {
    if (!target && ep === STAGE1) relabel(net, '刚训出的网络');
    const te = Date.now();
    for (let i = trainIdx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)), t = trainIdx[i]; trainIdx[i] = trainIdx[j]; trainIdx[j] = t; }
    for (let s0 = 0; s0 < trainIdx.length; s0 += B) {
      const end = Math.min(trainIdx.length, s0 + B);
      for (let a = s0; a < end; a++) { const i = trainIdx[a];
        if (i < P) backward(net, w, Gr, sig(forward(net, posE(i), w)) - G[i]); else backward(net, w, Gr, SW * (sig(forward(net, sE(i - P), w)) - sQ(i - P))); clear(w); }
      step++; const n = end - s0, c1 = 1 - b1 ** step, c2 = 1 - b2 ** step;
      for (const k of KEYS) { const p = net[k], g = Gr[k], m = M[k], v = Vv[k];
        for (let j = 0; j < p.length; j++) { const gj = g[j] / n + wd * p[j]; if (gj === 0 && m[j] === 0) continue; m[j] = b1 * m[j] + (1 - b1) * gj; v[j] = b2 * v[j] + (1 - b2) * gj * gj; p[j] -= LR * (m[j] / c1) / (Math.sqrt(v[j] / c2) + eps); g[j] = 0; } }
    }
    const epSec = (Date.now() - te) / 1000, r = { ep: ep + 1, ...evalSets(), seconds: sec(), epochSeconds: +epSec.toFixed(1), secPerMillion: +(epSec / trainIdx.length * 1e6).toFixed(1), target: tgtTag };
    rep.epochs.push(r); writeFileSync(outFile, toJSON(net)); if (reportFile) writeFileSync(reportFile, JSON.stringify(rep, null, 1));
    console.log(`第 ${ep + 1} 轮（目标=${tgtTag}）：考卷对胜负误差 ${r.testBceOutcome}，猜对胜负 ${r.testAcc === null ? '-' : (100 * r.testAcc).toFixed(1) + '%'}，对 λ 目标误差 ${r.testBceTarget}，老师误差 ${r.testBceSearch ?? '-'}；这轮 ${epSec.toFixed(1)} 秒（每百万条 ${r.secPerMillion} 秒），共 ${r.seconds} 秒`);
  }
  console.log(`完成 → ${outFile}`);
}

// ---------- 自检 ----------
async function selftest() {
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  // 1. 三局假序列：A=(目录0,gid0) 两方交替 5 条；B=(目录0,gid1) 3 条；C=(目录1,gid0) 4 条，和 A 同 gid 不同目录，不能串到一起
  const dir = Uint16Array.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1]), gid = Uint32Array.from([0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0]),
    me = Uint8Array.from([0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0]);
  const nxt = linkNext(dir, gid, me);
  assert.deepEqual(Array.from(nxt), [3, 5, 6, 8, -1, 10, -1, 11, -1, 12, -1, -1, -1]);
  const zz = Float32Array.from([1, 0, .5, 1, .5, 0, .5, 1, 1, 0, 0, 1, 0]), rv = lcg(3), V = Float32Array.from(zz, () => rv());
  const G0 = lambdaReturns(nxt, zz, V, 0), G1 = lambdaReturns(nxt, zz, V, 1), Gh = lambdaReturns(nxt, zz, V, .5);
  for (let i = 0; i < zz.length; i++) { assert(close(G0[i], nxt[i] < 0 ? zz[i] : V[nxt[i]]), `λ=0 第 ${i} 条`); assert(close(G1[i], zz[i]), `λ=1 第 ${i} 条`); }
  assert(close(Gh[8], 1) && close(Gh[3], .5 * V[8] + .5) && close(Gh[0], .5 * V[3] + .5 * Gh[3]), 'λ=0.5 手算');
  // 2. 考卷按局：约 3%，同一 (目录, gid) 永远同进同出
  let k = 0; for (let g = 0; g < 20000; g++) k += heldOut(0, g) + heldOut(1, g); assert(k > 40000 * .02 && k < 40000 * .04, `考卷比例 ${k / 40000}`);
  assert(Array.from({ length: 2000 }, (_, g) => heldOut(0, g) !== heldOut(1, g)).some(Boolean), '不同目录同 gid 应该独立抽');
  // 3. 端到端：用 aiTurn 造两个目录各 20 局（按 selfplay 格式）+ 一份假老师数据，跑两段式、--target、错牌表
  const { newGame, apply, aiTurn } = await import('../../chess.js'), { pickDeck, makeAI } = await import('./play.mjs');
  const T = fileURLToPath(new URL('../../out/lab/train2_selftest', import.meta.url)), ai = makeAI('beam2'); // out/ 不进 git
  const sRecs = [], gameOf = []; let total = 0;
  for (const [d, gidBase] of [[0, 0], [1, 7]]) {
    const recs = [], gids = []; mkdirSync(`${T}/d${d}`, { recursive: true });
    for (let g = 0; g < 20; g++) { const rnd = lcg(1000 * d + g + 1); let s = newGame([pickDeck(rnd), pickDeck(rnd)], rnd); const mine = [];
      while (s.winner === null && s.n <= 70) { const m = s.turn; for (const x of aiTurn(s, { ...ai, rnd })) s = apply(s, x).state; if (s.winner === null) mine.push([encode(s, m), m, s.n]); }
      const res = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : -1;
      for (const [e, m, n] of mine) { const r = new Int16Array(R); r.set(e); r[L] = res < 0 ? 2 : res === m ? 1 : 0; r[L + 1] = n; r[L + 2] = m; recs.push(r); gids.push(gidBase + g * 2);
        if (sRecs.length < 300 && rnd() < .5) { const q = new Int16Array(RS); q.set(e); q[L] = Math.round(rnd() * 10000); sRecs.push(q); } } }
    const out = new Int16Array(recs.length * R); recs.forEach((r, i) => out.set(r, i * R));
    writeFileSync(`${T}/d${d}/pos.bin`, out); writeFileSync(`${T}/d${d}/pos_gid.bin`, Uint32Array.from(gids)); total += recs.length; gids.forEach(g => gameOf.push(d * 1e6 + g));
  }
  const so = new Int16Array(sRecs.length * RS); sRecs.forEach((r, i) => so.set(r, i * RS)); writeFileSync(`${T}/search.bin`, so);
  // 考卷划分在真实格式数据上无重叠
  const { dir: ld, gid: lg, n: ln, keys: lk } = loadPos([`${T}/d0`, `${T}/d1`]); assert.equal(ln, total);
  const inTest = new Map(); for (let i = 0; i < ln; i++) { const key = ld[i] * 4294967296 + lg[i], t = heldOut(lk[ld[i]], lg[i]); assert(!inTest.has(key) || inTest.get(key) === t, '同一局跨了训练和考卷'); inTest.set(key, t); }
  const me2 = new Uint8Array(ln); { const { data } = loadPos([`${T}/d0`, `${T}/d1`]); for (let i = 0; i < ln; i++) me2[i] = data[i * R + L + 2]; }
  const nx2 = linkNext(ld, lg, me2); for (let i = 0; i < ln; i++) if (nx2[i] >= 0) assert(nx2[i] > i && ld[nx2[i]] === ld[i] && lg[nx2[i]] === lg[i] && me2[nx2[i]] === me2[i], '序列串错');
  // 目录换个先后（回放缓冲里上一轮的目录这轮排第二），每局进不进考卷不变
  { const sw = loadPos([`${T}/d1`, `${T}/d0`]), a = new Map(), b = new Map(); for (let i = 0; i < ln; i++) a.set(`${lk[ld[i]]}:${lg[i]}`, heldOut(lk[ld[i]], lg[i]));
    for (let i = 0; i < sw.n; i++) b.set(`${sw.keys[sw.dir[i]]}:${sw.gid[i]}`, heldOut(sw.keys[sw.dir[i]], sw.gid[i])); assert.deepEqual([...b].sort(), [...a].sort(), '目录先后变了考卷就变'); }
  // 超过 2 GiB 的 pos.bin 也能读（稀疏文件，不占磁盘）
  { const big = `${T}/big`, nb = Math.ceil(2 ** 31 / (2 * R)) + 5; mkdirSync(big, { recursive: true });
    const fp = openSync(`${big}/pos.bin`, 'w'); writeSync(fp, Int16Array.of(7), 0, 2, nb * R * 2 - 2); closeSync(fp); const fg = openSync(`${big}/pos_gid.bin`, 'w'); writeSync(fg, Uint32Array.of(9), 0, 4, nb * 4 - 4); closeSync(fg);
    const b = loadPos([big]); assert(b.n === nb && b.data[nb * R - 1] === 7 && b.gid[nb - 1] === 9 && b.data[0] === 0, '大文件读错'); rmSync(big, { recursive: true, force: true }); }
  const self = fileURLToPath(import.meta.url), run = a => spawnSync(process.execPath, [self, ...a], { encoding: 'utf8' });
  let r = run([`${T}/w.json`, '2', '--pos', `${T}/d0,${T}/d1`, '--search', `${T}/search.bin`, '--stage1', '1', '--report', `${T}/rep.json`]);
  assert.equal(r.status, 0, r.stderr); const rep = JSON.parse(readFileSync(`${T}/rep.json`, 'utf8'));
  assert.equal(rep.records, total); assert.equal(rep.games, 40); assert.equal(rep.search, sRecs.length); assert.equal(rep.epochs.length, 2); assert.equal(rep.mode, 'two-stage');
  assert.equal(rep.epochs[0].target, 'z'); assert.equal(rep.epochs[1].target, '刚训出的网络'); for (const e of rep.epochs) assert(Number.isFinite(e.testBceSearch) && e.seconds >= 0);
  fromJSON(readFileSync(`${T}/w.json`, 'utf8'));
  r = run([`${T}/w2.json`, '1', '--pos', `${T}/d0,${T}/d1`, '--from', `${T}/w.json`, '--target', `${T}/w.json`, '--lambda', '0.5', '--report', `${T}/rep2.json`]);
  assert.equal(r.status, 0, r.stderr); const rep2 = JSON.parse(readFileSync(`${T}/rep2.json`, 'utf8')); assert(rep2.mode === 'target' && rep2.epochs[0].target === '目标网络' && rep2.lambda === .5);
  const bad = JSON.parse(readFileSync(`${T}/w.json`, 'utf8')); bad.cards = [...bad.cards].reverse(); writeFileSync(`${T}/bad.json`, JSON.stringify(bad));
  r = run([`${T}/w3.json`, '1', '--pos', `${T}/d0`, '--target', `${T}/bad.json`]); assert.notEqual(r.status, 0); assert(/另一套牌/.test(r.stderr), '错牌表要报错');
  console.log(`${total} 条局面、${sRecs.length} 条老师数据；两段式 2 轮、--target 1 轮、错牌表报错都对`);
  console.log(rep.epochs.map(e => `第 ${e.ep} 轮 目标=${e.target} 胜负误差 ${e.testBceOutcome} 老师误差 ${e.testBceSearch}`).join('；'));
  console.log('自检通过');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) await selftest(); else main(args);
}
