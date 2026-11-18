#!/usr/bin/env python3
# 看板工具的自检：造假 loop 目录 → ingest → 核对表行数、去重、超时、规则核对、gate、先手胜率和 Wilson 区间 → dashboard → 内嵌 JSON 能解析、页面脚本过 node --check。
# 用法：python3 -I tools/lab/analysis/selftest.py [--keep <目录>]（--keep：假目录和产物留在这个目录里，不删）
import importlib.util, json, re, shutil, sqlite3, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

def run(*a):
    r = subprocess.run([sys.executable, '-I', *map(str, a)], capture_output=True, text=True)
    assert r.returncode == 0, f'{a[0]} 失败：\n{r.stdout}\n{r.stderr}'
    return r.stdout

def main():
    keep = sys.argv[sys.argv.index('--keep') + 1] if '--keep' in sys.argv else None
    base = Path(keep) if keep else Path(tempfile.mkdtemp(prefix='lab-selftest-'))
    fx = base / 'fixture'
    if fx.exists(): shutil.rmtree(fx)
    try:
        run(HERE / 'make_fixture.py', fx); exp = json.loads((fx / 'expected.json').read_text(encoding='utf-8'))
        out = run(HERE / 'ingest.py', fx); print(out.strip())
        out2 = run(HERE / 'ingest.py', fx)  # 重复跑要得到同样的库
        assert out2.splitlines()[1:] == out.splitlines()[1:], '重复 ingest 行数变了'
        db = sqlite3.connect(fx / 'lab.db'); q = lambda s, *a: db.execute(s, a).fetchall()
        cnt = lambda t: q(f'SELECT COUNT(*) FROM {t}')[0][0]
        assert cnt('rounds') == 2
        assert cnt('games') == sum(exp['games'].values()), (cnt('games'), exp['games'])
        for t in ('cards', 'pairs', 'triples', 'presets', 'train', 'teacher', 'needs_design'): assert cnt(t) == exp[t], (t, cnt(t), exp[t])
        assert cnt('tune') == exp['tune_rows'], ('调整历史没清洗对', q('SELECT round,id,new_str FROM tune'))
        assert q('SELECT new_str FROM tune WHERE round=2')[0][0] == exp['tune_r2_new_str'], '第 2 轮没留最后一批'
        assert q("SELECT name, faction FROM tune WHERE round=1 AND id='n_ogre'")[0] == ('食人魔', 'n'), 'tune.json 的牌名/阵营没补上'
        for r in (1, 2):
            row = dict(zip(('games', 'dups', 'timeouts', 'draws', 'first_win', 'rules_ok', 'gc', 'gs', 'outside'),
                           q('SELECT games,dups,timeouts,draws,first_win,rules_ok,gate_vs_champ,gate_vs_strong,outside FROM rounds WHERE round=?', r)[0]))
            k = str(r)
            assert row['games'] == exp['games'][k] and row['dups'] == exp['dups'][k], (r, row)
            assert row['timeouts'] == exp['timeouts'][k] == q('SELECT SUM(timeout) FROM games WHERE round=?', r)[0][0], (r, row)
            assert row['draws'] == exp['draws'][k] == q('SELECT SUM(draw) FROM games WHERE round=?', r)[0][0]
            assert abs(row['first_win'] - exp['first_win'][k]) < 1e-6, ('先手胜率不对', r, row['first_win'], exp['first_win'][k])
            assert row['rules_ok'] == exp['rules_ok'][k], ('规则核对不对', r, row)
            assert row['gc'] == exp['gate_vs_champ'][k] and row['gs'] == exp['gate_vs_strong'][k], ('gate 不对', r, row)
            assert row['outside'] == exp['outside'][k], ('超范围棋子数不对', r, row)
            assert q('SELECT converged FROM rounds WHERE round=?', r)[0][0] == exp['converged'][k]
            assert all(x is not None for x in q('SELECT gc_lo, gc_hi, gs_lo, gs_hi FROM rounds WHERE round=?', r)[0]), ('gate 区间缺了', r)
            assert q("SELECT COUNT(*) FROM games WHERE round=? AND first_faction='f1'", r)[0][0] == exp['f1_first_games'][k], '阵营解码不对'
        assert q('SELECT COUNT(DISTINCT seed) FROM games WHERE round=1')[0][0] == exp['games']['1'], '去重不对'
        # Wilson：独立的已知值 8/10 → 49.0%–94.3%；以及表里的区间包住点估计
        spec = importlib.util.spec_from_file_location('ingest', HERE / 'ingest.py'); ing = importlib.util.module_from_spec(spec); spec.loader.exec_module(ing)
        lo, hi = ing.wilson(8, 10); assert abs(lo - 49.02) < .05 and abs(hi - 94.33) < .05, (lo, hi)
        assert ing.wilson(0, 0) == (None, None)
        for t in ('factions', 'matrix', 'neutral', 'presets'):
            col = 'rate' if t == 'presets' else 'win'
            bad = q(f'SELECT * FROM {t} WHERE lo IS NOT NULL AND NOT (lo <= {col} AND {col} <= hi)'); assert not bad, (t, bad)
        assert q("SELECT low_n FROM factions WHERE round=1 AND faction='n'")[0][0] == 1
        assert q("SELECT win FROM factions WHERE round=1 AND faction='f1'")[0][0] == 51.5
        db.close()
        # 看板
        html = fx / 'dashboard.html'
        print(run(HERE / 'dashboard.py', '--db', fx / 'lab.db', '--out', html).strip())
        s = html.read_text(encoding='utf-8')
        m = re.search(r'<script id="data" type="application/json">(.*?)</script>', s, re.S); assert m, '没找到内嵌数据'
        D = json.loads(m.group(1), parse_constant=lambda c: (_ for _ in ()).throw(AssertionError(f'内嵌 JSON 有 {c}，浏览器 JSON.parse 会失败')))
        assert len(D['rounds']) == 2 and len(D['cards']) == exp['cards'] and len(D['pairs']) == exp['pairs'] and D['factionNames']['f1'] == '圣辉骑士团'
        assert 'cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js' in s
        js = [b for a, b in re.findall(r'<script([^>]*)>(.*?)</script>', s, re.S) if 'src=' not in a and 'application/json' not in a]
        assert len(js) == 1
        node = shutil.which('node')
        if node:
            jf = base / 'dashboard_inline.js'; jf.write_text(js[0], encoding='utf-8')
            r = subprocess.run([node, '--check', str(jf)], capture_output=True, text=True); assert r.returncode == 0, r.stderr
            print('页面脚本 node --check 通过')
        else: print('没有 node，跳过页面脚本语法检查')
        print('自检通过')
    finally:
        if not keep: shutil.rmtree(base, ignore_errors=True)

if __name__ == '__main__': main()
