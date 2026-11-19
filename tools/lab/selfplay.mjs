// 自我对打：一份对局同时当"普查数据"（games.bin/jitter.bin/meta.json，和 census.mjs 同格式）和"网络训练数据"（pos.bin/pos_gid.bin）。
// 用法：node tools/lab/selfplay.mjs <电脑> <局数> <线程数> <输出目录> [--jitter 1] [--pos-games N] [--presets 0.25] [--seed-base 1]
//       node tools/lab/selfplay.mjs --selftest
// 卡组：每副牌以 --presets 的概率用预设（DECKS），其余 randomDeck；--presets 0 时卡组、种子和 census.mjs 完全一样（replay.mjs 能重放）。
// 抖动：同 census.mjs（每局两副牌里每张棋子战力 −1/0/+1，不低于 1，两边同一张牌一样，局后还原）。
// pos.bin：每当一方结束回合且局没结束记一条，L+3 个 int16 = encode(s, me) + [结果 1 me 赢/0 输/2 平, s.n, me]；只记前 --pos-games 局。
// pos_gid.bin：每条一个 uint32 = 这局在 games.bin 里的行号（主线程写文件时分配）；同一局的记录连续、按回合顺序。
// --v2：再写 ext.bin，每条 pos 记录配 24 个 int16 = encode2(s, me)（整副卡组 + 对面亮过的牌，第 2 代网络用）。
// --league a,b,c：联赛陪练，每局以 --league-share（默认 .5）的概率让随机一方换成名单里随机一个电脑；两边的局面都记
// --decks shaped：成型卡组——40% 预设、40% 预设换掉 1–4 张（同阵营或中立）、20% 随机；--deck-file <json>：再混进一批指定卡组（[[12 个 id], …]，占 --deck-share，默认 0.2）
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { CARDS, DECKS, EVAL, N, newGame, apply, aiTurn, evaluate } from '../../chess.js';
import { IDS, REC, randomDeck, POOL } from './census.mjs';
import { makeAI, lcg, farm } from './play.mjs';
import { encode, encode2, L, L2, CIX } from './net.mjs';
import { deckError } from '../../chess.js';

const IX = Object.fromEntries(IDS.map((k, i) => [k, i])), PR = L + 3;

