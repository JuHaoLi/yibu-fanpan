// 收敛循环总控（在 5090 上用 tmux 跑）：每轮 自我对打 → 老师 → 训练新网络（同时做普查拟合、预设互打）→ 新网络过关 → 自动调牌 → 汇总判收敛。
// 用法：node tools/lab/loop.mjs [--rounds N] [--smoke] [--from-round r] [--dry-run] [--dir 工作目录]
//   读 tools/lab/loop.config.json；--smoke 用里面 smoke 那组小参数（工作目录 out/loop-smoke，Mac 上几分钟一轮，只验证流程；
//     冒烟每次结束都把 chess-tune.js 的 TUNE 恢复成第 1 轮开始时的样子，免得把小样本调出来的数写进去）
//   --rounds N：这次最多跑 N 轮（默认跑到收敛或 maxRounds）
//   --from-round r：从第 r 轮重来：冠军、TUNE、每张牌的改动历史、收敛历史都退回第 r 轮开始时，第 r 轮起的进度作废
//   --dir：换工作目录（相对仓库根），盖过 config 里的 dir
//   --dry-run：只打印每轮要执行的命令，不执行、不写任何文件（后面几轮按"每轮新网络都过关"假设冠军）
// 工作目录 <dir>/：state.json（当前轮、冠军、每轮每步是否完成、每张牌改动历史、收敛历史；断了重跑从没做完的那步接着做）、
//   config.json（这次实际用的参数，tune_step 读）、champion.json（冠军权重的副本）、tune_history.csv、每轮 rNN/（各步输出和 <步骤>.log）
// 每步都是子进程（nice -n 10），非零退出就记进 state 并停下。第 3 步训练和第 5、6 步（拟合、预设）并行。
// 每次启动先把 chess-tune.js 的 TUNE 对齐成 state 里当前轮该用的那份（不一致会打印一行再改）。
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)), argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const SMOKE = argv.includes('--smoke'), DRY = argv.includes('--dry-run'), ROUNDS = +(opt('--rounds') ?? Infinity), FROM = opt('--from-round');
const base = JSON.parse(readFileSync(ROOT + 'tools/lab/loop.config.json', 'utf8')), cfg = { ...base, ...(SMOKE ? base.smoke : {}) }; delete cfg.smoke; if (opt('--dir')) cfg.dir = opt('--dir');
const DIR = cfg.dir, SP = `${DIR}/state.json`, TF = ROOT + 'chess-tune.js', at = p => ROOT + p; // 命令里一律用相对仓库根的路径（5090 副本上也能用）
const R = r => `${DIR}/r${String(r).padStart(2, '0')}`, spec = c => c ? `mix:${c}@${cfg.mix}` : 'strong';
const J = p => existsSync(at(p)) ? JSON.parse(readFileSync(at(p), 'utf8')) : null;
const readTune = () => JSON.parse(/export const TUNE = (.*);\n/.exec(readFileSync(TF, 'utf8'))[1]);
const writeTune = T => writeFileSync(TF, readFileSync(TF, 'utf8').replace(/export const TUNE = .*;\n/, 'export const TUNE = ' + JSON.stringify(T) + ';\n'));
let state = J(SP) ?? { round: 1, champion: null, rounds: {}, cards: {}, conv: [], done: null };
const save = () => { if (!DRY) writeFileSync(at(SP), JSON.stringify(state, null, 1)); };

