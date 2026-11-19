#!/usr/bin/env python3
# 第 2 代网络 · 对照实验：网络"看到卡组"能不能更准地猜出胜负。用现有自我对打数据（selfplay 的 pos.bin + games.bin），在显卡上训几种网络比考卷成绩。
# 用法：<带 torch 的 python> tools/lab/v2/deck_probe.py <cards.json> <输出.json> <selfplay目录…> [--epochs 3] [--mem 0.3] [--models m0,m1,...]
#       <带 torch 的 python> tools/lab/v2/deck_probe.py --selftest
# cards.json 用 node tools/lab/v2/dump_cards.mjs 导出（和数据同一套牌）。
# 输入和 chess-net.js 的 featurize 一一对应（棋盘每格 × 双方、地格、手牌、全局 15 项），这一块就是现在游戏里的网络；在它后面按开关追加：
#   deck：我整副 12 张牌的平均牌特征；rem：牌库里还剩的牌（= 整副去掉手牌，打出的牌回合结束洗回牌库）的平均牌特征 —— 都是玩家自己知道的
#   foe：对面整副牌（玩家其实不知道，只当"上限"对照，不能上线）
# 牌特征 = 23 维固定牌面特征 + 8 维学出来的嵌入（同 chess-net.js）。目标 = 最终胜负（赢 1、输 0、平 .5），考卷按局留 3%。
# 显卡：只占 --mem 比例的显存；每 500 步看一次 ComfyUI（127.0.0.1:8188）队列，有人在出图就等它出完。进程自己 nice 10。
import argparse, json, math, os, sys, time, urllib.request
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F

MODELS = {  # 名字：(H1, H2, 带哪些卡组信息)
    'm0': (64, 32, ()), 'm1': (64, 32, ('deck', 'rem')), 'm2': (64, 32, ('deck', 'rem', 'foe')),
    'm0big': (256, 128, ()), 'm1big': (256, 128, ('deck', 'rem')),
    'v2': (64, 32, ('deck', 'rem', 'seen')),  # 第 2 代正式网络：和 chess-net.js 的 v2 前向一一对应
}

def comfy_busy():
    try:
        with urllib.request.urlopen('http://127.0.0.1:8188/queue', timeout=3) as r: q = json.load(r)
        return bool(q.get('queue_running')) or bool(q.get('queue_pending'))
    except Exception: return False

def wait_gpu(log):
    t = time.time()
    while comfy_busy(): time.sleep(30)
    if time.time() - t > 5: log(f'等 ComfyUI 出图 {time.time() - t:.0f} 秒')

class Net(nn.Module):
    def __init__(s, C, H1, H2, extra):
        super().__init__()
        s.N, s.L, s.CS, s.D, s.extra = C['N'], C['L'], C['CS'], C['D'], extra
        s.register_buffer('SF', torch.tensor(C['SF'], dtype=torch.float32).view(C['NC'], C['CS']))
        s.E = nn.Embedding(C['NC'], C['D']); nn.init.uniform_(s.E.weight, -.1, .1)
        s.TF = 9 + s.CS + s.D; K = s.CS + s.D
        din = s.N * 2 * s.TF + s.N * 3 + K + 1 + 15 + K * len(extra) + ('seen' in extra)
        s.l1, s.l2, s.l3 = nn.Linear(din, H1), nn.Linear(H1, H2), nn.Linear(H2, 1)
        s.register_buffer('sc', torch.tensor([10, 10, 10, 10, 10, 10, 8, 8, 1, 1, 12, 12, 4, 30, 1], dtype=torch.float32))
    def card(s, ci): return torch.cat([s.SF[ci], s.E(ci)], -1) * (ci > 0).unsqueeze(-1)  # 0 号 = 没有牌，特征全 0
    def mean(s, ci, m):  # 一组牌的平均牌特征，m：哪些算数
        f = s.card(ci) * m.unsqueeze(-1); return f.sum(1) / m.sum(1, keepdim=True).clamp(min=1)
    def forward(s, e, deck, seen, foe):
        B, N = e.shape[0], s.N
        t = e[:, :N * 6].view(B, N, 6); ci, side, st, fl = t[..., 0], t[..., 1], t[..., 2].float(), t[..., 3]
        bits = torch.stack([(fl >> k) & 1 for k in range(6)], -1).float()
        tv = torch.cat([torch.ones_like(st).unsqueeze(-1), (st / 10).unsqueeze(-1), bits, ((fl >> 8).float() / 3).unsqueeze(-1), s.card(ci)], -1) * (ci > 0).unsqueeze(-1)
        tiles = (tv.unsqueeze(2) * F.one_hot(side.clamp(0, 1), 2).unsqueeze(-1)).reshape(B, -1)
        cr, sh = t[..., 4], t[..., 5].float()
        creep = torch.stack([(cr == 1).float(), (cr == 2).float(), sh / 3], -1).reshape(B, -1)
        h = e[:, N * 6:N * 6 + 4]; hand = torch.cat([s.card(h).sum(1), ((h > 0).sum(1, keepdim=True).float() / 4)], -1)
        g = e[:, N * 6 + 4:N * 6 + 19].float() / s.sc; boss = g[:, 14]; g = torch.cat([g[:, :14], torch.where(boss == 1, 1., torch.where(boss == 2, -1., 0.)).unsqueeze(-1)], -1)
        parts = [tiles, creep, hand, g]
        if 'deck' in s.extra: parts.append(s.mean(deck, (deck > 0).float()))
        if 'rem' in s.extra: parts.append(s.mean(deck, remaining(deck, h).float()))
        if 'seen' in s.extra: m = (seen > 0).float(); parts += [s.mean(seen, m), m.sum(1, keepdim=True) / 12]  # 对面亮过的牌 + 张数
        if 'foe' in s.extra: parts.append(s.mean(foe, (foe > 0).float()))
        return s.l3(F.relu(s.l2(F.relu(s.l1(torch.cat(parts, -1)))))).squeeze(-1)