if (!isMainThread && workerData?.selfplay) {
  const { ai: spec, jitter: jit, posGames, presets: P, base, v2, shaped, extra, share, league, lshare } = workerData, ai = makeAI(spec), foes = (league || []).map(makeAI);
  const mutate = (d0, f, k, rnd) => { for (let t = 0; t < 20; t++) { const d = [...d0], pool = [...POOL[f], ...POOL.n].filter(x => !d.includes(x));
    for (let i = 0; i < k; i++) d[Math.floor(rnd() * 12)] = pool.splice(Math.floor(rnd() * pool.length), 1)[0]; if (!deckError(d, IDS)) return d; } return [...d0]; };
  const deck = rnd => { if (extra?.length && rnd() < share) return [...extra[Math.floor(rnd() * extra.length)]];
    if (shaped) { const u = rnd(), p = DECKS[Math.floor(rnd() * DECKS.length)]; return u < .4 ? [...p.cards] : u < .8 ? mutate(p.cards, p.f, 1 + Math.floor(rnd() * 4), rnd) : randomDeck(rnd); }
    return P > 0 && rnd() < P ? [...DECKS[Math.floor(rnd() * DECKS.length)].cards] : randomDeck(rnd); }; // P=0 时不多抽随机数，和 census 一致
  parentPort.on('message', ({ from, n }) => {
    const jo = new Int8Array(n * 24), out = new Uint32Array(n * REC), sum = new Float64Array(IDS.length), cnt = new Uint32Array(IDS.length), recs = [], loc = [], exts = [];
    for (let g = 0; g < n; g++) {
      const seed = (base + from + g) * 2654435761 >>> 0, rnd = lcg(seed ^ 0x9e3779b9), d0 = deck(rnd), d1 = deck(rnd), keep = from + g < posGames;
      const dl = {}; if (jit) for (const k of new Set([...d0, ...d1])) { const c = CARDS[k]; if (c.kind === 'spell' || c.str === undefined) continue; let x = Math.floor(rnd() * 3) - 1; if (c.str + x < 1) x = 0; dl[k] = x; c.str += x; }
      const grnd = lcg(seed), mine = [], mx = []; let s = newGame([d0, d1], grnd), turns = 0;
      const fi = foes.length && rnd() < lshare ? Math.floor(rnd() * foes.length) : -1, fs = fi >= 0 && rnd() < .5 ? 1 : 0; // 不开联赛时不多抽随机数
      while (s.winner === null && s.n <= 70) {
        const me = s.turn;
        for (const x of aiTurn(s, { ...(fi >= 0 && me === fs ? foes[fi] : ai), rnd: grnd })) {
          if (x.type === 'play') { const id = s.hand[me][x.i], before = evaluate(s, me, EVAL); s = apply(s, x).state; // 同 census：评分涨幅截到 ±30
            sum[IX[id]] += Math.max(-30, Math.min(30, evaluate(s, me, EVAL) - before)); cnt[IX[id]]++; }
          else s = apply(s, x).state;
        }
        turns++;
        if (keep && s.winner === null) { const r = new Int16Array(PR); encode(s, me, r); r[L + 1] = s.n; r[L + 2] = me; mine.push(r); if (v2) mx.push(encode2(s, me)); }
      }
      const res = s.winner !== null ? s.winner : s.base[0] > s.base[1] ? 0 : s.base[1] > s.base[0] ? 1 : 2, o = g * REC;
      for (const r of mine) { r[L] = res === 2 ? 2 : res === r[L + 2] ? 1 : 0; recs.push(r); loc.push(g); } exts.push(...mx);
      for (const k in dl) CARDS[k].str -= dl[k]; [...d0, ...d1].forEach((k, i) => (jo[g * 24 + i] = dl[k] ?? 0));
      d0.forEach((k, i) => (out[o + i] = IX[k])); d1.forEach((k, i) => (out[o + 12 + i] = IX[k])); out[o + 24] = res; out[o + 25] = turns; out[o + 26] = seed;
    }
    const pos = new Int16Array(recs.length * PR); recs.forEach((r, i) => pos.set(r, i * PR));
    const lg = Uint32Array.from(loc), ext = new Int16Array(exts.length * L2); exts.forEach((r, i) => ext.set(r, i * L2));
    parentPort.postMessage({ out, sum, cnt, jo, pos, lg, ext }, [out.buffer, jo.buffer, pos.buffer, lg.buffer, ext.buffer]);
  });
}

