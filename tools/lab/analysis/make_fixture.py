#!/usr/bin/env python3
# 造一个假的 loop 目录（两轮、几十局、十几张牌），用来测 ingest.py 和 dashboard.py；格式照 SPEC.md（games.bin 小端 uint32，每局 27 个）。
# 用法：python3 -I tools/lab/analysis/make_fixture.py <输出目录>
#   另写 <输出目录>/expected.json：自检要核对的数（去重后局数、先手胜率、超时局数、规则版本是否对得上……），由这里独立算出。
# 故意埋的坑：第 1 轮有一局种子重复、每轮有打满 70 回合的局和平局、第 2 轮 summary 的 rules 和 meta 不一样、
#   第 1 轮 summary 不带对冠军的 gate（要从 gate_champ.json 读）、也没有 gate_strong.json（对 strong 只有 summary 的胜率和 ci）、
#   第 2 轮 summary 是 loop.mjs 的真实格式（gateVsChamp 小数、converged 是原因字符串、seconds 是各步耗时）；
#   tune_history.csv 里第 1 轮的行和 r01/tune.json 不一样（以 tune.json 为准），第 2 轮重跑过（追加了新的一批，只留最后一批）。
import csv, json, random, struct, sys
from pathlib import Path

CARDS = [  # id, 名字, 阵营, 类型, 费用, 战力
    ('f1_knight', '圣骑', 'f1', 'unit', 3, 4), ('f1_guard', '盾卫', 'f1', 'unit', 2, 3), ('f1_tower', '箭塔', 'f1', 'structure', 4, 5),
    ('f1_smite', '惩戒', 'f1', 'spell', 2, None), ('f1_lord', '圣王', 'f1', 'unit', 7, 9),
    ('f2_shade', '影刺', 'f2', 'unit', 2, 2), ('f2_wind', '疾风', 'f2', 'unit', 4, 5), ('f2_totem', '风图腾', 'f2', 'structure', 5, 6),
    ('f2_gust', '狂风', 'f2', 'spell', 3, None), ('f2_storm', '风暴', 'f2', 'unit', 6, 8),
    ('n_scout', '斥候', 'n', 'unit', 1, 1), ('n_ogre', '食人魔', 'n', 'unit', 5, 7), ('n_wall', '石墙', 'n', 'structure', 3, 6), ('n_bolt', '飞弹', 'n', 'spell', 1, None)]
IDS = [c[0] for c in CARDS]; FN = {'f1': '圣辉骑士团', 'f2': '岚影', 'n': '中立'}

def wcsv(p, head, rows):
    with open(p, 'w', encoding='utf-8', newline='') as f: w = csv.writer(f); w.writerow(head); w.writerows(rows)

