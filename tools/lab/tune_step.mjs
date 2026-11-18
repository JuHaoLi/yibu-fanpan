// 收敛循环的调牌一步：按普查拟合（combo_fit 的 singles.csv）和预设互打（preset_tune 的输出）改一轮棋子战力，写 chess-tune.js 的 TUNE。
// 只改单位/建筑里有战力、不是首领/奖励牌/衍生物、不在 config.lock 里的牌；本轮范围 band 逐轮收紧，超范围且显著（|pp|>band、|z|≥2）才改。
// 步长 Δ = −round(0.7·pp / max(斜率, 1))，限 ±2、至少 ±1；战力到 1 还要减的记"要改费用"。最近两次改动方向相反的牌歇一轮（防震荡）。
// 用法：node tools/lab/tune_step.mjs <fit目录> <presets.json> <state.json> <轮次> [--apply] [--config tools/lab/loop.config.json] [--tune-file chess-tune.js]
//   轮次从 1 起，本轮范围 = config.bands[min(轮次−1, 长度−1)] 个百分点
//   每次都写 <fit目录>/../tune.json（本轮结果，loop 汇总用）和 <fit目录>/../needs_design.csv（法术/首领/奖励牌、战力到底的：要改设计，不改数）
//   --apply：改 TUNE、更新 state 里每张牌的改动历史、往 state 同目录的 tune_history.csv 追加。同一轮重复 --apply 只把 TUNE 恢复成那一轮的结果，不会改两次
//   --selftest：假 fit 目录 + 临时 chess-tune.js 副本，验证挑牌、步长、防震荡、锁定、战力下限（不碰仓库里的 chess-tune.js）
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { CARDS, FACTIONS } from '../../chess.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// 小 CSV：支持双引号字段（"" 转义）
export function readCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else f += ch; }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [head, ...rest] = rows; return rest.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const line = a => a.map(esc).join(',') + '\n';
const readTune = text => JSON.parse(/export const TUNE = (.*);\n/.exec(text)[1]);
const writeTune = (text, T) => text.replace(/export const TUNE = .*;\n/, 'export const TUNE = ' + JSON.stringify(T) + ';\n');
const strOf = (id, T) => Math.max(1, Math.min(15, Math.round(CARDS[id].raw) + (T[id] || 0))); // 同 chess-cards.js 的 put
const piece = c => c && (c.kind === 'unit' || c.kind === 'structure') && c.str !== undefined && c.raw !== undefined;

