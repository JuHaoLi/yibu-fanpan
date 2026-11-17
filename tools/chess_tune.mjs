// 平衡测试：电脑用随机组出的合法卡组（9 张本阵营 + 3 张中立）大量对打，统计每张牌所在卡组的胜率。
// 加上 --apply 就把太强的单位 −1 战力、太弱的 +1，写进 chess-tune.js。一次只调一轮：
// 卡牌模块载入后就定了，要让新数值生效得重新起一个进程，所以多轮调整用 shell 循环跑。
// 用法：node tools/chess_tune.mjs [局数=12000] [--apply]
//       for i in 1 2 3 4 5 6; do node tools/chess_tune.mjs 12000 --apply; done
import { writeFileSync } from 'node:fs';
const games = +(process.argv[2] ?? 12000), doApply = process.argv.includes('--apply');
let seed = 77; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const sh = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
let tune = { ...(await import('../chess-tune.js')).TUNE };
{
  const m = await import('../chess.js'), { CARDS, newGame, apply, aiTurn, deckError } = m, ids = Object.keys(CARDS).filter(k => !CARDS[k].token && !CARDS[k].boss), fs = m.FKEYS, F = fs.length;
  const pool = f => ids.filter(k => CARDS[k].faction === f), neutral = pool('n'), deck = f => [...sh(pool(f)).slice(0, 9), ...sh([...neutral]).slice(0, 3)];
  const stat = Object.fromEntries(ids.map(k => [k, [0, 0]])), fw = Object.fromEntries(fs.map(f => [f, [0, 0]])); let first = 0, done = 0, turns = 0;
  for (let g = 0; g < games; g++) {
    const fa = fs[g % F], fb = fs[Math.floor(g / F) % F], d = [deck(fa), deck(fb)]; if (deckError(d[0]) || deckError(d[1])) throw new Error('随机卡组不合法');
    let s = newGame(d, rnd); while (s.winner === null && s.n <= 70) for (const a of aiTurn(s)) s = apply(s, a).state;
    turns += s.n; if (s.winner === null) continue; done++; if (s.winner === 0) first++;
    d.forEach((dk, p) => dk.forEach(k => { stat[k][1]++; if (s.winner === p) stat[k][0]++; })); fw[fa][1]++; fw[fb][1]++; fw[s.winner ? fb : fa][0]++;
  }
  const rate = k => stat[k][0] / (stat[k][1] || 1), units = ids.filter(k => CARDS[k].kind !== 'spell' && stat[k][1] >= 60);
  // 每张牌和本阵营的平均胜率比（中立牌和 50% 比），偏离超过 5 个点才算偏强或偏弱；整阵营一起加减会来回震荡
  const mean = f => f === 'n' ? .5 : fw[f][0] / fw[f][1], dev = k => rate(k) - mean(CARDS[k].faction);
  const hi = units.filter(k => dev(k) > .05).sort((a, b) => dev(b) - dev(a)), lo = units.filter(k => dev(k) < -.05).sort((a, b) => dev(a) - dev(b));
  for (const f of fs) { // 阵营整体偏强或偏弱：每轮只再动其中最极端的 4 张
    const mine = units.filter(k => CARDS[k].faction === f && !hi.includes(k) && !lo.includes(k)).sort((a, b) => rate(b) - rate(a));
    if (mean(f) > .53) hi.push(...mine.slice(0, 4)); else if (mean(f) < .47) lo.push(...mine.slice(-4));
  }
  console.log(`${done} 局分出胜负，先手胜 ${(100 * first / done).toFixed(0)}%，平均 ${(turns / games).toFixed(1)} 回合；阵营胜率 ` + fs.map(f => `${m.FACTIONS[f].name} ${(100 * fw[f][0] / fw[f][1]).toFixed(0)}%`).join('，') + `；偏强 ${hi.length} 张，偏弱 ${lo.length} 张`);
  const show = l => l.slice(0, 8).map(k => `${CARDS[k].name}${(100 * rate(k)).toFixed(0)}%`).join(' ');
  console.log('  最强：' + show(hi) + '\n  最弱：' + show(lo));
  const spells = ids.filter(k => CARDS[k].kind === 'spell' && stat[k][1] >= 60).sort((a, b) => rate(b) - rate(a)); console.log('  法术：' + spells.slice(0, 5).map(k => `${CARDS[k].name}${(100 * rate(k)).toFixed(0)}%`).join(' ') + ' … ' + spells.slice(-5).map(k => `${CARDS[k].name}${(100 * rate(k)).toFixed(0)}%`).join(' '));
  if (doApply) {
    const { LESSON } = await import('../tutorial.js'), PIN = new Set([...LESSON.mine, ...LESSON.foe]); // 新手教学用到的牌不动：教学的台词里写着它们的战力
    for (const k of hi) if (!PIN.has(k)) tune[k] = Math.max(-5, (tune[k] || 0) - 1); for (const k of lo) if (!PIN.has(k)) tune[k] = Math.min(5, (tune[k] || 0) + 1);
    for (const k of Object.keys(tune)) if (!tune[k]) delete tune[k];
    writeFileSync(new URL('../chess-tune.js', import.meta.url), `// 由 tools/chess_tune.mjs 生成：每张单位牌在“按公式算出的战力”上再加减几点。不要手改。\nexport const TUNE = ${JSON.stringify(tune)};\n`);
  }
}