def main():
    if len(sys.argv) < 2: sys.exit('用法：make_fixture.py <输出目录>')
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(7); exp = {'games': {}, 'first_win': {}, 'timeouts': {}, 'draws': {}, 'dups': {}, 'rules_ok': {1: 1, 2: 0}, 'f1_first_games': {}}
    for r in (1, 2):
        rd = out / f'r{r:02d}'; sp, fit = rd / 'selfplay', rd / 'fit'
        sp.mkdir(parents=True, exist_ok=True); fit.mkdir(parents=True, exist_ok=True)
        G = 40 + r * 5; recs, jit, seeds = [], [], []
        for g in range(G):
            decks = []
            for _ in range(2):
                f = rnd.choice(['f1', 'f2']); k = rnd.randint(0, 4)
                pool = [i for i, c in enumerate(CARDS) if c[2] == f]; npool = [i for i, c in enumerate(CARDS) if c[2] == 'n']
                decks.append([rnd.choice(pool) for _ in range(12 - k)] + [rnd.choice(npool) for _ in range(k)])
            res = 2 if g % 13 == 5 else rnd.choice([0, 0, 1]); turns = 70 if g % 17 == 3 else rnd.randint(12, 60)
            seed = 1000 * r + g
            if r == 1 and g == G - 1: seed = seeds[0]  # 故意重复一个种子
            seeds.append(seed); recs.append(decks[0] + decks[1] + [res, turns, seed])
            jit.append([rnd.choice([-1, 0, 1]) if CARDS[i][5] else 0 for i in decks[0] + decks[1]])
        (sp / 'games.bin').write_bytes(b''.join(struct.pack('<27I', *x) for x in recs))
        (sp / 'jitter.bin').write_bytes(b''.join(struct.pack('<24b', *x) for x in jit))
        rules = f'rule{r}aaaaaaa'
        (sp / 'meta.json').write_text(json.dumps({'games': G, 'rules': rules, 'ai': 'strong' if r == 1 else 'mix:out/loop/champion.json@20', 'jitter': True, 'ids': IDS,
                                                  'playSum': [0] * len(IDS), 'playCnt': [0] * len(IDS), 'seconds': 3.2, 'posRecords': 900, 'posGames': G, 'presets': .25, 'seedBase': 1}))
        # 独立算期望值（去重：保留先出现的那局）
        kept, seen = [], set()
        for x in recs:
            if x[26] in seen: continue
            seen.add(x[26]); kept.append(x)
        dec = [x for x in kept if x[24] != 2]
        exp['games'][r] = len(kept); exp['dups'][r] = len(recs) - len(kept); exp['timeouts'][r] = sum(x[25] >= 70 for x in kept); exp['draws'][r] = len(kept) - len(dec)
        exp['first_win'][r] = round(100 * sum(x[24] == 0 for x in dec) / len(dec), 3)
        exp['f1_first_games'][r] = sum(1 for x in kept if next((CARDS[i][2] for i in x[:12] if CARDS[i][2] != 'n'), 'n') == 'f1')
        # 拟合结果（假数字）
        rows = []
        for i, (cid, name, f, kind, cost, s) in enumerate(CARDS):
            pp = round(rnd.gauss(0, 3) + (4 if cid == 'f2_storm' else 0), 2); se = round(rnd.uniform(.6, 1.6), 2)
            rows.append([cid, name, f, kind, cost, '' if s is None else s + (r == 2 and cid == 'f2_storm') * -1, 0, 0, pp, se, round(pp / se, 2), rnd.randint(800, 9000),
                         '' if s is None else round(rnd.uniform(1, 4), 2), '' if s is None else .4, round(rnd.uniform(-2, 8), 2)])
        rows[0][9] = 'Infinity'  # 坑：Fisher=0 的牌 se 无穷（旧版 combo_fit 会写出来），ingest 要洗成空
        wcsv(fit / 'singles.csv', 'id,name,faction,kind,cost,str,boss,prize,pp,se,z,games,slope_pp,slope_se,play_delta'.split(','), rows)
        pr = [[a[0], b[0], a[1], b[1], a[2] if a[2] != 'n' else b[2], round(rnd.gauss(0, 2), 2), .8, round(rnd.gauss(0, 2.5), 2), rnd.randint(1000, 5000)]
              for a, b in [(CARDS[0], CARDS[1]), (CARDS[0], CARDS[10]), (CARDS[5], CARDS[6]), (CARDS[6], CARDS[9]), (CARDS[7], CARDS[12])]]
        wcsv(fit / 'pairs.csv', 'a,b,name_a,name_b,faction,pp,se,z,games'.split(','), sorted(pr, key=lambda x: -x[5]))
        wcsv(fit / 'triples.csv', 'a,b,c,name_a,name_b,name_c,faction,pp,se,z,games,pair_sum_pp,total_pp'.split(','),
             [['f1_knight', 'f1_guard', 'n_scout', '圣骑', '盾卫', '斥候', 'f1', 2.1, .9, 2.33, 700, 1.5, 6.2], ['f2_shade', 'f2_wind', 'f2_storm', '影刺', '疾风', '风暴', 'f2', 1.4, 1.1, 1.27, 1500, 3.0, 9.1]])
        wcsv(fit / 'factions.csv', 'faction,name,win,games'.split(','), [['f1', FN['f1'], 52.5 - r, 50 + r], ['f2', FN['f2'], 47.5 + r, 48 + r], ['n', FN['n'], 40.0, 6]])
        wcsv(fit / 'matrix.csv', 'faction,vs,win,games'.split(','), [[a, b, 50 if a == b else (55 if a == 'f1' else 45), 20] for a in ('f1', 'f2') for b in ('f1', 'f2')])
        wcsv(fit / 'neutral.csv', 'k,win,decks'.split(','), [[k, round(50 - 2 * k + rnd.uniform(-3, 3), 1), 30 - 5 * k] for k in range(5)])
        (fit / 'summary.json').write_text(json.dumps({'games': len(kept), 'rules': rules, 'ai': 'strong', 'firstWin': exp['first_win'][r], 'draws': 5.0, 'avgTurns': 30.1,
                                                      'heldOut': {'baseline': .69, 'singles': .66, 'pairs': .655, 'triples': .654}, 'nPairs': 5, 'nTriples': 2, 'seconds': 1.1}))
        (rd / 'presets.json').write_text(json.dumps({'ai': 'strong', 'per': 8, 'rates': [{'name': n, 'rate': v} for n, v in
                                                     zip(['铁壁列阵', '骑士冲锋', '影灵海', '风暴之眼'], [38.0 + 3 * r, 55.0, 62.5 - 2 * r, 47.0])], 'slopes': [], 'plan': []}))
        (rd / 'train.json').write_text(json.dumps({'records': 900, 'games': G, 'lambda': .7, 'from': None if r == 1 else 'champion.json', 'target': None,
                                                   'epochs': [{'ep': e, 'testBceOutcome': .58 - .01 * e, 'testAcc': .70 + .01 * e + .01 * r, 'testBceTarget': .5, 'testBceSearch': None if r == 1 else .45, 'seconds': 2}
                                                              for e in (1, 2)]}))
        if r == 1:
            (rd / 'gate_champ.json').write_text(json.dumps({'a': 'mix:r01/net.json@20', 'b': 'strong', 'games': 80, 'won': 44, 'p': .55}))
            (rd / 'tune.json').write_text(json.dumps({'round': 1, 'band': 4, 'outside': 4, 'ppStd': 3.1, 'presetsOutside': 2, 'applied': True, 'needs': [], 'skipped': [], 'presetsOut': [],
                'changes': [{'id': 'f2_storm', 'old': 8, 'nw': 7, 'delta': -1, 'reason': '超范围', 'pp': 6.1, 'z': 3.2, 'slope_pp': 2.5},
                            {'id': 'n_ogre', 'old': 7, 'nw': 6, 'delta': -1, 'reason': '超范围', 'pp': 5.0, 'z': 2.4, 'slope_pp': ''}]}, ensure_ascii=False))
            wcsv(rd / 'needs_design.csv', 'id,name,faction,kind,pp,z,reason'.split(','), [['f1_smite', '惩戒', 'f1', 'spell', 7.2, 3.1, '法术超范围']])
            summ = {'round': 1, 'rules': rules, 'gateVsStrong': .55, 'gateVsStrongCi': .109, 'outside': 4, 'ppStd': 3.1, 'presetsOutside': 2, 'promoted': True, 'converged': False,
                    'seconds': 120.5, 'steps': {'selfplay': 50, 'train': 40, 'gate': 30}}
        else:
            (rd / 'teacher').mkdir(exist_ok=True)
            (rd / 'teacher' / 'teacher.json').write_text(json.dumps({'teacherTurns': 120, 'avgCandidates': 5.2, 'notMasterBest': .31, 'avgQGain': .042, 'msPerTurn': 85.0}))
            (rd / 'gate_champ.json').write_text(json.dumps({'a': 'mix:out/loop/r02/net.json@20', 'b': 'mix:out/loop/champion.json@20', 'winA': .48, 'ci': .109, 'games': 80, 'msA': 9, 'msB': 9}))
            (rd / 'gate_strong.json').write_text(json.dumps({'a': 'mix:out/loop/r02/net.json@20', 'b': 'strong', 'winA': .6, 'ci': .107, 'games': 80, 'msA': 9, 'msB': 2}))
            summ = {'round': 2, 'rules': 'changed00000', 'ai': 'mix:out/loop/r01/net.json@20', 'championIn': 'out/loop/r01/net.json', 'champion': 'out/loop/r01/net.json', 'promoted': False,
                    'gateVsChamp': .48, 'gateVsChampCi': .109, 'gateVsStrong': .6, 'gateVsStrongCi': .107, 'testAcc': .74, 'testBceOutcome': .56,
                    'outside': 2, 'ppStd': 2.7, 'presetsOutside': 0, 'firstWin': 51.0, 'changes': 1, 'needsDesign': 0,
                    'seconds': {'selfplay': 60, 'teacher': 30, 'train': 30, 'gate': 20}, 'converged': '到了 2 轮'}
        (rd / 'summary.json').write_text(json.dumps(summ, ensure_ascii=False))
    th = [[1, 'f2_storm', '风暴', 'f2', 8, 7, -1, '超范围', 6.1, 3.2, 2.5, 4], [1, 'n_ogre', '食人魔', 'n', 7, 6, -1, '超范围', 5.0, 2.4, 3.0, 4],
          [1, 'f1_guard', '盾卫', 'f1', 3, 4, 1, '预设:铁壁列阵', -4.0, -2.1, 2.0, 4],  # 第 1 轮旧的一批（r01/tune.json 只有前两张，以它为准）
          [2, 'f2_storm', '风暴', 'f2', 7, 5, -2, '超范围', 6.4, 2.9, 2.4, 4], [2, 'f2_storm', '风暴', 'f2', 7, 6, -1, '超范围', 4.4, 2.6, 2.4, 4]]  # 第 2 轮重跑过，留后一行
    wcsv(out / 'tune_history.csv', 'round,id,name,faction,old_str,new_str,delta,reason,pp,z,slope_pp,band'.split(','), th)
    (out / 'state.json').write_text(json.dumps({'round': 2, 'champion': 'out/loop/champion.json', 'converged': False}))
    exp.update(tune_rows=3, tune_r2_new_str=6, converged={1: 0, 2: 1}, cards=len(CARDS) * 2, pairs=10, triples=4, presets=8, train=4, teacher=5, needs_design=1,
               gate_vs_champ={1: 55.0, 2: 48.0}, gate_vs_strong={1: 55.0, 2: 60.0}, outside={1: 4, 2: 2})
    (out / 'expected.json').write_text(json.dumps(exp, ensure_ascii=False, indent=1))
    print(f'假 loop 目录：{out}（2 轮，{sum(exp["games"].values())} 局去重后）')

if __name__ == '__main__': main()
