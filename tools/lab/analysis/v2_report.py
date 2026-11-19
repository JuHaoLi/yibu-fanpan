#!/usr/bin/env python3
# 第 2 代网络（会看卡组）的统计报告：从 out/v2/ 读三版的训练、过关赛、同一考卷上的网络统计、逐套卡组对阵、DeepSeek 陪练记录，输出一个自包含 HTML（ECharts 5.4.3 / cdnjs）。
# 用法：python3 -I tools/lab/analysis/v2_report.py [--dir out/v2] [--out <dir>/report.html]；python3 -I tools/lab/analysis/v2_report.py --selftest
# 读（缺哪个就跳过那一节）：probe.json（deck_probe 对照实验）；vNN/summary.txt、train.json、gate_*.json、selfplay/meta.json（round.sh）；
#   stats/net_stats.json（net_stats.py）、stats/deck_*.json（deck_matrix.mjs）、stats/base_*.json（arena.mjs 基线）；agent/games/*.json、agent/notes.md（board_cli / agent_run）
# 只用 Python 标准库。
import argparse, glob, json, os, re, sys, tempfile
from pathlib import Path

def jl(p):
    try: return json.load(open(p, encoding='utf-8'))
    except (OSError, ValueError): return None

GATE = re.compile(r'^(\S+) 对 (\S+)：A 胜率 ([\d.]+)% ± ([\d.]+)（(\d+) 局')
def parse_summary(txt):  # round.sh 的 summary.txt → 过关赛列表 + 最后一轮考卷成绩
    gates, last = [], None
    for ln in txt.splitlines():
        m = GATE.match(ln)
        if m: gates.append({'a': m[1], 'b': m[2], 'win': float(m[3]), 'ci': float(m[4]), 'games': int(m[5])})
        m = re.search(r'交叉熵 ([\d.]+)，猜对 ([\d.]+)%', ln)
        if m: last = {'bce': float(m[1]), 'acc': float(m[2])}
    return gates, last

def short(spec):  # 'mix:out/v2/v22/net.json@20' → 'v22'
    m = re.search(r'(v2\d)/net\.json|net-(g\d)', spec)
    return (m[1] or m[2]) if m else spec

def build(D):
    D = Path(D); R = {'versions': [], 'probe': None, 'stats': jl(D / 'stats/net_stats.json'), 'decks': {}, 'base': {}, 'agent': [], 'notes': ''}
    p = jl(D / 'probe.json')
    if p: R['probe'] = {'records': p['records'], 'test': p['test'], 'models': [{'model': m['model'], 'H1': m['H1'], 'H2': m['H2'], 'extra': m['extra'], 'params': m['params'], **m['epochs'][-1]} for m in p['models']]}
    for v in sorted(D.glob('v2[0-9]')):
        s = (v / 'summary.txt').read_text(encoding='utf-8') if (v / 'summary.txt').exists() else ''
        gates, last = parse_summary(s); t = jl(v / 'train.json') or {}; meta = jl(v / 'selfplay/meta.json') or {}
        ep = next((m['epochs'] for m in t.get('models', []) if m['model'] == 'v2'), [])
        init = re.search(r'从 (\S+) 起步', s + (v / 'train.log').read_text(encoding='utf-8') if (v / 'train.log').exists() else s)
        R['versions'].append({'name': v.name, 'gates': [dict(g, a=short(g['a']), b=short(g['b'])) for g in gates], 'last': last, 'epochs': ep,
            'records': t.get('records'), 'dirs': t.get('dirs'), 'games': meta.get('games'), 'posRecords': meta.get('posRecords'), 'ai': short(meta.get('ai', '')),
            'league': [short(x) for x in meta.get('league') or []], 'lshare': meta.get('lshare'), 'extraDecks': meta.get('extraDecks'), 'seconds': meta.get('seconds'), 'init': init[1] if init else None})
    for f in sorted(D.glob('stats/deck_*.json')): R['decks'][f.stem[5:]] = jl(f)
    for f in sorted(D.glob('stats/base_*.json')):
        b = jl(f); R['base'][f.stem[5:]] = b and {'a': short(b['a']), 'b': short(b['b']), 'win': round(100 * b['winA'], 1), 'ci': round(100 * b['ci'], 1), 'games': b['games']}
    for f in sorted(glob.glob(str(D / 'agent/games/*.json'))):
        o = jl(f)
        if o and o.get('done'): R['agent'].append({'t': Path(f).stem[:16], 'net': short(o['net']), 'win': o['winner'] == 0, 'turns': o['turns'], 'base': o['base'], 'moves': len(o['moves']), 'mine': o['mine'], 'theirs': o['theirs']})
    nf = D / 'agent/notes.md'; R['notes'] = nf.read_text(encoding='utf-8') if nf.exists() else ''
    secs = [x for x in re.split(r'\n(?=## )', R['notes']) if x.startswith('## ')]  # 每局一段复盘；数"大师电脑不守自家城门"被提到几次
    R['gateNotes'] = [len(secs), sum(1 for x in secs if re.search(r'(城门|d4)[^。\n]{0,30}(空|裸奔|不设防|不守|敞开)|不守[^。\n]{0,6}门', x))]
    return R