// 纯计算：不读写文件。singles = singles.csv 的行；presets = preset_tune 的输出（可为 null）；state 会被复制，返回新的
export function plan({ singles, presets, state, round, cfg, tune }) {
  const band = cfg.bands[Math.min(round - 1, cfg.bands.length - 1)], lock = new Set(cfg.lock || []), max = cfg.maxChanges;
  const st = structuredClone(state || {}), hist = (st.cards ??= {}), T = { ...tune }, changes = [], skipped = [], needs = [];
  const rows = singles.map(r => ({ ...r, pp: +r.pp, z: +r.z, slope_pp: +r.slope_pp })).filter(r => CARDS[r.id] && Number.isFinite(r.pp));
  const tunable = id => { const c = CARDS[id]; return piece(c) && !c.boss && !c.prize && !c.token; };
  const sig = rows.filter(r => Math.abs(r.pp) > band && Math.abs(r.z) >= 2);
  for (const r of sig) { const c = CARDS[r.id];
    if (!tunable(r.id)) needs.push({ id: r.id, pp: r.pp, z: r.z, reason: c.kind === 'spell' ? '法术' : c.boss ? '首领' : c.prize ? '奖励牌' : '没有战力' }); }
  const cands = sig.filter(r => tunable(r.id) && !lock.has(r.id)).sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp));
  const outside = cands.length;
  const tryChange = (id, d, reason, r) => {
    if (changes.some(x => x.id === id) || skipped.some(x => x.id === id) || changes.length >= max) return;
    if (lock.has(id) || !tunable(id)) return;
    const h = hist[id] || [], moves = h.filter(x => x.delta), last = h.at(-1);
    if (moves.length >= 2 && Math.sign(moves.at(-1).delta) !== Math.sign(moves.at(-2).delta) && !last.osc) { // 歇过一轮就放开
      skipped.push({ id, reason: '震荡' }); (hist[id] = h).push({ round, delta: 0, osc: true }); return; }
    const old = strOf(id, T), nw = Math.max(1, Math.min(15, old + d));
    if (old + d < 1) needs.push({ id, pp: r?.pp ?? '', z: r?.z ?? '', reason: '战力到 1 了，要改费用' });
    if (nw === old) return;
    const t = nw - Math.round(CARDS[id].raw); if (t) T[id] = t; else delete T[id];
    changes.push({ id, old, nw, delta: nw - old, reason, pp: r?.pp ?? '', z: r?.z ?? '', slope_pp: r?.slope_pp ?? '' });
    (hist[id] = h).push({ round, delta: nw - old, reason, pp: r?.pp }); // pp：改之前的单卡分，下一轮拿来算实测斜率
  };
  for (const r of cands) { // 斜率取"拟合出的"和"上一轮实测的"（上次改了几点、单卡分跟着变了多少）里大的那个：低战力的牌改 1 点，实际影响常比拟合的大
    const m = (hist[r.id] || []).filter(x => x.delta && Number.isFinite(x.pp)).at(-1), emp = m && m.round === round - 1 ? Math.abs((r.pp - m.pp) / m.delta) : 0;
    const s = Math.max(Number.isFinite(r.slope_pp) ? r.slope_pp : 0, emp, 1), raw = -Math.round(0.7 * r.pp / s);
    const k = Math.min(2, Math.max(1, Math.abs(raw))), after = Math.abs(r.pp) - k * s; // 改完预计还剩多少（负的 = 越过中线）
    if (after < 0 && -after > .8 * Math.abs(r.pp)) { needs.push({ id: r.id, pp: r.pp, z: r.z, reason: `卡在两个战力之间（每点约 ${s.toFixed(1)}），要改费用或能力` }); continue; } // 改 1 点只会跑到中线另一边差不多远（或更远）：整数战力调不准，不改
    tryChange(r.id, Math.sign(-r.pp) * k, '单卡', r); }
  const lo = cfg.presetLo, hi = cfg.presetHi, outP = (presets?.rates || []).filter(p => p.rate < lo || p.rate > hi);
  for (const p of presets?.plan || []) if (outP.some(o => p.deck === o.name || p.deck.endsWith('·' + o.name))) tryChange(p.k, p.d, '预设 ' + p.deck, rows.find(r => r.id === p.k));
  const pps = rows.filter(r => tunable(r.id) && !lock.has(r.id)).map(r => r.pp), mean /* 只算能自动调的棋子：首领、法术不归这个循环管，算进去标准差永远降不下来 */ = pps.reduce((a, b) => a + b, 0) / (pps.length || 1);
  const ppStd = Math.sqrt(pps.reduce((a, b) => a + (b - mean) ** 2, 0) / (pps.length || 1));
  return { round, band, outside, ppStd, presetsOutside: outP.length, presetsOut: outP, changes, skipped, needs, tune: T, state: st };
}

