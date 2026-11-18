// 训练局面价值网络。数据是 gen.mjs 的输出（可以给多个文件）；留 3% 当考卷，每轮报一次考卷上的误差和猜对率。
// 用法：node tools/lab/train.mjs <输出权重.json> <轮数> <数据文件...> [--from 旧权重.json] [--lr 0.001] [--hidden 64,32]
import { readFileSync, writeFileSync } from 'node:fs';
import { L, KEYS, initNet, scratch, forward, backward, clear, toJSON, fromJSON } from './net.mjs';
import { lcg } from './play.mjs';

const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const from = opt('--from'), HID = (opt('--hidden') ?? '64,32').split(',').map(Number), LR = +(opt('--lr') ?? 1e-3), [outFile, epochs, ...files] = args, R = L + 1;
const chunks = files.map(f => { const b = readFileSync(f); return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2 / R) * R); });
const total = chunks.reduce((a, c) => a + c.length / R, 0), data = new Int16Array(total * R); let o = 0; for (const c of chunks) { data.set(c, o); o += c.length; }
const rnd = lcg(12345), order = Uint32Array.from({ length: total }, (_, i) => i);
for (let i = total - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
const nTest = Math.floor(total * .03), test = order.subarray(0, nTest), train = order.subarray(nTest);
const net = from ? fromJSON(readFileSync(from, 'utf8')) : initNet(lcg(7), ...HID), w = scratch(net);
const zero = () => Object.fromEntries(KEYS.map(k => [k, new Float32Array(net[k].length)]));
const G = zero(), M = zero(), V = zero(), B = 256, b1 = .9, b2 = .999, eps = 1e-8, wd = 1e-5; let step = 0;
const label = i => { const y = data[i * R + L]; return y === 2 ? .5 : y; };
const sig = z => 1 / (1 + Math.exp(-z));
function evalSet(set) { let loss = 0, hit = 0, n = 0; for (const i of set) { const y = label(i); const p = Math.min(1 - 1e-7, Math.max(1e-7, sig(forward(net, data.subarray(i * R, i * R + L), w)))); clear(w);
  loss -= y * Math.log(p) + (1 - y) * Math.log(1 - p); if (y !== .5) { hit += (p > .5) === (y === 1) ? 1 : 0; n++; } } return [loss / set.length, hit / n]; }
const yMean = Array.from(test, label).reduce((a, b) => a + b, 0) / nTest, base = -(yMean * Math.log(yMean) + (1 - yMean) * Math.log(1 - yMean));
console.log(`${total} 条，训练 ${train.length}，考卷 ${nTest}；只猜平均数的误差 ${base.toFixed(4)}`);
const t0 = Date.now();
for (let ep = 0; ep < +epochs; ep++) {
  for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  for (let s0 = 0; s0 < train.length; s0 += B) {
    const end = Math.min(train.length, s0 + B);
    for (let a = s0; a < end; a++) { const i = train[a]; const z = forward(net, data.subarray(i * R, i * R + L), w); backward(net, w, G, sig(z) - label(i)); clear(w); }
    step++; const n = end - s0, c1 = 1 - b1 ** step, c2 = 1 - b2 ** step;
    for (const k of KEYS) { const p = net[k], g = G[k], m = M[k], v = V[k];
      for (let j = 0; j < p.length; j++) { const gj = g[j] / n + wd * p[j]; if (gj === 0 && m[j] === 0) continue; m[j] = b1 * m[j] + (1 - b1) * gj; v[j] = b2 * v[j] + (1 - b2) * gj * gj; p[j] -= LR * (m[j] / c1) / (Math.sqrt(v[j] / c2) + eps); g[j] = 0; } }
  }
  const [loss, acc] = evalSet(test); console.log(`第 ${ep + 1} 轮：考卷误差 ${loss.toFixed(4)}，猜对胜负 ${(100 * acc).toFixed(1)}%（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  writeFileSync(outFile, toJSON(net));
}
