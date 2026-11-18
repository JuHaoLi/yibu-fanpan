#!/usr/bin/env python3
# 收敛循环的数据清洗：把 out/loop/rNN/ 下每轮的产出（自我对打、拟合、预设互打、训练报告、老师、gate、调整历史）洗进一个 SQLite 库，给 dashboard.py 出看板。
# 用法：python3 -I tools/lab/analysis/ingest.py [loop目录=out/loop] [--db <路径>=<loop目录>/lab.db]
# 每次运行都整库重建（先写临时文件，成功后替换），可以随便重复跑。只用 Python 标准库。
# 每轮读（缺哪个就跳过哪张表，不报错）：
#   selfplay/games.bin（小端 uint32，每局 27 个）、selfplay/jitter.bin（每局 24 个 int8）、selfplay/meta.json
#   fit/singles.csv pairs.csv triples.csv factions.csv matrix.csv neutral.csv summary.json（combo_fit.mjs）
#   presets.json（preset_tune.mjs 的 rates/per）、summary.json（loop.mjs）、gate_champ.json / gate_strong.json（arena.mjs 的 {a,b,winA,ci,games}）、
#   tune.json（tune_step.mjs）、含 epochs 列表的 JSON = train2.mjs 的 --report、teacher.json、needs_design.csv；loop 目录根上的 tune_history.csv、state.json
# 清洗：同一轮同一种子去重；meta.rules / summary.rules / fit 的 rules 对不上的轮标记 rules_ok=0；回合数 ≥ 70 的局标 timeout；平局单列；
#   出现局数少于 LOW_N 的牌/组合/格子标 low_n；胜率全部换成百分数并给 Wilson 95% 区间（平局算半场）。
# summary.json/gate 的字段名由 loop.mjs 决定，这里按名字模式宽松匹配（见 PAT）；对不上的数据会从局数据、拟合结果里重新算。
import argparse, csv, json, math, os, re, sqlite3, sys
from array import array
from pathlib import Path

REC, JREC, TIMEOUT_TURNS, Z = 27, 24, 70, 1.959964
LOW_N = {'cards': 3000, 'pairs': 2000, 'triples': 1000, 'factions': 1000, 'matrix': 300, 'neutral': 300}  # 样本少的阈值（局数）
PRESET_LO, PRESET_HI = 40, 60  # loop.config.json 里有 presetLo/presetHi 就用它的
CONFIG = Path(__file__).resolve().parent.parent / 'loop.config.json'

def wilson(k, n):  # 返回百分数区间
    if not n: return None, None
    p = k / n; d = 1 + Z * Z / n; c = (p + Z * Z / (2 * n)) / d; h = Z * math.sqrt(max(0.0, p * (1 - p) / n + Z * Z / (4 * n * n))) / d
    return round(100 * (c - h), 2), round(100 * (c + h), 2)

def num(x):
    if x is None or isinstance(x, bool): return x
    if isinstance(x, (int, float)): return x
    x = str(x).strip()
    if x == '' or x.lower() in ('null', 'none', 'nan', 'undefined'): return None
    try: return int(x)
    except ValueError:
        try: f = float(x)
        except ValueError: return x
        return f if math.isfinite(f) else None  # Infinity/NaN 进库后 json.dumps 会写成 JSON 不认的字面量，看板整页解析失败

def to_pct(vals):  # 一列胜率：全部 ≤ 1 当小数，乘 100
    ok = [v for v in vals if isinstance(v, (int, float))]
    k = 100 if ok and max(ok) <= 1 else 1
    return [None if not isinstance(v, (int, float)) else round(v * k, 3) for v in vals]

def pct1(v):  # 单个胜率
    return None if not isinstance(v, (int, float)) or isinstance(v, bool) else round(v * 100 if v <= 1 else v, 3)

def norm(k): return re.sub(r'[^0-9a-z]', '', str(k).lower())

def flatten(d, pre=''):
    out = {}
    if isinstance(d, dict):
        for k, v in d.items(): out.update(flatten(v, pre + norm(k)))
    else: out[pre] = d
    return out

