// 核对：deck_probe.py 导出的第 2 代网络，在 chess-net.js 里算出来的 logit 和 torch 一致。
// 用法：node tools/lab/v2/parity.mjs <网络.json>   （同目录要有 <网络>.parity.json）
import { readFileSync } from 'node:fs';
import { fromJSON, scratch, forward, clear } from '../net.mjs';
const f = process.argv[2], net = fromJSON(readFileSync(f, 'utf8')), P = JSON.parse(readFileSync(f.replace('.json', '.parity.json'), 'utf8')), w = scratch(net);
if (!net.v2) throw new Error('不是第 2 代网络');
let worst = 0; P.e.forEach((e, i) => { const z = forward(net, Int16Array.from(e), w, Int16Array.from(P.e2[i])); clear(w); worst = Math.max(worst, Math.abs(z - P.z[i])); });
console.log(`${P.e.length} 条样本，JS 和 torch 的 logit 最大差 ${worst.toExponential(2)}`); if (worst > 2e-3) { console.log('对不上'); process.exit(1); } console.log('一致');