def selftest():
    s = '[1 v22] 自我对打\n[ 9s] v2 第 4 轮：考卷交叉熵 0.4771，猜对 75.99%（86 秒）\nmix:out/v2/v22/net.json@20 对 mix:assets/ai/net-g4.json@20：A 胜率 55.0% ± 1.5（4000 局，22 秒）；x\nmix:out/v2/v22/net.json@20 对 strong：A 胜率 71.8% ± 1.4（4000 局，19 秒）'
    g, last = parse_summary(s)
    assert [(short(x['a']), short(x['b']), x['win'], x['games']) for x in g] == [('v22', 'g4', 55.0, 4000), ('v22', 'strong', 71.8, 4000)], g
    assert last == {'bce': .4771, 'acc': 75.99}, last
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(f'{d}/v22/selfplay'); open(f'{d}/v22/summary.txt', 'w', encoding='utf-8').write(s); json.dump({'games': 10, 'league': ['strong']}, open(f'{d}/v22/selfplay/meta.json', 'w'))
        R = build(d); assert R['versions'][0]['gates'][0]['win'] == 55.0 and R['versions'][0]['league'] == ['strong'] and R['probe'] is None
        html(R)
    print('自检通过')

def html(R):
    return PAGE.replace('__DATA__', json.dumps(R, ensure_ascii=False).replace('</', '<\\/'))