def remaining(deck, hand):  # 整副牌去掉手牌（按张数，同名牌只去掉手里那么多张）
    gone = torch.zeros_like(deck, dtype=torch.bool)
    for k in range(hand.shape[1]):
        hk = hand[:, k:k + 1]; eq = (deck == hk) & ~gone & (hk > 0)
        gone |= eq & (eq.cumsum(1) == 1)
    return (deck > 0) & ~gone

def load(C, dirs, log):
    i2c = np.array(C['ids2cix'], dtype=np.int16); PR = C['L'] + 3; E, DK, SN, FO, Y, TE = [], [], [], [], [], []
    for di, d in enumerate(dirs):
        pos = np.fromfile(f'{d}/pos.bin', dtype=np.int16); gid = np.fromfile(f'{d}/pos_gid.bin', dtype=np.uint32)
        games = np.fromfile(f'{d}/games.bin', dtype=np.uint32); games = games[:len(games) // C['REC'] * C['REC']].reshape(-1, C['REC'])
        n = min(len(pos) // PR, len(gid)); pos = pos[:n * PR].reshape(n, PR); gid = gid[:n]; ok = gid < len(games); pos, gid = pos[ok], gid[ok]  # 中途停掉的那轮：只要两边都写全的
        me = pos[:, C['L'] + 2].astype(np.int64); rows = games[gid]
        mine = np.where(me[:, None] == 0, rows[:, 0:12], rows[:, 12:24]); theirs = np.where(me[:, None] == 0, rows[:, 12:24], rows[:, 0:12])
        y = pos[:, C['L']]; E.append(pos[:, :C['L']]); FO.append(i2c[theirs]); Y.append(np.where(y == 2, .5, y).astype(np.float32))
        if os.path.exists(f'{d}/ext.bin'): x = np.fromfile(f'{d}/ext.bin', dtype=np.int16).reshape(-1, 24)[:n][ok]; DK.append(x[:, :12]); SN.append(x[:, 12:])  # selfplay --v2：encode2 的整副卡组和对面亮过的牌
        else: DK.append(i2c[mine]); SN.append(np.zeros((len(pos), 12), np.int16))  # 旧数据没记亮过的牌
        TE.append(((gid.astype(np.uint64) * 2654435761 + di * 97) % 100) < 3)
        log(f'{d}：{n} 条局面，{len(games)} 局')
    return [np.concatenate(a) for a in (E, DK, SN, FO, Y, TE)]

def evaluate(net, data, idx, dev, bs=8192):
    e, dk, sn, fo, y = data; net.eval(); tot, cor, cnt, n = 0., 0, 0, 0
    with torch.no_grad():
        for a in range(0, len(idx), bs):
            j = idx[a:a + bs]; z = net(*(torch.from_numpy(x[j]).to(dev).long() for x in (e, dk, sn, fo))); t = torch.from_numpy(y[j]).to(dev)
            tot += F.binary_cross_entropy_with_logits(z, t, reduction='sum').item(); n += len(j)
            d = t != .5; cor += ((z[d] > 0) == (t[d] > .5)).sum().item(); cnt += d.sum().item()
    net.train(); return tot / n, cor / max(cnt, 1)

INIT = None  # --init：从第 1 代网络 JSON 起步（同牌表、同 64/32 才行）
def load_init(net, path):  # 新加的卡组输入在 W1 里的行置零，起点的输出 = 原网络
    o = json.load(open(path)); H1 = net.l1.out_features; W1 = torch.tensor(o['W1']).view(o['din'], H1); t = lambda k, ref: torch.tensor(o[k]).view_as(ref)
    assert o['din'] <= net.l1.in_features and len(o['b1']) == H1 and len(o['b3']) == 1, '起步网络的形状对不上'
    with torch.no_grad():
        net.E.weight.copy_(t('E', net.E.weight)); net.l1.weight.zero_(); net.l1.weight[:, :o['din']] = W1.t(); net.l1.bias.copy_(t('b1', net.l1.bias))
        net.l2.weight.copy_(t('W2', net.l2.weight)); net.l2.bias.copy_(t('b2', net.l2.bias)); net.l3.weight.copy_(t('w3', net.l3.weight)); net.l3.bias.copy_(t('b3', net.l3.bias))
def train(name, C, data, tr, te, dev, epochs, log, bs=2048, lr=2e-3):
    H1, H2, extra = MODELS[name]; torch.manual_seed(1); net = Net(C, H1, H2, extra).to(dev)
    if INIT and name == 'v2':
        load_init(net, INIT); lr = lr / 4; bce, acc = evaluate(net, data, te, dev); log(f'{name} 从 {INIT} 起步：考卷交叉熵 {bce:.4f}，猜对 {100 * acc:.2f}%；学习率降到 {lr:g}')
    opt = torch.optim.Adam(net.parameters(), lr=lr, weight_decay=1e-5); e, dk, sn, fo, y = data; rng = np.random.default_rng(1); hist = []
    steps = epochs * (len(tr) // bs); sched = torch.optim.lr_scheduler.OneCycleLR(opt, lr, total_steps=steps); k = 0; t0 = time.time()
    for ep in range(epochs):
        p = rng.permutation(tr)
        for a in range(0, len(p) - bs + 1, bs):
            if k % 500 == 0: wait_gpu(log)
            j = np.sort(p[a:a + bs]); z = net(*(torch.from_numpy(x[j]).to(dev, non_blocking=True).long() for x in (e, dk, sn, fo)))
            loss = F.binary_cross_entropy_with_logits(z, torch.from_numpy(y[j]).to(dev)); opt.zero_grad(); loss.backward(); opt.step(); sched.step(); k += 1
        bce, acc = evaluate(net, data, te, dev); hist.append({'epoch': ep + 1, 'testBce': round(bce, 5), 'testAcc': round(acc, 5), 'sec': round(time.time() - t0)})
        log(f'{name} 第 {ep + 1} 轮：考卷交叉熵 {bce:.4f}，猜对 {100 * acc:.2f}%（{time.time() - t0:.0f} 秒）')
    return {'model': name, 'H1': H1, 'H2': H2, 'extra': list(extra), 'params': sum(p.numel() for p in net.parameters()), 'epochs': hist}, net

def export_js(net, C, data, idx, path):  # 导出成 chess-net.js 的 v2 格式（权重四舍五入到 1e-5，同 toJSON），另写一份对照样本给 parity.mjs 核对 JS 前向
    r = lambda t: [round(float(x), 5) for x in t.detach().cpu().flatten()]
    o = {'v': 2, 'cards': C['cids'], 'din': net.l1.in_features, 'E': r(net.E.weight), 'W1': r(net.l1.weight.t()), 'b1': r(net.l1.bias),
         'W2': r(net.l2.weight), 'b2': r(net.l2.bias), 'w3': r(net.l3.weight[0]), 'b3': r(net.l3.bias)}
    json.dump(o, open(path, 'w'), separators=(',', ':'))
    with torch.no_grad():
        for p in net.parameters(): p.copy_(torch.round(p * 1e5) / 1e5)
        e, dk, sn, fo, y = data; j = idx[:256]; dev = net.l1.weight.device
        z = net(*(torch.from_numpy(x[j]).to(dev).long() for x in (e, dk, sn, fo))).cpu().tolist()
    json.dump({'e': e[j].tolist(), 'e2': np.concatenate([dk[j], sn[j]], 1).tolist(), 'z': z}, open(path.replace('.json', '.parity.json'), 'w'))

def selftest():
    # 小牌表 + 合成数据：结果只取决于"我的卡组里有没有 7 号牌"——看得到卡组的 m1 应该学会，m0 学不会
    N, L, CS, D, NC = 20, 20 * 6 + 19, 3, 2, 12
    C = {'N': N, 'L': L, 'CS': CS, 'D': D, 'NC': NC, 'REC': 27, 'SF': [0.] * CS + [((i * 7 + k) % 5) / 5 for i in range(1, NC) for k in range(CS)], 'ids2cix': list(range(1, NC))}
    deck = torch.tensor([[3, 3, 5, 0], [1, 2, 3, 4]]); hand = torch.tensor([[3, 9], [4, 0]])
    assert remaining(deck, hand).tolist() == [[False, True, True, False], [True, True, True, False]], '去手牌算错了'
    rng = np.random.default_rng(0); M = 6000
    e = np.zeros((M, L), np.int16); e[:, N * 6:N * 6 + 4] = rng.integers(1, NC, (M, 4)); e[:, N * 6 + 4] = 10
    dk = rng.integers(1, NC - 1, (M, 12)).astype(np.int16); dk[dk == 7] = 8; has = rng.random(M) < .5; dk[has, rng.integers(0, 12, has.sum())] = 7
    fo = rng.integers(1, NC, (M, 12)).astype(np.int16); y = has.astype(np.float32); te = np.arange(M) % 10 == 0; tr, ts = np.where(~te)[0], np.where(te)[0]
    MODELS['t0'] = (16, 8, ()); MODELS['t1'] = (16, 8, ('deck', 'rem'))
    dev = 'cpu'; sn = np.zeros_like(dk); r0, _ = train('t0', C, (e, dk, sn, fo, y), tr, ts, dev, 3, lambda *_: None, bs=128, lr=1e-2); r1, _ = train('t1', C, (e, dk, sn, fo, y), tr, ts, dev, 3, lambda *_: None, bs=128, lr=1e-2)
    a0, a1 = r0['epochs'][-1]['testAcc'], r1['epochs'][-1]['testAcc']
    assert a1 > .9 and a0 < .65, f'看得到卡组的网络应该学会（{a1}），看不到的学不会（{a0}）'
    print(f'合成数据：不看卡组 {100 * a0:.0f}%，看卡组 {100 * a1:.0f}%；自检通过')

if __name__ == '__main__':
    if '--selftest' in sys.argv: selftest(); sys.exit()
    ap = argparse.ArgumentParser(); ap.add_argument('cards'); ap.add_argument('out'); ap.add_argument('dirs', nargs='+')
    ap.add_argument('--export', default=None);  # 训完 v2 后导出给游戏用的网络 JSON
    ap.add_argument('--epochs', type=int, default=3); ap.add_argument('--init', default=None); ap.add_argument('--mem', type=float, default=.3); ap.add_argument('--models', default=','.join(MODELS))
    a = ap.parse_args(); INIT = a.init; os.nice(10); C = json.load(open(a.cards)); T0 = time.time()
    log = lambda m: print(f'[{time.time() - T0:6.0f}s] {m}', flush=True)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    if dev == 'cuda': torch.cuda.set_per_process_memory_fraction(a.mem); log(f'显卡 {torch.cuda.get_device_name()}，最多用 {a.mem:.0%} 显存')
    *data, te = load(C, a.dirs, log); te_i, tr_i = np.where(te)[0], np.where(~te)[0]; log(f'共 {len(te) } 条，训练 {len(tr_i)}，考卷 {len(te_i)}')
    res = {'dirs': a.dirs, 'records': int(len(te)), 'test': int(len(te_i)), 'models': []}
    for m in a.models.split(','):
        r, net = train(m, C, data, tr_i, te_i, dev, a.epochs, log); res['models'].append(r)
        torch.save(net.state_dict(), a.out.replace('.json', f'.{m}.pt')); json.dump(res, open(a.out, 'w'), ensure_ascii=False, indent=1)
        if m == 'v2' and a.export: export_js(net, C, data, te_i, a.export); log('导出 → ' + a.export)
    log('完成 → ' + a.out)