// 一轮的计划：若干阶段，阶段里的几条链并行，链里的步骤依次做。node 步骤 = { name, argv }，内部步骤 = { name, js }
function roundPlan(r, champ) {
  const d = R(r), W = cfg.workers, cs = spec(champ), prev = r > 1 && (DRY || existsSync(at(`${R(r - 1)}/selfplay/pos.bin`))) ? `${R(r - 1)}/selfplay` : null;
  const L = 'tools/lab/', net = `${d}/net.json`, search = champ ? [`--search`, `${d}/teacher/search.bin`, '--search-weight', cfg.searchWeight] : [];
  const st = (name, ...a) => ({ name, argv: a.flat().map(String) });
  return [
    [[st('selfplay', L + 'selfplay.mjs', cs, cfg.selfplayGames, W, `${d}/selfplay`, '--jitter', 1, '--pos-games', cfg.posGames, '--presets', cfg.presets, '--seed-base', 1 + (r - 1) * 10000000)]],
    champ ? [[st('teacher', L + 'teacher.mjs', champ, cfg.teacherGames, W, `${d}/teacher`, '--p', cfg.p, '--K', cfg.K, '--M', cfg.M, '--opp', cfg.opp, '--act', cfg.act, '--seed-base', 500001 + r * 1000000)]] : null,
    [[st('train', L + 'train2.mjs', net, cfg.epochs, '--pos', [`${d}/selfplay`, prev].filter(Boolean).join(','), champ ? ['--from', champ, '--target', champ] : ['--stage1', cfg.stage1], '--lambda', cfg.lambda, search, '--report', `${d}/train.json`)],
      [st('fit', L + 'combo_fit.mjs', `${d}/fit`, `${d}/selfplay`), st('presets', L + 'preset_tune.mjs', cs, cfg.presetsPer, Math.max(1, W - 1), cfg.presetLo, cfg.presetHi, `${d}/presets.json`)]],
    [[st('gate', L + 'arena.mjs', spec(net), cs, cfg.gateGames, W, 900001 + r * 10007, `${d}/gate_champ.json`), ...(champ ? [st('gate_strong', L + 'arena.mjs', spec(net), 'strong', cfg.gateGames, W, 900001 + r * 10007, `${d}/gate_strong.json`)] : [])]],
    [[{ name: 'promote', js: () => promote(r, champ) }]],
    [[st('tune', L + 'tune_step.mjs', `${d}/fit`, `${d}/presets.json`, SP, r, '--apply', '--config', `${DIR}/config.json`)]],
    [[{ name: 'summary', js: () => summary(r) }]],
  ].filter(Boolean);
}

// 新网络过关：对冠军（第一轮没有冠军就是对 strong）胜率够了就当新冠军
// 冠军当年对 strong 的胜率：冠军是第 k 轮训出来的，就看第 k 轮的 gate_strong（第 1 轮没有冠军时 gate_champ 就是对 strong）
function champStrong(champ) { const m = champ && /r(\d+)\/net\.json$/.exec(champ); if (!m) return null; const k = +m[1], d = R(k);
  return (J(`${d}/gate_strong.json`) ?? (state.rounds[k]?.championIn ? null : J(`${d}/gate_champ.json`)))?.winA ?? null; }
function promote(r, champ) {
  const g = J(`${R(r)}/gate_champ.json`), need = champ ? cfg.gateWin : cfg.gateWin1, rd = state.rounds[r];
  // 第二条路：对冠军不输（≥50%），而且对 strong 这个固定参照比冠军当年高出 2 个百分点。冠军对冠军的比赛噪声大（±1.5），对固定参照的进步更说明问题
  const gs = champ && J(`${R(r)}/gate_strong.json`), cs = champStrong(champ), alt = !!(gs && cs != null && g.winA >= .5 && gs.winA >= cs + .02);
  rd.promoted = g.winA >= need || alt;
  console.log(`[${R(r)}] 新网络对${champ ? '冠军' : ' strong'}：${(100 * g.winA).toFixed(1)}% ± ${(100 * g.ci).toFixed(1)}，过关线 ${100 * need}%${gs ? `；对 strong ${(100 * gs.winA).toFixed(1)}%（冠军 ${cs == null ? '?' : (100 * cs).toFixed(1)}%）` : ''} → ${rd.promoted ? '当新冠军' + (alt && g.winA < need ? '（按对 strong 的进步）' : '') : '没过'}`);
  if (rd.promoted) { state.champion = `${R(r)}/net.json`; copyFileSync(at(state.champion), at(`${DIR}/champion.json`)); }
}