PAT = {  # 规范化后的键（小写、去掉非字母数字、嵌套路径直接拼接）整串匹配
    'gate_vs_champ': r'.*gate.*champ(ion)?(p|pa|win|winrate|rate|awin|arate|score)?',
    'gate_vs_champ_n': r'.*gate.*champ(ion)?.*(games|n)',
    'gate_vs_strong': r'.*gate.*strong(p|pa|win|winrate|rate|awin|arate|score)?',
    'gate_vs_strong_n': r'.*gate.*strong.*(games|n)',
    'gate_vs_champ_ci': r'.*gate.*champ(ion)?ci', 'gate_vs_strong_ci': r'.*gate.*strong.*ci',
    'promoted': r'(.*gate)?(promoted|passed|pass|newchampion|accepted|champion(changed|new))',
    'outside': r'(outside|outsidepieces|piecesoutside|outofband|nout(side)?)',
    'pp_std': r'(ppstd|stdpp|singlesstd|singlesppstd|ppsd|std)',
    'presets_outside': r'(presets?outside|outsidepresets?)',
    'first_win': r'(firstwin|firstwinrate)',
    'changes': r'(changes|nchanges|changed|nchanged|changecount)',
    'converged': r'(converged|done|stop)',
    'reason': r'(convergedreason|reason|why|stopreason)',
    'seconds': r'(seconds|totalseconds|secs)',
    'band': r'band',
    'champion': r'(champion|championpath)',
    'rules': r'rules', 'ai': r'ai',
}
def pick(flat, key, kind='num'):
    for k, v in flat.items():
        if not re.fullmatch(PAT[key], k): continue
        if kind == 'num' and isinstance(v, (int, float)) and not isinstance(v, bool): return v
        if kind == 'bool' and isinstance(v, (bool, int)) and not isinstance(v, float): return int(bool(v))
        if kind == 'str' and isinstance(v, str): return v
        if kind == 'len' and isinstance(v, list): return len(v)
    return None

def jload(p):
    try: return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception as e:
        print(f'  ! 读不了 {p}：{e}', file=sys.stderr); return None

def rcsv(p):
    with open(p, encoding='utf-8-sig', newline='') as f: return [{k.strip(): num(v) for k, v in r.items() if k} for r in csv.DictReader(f)]

def find(rdir, name):  # 先找本轮目录根，再往下找（路径最短的）
    p = rdir / name
    if p.exists(): return p
    hits = sorted(rdir.rglob(name), key=lambda x: len(x.parts))
    return hits[0] if hits else None

SCHEMA = '''
CREATE TABLE rounds(round INT PRIMARY KEY, rules TEXT, rules_summary TEXT, rules_fit TEXT, rules_ok INT, ai TEXT, champion TEXT, promoted INT,
  gate_vs_champ REAL, gate_vs_champ_n INT, gc_lo REAL, gc_hi REAL, gate_vs_strong REAL, gate_vs_strong_n INT, gs_lo REAL, gs_hi REAL,
  outside INT, pp_std REAL, presets_outside INT, first_win REAL, fw_lo REAL, fw_hi REAL, draws INT, timeouts INT, dups INT, games INT,
  changes INT, band REAL, test_acc REAL, converged INT, reason TEXT, seconds REAL, steps TEXT);
CREATE TABLE games(round INT, gid INT, first_faction TEXT, second_faction TEXT, first_neutral INT, second_neutral INT, result INT, turns INT,
  seed INT, jittered INT, timeout INT, draw INT, PRIMARY KEY(round, seed));
CREATE TABLE cards(round INT, id TEXT, name TEXT, faction TEXT, kind TEXT, cost INT, str INT, boss INT, prize INT, pp REAL, se REAL, z REAL,
  games INT, slope_pp REAL, slope_se REAL, play_delta REAL, low_n INT, PRIMARY KEY(round, id));
CREATE TABLE pairs(round INT, a TEXT, b TEXT, name_a TEXT, name_b TEXT, faction TEXT, pp REAL, se REAL, z REAL, games INT, low_n INT);
CREATE TABLE triples(round INT, a TEXT, b TEXT, c TEXT, name_a TEXT, name_b TEXT, name_c TEXT, faction TEXT, pp REAL, se REAL, z REAL, games INT,
  pair_sum_pp REAL, total_pp REAL, low_n INT);
CREATE TABLE factions(round INT, faction TEXT, name TEXT, win REAL, lo REAL, hi REAL, games INT, low_n INT);
CREATE TABLE matrix(round INT, faction TEXT, vs TEXT, win REAL, lo REAL, hi REAL, games INT, low_n INT);
CREATE TABLE neutral(round INT, k INT, win REAL, lo REAL, hi REAL, decks INT, low_n INT);
CREATE TABLE presets(round INT, deck TEXT, rate REAL, lo REAL, hi REAL, games INT, outside INT);
CREATE TABLE tune(round INT, id TEXT, name TEXT, faction TEXT, old_str INT, new_str INT, delta INT, reason TEXT, pp REAL, z REAL, slope_pp REAL, band REAL);
CREATE TABLE needs_design(round INT, id TEXT, name TEXT, faction TEXT, kind TEXT, pp REAL, z REAL, reason TEXT, raw TEXT);
CREATE TABLE train(round INT, ep INT, test_bce_outcome REAL, test_acc REAL, test_bce_target REAL, test_bce_search REAL, seconds REAL, records INT, games INT, lambda REAL);
CREATE TABLE teacher(round INT, key TEXT, value REAL);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX games_round ON games(round);
'''