export async function run(AI, G, W, dir, { jitter = false, posGames = G, presets = 0.25, seedBase = 1, quiet = false, chunk = 200, v2 = false, shaped = false, extra = null, share = .2, league = null, lshare = .5 } = {}) {
  mkdirSync(dir, { recursive: true });
  const fd = openSync(`${dir}/games.bin`, 'w'), fj = openSync(`${dir}/jitter.bin`, 'w'), fp = openSync(`${dir}/pos.bin`, 'w'), fg = openSync(`${dir}/pos_gid.bin`, 'w'), fx = v2 ? openSync(`${dir}/ext.bin`, 'w') : null;
  const sum = new Float64Array(IDS.length), cnt = new Float64Array(IDS.length), t0 = Date.now(), log = quiet ? () => {} : console.log;
  const rules = createHash('sha1').update(readFileSync(new URL('../../chess-cards.js', import.meta.url))).update(readFileSync(new URL('../../chess.js', import.meta.url))).update(readFileSync(new URL('../../chess-tune.js', import.meta.url))).digest('hex').slice(0, 12);
  let done = 0, posRecords = 0, shown = 0;
  const meta = () => writeFileSync(`${dir}/meta.json`, JSON.stringify({ games: done, rules, ai: AI, jitter, ids: IDS, playSum: [...sum], playCnt: [...cnt], seconds: (Date.now() - t0) / 1000, posRecords, posGames: Math.min(posGames, G), presets, seedBase, v2, decks: shaped ? 'shaped' : 'presets+random', extraDecks: extra?.length || 0, league, lshare }));
  await farm(new URL(import.meta.url), G, W, chunk, { selfplay: true, ai: AI, jitter, posGames, presets, base: seedBase, v2, shaped, extra, share, league, lshare }, r => {
    writeSync(fd, new Uint8Array(r.out.buffer)); writeSync(fj, new Uint8Array(r.jo.buffer));
    if (r.lg.length) { for (let i = 0; i < r.lg.length; i++) r.lg[i] += done; writeSync(fp, new Uint8Array(r.pos.buffer)); writeSync(fg, new Uint8Array(r.lg.buffer)); if (fx) writeSync(fx, new Uint8Array(r.ext.buffer)); posRecords += r.lg.length; }
    for (let k = 0; k < IDS.length; k++) { sum[k] += r.sum[k]; cnt[k] += r.cnt[k]; } done += r.out.length / REC;
    if (done - shown >= 20000) { shown = done; meta(); log(`${done}/${G} 局，${posRecords} 条局面，${((Date.now() - t0) / 1000).toFixed(0)} 秒`); }
  });
  [fd, fj, fp, fg, fx].filter(x => x !== null).forEach(closeSync); meta();
  const sec = (Date.now() - t0) / 1000;
  log(`完成 ${done} 局，${posRecords} 条局面，${sec.toFixed(1)} 秒（${(done / sec).toFixed(1)} 局/秒），规则版本 ${rules} → ${dir}`);
  return { games: done, posRecords, seconds: sec, rules };
}

