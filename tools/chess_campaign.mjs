// 闯关难度体检和校准：电脑用 12 套预设卡组各把每一关打若干局（玩家永远先手），看每关的通关率。
// 电脑只是每步贪心，人比它强不少，所以给电脑定的目标偏低：普通关约 50%，阵营首领和中立小首领约 30%，最终首领约 20%。
// 血量有范围：对面普通关不低于 8、首领不低于 10；我方不高于 12。范围内够不着目标就停在边上。
// 用法：node tools/chess_campaign.mjs [每套卡组每关局数=4]          只看现在的通关率
//       node tools/chess_campaign.mjs 3 --fit                      按目标反推每关双方的城堡血量，写进 campaign-hp.js
import { writeFileSync } from 'node:fs';
import { DECKS, newGame, apply, aiTurn } from '../chess.js';
import { AREAS, stageOpts } from '../campaign.js';
const per = +(process.argv[2] ?? 4), fit = process.argv.includes('--fit'); let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const rate = (st, base) => { let w = 0, n = 0; for (const d of DECKS) for (let g = 0; g < per; g++) { let s = newGame([d.cards, st.foe], rnd, { ...stageOpts(st), base }); while (s.winner === null && s.n <= 80) for (const x of aiTurn(s)) s = apply(s, x).state; n++; if (s.winner === 0) w++; } return w / n; };
const out = {};
for (const a of AREAS) {
  const row = a.stages.map((st, i) => { const last = i === a.stages.length - 1, star = last || a.key === 'n', target = a.key === 'n' && last ? .2 : star ? .3 : .5, lo = star ? 10 : 8;
    let base = fit ? [10, Math.max(lo, 10)] : [...st.base], p = rate(st, base);
    if (fit) { // 对面血量越高越难：从现在的值往目标方向一格一格挪；对面降到 6 还不够，就给我方加血
      const step = p > target ? 1 : -1; let best = [Math.abs(p - target), base, p];
      for (let k = 0; k < 10; k++) { const nb = [...base]; if (step < 0 && nb[1] <= lo) { if (nb[0] >= 12) break; nb[0]++; } else if (step > 0 && nb[0] > 10) nb[0]--; else { nb[1] += step; if (nb[1] > 18) break; }
        const q = rate(st, nb); if (Math.abs(q - target) < best[0]) best = [Math.abs(q - target), nb, q]; base = nb; if ((q - target) * step <= 0) break; }
      base = best[1]; p = best[2]; }
    (out[a.key] ||= []).push(base); return `${star ? '★' : ''}${(100 * p).toFixed(0)}%[${base}]`; });
  console.log(a.name.padEnd(6, '　'), row.join('  '));
}
if (fit) writeFileSync(new URL('../campaign-hp.js', import.meta.url), `// 由 tools/chess_campaign.mjs --fit 生成：每个场地每一关 [我方城堡血量, 对面城堡血量]。不要手改。\nexport const HP = ${JSON.stringify(out)};\n`);
