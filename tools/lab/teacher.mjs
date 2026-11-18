// 老师：大师电脑自我对打，按概率 p 挑一些回合做"加强搜索"——取最多 K 个整回合候选，每个候选抽 M 次对面手牌/牌序、
// 让对面电脑走完它的回合再用网络估值，得到 Q；把 (候选回合结束的局面, Q) 写下来给 train2.mjs 当老师目标。
// 注意：这个老师只在离线训练用。它在 determinize 时用了对面真实的 12 张牌表（只打乱手牌和牌序），不能当游戏里的电脑，也不参加强弱评比。
// 用法：node tools/lab/teacher.mjs <权重.json> <局数> <线程数> <输出目录> [--p 0.3] [--K 6] [--M 4] [--opp beam6|mix] [--act 1] [--seed-base 500001]
//       node tools/lab/teacher.mjs --selftest
// 输出：search.bin（每条 L+1 个 int16：encode(end, me) + round(Q×10000)；回合内已经分出胜负的候选不写，网络从来不估那种局面）、
//       teacher.json（老师回合数、候选平均数、"Q 最大的不是大师电脑原选"的比例、平均 Q 提升、每个老师回合耗时）
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newGame, apply, aiTurn } from '../../chess.js';
import { encode, L, fromJSON, toJSON, initNet, mixAI } from './net.mjs';
import { pickDeck, lcg, farm } from './play.mjs';
import { candidates, qValue } from './lookahead.mjs';

const R = L + 1;
if (!isMainThread) {
  const o = workerData, net = fromJSON(o.net), ai = mixAI(net, 20), opp = o.opp === 'mix' ? ai : { deep: true, beam: 6 };
  parentPort.on('message', ({ from, n }) => {
    const recs = [], st = { turns: 0, cands: 0, notOrig: 0, gain: 0, ms: 0, games: 0 };
    for (let g = 0; g < n; g++) {
      const seed = (o.base + from + g) * 2654435761 >>> 0, rnd = lcg(seed), dr = lcg(seed ^ 0x5bd1e995), tr = lcg(seed ^ 0x27d4eb2f);
      let s = newGame([pickDeck(dr), pickDeck(dr)], rnd);
      while (s.winner === null && s.n <= 70) { const me = s.turn; let acts;
        if (tr() < o.p) { const t = performance.now(), cs = candidates(s, net, o.K, ai), cr = tr() * 4294967296 >>> 0, q = cs.map(c => qValue(c.end, me, net, o.M, opp, lcg(cr))); // 各候选共用同一组抽样（同样的对面手牌），比较的是候选本身而不是运气；独立抽样时取最大会挑中噪声
          let b = 0; q.forEach((v, i) => { if (v > q[b]) b = i; });
          cs.forEach((c, i) => { if (c.end.winner !== null) return; const r = new Int16Array(R); encode(c.end, me, r); r[L] = Math.round(q[i] * 10000); recs.push(r); });
          st.turns++; st.cands += cs.length; st.notOrig += b ? 1 : 0; st.gain += q[b] - q[0]; st.ms += performance.now() - t;
          acts = cs[o.act ? b : 0].acts; }
        else acts = aiTurn(s, { ...ai, rnd });
        for (const x of acts) s = apply(s, x).state; }
      st.games++;
    }
    const out = new Int16Array(recs.length * R); recs.forEach((r, i) => out.set(r, i * R));
    parentPort.postMessage({ out, st }, [out.buffer]);
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  async function run(netText, G, W, dir, o) {
    mkdirSync(dir, { recursive: true }); const fd = openSync(join(dir, 'search.bin'), 'w'), t0 = Date.now(), S = { turns: 0, cands: 0, notOrig: 0, gain: 0, ms: 0, games: 0 }; let recs = 0, shown = 0;
    await farm(new URL(import.meta.url), G, W, 2, { net: netText, ...o }, r => { writeSync(fd, new Uint8Array(r.out.buffer)); recs += r.out.length / R; for (const k in S) S[k] += r.st[k];
      if (S.games - shown >= 200) { shown = S.games; console.log(`${S.games}/${G} 局，${recs} 条，${((Date.now() - t0) / 1000).toFixed(0)} 秒`); } });
    closeSync(fd);
    const rep = { games: S.games, records: recs, teacherTurns: S.turns, avgCandidates: S.cands / S.turns, notOrigFrac: S.notOrig / S.turns, avgQGain: S.gain / S.turns, msPerTeacherTurn: S.ms / S.turns, ...o, seconds: (Date.now() - t0) / 1000 };
    writeFileSync(join(dir, 'teacher.json'), JSON.stringify(rep, null, 1));
    console.log(`完成：${S.games} 局，老师回合 ${S.turns}，${recs} 条；平均 ${rep.avgCandidates.toFixed(2)} 个候选，Q 最大的不是原选 ${(100 * rep.notOrigFrac).toFixed(1)}%，平均 Q 提升 ${rep.avgQGain.toFixed(4)}，每个老师回合 ${rep.msPerTeacherTurn.toFixed(0)} 毫秒（${rep.seconds.toFixed(0)} 秒）→ ${dir}`);
    return rep;
  }
  if (args.includes('--selftest')) {
    const assert = (c, m) => { if (!c) throw new Error('自检失败：' + m); }, dir = join(tmpdir(), 'teacher-selftest-' + process.pid);
    const rep = await run(toJSON(initNet(lcg(7))), 4, 2, dir, { p: 1, K: 3, M: 2, opp: 'beam6', act: 1, base: 500001 });
    const n = statSync(join(dir, 'search.bin')).size / 2 / R, b = readFileSync(join(dir, 'search.bin')), a = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
    assert(Number.isInteger(n) && n === rep.records && n > 0, '条数不对'); assert(rep.games === 4 && rep.teacherTurns > 0, '局数/老师回合不对');
    for (let i = 0; i < n; i++) assert(a[i * R + L] >= 0 && a[i * R + L] <= 10000, 'Q 越界');
    assert(rep.avgCandidates >= 1 && rep.avgCandidates <= 3, '候选数越界'); rmSync(dir, { recursive: true });
    console.log('自检通过');
  } else {
    const p = +opt('--p', .3), K = +opt('--K', 6), M = +opt('--M', 4), opp = opt('--opp', 'mix'), act = +opt('--act', 1), base = +opt('--seed-base', 500001), [wf, G, W, dir] = args;
    if (!dir) { console.log('用法：node tools/lab/teacher.mjs <权重.json> <局数> <线程数> <输出目录> [--p 0.3] [--K 6] [--M 4] [--opp beam6|mix] [--act 1] [--seed-base 500001]'); process.exit(1); }
    if (opp !== 'mix' && opp !== 'beam6') throw new Error('--opp 只能是 mix 或 beam6');
    const txt = readFileSync(wf, 'utf8'); fromJSON(txt); // 牌表不对在这里就报错
    await run(txt, +G, +W, dir, { p, K, M, opp, act, base, weights: wf });
  }
}