async function selftest() {
  const dir = new URL('../../out/lab/_selfplay_selftest', import.meta.url).pathname, G = 40, PG = 30;
  rmSync(dir, { recursive: true, force: true });
  const r = await run('strong', G, 3, dir, { jitter: true, posGames: PG, presets: .25, quiet: true, chunk: 3 }); // 小块 + 3 线程：各块乱序到达，测 pos_gid 和 games.bin 行号对得上
  const rd = f => readFileSync(`${dir}/${f}`), gb = rd('games.bin'), games = new Uint32Array(gb.buffer, gb.byteOffset, gb.length / 4);
  const jit = new Int8Array(rd('jitter.bin')), pb = rd('pos.bin'), pos = new Int16Array(pb.buffer, pb.byteOffset, pb.length / 2), qb = rd('pos_gid.bin'), gid = new Uint32Array(qb.buffer, qb.byteOffset, qb.length / 4), meta = JSON.parse(rd('meta.json'));
  assert.equal(games.length, G * REC); assert.equal(jit.length, G * 24); assert.equal(pos.length, gid.length * PR); assert.equal(gid.length, r.posRecords);
  assert.equal(meta.games, G); assert.equal(meta.posRecords, gid.length); assert.equal(meta.posGames, PG); assert.equal(meta.ids.length, IDS.length);
  for (const k of ['games', 'rules', 'ai', 'jitter', 'ids', 'playSum', 'playCnt', 'seconds', 'posRecords', 'posGames', 'presets', 'seedBase']) assert.ok(k in meta, '缺字段 ' + k);
  const seen = new Set(); let prevG = 0, prevN = -1, prevMe = -1;
  for (let i = 0; i < gid.length; i++) {
    const g = gid[i], o = i * PR, me = pos[o + L + 2], y = pos[o + L], res = games[g * REC + 24];
    assert.ok(g < G && g >= prevG, 'pos_gid 要单调不减且 < 局数'); assert.ok(me === 0 || me === 1);
    if (g !== prevG || i === 0) { assert.ok(!seen.has(g), '同一局的记录要连续'); seen.add(g); prevN = -1; prevMe = -1; }
    assert.ok(pos[o + L + 1] > prevN, '同一局按回合顺序'); assert.notEqual(me, prevMe, '同一局两边交替记'); prevN = pos[o + L + 1]; prevMe = me; prevG = g;
    assert.equal(y, res === 2 ? 2 : res === me ? 1 : 0, '局面结果要和 games.bin 一致');
  }
  assert.equal(seen.size, PG, '只记前 --pos-games 局，且每局都有记录');
  // 行号对不对：每局第 k 条记录的回合计数是 k+2、条数 = 回合数−1（打满 70 回合可能多 1 条），前两条的手牌必须出自这一行的先手/后手牌
  const task = new Map(Array.from({ length: G }, (_, t) => [(1 + t) * 2654435761 >>> 0, t])); let moved = 0, k = 0;
  for (let g = 0; g < G; g++) { const t = task.get(games[g * REC + 26]); assert.ok(t !== undefined); moved += t !== g;
    const recs = []; while (k < gid.length && gid[k] === g) recs.push(k++); if (t >= PG) { assert.equal(recs.length, 0, '--pos-games 之外的局不该有记录'); continue; }
    const turns = games[g * REC + 25]; assert.ok(recs.length === turns - 1 || (turns === 70 && recs.length === 70), `第 ${g} 行：${recs.length} 条记录、${turns} 回合`);
    recs.forEach((i, j) => assert.equal(pos[i * PR + L + 1], j + 2, '回合计数要连续'));
    for (const [j, side] of [[0, 0], [1, 1]]) { if (j >= recs.length) continue; const own = new Set(Array.from(games.subarray(g * REC + side * 12, g * REC + side * 12 + 12), x => CIX[IDS[x]]));
      for (let h = 0; h < 4; h++) { const c = pos[recs[j] * PR + N * 6 + h]; assert.ok(c === 0 || own.has(c), `第 ${g} 行的手牌不在这一行的牌里：pos_gid 串行了`); } } }
  assert.equal(k, gid.length);
  // 先后手抽到的每张牌都在 IDS 里、结果合法、抖动只在 ±1
  for (let g = 0; g < G; g++) { const o = g * REC; for (let i = 0; i < 24; i++) assert.ok(games[o + i] < IDS.length); assert.ok(games[o + 24] <= 2); assert.ok(games[o + 25] >= 1); }
  assert.ok(jit.every(x => x >= -1 && x <= 1) && jit.some(x => x !== 0), '抖动要在 ±1 且确实抖了');
  // 同种子重跑结果一样（换线程数也一样）
  const dir2 = dir + '2'; await run('strong', 10, 1, dir2, { jitter: true, posGames: 10, presets: .25, quiet: true });
  const b2 = readFileSync(`${dir2}/games.bin`), g2 = new Uint32Array(b2.buffer, b2.byteOffset, b2.length / 4), byseed = new Map(); for (let g = 0; g < G; g++) byseed.set(games[g * REC + 26], games.subarray(g * REC, g * REC + REC).join());
  for (let g = 0; g < 10; g++) assert.equal(byseed.get(g2[g * REC + 26]), g2.subarray(g * REC, g * REC + REC).join(), '同种子要可复现');
  rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true });
  console.log(`${G} 局，${gid.length} 条局面，${moved} 局乱序落行，${r.seconds.toFixed(1)} 秒；自检通过`);
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  if (args.includes('--selftest')) await selftest();
  else {
    const jitter = opt('--jitter', '0') === '1', pg = opt('--pos-games', null), presets = +opt('--presets', '0.25'), seedBase = +opt('--seed-base', '1'), df = opt('--deck-file', null);
    const v2 = opt('--v2', '0') === '1', shaped = opt('--decks', '') === 'shaped', share = +opt('--deck-share', '0.2'), extra = df ? JSON.parse(readFileSync(df, 'utf8')) : null, lg = opt('--league', null), league = lg ? lg.split(',') : null, lshare = +opt('--league-share', '0.5');
    const [AI, G, W, dir] = args; if (!dir) { console.error('用法：node tools/lab/selfplay.mjs <电脑> <局数> <线程数> <输出目录> [--jitter 1] [--pos-games N] [--presets 0.25] [--seed-base 1]'); process.exit(2); }
    await run(AI, +G, +W, dir, { jitter, posGames: pg === null ? +G : +pg, presets, seedBase, v2, shaped, extra, share, league, lshare });
  }
}