def ins(db, table, rows):
    rows = list(rows)
    if not rows: return 0
    cols = list(rows[0].keys())
    db.executemany(f'INSERT INTO {table}({",".join(cols)}) VALUES({",".join("?" * len(cols))})', [tuple(r.get(c) for c in cols) for r in rows])
    return len(rows)

def ingest_games(db, rnd, sp, fac_of):
    meta = jload(sp / 'meta.json') or {}
    gb = sp / 'games.bin'
    if not gb.exists(): return meta, None
    raw = gb.read_bytes(); n = len(raw) // (4 * REC)
    g = array('I'); g.frombytes(raw[:n * REC * 4])
    j = array('b')
    jr = (sp / 'jitter.bin').read_bytes() if (sp / 'jitter.bin').exists() else b''
    if len(jr) >= n * JREC: j.frombytes(jr[:n * JREC])  # 长度不够（没抖动/写坏了）就当没抖动
    if sys.byteorder == 'big': g.byteswap()
    ids = meta.get('ids') or []
    fac = [fac_of.get(i, '?') for i in ids]
    seen, rows, dups = set(), [], 0
    def side(o):
        fs = [fac[g[o + i]] if g[o + i] < len(fac) else '?' for i in range(12)]
        f = next((x for x in fs if x != 'n'), 'n')
        return f, fs.count('n')
    for gid in range(n):
        o = gid * REC; seed = g[o + 26]
        if seed in seen: dups += 1; continue
        seen.add(seed)
        f0, n0 = side(o); f1, n1 = side(o + 12); res, turns = g[o + 24], g[o + 25]
        jit = int(any(j[gid * JREC:(gid + 1) * JREC])) if len(j) else 0
        rows.append((rnd, gid, f0, f1, n0, n1, res, turns, seed, jit, int(turns >= TIMEOUT_TURNS), int(res == 2)))
    db.executemany('INSERT INTO games VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', rows)
    first = sum(1 for r in rows if r[6] == 0); decided = sum(1 for r in rows if r[6] != 2)
    return meta, dict(games=len(rows), dups=dups, draws=len(rows) - decided, timeouts=sum(r[10] for r in rows),
                      first_win=round(100 * first / decided, 3) if decided else None, fw=wilson(first, decided))

