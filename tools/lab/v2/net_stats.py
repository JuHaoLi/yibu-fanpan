#!/usr/bin/env python3
# 第 2 代网络的统计：同一份考卷（默认 v23 自我对打的 3% 留出局面，四个网络都没在这些局面上训练过）上比 g4 / v2.x：
#   交叉熵、猜对率、Brier、校准（10 档预测胜率 vs 实际）、按回合段的猜对率；
#   只对 --focus 网络：卡组输入的作用（打乱各块输入看交叉熵涨多少）、各块输入对第一层的贡献（W·x 的标准差）。
# 用法（5090，实验目录根上）：$PY -I tools/lab/v2/net_stats.py out/v2/v23/cards.json out/v2/stats/net_stats.json out/v2/v23/selfplay \
#        --nets g4=assets/ai/net-g4.json,v21=out/v2/v21/net.json,v22=out/v2/v22/net.json,v23=out/v2/v23/net.json --focus v22
#   g4 是第 1 代 JSON：装进 v2 结构、卡组那几块的权重全零，输出和 g4 一样。
import argparse, json, os, sys, time
import numpy as np, torch, torch.nn.functional as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deck_probe as d

TURNS = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 14), (15, 99)]

def logits(net, data, idx, dev, swap=None, bs=8192):  # swap：{'deck'|'seen': 打乱后的行号}，换掉那一块输入
    e, dk, sn, fo, _ = data; out = []; net.eval()
    with torch.no_grad():
        for a in range(0, len(idx), bs):
            j = idx[a:a + bs]; jd = swap['deck'][a:a + bs] if swap and 'deck' in swap else j; js = swap['seen'][a:a + bs] if swap and 'seen' in swap else j
            out.append(net(*(torch.from_numpy(x).to(dev).long() for x in (e[j], dk[jd], sn[js], fo[j]))).float().cpu())
    return torch.cat(out).numpy()

def scores(z, y):
    p = 1 / (1 + np.exp(-z)); dec = y != .5
    bce = float(F.binary_cross_entropy_with_logits(torch.from_numpy(z), torch.from_numpy(y)).item())
    return {'bce': round(bce, 5), 'acc': round(float(((p > .5) == (y > .5))[dec].mean()), 5), 'brier': round(float(((p - y) ** 2).mean()), 5)}

def calib(z, y):
    p = 1 / (1 + np.exp(-z)); b = np.minimum((p * 10).astype(int), 9)
    return [{'bin': k, 'pred': round(float(p[b == k].mean()), 4), 'real': round(float(y[b == k].mean()), 4), 'n': int((b == k).sum())} for k in range(10) if (b == k).any()]

def blocks(net, data, idx, dev, n=20000):  # 第一层每块输入的贡献：W_block·x_block 的标准差（对隐藏单元取平均）
    cap = {}; h = net.l1.register_forward_hook(lambda m, i, o: cap.update(x=i[0].detach()))  # 钩子要返回 None，否则会顶掉这一层的输出
    logits(net, data, idx[:n], dev, bs=n); h.remove(); x = cap['x']; W = net.l1.weight.detach()
    N, TF, K = net.N, net.TF, net.CS + net.D
    sizes = [('棋盘格子', N * 2 * TF), ('蔓延/暗影', N * 3), ('手牌', K + 1), ('城堡/能量等', 15), ('整副卡组', K), ('牌库剩余', K), ('对面亮过的牌', K + 1)]
    out, a = [], 0
    for name, k in sizes:
        if a >= x.shape[1]: break
        c = x[:, a:a + k] @ W[:, a:a + k].T; out.append({'block': name, 'dims': k, 'std': round(float(c.std(0).mean()), 4)}); a += k
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('cards'); ap.add_argument('out'); ap.add_argument('dirs', nargs='+')
    ap.add_argument('--nets', required=True); ap.add_argument('--focus', default='v22'); ap.add_argument('--mem', type=float, default=.3)
    a = ap.parse_args(); os.nice(10); T0 = time.time(); log = lambda m: print(f'[{time.time() - T0:5.0f}s] {m}', flush=True)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    if dev == 'cuda': torch.cuda.set_per_process_memory_fraction(a.mem)
    C = json.load(open(a.cards)); *data, te = d.load(C, a.dirs, log); idx = np.where(te)[0]; y = data[4][idx]
    turn = np.concatenate([np.fromfile(f'{x}/pos.bin', dtype=np.int16) for x in a.dirs])  # 回合数 = 每条记录的第 L+1 个（load 里按同样规则截断）
    PR = C['L'] + 3; turn = turn[:len(turn) // PR * PR].reshape(-1, PR); assert len(turn) == len(te), '回合数对不上：只支持跑完整的目录'; turn = turn[idx, C['L'] + 1]
    d.wait_gpu(log); H1, H2, ex = d.MODELS['v2']; res = {'test': int(len(idx)), 'dirs': a.dirs, 'nets': {}, 'turnBins': [f'{lo}–{hi}' if hi < 99 else f'{lo}+' for lo, hi in TURNS]}
    for kv in a.nets.split(','):
        name, path = kv.split('='); net = d.Net(C, H1, H2, ex).to(dev); d.load_init(net, path); z = logits(net, data, idx, dev)
        r = scores(z, y); r['calib'] = calib(z, y)
        r['byTurn'] = [dict(scores(z[(turn >= lo) & (turn <= hi)], y[(turn >= lo) & (turn <= hi)]), n=int(((turn >= lo) & (turn <= hi)).sum())) for lo, hi in TURNS]
        if name == a.focus:
            rng = np.random.default_rng(7); base = r['bce']; r['permute'] = []
            def same_turn():  # 只在同一回合数的局面之间打乱：亮过几张牌和回合数强相关，全局打乱会把"进行到第几回合"也一起打乱
                p = idx.copy()
                for t in np.unique(turn): k = np.where(turn == t)[0]; p[k] = idx[k][rng.permutation(len(k))]
                return p
            for what, sw in [('整副卡组 + 牌库剩余', {'deck': same_turn()}), ('对面亮过的牌', {'seen': same_turn()}), ('两样都打乱', {'deck': same_turn(), 'seen': same_turn()}), ('对面亮过的牌（全局打乱，含回合信息）', {'seen': rng.permutation(idx)})]:
                s = scores(logits(net, data, idx, dev, sw), y); r['permute'].append({'what': what, 'bce': s['bce'], 'acc': s['acc'], 'dBce': round(s['bce'] - base, 5)})
            r['blocks'] = blocks(net, data, idx, dev)
        res['nets'][name] = r; log(f'{name}：交叉熵 {r["bce"]:.4f}，猜对 {100 * r["acc"]:.2f}%，Brier {r["brier"]:.4f}')
    os.makedirs(os.path.dirname(a.out), exist_ok=True); json.dump(res, open(a.out, 'w'), ensure_ascii=False, indent=1); log('完成 → ' + a.out)

if __name__ == '__main__': main()