export function main(argv) {
  const flag = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const pos = argv.filter((x, i) => !x.startsWith('--') && !['--config', '--tune-file'].includes(argv[i - 1]));
  const [fitDir, presetsPath, statePath, roundS] = pos, round = +roundS, apply = argv.includes('--apply');
  if (!fitDir || !statePath || !(round >= 1)) throw new Error('用法：tune_step.mjs <fit目录> <presets.json> <state.json> <轮次≥1> [--apply]');
  const cfg = JSON.parse(readFileSync(flag('--config') || join(ROOT, 'tools/lab/loop.config.json'), 'utf8'));
  const tuneFile = flag('--tune-file') || join(ROOT, 'chess-tune.js'), tuneText = readFileSync(tuneFile, 'utf8');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  if (apply && state.tuneAfter?.[round]) { // 这一轮已经改过：只恢复成那一轮的结果
    writeFileSync(tuneFile, writeTune(tuneText, state.tuneAfter[round])); console.log(`第 ${round} 轮已经改过，TUNE 恢复成那一轮的结果，不重复改`); return null; }
  const presets = presetsPath && existsSync(presetsPath) ? JSON.parse(readFileSync(presetsPath, 'utf8')) : null;
  const r = plan({ singles: readCSV(readFileSync(join(fitDir, 'singles.csv'), 'utf8')), presets, state, round, cfg: cfg, tune: readTune(tuneText) });
  const out = dirname(fitDir.replace(/\/+$/, '')), nm = id => CARDS[id].name, fa = id => CARDS[id].faction;
  writeFileSync(join(out, 'needs_design.csv'), line(['round', 'id', 'name', 'faction', 'kind', 'pp', 'z', 'reason']) + r.needs.map(x => line([round, x.id, nm(x.id), fa(x.id), CARDS[x.id].kind, x.pp, x.z, x.reason])).join(''));
  const { state: _s, tune: _t, ...res } = r; writeFileSync(join(out, 'tune.json'), JSON.stringify({ ...res, applied: apply }, null, 1));
  console.log(`第 ${round} 轮，范围 ±${r.band} 个百分点：超范围的棋子 ${r.outside} 张，单卡分标准差 ${r.ppStd.toFixed(2)}，预设超范围 ${r.presetsOutside} 套`);
  for (const c of r.changes) console.log(`  ${c.delta > 0 ? '加' : '减'} ${FACTIONS[fa(c.id)]?.name ?? fa(c.id)}·${nm(c.id)}（${c.id}）${c.old}→${c.nw}，${c.reason}，${c.pp === '' ? '' : `单卡分 ${c.pp.toFixed(1)}、z ${c.z.toFixed(1)}、每点 ${Number.isFinite(c.slope_pp) ? c.slope_pp.toFixed(1) : '?'}`}`);
  for (const s of r.skipped) console.log(`  跳过 ${nm(s.id)}（${s.id}）：${s.reason}`);
  if (r.needs.length) console.log(`  要改设计 ${r.needs.length} 张：${r.needs.map(x => `${nm(x.id)}(${x.reason})`).join('、')}`);
  if (!apply) { console.log(`共 ${r.changes.length} 张（没加 --apply，只打印）`); return r; }
  const st = r.state; (st.tuneAfter ??= {})[round] = r.tune;
  writeFileSync(statePath, JSON.stringify(st, null, 1)); // state 先写（带这一轮的 TUNE 快照），断了重跑能恢复
  writeFileSync(tuneFile, writeTune(tuneText, r.tune));
  const hf = join(dirname(statePath), 'tune_history.csv');
  if (!existsSync(hf)) writeFileSync(hf, line(['round', 'id', 'name', 'faction', 'old_str', 'new_str', 'delta', 'reason', 'pp', 'z', 'slope_pp', 'band']));
  appendFileSync(hf, r.changes.map(c => line([round, c.id, nm(c.id), fa(c.id), c.old, c.nw, c.delta, c.reason, c.pp, c.z, Number.isFinite(c.slope_pp) ? c.slope_pp : '', r.band])).join(''));
  console.log(`已写进 ${tuneFile}：${r.changes.length} 张`); return r;
}