// 汇总这一轮 + 判收敛
function summary(r) {
  const d = R(r), rd = state.rounds[r], gc = J(`${d}/gate_champ.json`), gs = rd.championIn ? J(`${d}/gate_strong.json`) : gc;
  const tu = J(`${d}/tune.json`), fs = J(`${d}/fit/summary.json`), tr = J(`${d}/train.json`), last = tr?.epochs?.at(-1);
  const s = { round: r, rules: fs?.rules, ai: spec(rd.championIn), championIn: rd.championIn, champion: state.champion, promoted: rd.promoted,
    gateVsChamp: gc?.winA, gateVsChampCi: gc?.ci, gateVsStrong: gs?.winA, gateVsStrongCi: gs?.ci, testAcc: last?.testAcc, testBceOutcome: last?.testBceOutcome,
    outside: tu.outside, ppStd: tu.ppStd, presetsOutside: tu.presetsOutside, firstWin: fs?.firstWin, changes: tu.changes.length, needsDesign: tu.needs.length,
    seconds: Object.fromEntries(Object.entries(rd.steps).map(([k, v]) => [k, v.sec])) };
  state.conv = state.conv.filter(c => c.round !== r).concat({ round: r, outside: s.outside, ppStd: s.ppStd, presetsOutside: s.presetsOutside, promoted: s.promoted });
  const c = state.conv, n = c.length, noGate2 = n >= 2 && !c[n - 1].promoted && !c[n - 2].promoted;
  const why = s.outside <= cfg.doneOutside && s.presetsOutside === 0 && noGate2 ? `超范围棋子 ≤ ${cfg.doneOutside}、预设全在线内、网络连续 2 轮没过关`
    : n >= 3 && c[n - 1].ppStd >= c[n - 2].ppStd && c[n - 2].ppStd >= c[n - 3].ppStd && noGate2 ? '单卡分标准差连续 2 轮没下降、网络连续 2 轮没过关'
    : r >= cfg.maxRounds ? `到了 ${cfg.maxRounds} 轮` : null;
  s.converged = why; writeFileSync(at(`${d}/summary.json`), JSON.stringify(s, null, 1));
  console.log(`[${d}] 汇总：超范围棋子 ${s.outside}，单卡分标准差 ${s.ppStd.toFixed(2)}，预设超范围 ${s.presetsOutside}，先手胜率 ${s.firstWin ?? '?'}，改 ${s.changes} 张，新网络${s.promoted ? '过关' : '没过关'}${why ? `；收敛：${why}` : ''}`);
  if (why) state.done = { round: r, reason: why }; else state.round = r + 1;
}