def main():
    ap = argparse.ArgumentParser(description='把收敛循环每轮的产出洗进 SQLite')
    ap.add_argument('loop', nargs='?', default='out/loop'); ap.add_argument('--db')
    a = ap.parse_args()
    loop = Path(a.loop); dbp = Path(a.db) if a.db else loop / 'lab.db'
    if not loop.is_dir(): sys.exit(f'没有这个目录：{loop}')
    lo, hi, bands = PRESET_LO, PRESET_HI, None
    cfg = jload(CONFIG) if CONFIG.exists() else None
    if isinstance(cfg, dict): lo, hi, bands = cfg.get('presetLo', lo), cfg.get('presetHi', hi), cfg.get('bands')
    rdirs = sorted((int(m.group(1)), p) for p in loop.iterdir() if p.is_dir() and (m := re.fullmatch(r'r(\d+)', p.name)))
    if not rdirs: print(f'  ! {loop} 下没有 rNN 目录', file=sys.stderr)
    tmp = dbp.with_name(dbp.name + '.tmp'); tmp.parent.mkdir(parents=True, exist_ok=True)
    if tmp.exists(): tmp.unlink()
    db = sqlite3.connect(tmp); db.executescript(SCHEMA)

    fac_of, name_of = {}, {}  # id → 阵营/名字：从所有轮的 singles.csv 拿（别去解析 JS）
    singles = {}
    for rnd, rd in rdirs:
        p = rd / 'fit' / 'singles.csv'
        if p.exists():
            singles[rnd] = rcsv(p)
            for r in singles[rnd]: fac_of[str(r.get('id'))], name_of[str(r.get('id'))] = r.get('faction'), r.get('name')
    # 调整历史：tune_history.csv 只追加（重跑、退回某轮都会再追加），每轮只留最后一批：同一轮连续的行算一批，同一张牌再出现就是新的一批。
    # rNN/tune.json（每次 --apply 覆盖）里有 changes 的轮，以它为准。
    TC = ('round', 'id', 'name', 'faction', 'old_str', 'new_str', 'delta', 'reason', 'pp', 'z', 'slope_pp', 'band')
    tune_by, tp = {}, loop / 'tune_history.csv'
    if tp.exists():
        prev, ids = None, set()
        for r in rcsv(tp):
            rr = r.get('round')
            if rr != prev or r.get('id') in ids: tune_by[rr], ids = [], set()  # 新的一批
            prev = rr; ids.add(r.get('id')); tune_by[rr].append({c: r.get(c) for c in TC})

    for rnd, rd in rdirs:
        sp = rd / 'selfplay' / 'games.bin'
        sp = sp if sp.exists() else find(rd, 'games.bin'); meta, gs = ingest_games(db, rnd, sp.parent, fac_of) if sp else ({}, None)
        summ = (jload(rd / 'summary.json') if (rd / 'summary.json').exists() else None) or {}
        tj = (jload(rd / 'tune.json') if (rd / 'tune.json').exists() else None) or {}
        flat = {**flatten(tj), **flatten(summ)}  # summary 优先，缺的从 tune.json 补（outside/ppStd/presetsOutside/changes）
        if isinstance(tj.get('changes'), list):
            tune_by[rnd] = [dict(round=rnd, id=c.get('id'), name=name_of.get(c.get('id')), faction=fac_of.get(c.get('id')), old_str=num(c.get('old')), new_str=num(c.get('nw')),
                                 delta=num(c.get('delta')), reason=c.get('reason'), pp=num(c.get('pp')), z=num(c.get('z')), slope_pp=num(c.get('slope_pp')), band=num(tj.get('band')))
                            for c in tj['changes'] if isinstance(c, dict)]
        fsum = jload(rd / 'fit' / 'summary.json') if (rd / 'fit' / 'summary.json').exists() else {}
        R = dict(round=rnd, rules=meta.get('rules') or (fsum or {}).get('rules'), rules_summary=pick(flat, 'rules', 'str'), rules_fit=(fsum or {}).get('rules'),
                 ai=meta.get('ai') or pick(flat, 'ai', 'str'), champion=pick(flat, 'champion', 'str'), promoted=pick(flat, 'promoted', 'bool'))
        rs = [x for x in (meta.get('rules'), R['rules_summary'], R['rules_fit']) if x]
        R['rules_ok'] = int(len(set(rs)) <= 1) if rs else None
        # gate：summary 里有就用；缺的胜率/局数从 gate_champ.json / gate_strong.json（arena.mjs 的 {a,b,winA,ci,games}）补
        for k, a2, fname in (('gate_vs_champ', 'gc', 'gate_champ.json'), ('gate_vs_strong', 'gs', 'gate_strong.json')):
            R[k], R[k + '_n'], ci = pct1(pick(flat, k)), pick(flat, k + '_n'), pick(flat, k + '_ci')
            gf = flatten(jload(rd / fname) or {}) if (rd / fname).exists() else {}
            n = next((v for kk, v in gf.items() if kk in ('games', 'n') and isinstance(v, (int, float))), None)
            rate = next((v for kk, v in gf.items() if re.fullmatch(r'(wina|p|pa|win|winrate|rate|awin|arate|score)', kk) and isinstance(v, (int, float))), None)
            if rate is None and isinstance(gf.get('won'), (int, float)) and n: rate = gf['won'] / n
            if R[k] is None: R[k] = pct1(rate)
            if R[k + '_n'] is None and n and (rate is None or abs(pct1(rate) - R[k]) < 1e-6): R[k + '_n'] = n
            if ci is None: ci = gf.get('ci')
            if R[k] is not None and R[k + '_n']: R[a2 + '_lo'], R[a2 + '_hi'] = wilson(R[k] / 100 * R[k + '_n'], R[k + '_n'])
            elif R[k] is not None and isinstance(ci, (int, float)):  # 没有局数（第 1 轮对 strong 就是对冠军那场），用它给的 ±ci
                c = ci * 100 if ci <= 1 else ci; R[a2 + '_lo'], R[a2 + '_hi'] = round(R[k] - c, 2), round(R[k] + c, 2)
            else: R[a2 + '_lo'] = R[a2 + '_hi'] = None
        if gs:
            R.update(games=gs['games'], dups=gs['dups'], draws=gs['draws'], timeouts=gs['timeouts'], first_win=gs['first_win'])
            R['fw_lo'], R['fw_hi'] = gs['fw']
        else:
            R['games'], R['first_win'] = (fsum or {}).get('games'), pct1(pick(flat, 'first_win') or (fsum or {}).get('firstWin'))
        # 单卡
        cards = []
        for r in singles.get(rnd, []):
            c = {k: r.get(k) for k in ('id', 'name', 'faction', 'kind', 'cost', 'str', 'boss', 'prize', 'pp', 'se', 'z', 'games', 'slope_pp', 'slope_se', 'play_delta')}
            c['id'] = str(c['id']); c['round'] = rnd; c['low_n'] = int((c['games'] or 0) < LOW_N['cards'])
            for b in ('boss', 'prize'): c[b] = int(c[b] in (1, True, 'true', 'True')) if c[b] is not None else 0
            cards.append(c)
        ins(db, 'cards', cards)
        pps = [c['pp'] for c in cards if isinstance(c['pp'], (int, float))]
        std = round(math.sqrt(sum((x - sum(pps) / len(pps)) ** 2 for x in pps) / len(pps)), 3) if pps else None
        R['pp_std'] = pick(flat, 'pp_std') if pick(flat, 'pp_std') is not None else std
        R['outside'] = pick(flat, 'outside')
        if R['outside'] is None: R['outside'] = pick(flat, 'outside', 'len')
        # 组合
        for t, cols in (('pairs', ('a', 'b', 'name_a', 'name_b', 'faction', 'pp', 'se', 'z', 'games')),
                        ('triples', ('a', 'b', 'c', 'name_a', 'name_b', 'name_c', 'faction', 'pp', 'se', 'z', 'games', 'pair_sum_pp', 'total_pp'))):
            p = rd / 'fit' / f'{t}.csv'
            if p.exists(): ins(db, t, ({**{c: r.get(c) for c in cols}, 'round': rnd, 'low_n': int((r.get('games') or 0) < LOW_N[t])} for r in rcsv(p)))
        for t, kcol, ncol, cols in (('factions', 'faction', 'games', ('faction', 'name')), ('matrix', 'faction', 'games', ('faction', 'vs')), ('neutral', 'k', 'decks', ('k',))):
            p = rd / 'fit' / f'{t}.csv'
            if not p.exists(): continue
            rows = rcsv(p); wins = to_pct([r.get('win') for r in rows]); out = []
            for r, w in zip(rows, wins):
                n = r.get(ncol) or 0; l, h = wilson(w / 100 * n, n) if w is not None and n else (None, None)
                out.append({**{c: r.get(c) for c in cols}, 'round': rnd, 'win': w, 'lo': l, 'hi': h, ncol: n, 'low_n': int(n < LOW_N[t])})
            ins(db, t, out)
        # 预设
        pj = find(rd, 'presets.json'); pr = jload(pj) if pj else None
        if isinstance(pr, dict) and isinstance(pr.get('rates'), list):
            rates = pr['rates']; per = pr.get('per'); ng = per * (len(rates) - 1) if isinstance(per, (int, float)) else None
            vals = to_pct([x.get('rate') for x in rates]); out = []
            for x, v in zip(rates, vals):
                l, h = wilson(v / 100 * ng, ng) if v is not None and ng else (None, None)
                out.append(dict(round=rnd, deck=x.get('name'), rate=v, lo=l, hi=h, games=ng, outside=int(v is not None and not lo <= v <= hi)))
            ins(db, 'presets', out)
            R['presets_outside'] = pick(flat, 'presets_outside')
            if R['presets_outside'] is None: R['presets_outside'] = sum(o['outside'] for o in out)
        else: R['presets_outside'] = pick(flat, 'presets_outside')
        # 训练报告（含 epochs 列表的 JSON）、老师
        R['test_acc'] = None
        for p in sorted(rd.rglob('*.json'), key=lambda x: ('train' not in x.name, len(x.parts))):
            if p.stat().st_size > 500_000 or p.name in ('meta.json', 'summary.json', 'presets.json', 'teacher.json'): continue
            d = jload(p)
            if not (isinstance(d, dict) and isinstance(d.get('epochs'), list)): continue
            eps = [e for e in d['epochs'] if isinstance(e, dict)]
            accs = to_pct([e.get('testAcc') for e in eps])
            ins(db, 'train', (dict(round=rnd, ep=e.get('ep', i + 1), test_bce_outcome=e.get('testBceOutcome'), test_acc=acc, test_bce_target=e.get('testBceTarget'),
                                   test_bce_search=e.get('testBceSearch'), seconds=e.get('seconds'), records=d.get('records'), games=d.get('games'), **{'lambda': d.get('lambda')})
                              for i, (e, acc) in enumerate(zip(eps, accs))))
            R['test_acc'] = accs[-1] if accs else None
            break
        tj = find(rd, 'teacher.json'); td = jload(tj) if tj else None
        if isinstance(td, dict):
            ins(db, 'teacher', (dict(round=rnd, key=k, value=v) for k, v in flatten_keep(td).items() if isinstance(v, (int, float)) and not isinstance(v, bool)))
        nd = find(rd, 'needs_design.csv')
        if nd:
            ins(db, 'needs_design', ({**{c: r.get(c) for c in ('id', 'name', 'faction', 'kind', 'pp', 'z', 'reason')}, 'round': rnd, 'raw': json.dumps(r, ensure_ascii=False)} for r in rcsv(nd)))
        # 其余 summary 字段
        ch = pick(flat, 'changes')
        if ch is None: ch = pick(flat, 'changes', 'len')
        R['changes'] = ch if ch is not None else (len(tune_by[rnd]) if rnd in tune_by else None)
        tb = [t['band'] for t in tune_by.get(rnd, []) if isinstance(t['band'], (int, float))]
        R['band'] = pick(flat, 'band') if pick(flat, 'band') is not None else (max(tb) if tb else (bands[min(rnd, len(bands) - 1)] if bands else None))
        cv = summ.get('converged')  # loop.mjs：收敛原因（字符串）或 null
        R['converged'] = int(bool(cv)) if 'converged' in summ else None
        R['reason'] = cv if isinstance(cv, str) else pick(flat, 'reason', 'str')
        sec, steps = summ.get('seconds'), summ.get('steps') or summ.get('stepSeconds') or summ.get('times')
        if isinstance(sec, dict): steps, sec = sec, sum(v for v in sec.values() if isinstance(v, (int, float)))  # loop.mjs：{步骤: 秒}
        R['seconds'] = sec if isinstance(sec, (int, float)) else None
        R['steps'] = json.dumps(steps, ensure_ascii=False) if steps is not None else None
        ins(db, 'rounds', [R])
    ins(db, 'tune', (t for k in sorted(tune_by, key=lambda x: (x is None, x if isinstance(x, (int, float)) else 0)) for t in tune_by[k]))

    st = jload(loop / 'state.json') if (loop / 'state.json').exists() else None
    from datetime import datetime
    ins(db, 'meta', [dict(key=k, value=json.dumps(v, ensure_ascii=False)) for k, v in dict(
        loop=str(loop.resolve()), built=datetime.now().strftime('%Y-%m-%d %H:%M'), presetLo=lo, presetHi=hi, bands=bands, lowN=LOW_N, timeoutTurns=TIMEOUT_TURNS,
        state={k: v for k, v in (st or {}).items() if not isinstance(v, (dict, list)) or k in ('converged', 'convergence', 'done')}).items()])
    db.commit()
    counts = {t: db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY rowid")}
    bad = [r for (r,) in db.execute('SELECT round FROM rounds WHERE rules_ok = 0')]
    db.close(); os.replace(tmp, dbp)
    print(f'已写 {dbp}（{len(rdirs)} 轮）')
    for t, c in counts.items(): print(f'  {t:13s}{c:>9} 行')
    if bad: print(f'  ! 规则版本对不上的轮：{bad}')

def flatten_keep(d, pre=''):  # 老师统计：保留可读的键名（用点连接）
    out = {}
    for k, v in d.items():
        if isinstance(v, dict): out.update(flatten_keep(v, pre + k + '.'))
        else: out[pre + k] = v
    return out

if __name__ == '__main__': main()