function selftest() {
  const tmp = process.env.TMPDIR ? join(process.env.TMPDIR, 'tune_step_selftest_' + process.pid) : '/tmp/tune_step_selftest_' + process.pid;
  const realTune = readFileSync(join(ROOT, 'chess-tune.js'), 'utf8'), T0 = readTune(realTune);
  const ok = id => { const c = CARDS[id]; return piece(c) && !c.boss && !c.prize && !c.token; };
  const mid = Object.keys(CARDS).filter(id => ok(id) && CARDS[id].str >= 4 && CARDS[id].str <= 10 && id !== 'f2_mage4winds');
  const [A, B, C, D, E, G, H] = mid, ONE = Object.keys(CARDS).find(id => ok(id) && CARDS[id].str === 1);
  const SP = Object.keys(CARDS).find(id => CARDS[id].kind === 'spell' && !CARDS[id].token), BOSS = Object.keys(CARDS).find(id => CARDS[id].boss), LOCK = 'f2_mage4winds';
  const row = (id, pp, z, slope = 4) => ({ id, pp: String(pp), z: String(z), slope_pp: String(slope) });
  const singles = [row(A, 12, 5, 4), row(B, -6, 3, 5), row(C, 20, 6, 2), row(D, 6, 1.5), row(E, 4, 9), row(ONE, 10, 4, 3), row(G, 8, 3, 3), row(LOCK, 15, 5), row(SP, 9, 4), row(BOSS, -9, 4), row(H, 1, 1)];
  const cfg = { bands: [5, 4, 4, 3], maxChanges: 20, lock: [LOCK], presetLo: 40, presetHi: 60 };
  const st0 = { cards: { [G]: [{ round: 1, delta: 1 }, { round: 2, delta: -1 }] } };
  { // 粒度和实测斜率：pp 5、拟合斜率 12 → 改 1 点会越过中线更远，不改、记要改设计；上一轮改过 +1、单卡分从 -6 变到 +6.6 → 实测斜率 12.6，这轮 pp 6.6 也不改
    const g = plan({ singles: [row(A, 5, 4, 12), row(B, 6.6, 4, 5)], presets: null, state: { cards: { [B]: [{ round: 2, delta: 1, pp: -6 }] } }, round: 3, cfg, tune: { ...T0 } });
    assert.equal(g.changes.length, 0, '改 1 点会过头的不改'); assert.ok(g.needs.some(x => x.id === A) && g.needs.some(x => x.id === B), '记进要改设计'); }
  const presets = { rates: [{ name: 'X', rate: 70 }, { name: 'Y', rate: 50 }], plan: [{ k: A, d: -1, deck: '某阵营·X' }, { k: H, d: -1, deck: '某阵营·X' }, { k: E, d: 1, deck: '某阵营·Y' }] };
  const r = plan({ singles, presets, state: st0, round: 1, cfg, tune: T0 }), ch = Object.fromEntries(r.changes.map(c => [c.id, c]));
  const s = id => CARDS[id].str;
  assert.equal(r.band, 5);
  assert.equal(ch[A].delta, -2); assert.equal(ch[B].delta, 1); assert.equal(ch[C].delta, -2); // −round(8.4/4)=−2；−round(−0.84)=+1；−7 限到 −2
  assert.equal(ch[A].nw, s(A) - 2);
  assert.ok(!ch[D] && !ch[E], '不显著/没超范围的不改');
  assert.ok(!ch[LOCK] && !ch[SP] && !ch[BOSS], '锁定/法术/首领不改');
  assert.ok(!ch[ONE] && r.needs.some(x => x.id === ONE && /费用/.test(x.reason)), '战力 1 记要改费用');
  assert.ok(r.needs.some(x => x.id === SP) && r.needs.some(x => x.id === BOSS));
  assert.ok(!ch[G] && r.skipped.some(x => x.id === G && x.reason === '震荡'), '震荡跳过');
  assert.equal(ch[H].delta, -1); assert.ok(/预设/.test(ch[H].reason), '预设补牌'); assert.equal(r.changes.filter(c => c.id === A).length, 1, '已改的不重复');
  assert.equal(r.outside, 5); // A B C ONE G（锁定的不算）
  assert.equal(r.presetsOutside, 1);
  assert.deepEqual(r.changes.slice(0, 3).map(c => c.id), [C, A, B], '按超出量排序');
  const r2 = plan({ singles, presets: null, state: st0, round: 3, cfg: { ...cfg, maxChanges: 2 }, tune: T0 });
  assert.deepEqual(r2.changes.map(c => c.id), [C, A], '最多改 maxChanges 张'); assert.equal(r2.band, 4);
  const r3 = plan({ singles, presets: null, state: r.state, round: 2, cfg, tune: r.tune }); // 歇过一轮的放开
  assert.ok(r3.changes.some(c => c.id === G) && r3.changes.find(c => c.id === G).delta < 0);
  assert.equal(strOf(A, r.tune), s(A) - 2);
  for (const c of r.changes) assert.equal(strOf(c.id, r.tune), c.nw);
  // 完整走一遍 --apply（临时副本）
  mkdirSync(join(tmp, 'r01/fit'), { recursive: true });
  writeFileSync(join(tmp, 'r01/fit/singles.csv'), line(Object.keys(singles[0])) + singles.map(x => line(Object.values(x))).join(''));
  writeFileSync(join(tmp, 'r01/presets.json'), JSON.stringify(presets)); writeFileSync(join(tmp, 'cfg.json'), JSON.stringify(cfg));
  writeFileSync(join(tmp, 'state.json'), JSON.stringify(st0)); copyFileSync(join(ROOT, 'chess-tune.js'), join(tmp, 'chess-tune.js'));
  const args = [join(tmp, 'r01/fit'), join(tmp, 'r01/presets.json'), join(tmp, 'state.json'), '1', '--apply', '--config', join(tmp, 'cfg.json'), '--tune-file', join(tmp, 'chess-tune.js')];
  const log = console.log; console.log = () => {}; try { main(args); } finally { console.log = log; }
  const T1 = readTune(readFileSync(join(tmp, 'chess-tune.js'), 'utf8')), st1 = JSON.parse(readFileSync(join(tmp, 'state.json'), 'utf8'));
  assert.deepEqual(T1, r.tune); assert.equal(st1.cards[A].at(-1).delta, -2); assert.ok(st1.cards[G].at(-1).osc);
  const hist = readCSV(readFileSync(join(tmp, 'tune_history.csv'), 'utf8')); assert.equal(hist.length, r.changes.length); assert.equal(+hist[0].new_str, r.changes[0].nw);
  assert.ok(existsSync(join(tmp, 'r01/tune.json')) && readCSV(readFileSync(join(tmp, 'r01/needs_design.csv'), 'utf8')).length === r.needs.length);
  writeFileSync(join(tmp, 'chess-tune.js'), realTune); console.log = () => {}; try { main(args); } finally { console.log = log; } // 重跑同一轮：恢复、不重复
  assert.deepEqual(readTune(readFileSync(join(tmp, 'chess-tune.js'), 'utf8')), r.tune); assert.equal(readCSV(readFileSync(join(tmp, 'tune_history.csv'), 'utf8')).length, r.changes.length);
  assert.equal(readFileSync(join(ROOT, 'chess-tune.js'), 'utf8'), realTune, '仓库里的 chess-tune.js 没动');
  assert.deepEqual(readCSV('a,b\n"x,""y""",2\n'), [{ a: 'x,"y"', b: '2' }]);
  console.log(`改 ${r.changes.length} 张：${r.changes.map(c => `${c.id}${c.delta > 0 ? '+' : ''}${c.delta}`).join(' ')}；跳过 ${r.skipped.map(x => x.id)}；要改设计 ${r.needs.length} 张；临时目录 ${tmp}`);
  console.log('自检通过');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--selftest')) selftest(); else main(process.argv.slice(2));
}