// 跑一个子进程，输出同时写进 rNN/<步骤>.log 和屏幕
function runNode(r, step) {
  const log = createWriteStream(at(`${R(r)}/${step.name}.log`)), tag = `[r${String(r).padStart(2, '0')} ${step.name}] `;
  const p = spawn('nice', ['-n', String(cfg.nice), process.execPath, ...step.argv], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = b => { log.write(b); process.stdout.write(String(b).replace(/^(?=.)/gm, tag)); };
  p.stdout.on('data', out); p.stderr.on('data', out);
  return new Promise(ok => p.on('close', code => log.end(() => ok(code ?? 1))));
}

async function runRound(r) {
  const rd = (state.rounds[r] ??= { championIn: state.champion, tuneIn: readTune(), steps: {} }); save();
  mkdirSync(at(R(r)), { recursive: true });
  for (const stage of roundPlan(r, rd.championIn)) {
    const fails = (await Promise.all(stage.map(async chain => { for (const step of chain) {
      if (rd.steps[step.name]?.ok) continue;
      const t0 = Date.now(); let code = 0;
      if (step.js) { try { step.js(); } catch (e) { console.error(e); code = 1; } }
      else { console.log(`[${R(r)}] ${step.name}：node ${step.argv.join(' ')}`); code = await runNode(r, step); if (step.name === 'tune') { const t = J(SP); state.cards = t.cards; state.tuneAfter = t.tuneAfter; } } // tune_step 改了 state 里的 cards/tuneAfter
      rd.steps[step.name] = { ok: code === 0, sec: (Date.now() - t0) / 1000, code }; save();
      if (code) return step.name; } }))).filter(Boolean);
    if (fails.length) { state.failed = { round: r, steps: fails, at: new Date().toISOString() }; save(); return false; }
  }
  delete state.failed; save(); return true;
}

function rewind(r0) { // 退回第 r0 轮开始时
  const rd = state.rounds[r0]; if (!rd) throw new Error(`state 里没有第 ${r0} 轮`);
  state.champion = rd.championIn; writeTune(rd.tuneIn);
  if (rd.championIn) copyFileSync(at(rd.championIn), at(`${DIR}/champion.json`));
  for (const k of Object.keys(state.rounds)) if (+k >= r0) delete state.rounds[k];
  for (const k of Object.keys(state.tuneAfter || {})) if (+k >= r0) delete state.tuneAfter[k];
  for (const id in state.cards) state.cards[id] = state.cards[id].filter(h => h.round < r0);
  state.conv = state.conv.filter(c => c.round < r0); state.round = r0; state.done = null; delete state.failed;
  console.log(`已退回第 ${r0} 轮开始：冠军 ${spec(state.champion)}，TUNE 恢复`); // tune_history.csv 只追加，旧行留着，看 round 列
}

if (DRY) {
  let r = FROM ? +FROM : state.round, champ = FROM ? state.rounds[r]?.championIn ?? null : state.champion;
  console.log(`（只打印）${SMOKE ? '冒烟参数，' : ''}工作目录 ${DIR}，从第 ${r} 轮起${state.done && !FROM ? `（state 记着已收敛：${state.done.reason}）` : ''}`);
  for (let n = 0; n < ROUNDS && r <= cfg.maxRounds; n++, r++) {
    console.log(`\n== 第 ${r} 轮（冠军 ${spec(champ)}）==`);
    for (const stage of roundPlan(r, champ)) for (const [i, chain] of stage.entries()) for (const s of chain)
      console.log(`${stage.length > 1 ? `  [并行 ${i + 1}] ` : '  '}${s.js ? `（内部）${s.name}` : `nice -n ${cfg.nice} node ${s.argv.join(' ')}`}`);
    champ = `${R(r)}/net.json`; // 假设过关
  }
} else {
  mkdirSync(at(DIR), { recursive: true }); writeFileSync(at(`${DIR}/config.json`), JSON.stringify(cfg, null, 1));
  if (FROM) { rewind(+FROM); save(); }
  const tune0 = state.rounds[1]?.tuneIn ?? readTune(); let ok = true;
  if (!state.done) { const rd = state.rounds[state.round], want = rd ? (rd.steps.tune?.ok ? state.tuneAfter?.[state.round] : rd.tuneIn) : state.tuneAfter?.[state.round - 1]; // 续跑：TUNE 以 state 为准（冒烟退出时会恢复原样，kill -9 也可能留下半截）
    if (want && JSON.stringify(want) !== JSON.stringify(readTune())) { writeTune(want); console.log(`chess-tune.js 的 TUNE 和 state 记的第 ${state.round} 轮不一致，已按 state 改回`); } }
  try { for (let n = 0; n < ROUNDS && !state.done && ok; n++) ok = await runRound(state.round); }
  finally { if (SMOKE) { writeTune(tune0); console.log('冒烟：chess-tune.js 的 TUNE 已恢复成第 1 轮开始时的样子'); } }
  if (!ok) { console.error(`第 ${state.failed.round} 轮的 ${state.failed.steps.join('、')} 失败，看 ${R(state.failed.round)}/<步骤>.log；修好后直接重跑会从这一步接着做`); process.exit(1); }
  console.log(state.done ? `收敛（第 ${state.done.round} 轮）：${state.done.reason}；冠军 ${spec(state.champion)}` : `这次跑完了，下一轮是第 ${state.round} 轮`);
}