PAGE = r'''<title>大师电脑第二代网络</title>
<meta name="claude:viewport-fit-sides" content="cover">
<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js"></script>
<style>
/* 布局：单栏长报告，结论在前、细节在后；每节一个标题 + 一句话结论 + 图/表 */
:root{--bg:#f4f5f7;--card:#fff;--fg:#1c2230;--mut:#687080;--line:#e2e5ea;--acc:#2f6bd8;--g4:#9aa2ae;--good:#1f8a5b;--bad:#c2412d;--chip:#eef1f5;--hl:#fff6d6;
  --sans:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111318;--card:#1a1d23;--fg:#e5e7eb;--mut:#9aa2ae;--line:#2a2f37;--acc:#7aa7ff;--g4:#6b7380;--good:#4cc38a;--bad:#ff8a70;--chip:#252a32;--hl:#3a3420;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#111318;--card:#1a1d23;--fg:#e5e7eb;--mut:#9aa2ae;--line:#2a2f37;--acc:#7aa7ff;--g4:#6b7380;--good:#4cc38a;--bad:#ff8a70;--chip:#252a32;--hl:#3a3420;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:15px/1.65 var(--sans)}
main{max-width:980px;margin:0 auto;padding-block:28px 64px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:22px}
h1{font-size:28px;line-height:1.25;margin:0;text-wrap:balance} h2{font-size:19px;margin:0;text-wrap:balance} p{margin:0;max-width:68ch}
.lede{color:var(--mut)} .mut{color:var(--mut);font-size:13px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;display:grid;gap:12px;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;display:grid;gap:2px}
.kpi b{font:600 26px/1.2 var(--mono);font-variant-numeric:tabular-nums} .kpi span{color:var(--mut);font-size:13px}
.chart{width:100%;height:320px} .chart.tall{height:420px}
.tw{overflow-x:auto} table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap} th:first-child,td:first-child{text-align:left}
th{color:var(--mut);font-weight:500;font-size:12px;letter-spacing:.04em}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--chip)} .pill.ok{color:var(--good)} .pill.no{color:var(--bad)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px} .grid2>div{min-width:0}
ul{margin:0;padding-left:1.2em;display:grid;gap:4px;max-width:72ch} code{font:13px var(--mono);background:var(--chip);padding:0 4px;border-radius:4px}
.note{background:var(--hl);border-radius:8px;padding:10px 12px}
#nolib{display:none}
</style>
<main id="app">
<header style="display:grid;gap:8px"><h1>大师电脑第二代网络</h1>
<p class="lede">第 2 代价值网络（net-g5，已上线）除了棋盘，还会看三样玩家本来就知道的信息：自己整副卡组、牌库里还剩的牌、对面已经亮过的牌。下面是对照实验、三版训练、同一份考卷上的统计、逐套卡组对阵和 DeepSeek 陪练的全部数字。</p>
<p class="mut" id="nolib">图表库没加载出来，下面只显示表格。</p></header>
<div class="kpis" id="kpis"></div>
<section><h2>一、为什么加这三样输入：对照实验</h2><p id="probeTxt"></p><div class="chart" id="cProbe"></div><div class="tw" id="tProbe"></div></section>
<section><h2>二、三版训练和过关赛</h2><p id="verTxt"></p><div class="tw" id="tVer"></div><div class="grid2"><div class="chart" id="cGate"></div><div class="chart" id="cEpoch"></div></div></section>
<section><h2>三、同一份考卷上比四个网络</h2><p id="statTxt"></p><div class="tw" id="tStat"></div><div class="grid2"><div class="chart" id="cTurn"></div><div class="chart" id="cCal"></div></div></section>
<section><h2>四、网络到底用没用卡组信息</h2><p id="permTxt"></p><div class="grid2"><div class="chart" id="cPerm"></div><div class="chart" id="cBlock"></div></div></section>
<section><h2>五、逐套预设卡组</h2><p id="deckTxt"></p><div class="chart tall" id="cDeck"></div><div class="tw" id="tDeck"></div></section>
<section><h2>六、DeepSeek 陪练</h2><p id="agentTxt"></p><div class="tw" id="tAgent"></div></section>
<section><h2>七、结论和下一步</h2><ul id="concl"></ul></section>
</main>
<script>
const R = __DATA__;
const $ = s => document.querySelector(s), css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const pct = (x, d = 1) => x == null ? '—' : (+x).toFixed(d) + '%', f4 = x => x == null ? '—' : (+x).toFixed(4);
const table = (el, head, rows) => { $(el).innerHTML = `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`; };
const charts = [], dark = matchMedia('(prefers-color-scheme: dark)');
function chart(id, opt) { if (!window.echarts) return; const c = echarts.init(document.getElementById(id)); const t = { color: css('--fg'), fontFamily: css('--sans') }, ax = { axisLine: { lineStyle: { color: css('--line') } }, splitLine: { lineStyle: { color: css('--line') } }, axisLabel: { color: css('--mut') }, nameTextStyle: { color: css('--mut') } };
  for (const k of ['xAxis', 'yAxis']) if (opt[k]) opt[k] = [].concat(opt[k]).map(a => ({ ...ax, ...a }));
  c.setOption({ textStyle: t, grid: { left: 56, right: 16, top: 36, bottom: 40, containLabel: true }, legend: { top: 0, textStyle: { color: css('--mut') } }, tooltip: { trigger: 'axis' }, ...opt }); charts.push([c, id, opt]); }
addEventListener('resize', () => charts.forEach(([c]) => c.resize()));
if (!window.echarts) $('#nolib').style.display = 'block';
const V = Object.fromEntries(R.versions.map(v => [v.name, v])), gate = (v, b) => V[v]?.gates.find(g => g.b === b), S = R.stats?.nets || {}, base = R.base.g4s;
const ACC = () => css('--acc'), G4 = () => css('--g4');

// KPI
const live = 'v22', g = gate(live, 'g4'), gs = gate(live, 'strong');
$('#kpis').innerHTML = [[pct(g?.win), '上线版对 g4 胜率', `±${g?.ci} · ${g?.games} 局`], [pct(gs?.win), '对满强度电脑', `g4 是 ${pct(base?.win)}`],
  [pct(100 * (S.v22?.acc ?? 0), 1), '考卷上猜对胜负', `g4 是 ${pct(100 * (S.g4?.acc ?? 0))}`], [(R.versions.find(v => v.name === live)?.records / 1e6 || 0).toFixed(1) + 'M', '训练用的局面', '两轮各 40 万局自我对打']]
  .map(([b, s, m]) => `<div class="kpi"><b>${b}</b><span>${s}</span><span class="mut">${m}</span></div>`).join('');

// 一、对照
if (R.probe) { const P = R.probe.models, lab = { m0: '只看棋盘', m1: '+ 自己卡组', m2: '+ 对面整副（对照）', m0big: '只看棋盘 · 大 4 倍', m1big: '+ 自己卡组 · 大 4 倍' };
  $('#probeTxt').textContent = `用旧循环的 ${(R.probe.records / 1e6).toFixed(1)}M 条局面训了 5 个网络，留出 ${(R.probe.test / 1e3).toFixed(0)}k 条当考卷。网络加大 4 倍几乎没用（猜对 +0.1 个点）；看到自己卡组 +1.1 个点；如果能看到对面整副卡组 +4.8 个点。对面整副是作弊信息，游戏里只能用"对面亮过的牌"去逼近，所以第 2 代加的是自己整副、牌库剩余、对面亮过的牌三块，网络大小不变。`;
  chart('cProbe', { tooltip: {}, xAxis: { type: 'category', data: P.map(m => lab[m.model] || m.model), axisLabel: { interval: 0, rotate: 18, color: css('--mut') } }, yAxis: { type: 'value', name: '猜对 %', min: 70 }, series: [{ type: 'bar', data: P.map(m => +(100 * m.testAcc).toFixed(2)), itemStyle: { color: p => P[p.dataIndex].model === 'm2' ? css('--mut') : ACC() }, label: { show: true, position: 'top', color: css('--fg') } }] });
  table('#tProbe', ['网络', '第一层/第二层', '参数', '考卷交叉熵', '猜对'], P.map(m => [lab[m.model] || m.model, `${m.H1}/${m.H2}`, m.params.toLocaleString(), f4(m.testBce), pct(100 * m.testAcc, 2)])); }

// 二、三版
const VN = { v21: 'v2.1', v22: 'v2.2', v23: 'v2.3' }, how = { v21: '从零训练，g4 当陪练', v22: '从 g4 起步，联赛陪练 + agent 卡组', v23: '从 v2.2 接着练，联赛加 v2.1' };
$('#verTxt').textContent = '过关线：对上一版冠军 ≥ 52%，或者对上一版不输、对满强度高 2 个点。每场 4000 局，同一对卡组、同一个种子两边各先手一次，只有电脑不同。';
table('#tVer', ['版本', '做法', '自我对打', '对 g4', '对满强度', '对上一版', '结果'], R.versions.map(v => { const c = gate(v.name, 'g4'), s = gate(v.name, 'strong'), p = v.gates.find(x => /^v2\d$/.test(x.b));
  const ok = v.name === 'v22'; return [VN[v.name] || v.name, how[v.name] || '', `${(v.games / 1e4).toFixed(0)} 万局 · ${v.ai}${v.league.length ? ' + 联赛 ' + v.league.join('/') : ''}`, c ? `${pct(c.win)} ±${c.ci}` : '—', s ? `${pct(s.win)} ±${s.ci}` : '—', p ? `${pct(p.win)}（对 ${VN[p.b] || p.b}）` : '—', `<span class="pill ${ok ? 'ok' : 'no'}">${ok ? '过关 → 上线' : '未过关'}</span>`]; }));
chart('cGate', { title: { text: '过关赛胜率', textStyle: { fontSize: 13, color: css('--mut') }, left: 0 }, legend: { top: 0, right: 0 }, tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: R.versions.map(v => VN[v.name]) }, yAxis: { type: 'value', min: 45, max: 75, name: '%' },
  series: [{ name: '对 g4', type: 'bar', data: R.versions.map(v => gate(v.name, 'g4')?.win), itemStyle: { color: ACC() } }, { name: '对满强度', type: 'bar', data: R.versions.map(v => gate(v.name, 'strong')?.win), itemStyle: { color: css('--good') } },
    { name: 'g4 对满强度', type: 'line', data: R.versions.map(() => base?.win), symbol: 'none', lineStyle: { type: 'dashed', color: G4() }, itemStyle: { color: G4() } }, { name: '过关线 52%', type: 'line', data: R.versions.map(() => 52), symbol: 'none', lineStyle: { type: 'dotted', color: css('--bad') }, itemStyle: { color: css('--bad') } }] });
chart('cEpoch', { title: { text: '训练每一轮的考卷交叉熵（越低越好）', textStyle: { fontSize: 13, color: css('--mut') }, left: 0 }, legend: { top: 18, right: 0 }, grid: { top: 56, left: 56, right: 16, bottom: 30, containLabel: true }, xAxis: { type: 'category', data: [1, 2, 3, 4], name: '轮' }, yAxis: { type: 'value', scale: true },
  series: R.versions.map((v, i) => ({ name: VN[v.name], type: 'line', data: v.epochs.map(e => e.testBce), symbolSize: 6 })) });

// 三、同一考卷
if (R.stats) { const N = ['g4', 'v21', 'v22', 'v23'].filter(k => S[k]);
  $('#statTxt').textContent = `考卷是 v2.3 那轮自我对打留出的 ${(R.stats.test / 1e3).toFixed(0)}k 条局面，四个网络都没在上面训练过（v2.3 训练用的是同一轮的另外 97%）。猜对胜负提高了 5 个多点，但下棋只强了一点：v2.1 猜得比 g4 准 4 个点，对 g4 却只有 50.7%。猜胜负准不等于会选棋——卡组信息最能帮着判断"这副牌对那副牌谁占优"，可选棋时比较的是同一局面下几种走法的差别，这部分它帮得少。`;
  table('#tStat', ['网络', '考卷交叉熵', '猜对胜负', 'Brier'], N.map(k => [k === 'g4' ? 'g4（第 1 代，线上旧版）' : VN[k] + (k === 'v22' ? '（net-g5，线上）' : ''), f4(S[k].bce), pct(100 * S[k].acc, 2), f4(S[k].brier)]));
  chart('cTurn', { title: { text: '按回合段猜对胜负', textStyle: { fontSize: 13, color: css('--mut') }, left: 0 }, legend: { top: 18, right: 0 }, grid: { top: 56, left: 56, right: 16, bottom: 30, containLabel: true }, xAxis: { type: 'category', data: R.stats.turnBins, name: '回合' }, yAxis: { type: 'value', min: 50, name: '%' },
    series: N.map(k => ({ name: VN[k] || k, type: 'line', data: S[k].byTurn.map(b => +(100 * b.acc).toFixed(1)), lineStyle: k === 'g4' ? { type: 'dashed' } : {}, symbolSize: 5 })) });
  chart('cCal', { title: { text: '校准：预测胜率 vs 实际胜率', textStyle: { fontSize: 13, color: css('--mut') }, left: 0 }, legend: { top: 18, right: 0 }, grid: { top: 56, left: 56, right: 16, bottom: 30, containLabel: true }, tooltip: { trigger: 'item' }, xAxis: { type: 'value', min: 0, max: 1, name: '预测' }, yAxis: { type: 'value', min: 0, max: 1, name: '实际' },
    series: [{ name: '完全准', type: 'line', data: [[0, 0], [1, 1]], symbol: 'none', lineStyle: { type: 'dotted', color: G4() }, itemStyle: { color: G4() } }, ...['g4', 'v22'].filter(k => S[k]).map(k => ({ name: VN[k] || k, type: 'line', data: S[k].calib.map(c => [c.pred, c.real]), symbolSize: 6 }))] }); }

// 四、用没用
const F = S.v22;
if (F?.permute) { const P = F.permute;
  $('#permTxt').textContent = `把 v2.2（net-g5）考卷上的某一块输入在同一回合数的局面之间打乱（保留"进行到第几回合"，只把牌换成别局的），看交叉熵涨多少。打乱自己卡组 +${P[0].dBce.toFixed(3)}、打乱对面亮过的牌 +${P[1].dBce.toFixed(3)}，两样一起打乱后交叉熵 ${P[2].bce.toFixed(3)}，比从来不看卡组的 g4（${f4(S.g4?.bce)}）还差：它确实在大量依赖这几块信息，不是摆设。右图是第一层里每块输入的贡献（W·x 的标准差）：棋盘和城堡血量仍是大头，对面亮过的牌排第三。`;
  chart('cPerm', { title: { text: '打乱一块输入后交叉熵上涨', textStyle: { fontSize: 13, color: css('--mut') }, left: 0 }, tooltip: {}, grid: { top: 36, left: 8, right: 40, bottom: 20, containLabel: true }, xAxis: { type: 'value' }, yAxis: { type: 'category', data: P.map(p => p.what), inverse: true, axisLabel: { color: css('--mut') } }, series: [{ type: 'bar', data: P.map(p => p.dBce), itemStyle: { color: ACC() }, label: { show: true, position: 'right', color: css('--fg'), formatter: p => '+' + p.value.toFixed(3) } }] });
  chart('cBlock', { title: { text: '第一层各块输入的贡献', textStyle: { fontSize: 13, color: css('--mut') }, left: 0 }, tooltip: {}, grid: { top: 36, left: 8, right: 40, bottom: 20, containLabel: true }, xAxis: { type: 'value' }, yAxis: { type: 'category', data: F.blocks.map(b => `${b.block}（${b.dims} 维）`), inverse: true, axisLabel: { color: css('--mut') } },
    series: [{ type: 'bar', data: F.blocks.map((b, i) => ({ value: b.std, itemStyle: { color: i >= 4 ? ACC() : G4() } })), label: { show: true, position: 'right', color: css('--fg'), formatter: p => p.value.toFixed(3) } }] }); }

// 五、逐套卡组
const DK = R.decks, d1 = DK.g5_g4, d2 = DK.g5_strong, d3 = DK.g4_strong;
if (d1) { const names = d1.decks, by = (d, n) => d?.perDeck.find(x => x.deck === n);
  const rows = names.map(n => ({ n, a: by(d1, n), s: by(d2, n), b: by(d3, n) })).sort((x, y) => y.a.win - x.a.win);
  const up = rows.filter(r => r.s && r.b).map(r => ({ n: r.n, d: 100 * (r.s.win - r.b.win) })).sort((x, y) => y.d - x.d);
  $('#deckTxt').textContent = `每套预设两两对阵（含同套对打），每格 ${d1.games / names.length / names.length} 局、各先手一半，只有电脑不同。总胜率：net-g5 对 g4 ${pct(100 * d1.total)}${d2 ? `；对满强度 net-g5 ${pct(100 * d2.total)}、g4 ${pct(100 * d3.total)}` : ''}。` + (gate('v22', 'g4') ? `预设卡组上对 g4 的胜率比过关赛（预设和随机卡组混着打）的 ${pct(gate('v22', 'g4').win)} 更高：成型卡组正是卡组信息最管用的地方。` : '') + (up.length ? `对满强度时进步最多的是「${up[0].n}」（+${up[0].d.toFixed(1)} 个点），最少的是「${up.at(-1).n}」（${up.at(-1).d >= 0 ? '+' : ''}${up.at(-1).d.toFixed(1)}）。` : '');
  chart('cDeck', { title: { text: '用这套卡组时的胜率', textStyle: { fontSize: 13, color: css('--mut') }, left: 0 }, legend: { top: 18, right: 0 }, grid: { top: 56, left: 8, right: 16, bottom: 20, containLabel: true }, xAxis: { type: 'value', min: 30, max: 90, name: '%' }, yAxis: { type: 'category', data: rows.map(r => r.n), inverse: true, axisLabel: { color: css('--mut') } },
    series: [{ name: 'net-g5 对 g4', type: 'bar', data: rows.map(r => +(100 * r.a.win).toFixed(1)), itemStyle: { color: ACC() } }, ...(d2 ? [{ name: 'net-g5 对满强度', type: 'bar', data: rows.map(r => +(100 * r.s.win).toFixed(1)), itemStyle: { color: css('--good') } }, { name: 'g4 对满强度', type: 'bar', data: rows.map(r => +(100 * r.b.win).toFixed(1)), itemStyle: { color: G4() } }] : [])] });
  table('#tDeck', ['卡组', 'net-g5 对 g4', 'net-g5 对满强度', 'g4 对满强度', '对满强度进步'], rows.map(r => [r.n, `${pct(100 * r.a.win)} ±${(100 * r.a.ci).toFixed(1)}`, r.s ? pct(100 * r.s.win) : '—', r.b ? pct(100 * r.b.win) : '—', r.s && r.b ? `${(100 * (r.s.win - r.b.win)) >= 0 ? '+' : ''}${(100 * (r.s.win - r.b.win)).toFixed(1)}` : '—'])); }
else $('#deckTxt').textContent = '逐套对阵还没跑（tools/lab/v2/deck_matrix.mjs）。';

// 六、陪练
const A = R.agent, won = A.filter(a => a.win);
const byNet = A.reduce((m, a) => (m[a.net] = m[a.net] || [0, 0], m[a.net][0] += a.win, m[a.net][1]++, m), {});
$('#agentTxt').textContent = `DeepSeek V4 Pro（DeepSeek Harness，走 5090 本机 magpie）读过规则源码和训练数据，在无头浏览器（静音）里开真实的游戏页面对打大师电脑，每局一个独立会话、赛后写复盘。共 ${A.length} 局：` + Object.entries(byNet).map(([k, [w, n]]) => `对 ${k} ${n} 局赢 ${w}`).join('，') + `。第二轮原本 6 局都该对 net-g5，但对局服务在第 11/12 局之间因一个已修掉的错误崩了（服务日志里有记录），之后 4 局的记录显示对手是 g4，应该是 agent 照报错提示自己重启了服务、没带网络参数，所以对 net-g5 实际只打了 2 局。复盘里 ${R.gateNotes?.[0]} 局有 ${R.gateNotes?.[1]} 局提到同一件事：大师电脑全家压进对方后场、自家门口不留兵。按这条写的冲门型陪练对 g4 只赢 ${pct(R.base.rush?.win)}、对满强度 ${pct(R.base.rs?.win)}，说明这个毛病光靠猛冲抓不住。`;
table('#tAgent', ['开始（UTC）', '对手网络', '结果', '回合', '城堡（agent:电脑）', '步数'], A.map(a => [a.t.replace('T', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1'), a.net, `<span class="pill ${a.win ? 'ok' : 'no'}">${a.win ? 'agent 赢' : '电脑赢'}</span>`, a.turns, a.base.join(' : '), a.moves]));

// 七、结论
const C = [`上线：net-g5 = v2.2。对 g4 ${pct(g?.win)}、对满强度 ${pct(gs?.win)}（g4 ${pct(base?.win)}）。每回合多想约 1 毫秒（网络多算三块卡组特征）。`,
  '从零训练追不上 g4（v2.1）；从 g4 起步、新输入先置零、学习率降到四分之一（v2.2）才过关。以后每一版都该从上一版起步。',
  'v2.3 接着练没有再涨（对 v2.2 50.2%）。猜胜负的准确率还在涨（76.7% → 76.9%），下棋不涨：继续堆同样的自我对打数据已经到头。',
  '下一步值得试的：①用搜索结果当老师目标（预演一步后的评分），直接练"选哪步好"而不是"谁会赢"；②把对面卡组从"亮过的牌"推测成整副（对照实验里看到对面整副能 +4.8 个点）；③锦标赛的种子在网络换代后都要重测一次（这次宽度 4 → 3）。'];
$('#concl').innerHTML = C.map(c => `<li>${c}</li>`).join('');
</script>'''

if __name__ == '__main__':
    if '--selftest' in sys.argv: selftest(); sys.exit()
    ap = argparse.ArgumentParser(); ap.add_argument('--dir', default='out/v2'); ap.add_argument('--out', default=None); a = ap.parse_args()
    out = a.out or os.path.join(a.dir, 'report.html'); R = build(a.dir); open(out, 'w', encoding='utf-8').write(html(R))
    print(f'{len(R["versions"])} 版、{len(R["agent"])} 局陪练、逐套对阵 {len(R["decks"])} 组 → {out}')
