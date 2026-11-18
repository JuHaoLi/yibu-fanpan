#!/usr/bin/env python3
# 收敛循环的交互看板：从 ingest.py 建的 SQLite 库读数，输出一个自包含 HTML（数据以 JSON 内嵌，图表用 ECharts 5.4.3 / cdnjs）。
# 用法：python3 -I tools/lab/analysis/dashboard.py [--db out/loop/lab.db] [--out <库所在目录>/dashboard.html]
# 页面：顶部筛选栏（轮次单选、阵营多选、牌的类型、只看显著 |z|≥2，所有图表联动）、KPI、收敛曲线、网络每一代、单卡散点（点一张牌看它每轮走势）、
#   阵营胜率/对阵热力图、中立张数、两张/三张组合表（可排序、搜索）、调整历史、要改设计的牌、预设热力图。深浅色跟系统，手机宽度单列。
# 组合表每轮只内嵌 |z| 最大的 MAX_PAIRS / MAX_TRIPLES 条（库里是全量），免得 HTML 太大。
import argparse, json, sqlite3, sys
from pathlib import Path

MAX_PAIRS, MAX_TRIPLES = 3000, 2000

def rows(db, sql):
    try: return [dict(r) for r in db.execute(sql)]
    except sqlite3.OperationalError as e:
        print(f'  ! {e}', file=sys.stderr); return []

def capped(db, t, cap):
    return rows(db, f'SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY round ORDER BY ABS(COALESCE(z,0)) DESC) AS rk FROM {t}) WHERE rk <= {cap} ORDER BY round')

def build(dbp):
    db = sqlite3.connect(f'file:{dbp}?mode=ro', uri=True); db.row_factory = sqlite3.Row
    meta = {r['key']: json.loads(r['value']) for r in rows(db, 'SELECT * FROM meta')}
    fn = {r['faction']: r['name'] for r in rows(db, 'SELECT faction, name FROM factions WHERE name IS NOT NULL GROUP BY faction')}
    fn.setdefault('n', '中立')
    D = dict(meta=meta, factionNames=fn, rounds=rows(db, 'SELECT * FROM rounds ORDER BY round'),
             cards=rows(db, 'SELECT round,id,name,faction,kind,cost,str,boss,prize,pp,se,z,games,slope_pp,slope_se,play_delta,low_n FROM cards ORDER BY round'),
             pairs=capped(db, 'pairs', MAX_PAIRS), triples=capped(db, 'triples', MAX_TRIPLES),
             totals={t: {r['round']: r['n'] for r in rows(db, f'SELECT round, COUNT(*) n FROM {t} GROUP BY round')} for t in ('pairs', 'triples')},
             factions=rows(db, 'SELECT * FROM factions ORDER BY round'), matrix=rows(db, 'SELECT * FROM matrix ORDER BY round'),
             neutral=rows(db, 'SELECT * FROM neutral ORDER BY round, k'), presets=rows(db, 'SELECT * FROM presets ORDER BY round'),
             tune=rows(db, 'SELECT * FROM tune ORDER BY round'), needs=rows(db, 'SELECT * FROM needs_design ORDER BY round'),
             train=rows(db, 'SELECT * FROM train ORDER BY round, ep'), teacher=rows(db, 'SELECT * FROM teacher ORDER BY round'),
             gameStats=rows(db, 'SELECT round, first_faction f, COUNT(*) n, SUM(result=0) w, SUM(draw) d, SUM(timeout) t FROM games GROUP BY round, first_faction'))
    for t in ('pairs', 'triples'):
        for r in D[t]: r.pop('rk', None)
    db.close()
    return D

def main():
    ap = argparse.ArgumentParser(description='从 lab.db 出交互看板 HTML')
    ap.add_argument('--db', default='out/loop/lab.db'); ap.add_argument('--out')
    a = ap.parse_args(); dbp = Path(a.db)
    if not dbp.exists(): sys.exit(f'没有库：{dbp}（先跑 ingest.py）')
    out = Path(a.out) if a.out else dbp.with_name('dashboard.html')
    D = build(dbp)
    data = json.dumps(D, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')  # < 只会出现在字符串里；全换掉连 </script>、<!-- 都挡住
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(HTML.replace('/*DATA*/', data, 1), encoding='utf-8')
    print(f'已写 {out}（{len(D["rounds"])} 轮，{out.stat().st_size // 1024} KB）')

HTML = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>收敛循环看板</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js"></script>
<style>
:root{--bg:#f4f5f7;--card:#fff;--fg:#1c2230;--mut:#687080;--line:#e2e5ea;--acc:#2f6bd8;--pos:#c2412d;--neg:#2563b8;--chip:#eef1f5;--hl:#fff6d6}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d23;--fg:#e5e7eb;--mut:#9aa2ae;--line:#2a2f37;--acc:#7aa7ff;--pos:#ff8a70;--neg:#7fb0ff;--chip:#252a32;--hl:#3a3420}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%}
header{position:sticky;top:0;z-index:10;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px}
h1{font-size:17px;margin:0 8px 0 0;display:inline}.sub{color:var(--mut);font-size:12px}
.bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin-top:8px}.bar label{color:var(--mut);font-size:12px;margin-right:4px}
.grp{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
select,input[type=search],input[list]{font:inherit;color:var(--fg);background:var(--chip);border:1px solid var(--line);border-radius:6px;padding:3px 8px}
.chip{font:inherit;font-size:12px;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:999px;padding:2px 9px;cursor:pointer;display:inline-flex;gap:5px;align-items:center}
.chip[aria-pressed=true]{background:var(--chip);border-color:var(--acc)}.chip[aria-pressed=false]{opacity:.5}
.chip i,.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}
button.plain{font:inherit;font-size:12px;color:var(--acc);background:none;border:0;cursor:pointer;padding:2px 4px}
main{padding:12px 16px 40px;max-width:1500px;margin:0 auto}
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums;margin:2px 0}
.kpi .t{color:var(--mut);font-size:12px}.kpi .s{color:var(--mut);font-size:12px}.up{color:var(--pos)}.down{color:var(--neg)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.wide{grid-column:1/-1}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}
.panel h2{font-size:14px;margin:0 0 2px}.panel .note{color:var(--mut);font-size:12px;margin:0 0 6px}
.ch{height:320px;width:100%}.ch.tall{height:400px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}td.r,th.r{text-align:right}
th button{font:inherit;font-weight:600;color:var(--fg);background:none;border:0;cursor:pointer;padding:0}
tr.low td{opacity:.55}tr.hl td{background:var(--hl)}.pos{color:var(--pos)}.neg{color:var(--neg)}
.tag{font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:4px}
button.lnk{font:inherit;color:var(--acc);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline dotted}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0}.tmeta{color:var(--mut);font-size:12px}
.warn{color:var(--pos);font-size:12px;margin-left:6px}#nolib{display:none;color:var(--pos);margin:8px 0}
@media (max-width:900px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:760px){.grid{grid-template-columns:minmax(0,1fr)}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.ch{height:280px}.ch.tall{height:340px}header{position:static}}
</style></head>
<body>
<header>
  <h1>收敛循环看板</h1><span class="sub" id="status"></span>
  <div class="bar">
    <div class="grp"><label for="round">轮次</label><select id="round"></select></div>
    <div class="grp" role="group" aria-label="阵营"><label>阵营</label><span class="grp" id="fac"></span></div>
    <div class="grp" role="group" aria-label="牌的类型"><label>类型</label><span class="grp" id="kind"></span></div>
    <div class="grp"><input type="checkbox" id="sig"><label for="sig" style="color:var(--fg)">只看显著（|z|≥2）</label></div>
    <div class="grp"><label for="cardpick">找牌</label><input id="cardpick" list="cardlist" placeholder="输入牌名" size="10"><datalist id="cardlist"></datalist></div>
    <button type="button" class="plain" id="reset">重置筛选</button>
  </div>
</header>
<main>
  <p id="nolib">图表库（ECharts，cdnjs）没加载出来：需要联网。表格还能用。</p>
  <section class="kpis" id="kpis" aria-label="关键数字"></section>
  <div class="grid">
    <section class="panel"><h2>收敛曲线</h2><p class="note">每轮：超范围棋子数、单卡分标准差（左轴）；网络 gate 胜率、先手胜率（右轴，%）。虚线 = 当前选的轮。</p><div class="ch" id="c-conv"></div></section>
    <section class="panel"><h2>网络每一代</h2><p class="note">新网络对冠军、对满强度电脑的胜率（95% 区间）；◆ = 过了 gate 当上冠军；考卷猜对率（右轴）。</p><div class="ch" id="c-net"></div></section>
    <section class="panel wide"><h2>单卡强弱</h2><p class="note">横轴费用（加了点抖动免得重叠），纵轴单卡分（百分点，平均每张牌 = 0），点越大出现局数越多，虚线 = 本轮调整范围。悬停看详情，点一张牌看下面的走势；滚轮/双指缩放。</p><div class="ch tall" id="c-scatter"></div></section>
    <section class="panel wide"><h2 id="trend-h">单卡走势</h2><p class="note" id="trend-note">点上面的一张牌（或用"找牌"），这里显示它每轮的单卡分（±1.96 标准误）和战力。</p><div class="ch" id="c-trend"></div></section>
    <section class="panel"><h2>阵营胜率</h2><p class="note">本轮各阵营卡组的胜率（95% 区间，平局算半场）。点一个阵营 = 只看它，再点恢复。</p><div class="ch" id="c-fac"></div></section>
    <section class="panel"><h2>阵营对阵</h2><p class="note">行 = 这个阵营，列 = 对手阵营，格子 = 行方胜率 %；样本少的格子变淡。</p><div class="ch" id="c-matrix"></div></section>
    <section class="panel"><h2>中立张数和胜率</h2><p class="note">卡组里有 k 张中立牌时的胜率（左轴）和副数（右轴，柱）。</p><div class="ch" id="c-neutral"></div></section>
    <section class="panel"><h2>预设胜率（轮 × 预设）</h2><p class="note" id="preset-note">预设互打胜率 %，框出来的是超出范围的。</p><div class="ch" id="c-presets"></div></section>
    <section class="panel wide"><h2>两张组合</h2><p class="note" id="pairs-note">同在一副卡组时比两张单卡分加起来多（或少）的百分点。点牌名看单卡走势，点表头排序。</p>
      <div class="tools"><input type="search" data-q="pairs" placeholder="搜牌名" aria-label="搜两张组合"></div><div id="t-pairs"></div></section>
    <section class="panel wide"><h2>三张组合</h2><p class="note" id="triples-note">三张项 = 单卡和三条配对都扣掉后剩下的；总计 = 三张单卡 + 三条配对 + 三张项。</p>
      <div class="tools"><input type="search" data-q="triples" placeholder="搜牌名" aria-label="搜三张组合"></div><div id="t-triples"></div></section>
    <section class="panel wide"><h2>调整历史</h2><p class="note">每轮自动改的战力（所有轮，当前轮高亮）；跟着阵营、类型筛选。</p>
      <div class="tools"><input type="search" data-q="tune" placeholder="搜牌名/原因" aria-label="搜调整历史"></div><div id="t-tune"></div></section>
    <section class="panel wide"><h2>要改设计的牌</h2><p class="note">法术、首领、奖励牌超范围的（不自动改，等人来改设计）；当前轮。</p><div id="t-needs"></div></section>
  </div>
</main>
<script id="data" type="application/json">/*DATA*/</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const $ = s => document.querySelector(s), esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FC = { f1: '#d9a032', f2: '#2aa198', f3: '#d0683a', f4: '#8b6bd6', f5: '#5a9e44', f6: '#4a8fdc', f7: '#c8578a', n: '#8a8f98' };
const fcol = f => FC[f] || '#9aa0a6', fname = f => D.factionNames[f] || f, KIND = { unit: '单位', structure: '建筑', spell: '法术' };
const R = D.rounds.map(r => r.round), last = R[R.length - 1] ?? null, RL = R.map(r => `第${r}轮`);
const FAC = [...new Set([...D.cards.map(c => c.faction), ...D.factions.map(f => f.faction)])].filter(Boolean).sort((a, b) => (a === 'n') - (b === 'n') || a.localeCompare(b));
const CARD = {}; for (const c of D.cards) CARD[c.id] = c; // 名字/阵营/类型取最新一轮
const st = { round: last, fac: new Set(FAC), kind: new Set(Object.keys(KIND)), sig: false, card: null,
  sort: { pairs: ['pp', -1], triples: ['total_pp', -1], tune: ['round', -1], needs: ['pp', -1] }, lim: { pairs: 100, triples: 100, tune: 100, needs: 100 }, q: { pairs: '', triples: '', tune: '' } };
const num = x => typeof x === 'number' && isFinite(x), fmt = (x, d = 1) => num(x) ? x.toFixed(d) : '—', pct = (x, d = 1) => num(x) ? x.toFixed(d) + '%' : '—';
const sgn = (x, d = 1) => num(x) ? `<span class="${x > 0 ? 'pos' : x < 0 ? 'neg' : ''}">${x > 0 ? '+' : ''}${x.toFixed(d)}</span>` : '—';
const inR = a => a.filter(x => x.round === st.round), RR = () => D.rounds.find(r => r.round === st.round) || {};
const kindOf = id => CARD[id]?.kind, cardOk = c => st.fac.has(c.faction) && st.kind.has(c.kind) && (!st.sig || Math.abs(c.z) >= 2);
const comboOk = x => st.fac.has(x.faction) && (!st.sig || Math.abs(x.z) >= 2) && [x.a, x.b, x.c].every(id => id == null || !kindOf(id) || st.kind.has(kindOf(id))); // 类型筛选：组合里每张牌的类型都要被选中
const cname = (id, fb) => CARD[id]?.name ?? fb ?? id, lnk = (id, fb) => `<button type="button" class="lnk" data-card="${esc(id)}">${esc(cname(id, fb))}</button>`;
const fdot = f => `<span class="dot" style="background:${fcol(f)}"></span> ${esc(fname(f))}`;

// ---------- 图表 ----------
const dark = matchMedia('(prefers-color-scheme: dark)'), charts = {}, CLICK = { 'c-scatter': p => p.data?.id && pickCard(p.data.id), 'c-fac': p => soloFac(p.data?.f) };
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function chart(id, opt) {
  if (!window.echarts) return null;
  let c = charts[id];
  if (!c) { c = charts[id] = echarts.init(document.getElementById(id), dark.matches ? 'dark' : null); c.on('click', p => CLICK[id]?.(p)); }
  c.setOption({ backgroundColor: 'transparent', textStyle: { fontFamily: 'inherit' }, animationDuration: 250, ...opt }, true);
  return c;
}
const empty = (id, msg = '这一轮没有数据') => chart(id, { title: { text: msg, left: 'center', top: 'middle', textStyle: { color: css('--mut'), fontSize: 13, fontWeight: 'normal' } } });
const axisTip = { trigger: 'axis', confine: true, valueFormatter: v => num(v) ? (+v).toFixed(2) : '—' };
function errBars(data, color, horiz = false) { // data: [位置, 下, 上]
  return { type: 'custom', silent: true, tooltip: { show: false }, z: 1, data, encode: horiz ? { y: 0, x: [1, 2] } : { x: 0, y: [1, 2] },
    renderItem: (p, api) => { const i = api.value(0), a = api.value(1), b = api.value(2); if (!num(a) || !num(b)) return;
      const lo = api.coord(horiz ? [a, i] : [i, a]), hi = api.coord(horiz ? [b, i] : [i, b]), w = 5, s = { stroke: color, lineWidth: 1.4 };
      const cap = q => horiz ? { x1: q[0], y1: q[1] - w, x2: q[0], y2: q[1] + w } : { x1: q[0] - w, y1: q[1], x2: q[0] + w, y2: q[1] };
      return { type: 'group', children: [{ type: 'line', shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style: s }, { type: 'line', shape: cap(lo), style: s }, { type: 'line', shape: cap(hi), style: s }] }; } };
}
const roundMark = () => ({ symbol: 'none', silent: true, label: { show: false }, lineStyle: { type: 'dashed', color: css('--mut') }, data: st.round != null ? [{ xAxis: `第${st.round}轮` }] : [] });

function convChart() {
  if (!R.length) return empty('c-conv', '还没有跑完的轮');
  const pick = k => D.rounds.map(r => r[k] ?? null);
  chart('c-conv', { tooltip: axisTip, legend: { top: 0, type: 'scroll' }, grid: { left: 44, right: 46, top: 54, bottom: 26 },
    xAxis: { type: 'category', data: RL }, yAxis: [{ type: 'value', name: '张 / 百分点', nameTextStyle: { align: 'left' } }, { type: 'value', name: '%', scale: true, splitLine: { show: false } }],
    series: [{ name: '超范围棋子', type: 'bar', data: pick('outside'), barMaxWidth: 26, itemStyle: { color: '#d0683a', opacity: .8 }, markLine: roundMark() },
      { name: '单卡分标准差', type: 'line', data: pick('pp_std'), symbolSize: 7, itemStyle: { color: '#8b6bd6' } },
      { name: '网络 gate 胜率', type: 'line', yAxisIndex: 1, data: pick('gate_vs_champ'), symbolSize: 7, itemStyle: { color: '#2f6bd8' }, connectNulls: true },
      { name: '先手胜率', type: 'line', yAxisIndex: 1, data: pick('first_win'), symbolSize: 7, itemStyle: { color: '#2aa198' }, lineStyle: { type: 'dotted' },
        markLine: { symbol: 'none', silent: true, label: { formatter: '50%', color: css('--mut') }, lineStyle: { color: css('--line') }, data: [{ yAxis: 50 }] } }] });
}
function netChart() {
  if (!R.length) return empty('c-net', '还没有跑完的轮');
  const acc = {}; for (const t of D.train) acc[t.round] = t.test_acc; // 每轮最后一个 epoch
  const pts = k => D.rounds.map(r => ({ value: r[k] ?? null, symbol: r.promoted ? 'diamond' : 'circle', symbolSize: r.promoted ? 13 : 7 }));
  const bars = (lo, hi) => D.rounds.map((r, i) => [i, r[lo], r[hi]]);
  chart('c-net', { tooltip: axisTip, legend: { top: 0, type: 'scroll', data: ['对冠军', '对满强度', '考卷猜对率'] }, grid: { left: 44, right: 46, top: 54, bottom: 26 },
    xAxis: { type: 'category', data: RL }, yAxis: [{ type: 'value', name: '胜率 %', scale: true }, { type: 'value', name: '猜对 %', scale: true, splitLine: { show: false } }],
    series: [{ name: '对冠军', type: 'line', data: pts('gate_vs_champ'), itemStyle: { color: '#2f6bd8' }, connectNulls: true,
        markLine: { symbol: 'none', silent: true, lineStyle: { color: css('--line') }, label: { formatter: '50%', color: css('--mut') }, data: [{ yAxis: 50 }] } }, errBars(bars('gc_lo', 'gc_hi'), '#2f6bd8'),
      { name: '对满强度', type: 'line', data: pts('gate_vs_strong'), itemStyle: { color: '#d9a032' }, connectNulls: true }, errBars(bars('gs_lo', 'gs_hi'), '#d9a032'),
      { name: '考卷猜对率', type: 'line', yAxisIndex: 1, data: R.map(r => acc[r] ?? null), itemStyle: { color: '#5a9e44' }, lineStyle: { type: 'dashed' }, connectNulls: true }] });
}
const jit = id => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 1000 / 1000 - .5) * .56; };
function scatterChart() {
  const cs = inR(D.cards).filter(cardOk).filter(c => num(c.pp));
  if (!cs.length) return empty('c-scatter', '这一轮/这些筛选下没有牌');
  const m = Object.fromEntries(cs.map(c => [c.id, c])), band = RR().band;
  const series = FAC.filter(f => st.fac.has(f)).map(f => ({ name: fname(f), type: 'scatter', itemStyle: { color: fcol(f), opacity: .82 }, emphasis: { focus: 'series' },
    data: cs.filter(c => c.faction === f).map(c => ({ value: [(c.cost ?? 0) + jit(c.id), c.pp], id: c.id, symbolSize: Math.max(6, Math.min(20, Math.sqrt(c.games || 0) / 10)),
      itemStyle: c.id === st.card ? { borderColor: css('--fg'), borderWidth: 2.5, opacity: 1 } : c.low_n ? { opacity: .4 } : undefined })) }));
  if (series.length) series[0].markLine = { symbol: 'none', silent: true, label: { color: css('--mut') }, lineStyle: { type: 'dashed', color: css('--mut') },
    data: [{ yAxis: 0, label: { formatter: '0' } }, ...(num(band) ? [{ yAxis: band, label: { formatter: `+${band}` } }, { yAxis: -band, label: { formatter: `−${band}` } }] : [])] };
  chart('c-scatter', { legend: { top: 0, type: 'scroll' }, grid: { left: 48, right: 20, top: 54, bottom: 40 },
    tooltip: { trigger: 'item', confine: true, formatter: p => { const c = m[p.data?.id]; if (!c) return '';
      return `<b>${esc(c.name)}</b>　${esc(fname(c.faction))} · ${esc(KIND[c.kind] || c.kind)}<br>费用 ${c.cost ?? '—'}　战力 ${c.str ?? '—'}<br>单卡分 ${fmt(c.pp)} ± ${fmt(c.se)}　z ${fmt(c.z)}<br>斜率 ${fmt(c.slope_pp, 2)} 百分点/点战力<br>出现 ${(c.games || 0).toLocaleString()} 局${c.low_n ? '（样本少）' : ''}`; } },
    xAxis: { type: 'value', name: '费用', nameLocation: 'middle', nameGap: 24, min: v => Math.floor(v.min), max: v => Math.ceil(v.max), interval: 1, splitLine: { show: false } },
    yAxis: { type: 'value', name: '单卡分（百分点）', scale: true }, dataZoom: [{ type: 'inside', xAxisIndex: 0 }, { type: 'inside', yAxisIndex: 0 }], series });
}
function trendChart() {
  const id = st.card, c = CARD[id];
  if (!c) { $('#trend-h').textContent = '单卡走势'; return empty('c-trend', '点上面的一张牌'); }
  $('#trend-h').textContent = `单卡走势：${c.name}`;
  const by = Object.fromEntries(D.cards.filter(x => x.id === id).map(x => [x.round, x])), tn = D.tune.filter(t => t.id === id);
  $('#trend-note').innerHTML = `${fdot(c.faction)} · ${esc(KIND[c.kind] || c.kind)} · ${c.cost ?? '—'} 费。` + (tn.length ? '调整：' + tn.map(t => `第${t.round}轮 ${t.old_str}→${t.new_str}（${esc(t.reason)}）`).join('；') : '没被自动调整过。');
  const ppv = R.map(r => by[r]?.pp ?? null);
  chart('c-trend', { tooltip: axisTip, legend: { top: 0 }, grid: { left: 44, right: 46, top: 54, bottom: 26 }, xAxis: { type: 'category', data: RL },
    yAxis: [{ type: 'value', name: '单卡分', scale: true }, { type: 'value', name: '战力', minInterval: 1, scale: true, splitLine: { show: false } }],
    series: [{ name: '单卡分', type: 'line', data: ppv, symbolSize: 8, connectNulls: true, itemStyle: { color: fcol(c.faction) }, markLine: roundMark() },
      errBars(R.map((r, i) => [i, num(by[r]?.pp) && num(by[r]?.se) ? by[r].pp - 1.96 * by[r].se : null, num(by[r]?.pp) && num(by[r]?.se) ? by[r].pp + 1.96 * by[r].se : null]), fcol(c.faction)),
      { name: '战力', type: 'line', step: 'end', yAxisIndex: 1, data: R.map(r => by[r]?.str ?? null), itemStyle: { color: css('--mut') }, lineStyle: { type: 'dashed' }, connectNulls: true }] });
}
function facChart() {
  const fs = inR(D.factions).filter(f => st.fac.has(f.faction) && num(f.win)).sort((a, b) => a.win - b.win);
  if (!fs.length) return empty('c-fac');
  chart('c-fac', { grid: { left: 86, right: 24, top: 10, bottom: 28 }, tooltip: { trigger: 'item', confine: true, formatter: p => { const f = fs[p.dataIndex]; return f ? `<b>${esc(fname(f.faction))}</b><br>胜率 ${pct(f.win)}（${pct(f.lo)}–${pct(f.hi)}）<br>${(f.games || 0).toLocaleString()} 局${f.low_n ? '（样本少）' : ''}` : ''; } },
    yAxis: { type: 'category', data: fs.map(f => fname(f.faction)) }, xAxis: { type: 'value', name: '%', scale: true },
    series: [{ type: 'bar', data: fs.map(f => ({ value: f.win, f: f.faction, itemStyle: { color: fcol(f.faction), opacity: f.low_n ? .45 : .9 } })), barMaxWidth: 22,
      markLine: { symbol: 'none', silent: true, lineStyle: { type: 'dashed', color: css('--mut') }, label: { formatter: '50%', color: css('--mut') }, data: [{ xAxis: 50 }] } },
      errBars(fs.map((f, i) => [i, f.lo, f.hi]), css('--fg'), true)] });
}
const divColors = () => ['#2563b8', dark.matches ? '#30343b' : '#f2f2f0', '#c2412d'];
function matrixChart() {
  const ms = inR(D.matrix).filter(x => st.fac.has(x.faction) && st.fac.has(x.vs) && num(x.win));
  if (!ms.length) return empty('c-matrix');
  const ax = FAC.filter(f => ms.some(x => x.faction === f || x.vs === f)), ix = Object.fromEntries(ax.map((f, i) => [f, i]));
  chart('c-matrix', { grid: { left: 86, right: 16, top: 10, bottom: 70 }, tooltip: { confine: true, formatter: p => { const x = p.data.x; return `<b>${esc(fname(x.faction))}</b> 对 ${esc(fname(x.vs))}<br>胜率 ${pct(x.win)}（${pct(x.lo)}–${pct(x.hi)}）<br>${(x.games || 0).toLocaleString()} 局`; } },
    xAxis: { type: 'category', data: ax.map(fname), axisLabel: { rotate: 30 } }, yAxis: { type: 'category', data: ax.map(fname) },
    visualMap: { min: 30, max: 70, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120, inRange: { color: divColors() }, text: ['70%', '30%'] },
    series: [{ type: 'heatmap', label: { show: true, formatter: p => fmt(p.data.value[2], 0) }, data: ms.map(x => ({ value: [ix[x.vs], ix[x.faction], x.win], x, itemStyle: x.low_n ? { opacity: .45 } : undefined })) }] });
}
function neutralChart() {
  const ns = inR(D.neutral).filter(x => num(x.win));
  if (!ns.length) return empty('c-neutral');
  chart('c-neutral', { tooltip: axisTip, legend: { top: 0 }, grid: { left: 44, right: 50, top: 54, bottom: 30 }, xAxis: { type: 'category', name: '中立张数', nameLocation: 'middle', nameGap: 22, data: ns.map(x => x.k) },
    yAxis: [{ type: 'value', name: '胜率 %', scale: true }, { type: 'value', name: '副数', splitLine: { show: false } }],
    series: [{ name: '副数', type: 'bar', yAxisIndex: 1, data: ns.map(x => x.decks), itemStyle: { color: css('--line') }, barMaxWidth: 22 },
      { name: '胜率', type: 'line', data: ns.map(x => x.win), symbolSize: 7, itemStyle: { color: '#8a8f98' }, markLine: { symbol: 'none', silent: true, lineStyle: { type: 'dashed', color: css('--mut') }, label: { formatter: '50%' }, data: [{ yAxis: 50 }] } },
      errBars(ns.map((x, i) => [i, x.lo, x.hi]), '#8a8f98')] });
}
function presetChart() {
  const ps = D.presets.filter(p => num(p.rate));
  if (!ps.length) return empty('c-presets', '还没有预设互打数据');
  const decks = [...new Set(ps.map(p => p.deck))], ix = Object.fromEntries(decks.map((d, i) => [d, i])), lo = D.meta.presetLo ?? 40, hi = D.meta.presetHi ?? 60;
  $('#preset-note').textContent = `预设互打胜率 %，框出来的是超出 ${lo}–${hi}% 的。虚线框 = 当前选的轮。`;
  const h = Math.max(320, 34 + decks.length * 22 + 70); document.getElementById('c-presets').style.height = h + 'px'; charts['c-presets']?.resize();
  chart('c-presets', { grid: { left: 90, right: 16, top: 10, bottom: 60 }, tooltip: { confine: true, formatter: p => { const x = p.data.p; return `<b>${esc(x.deck)}</b> · 第${x.round}轮<br>胜率 ${pct(x.rate)}${num(x.lo) ? `（${pct(x.lo)}–${pct(x.hi)}）` : ''}${x.outside ? '<br>超出范围' : ''}`; } },
    xAxis: { type: 'category', data: RL }, yAxis: { type: 'category', data: decks, inverse: true },
    visualMap: { min: 30, max: 70, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120, inRange: { color: divColors() }, text: ['70%', '30%'] },
    series: [{ type: 'heatmap', label: { show: true, formatter: p => fmt(p.data.value[2], 0), fontWeight: 'normal' },
      data: ps.map(p => ({ value: [R.indexOf(p.round), ix[p.deck], p.rate], p, itemStyle: p.outside ? { borderColor: css('--fg'), borderWidth: 2 } : p.round === st.round ? { borderColor: css('--mut'), borderWidth: 1, borderType: 'dashed' } : undefined })) }] });
}

// ---------- 表格 ----------
function table(key, cols, list, rowCls) { // cols: [字段, 表头, 格式化(行)→HTML, 右对齐]
  const [sf, sd] = st.sort[key], lim = st.lim[key], el = document.getElementById('t-' + key);
  const rows = [...list].sort((a, b) => { const x = a[sf], y = b[sf]; if (x == null || y == null) return (x == null) - (y == null); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sd; });
  if (!rows.length) { el.innerHTML = '<p class="tmeta">没有数据（换个轮次或放宽筛选）</p>'; return; }
  el.innerHTML = `<p class="tmeta">${rows.length} 行${rows.length > lim ? `，显示前 ${lim}` : ''}</p><div class="tw"><table><thead><tr>${cols.map(c => `<th scope="col" class="${c[3] ? 'r' : ''}" aria-sort="${c[0] === sf ? (sd > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-f="${c[0]}">${c[1]}${c[0] === sf ? (sd > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead><tbody>` +
    rows.slice(0, lim).map(r => `<tr class="${rowCls ? rowCls(r) : ''}">${cols.map(c => `<td class="${c[3] ? 'r' : ''}">${c[2] ? c[2](r) : esc(r[c[0]])}</td>`).join('')}</tr>`).join('') +
    `</tbody></table></div>${rows.length > lim ? '<button type="button" class="plain" data-more="1">再显示 100 行</button>' : ''}`;
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.card) { pickCard(b.dataset.card); return; }
    if (b.dataset.more) st.lim[key] += 100; else if (b.dataset.f) { const f = b.dataset.f; st.sort[key] = [f, sf === f ? -sd : (typeof rows[0][f] === 'string' ? 1 : -1)]; }
    tables(); };
}
const hasQ = (q, ...s) => !q || s.some(x => String(x ?? '').toLowerCase().includes(q));
const lowTag = r => r.low_n ? '<span class="tag">样本少</span>' : '';
function tables() {
  const q = st.q, tot = D.totals;
  const pr = inR(D.pairs).filter(comboOk).filter(p => hasQ(q.pairs, cname(p.a, p.name_a), cname(p.b, p.name_b)));
  $('#pairs-note').textContent = `同在一副卡组时比两张单卡分加起来多（或少）的百分点。本轮共 ${tot.pairs?.[st.round] ?? 0} 对（页面内嵌 |z| 最大的一批）。点牌名看单卡走势，点表头排序。`;
  table('pairs', [['name_a', '组合', p => lnk(p.a, p.name_a) + ' + ' + lnk(p.b, p.name_b) + lowTag(p)], ['faction', '阵营', p => fdot(p.faction)], ['pp', '多出百分点', p => sgn(p.pp), 1], ['se', '标准误', p => fmt(p.se, 2), 1], ['z', 'z', p => sgn(p.z), 1], ['games', '同现局数', p => (p.games ?? 0).toLocaleString(), 1]], pr, r => r.low_n ? 'low' : '');
  const tr = inR(D.triples).filter(comboOk).filter(t => hasQ(q.triples, cname(t.a, t.name_a), cname(t.b, t.name_b), cname(t.c, t.name_c)));
  $('#triples-note').textContent = `三张项 = 单卡和三条配对都扣掉后剩下的；总计 = 三张单卡 + 三条配对 + 三张项。本轮共 ${tot.triples?.[st.round] ?? 0} 组。`;
  table('triples', [['name_a', '组合', t => [lnk(t.a, t.name_a), lnk(t.b, t.name_b), lnk(t.c, t.name_c)].join(' + ') + lowTag(t)], ['faction', '阵营', t => fdot(t.faction)], ['pp', '三张项', t => sgn(t.pp), 1], ['z', 'z', t => sgn(t.z), 1],
    ['games', '同现局数', t => (t.games ?? 0).toLocaleString(), 1], ['pair_sum_pp', '配对合计', t => sgn(t.pair_sum_pp), 1], ['total_pp', '总计', t => sgn(t.total_pp), 1]], tr, r => r.low_n ? 'low' : '');
  const tn = D.tune.filter(t => st.fac.has(t.faction) && (!kindOf(t.id) || st.kind.has(kindOf(t.id))) && hasQ(q.tune, cname(t.id, t.name), t.reason));
  table('tune', [['round', '轮', t => esc(t.round), 1], ['name', '牌', t => lnk(t.id, t.name)], ['faction', '阵营', t => fdot(t.faction)], ['old_str', '战力', t => `${esc(t.old_str)} → <b>${esc(t.new_str)}</b>`, 1], ['delta', '变化', t => sgn(t.delta, 0), 1],
    ['reason', '原因', t => esc(t.reason)], ['pp', '单卡分', t => sgn(t.pp), 1], ['z', 'z', t => fmt(t.z), 1], ['slope_pp', '斜率', t => fmt(t.slope_pp, 2), 1], ['band', '范围', t => fmt(t.band, 0), 1]], tn, r => r.round === st.round ? 'hl' : '');
  table('needs', [['name', '牌', t => lnk(t.id, t.name)], ['faction', '阵营', t => fdot(t.faction)], ['kind', '类型', t => esc(KIND[t.kind] || t.kind)], ['pp', '单卡分', t => sgn(t.pp), 1], ['z', 'z', t => fmt(t.z), 1], ['reason', '原因', t => esc(t.reason)]],
    inR(D.needs).filter(t => !t.faction || st.fac.has(t.faction)));
}

// ---------- KPI、筛选栏 ----------
function kpis() {
  const r = RR(), i = R.indexOf(st.round), p = i > 0 ? D.rounds[i - 1] : null, tot = D.rounds.reduce((a, x) => a + (x.games || 0), 0);
  let ch = null; for (const x of D.rounds) if (x.round <= st.round && x.promoted) ch = x; // 到这一轮为止最后一个当上冠军的网络
  const chv = ch ? ch.gate_vs_strong : r.gate_vs_strong;
  const dlt = (a, b, good, d = 1) => num(a) && num(b) && a !== b ? `<span class="${good === 0 ? '' : (a > b) === (good > 0) ? 'down' : 'up'}">${a > b ? '▲' : '▼'}${Math.abs(a - b).toFixed(d)}</span> 比上轮` : '';
  const ci = (l, h) => num(l) ? `95%：${fmt(l)}–${fmt(h)}` : '';
  const conv = D.rounds.some(x => x.converged) ? `已收敛${(D.rounds.find(x => x.converged)?.reason) ? '：' + esc(D.rounds.find(x => x.converged).reason) : ''}` : '还没收敛';
  const K = [['已跑轮数', R.length, conv], ['总局数', tot.toLocaleString(), `本轮 ${(r.games || 0).toLocaleString()} 局${num(r.dups) && r.dups ? `，去重 ${r.dups}` : ''}`],
    ['冠军网络对满强度', pct(chv), ch ? `第 ${ch.round} 轮的冠军${ci(ch.gs_lo, ch.gs_hi) ? '，' + ci(ch.gs_lo, ch.gs_hi) : ''}` : (num(chv) ? '本轮新网络（还没有冠军）' : '还没有冠军')],
    ['超范围棋子', fmt(r.outside, 0), dlt(r.outside, p?.outside, -1, 0) || (num(r.band) ? `范围 ±${r.band}` : '')], ['预设超范围', fmt(r.presets_outside, 0), dlt(r.presets_outside, p?.presets_outside, -1, 0)],
    ['先手胜率', pct(r.first_win), ci(r.fw_lo, r.fw_hi) + (num(r.draws) ? `　平 ${r.draws}，超时 ${r.timeouts ?? 0}` : '')]];
  $('#kpis').innerHTML = K.map(([t, v, s]) => `<div class="kpi"><span class="t">${t}</span><b>${v}</b><span class="s">${s || '&nbsp;'}</span></div>`).join('');
  const bad = D.rounds.filter(x => x.rules_ok === 0).map(x => x.round);
  $('#status').innerHTML = `${esc(D.meta.built || '')} · ${esc(D.meta.loop || '')}` + (bad.length ? `<span class="warn">规则版本对不上：第 ${bad.join('、')} 轮</span>` : '') + (r.rules ? ` · 本轮规则 ${esc(r.rules)}` : '');
}
function chips(sel, keys, label, set, color) {
  const el = $(sel), sync = () => el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', set.has(b.dataset.k)));
  el.innerHTML = keys.map(k => `<button type="button" class="chip" data-k="${esc(k)}" title="点击切换，双击只看这一个">${color ? `<i style="background:${color(k)}"></i>` : ''}${esc(label(k))}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return; const k = b.dataset.k; set.has(k) ? set.delete(k) : set.add(k); sync(); render(); };
  el.ondblclick = e => { const b = e.target.closest('button'); if (!b) return; set.clear(); set.add(b.dataset.k); sync(); render(); };
  sync(); return sync;
}
let syncFac = () => {};
function soloFac(f) { if (!f) return; const only = st.fac.size === 1 && st.fac.has(f); st.fac.clear(); (only ? FAC : [f]).forEach(x => st.fac.add(x)); syncFac(); render(); } // 点阵营条：只看它；再点一次恢复全部
function pickCard(id) { if (!CARD[id]) return; st.card = id; render(); document.getElementById('c-trend').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
function render() { kpis(); convChart(); netChart(); scatterChart(); trendChart(); facChart(); matrixChart(); neutralChart(); presetChart(); tables(); }

function init() {
  if (!window.echarts) $('#nolib').style.display = 'block';
  $('#round').innerHTML = R.map(r => `<option value="${r}">第 ${r} 轮</option>`).join('') || '<option>（没有数据）</option>';
  if (last != null) $('#round').value = last;
  $('#round').onchange = e => { st.round = +e.target.value; render(); };
  const s1 = syncFac = chips('#fac', FAC, fname, st.fac, fcol), s2 = chips('#kind', Object.keys(KIND), k => KIND[k], st.kind);
  $('#sig').onchange = e => { st.sig = e.target.checked; render(); };
  $('#reset').onclick = () => { st.fac.clear(); FAC.forEach(f => st.fac.add(f)); st.kind.clear(); Object.keys(KIND).forEach(k => st.kind.add(k)); st.sig = false; $('#sig').checked = false; s1(); s2(); render(); };
  const byName = {}; for (const c of Object.values(CARD)) byName[c.name] = c.id;
  $('#cardlist').innerHTML = Object.keys(byName).sort().map(n => `<option value="${esc(n)}">`).join('');
  $('#cardpick').onchange = e => { const id = byName[e.target.value.trim()]; if (id) pickCard(id); };
  document.querySelectorAll('input[data-q]').forEach(el => el.oninput = () => { st.q[el.dataset.q] = el.value.trim().toLowerCase(); st.lim[el.dataset.q] = 100; tables(); });
  dark.addEventListener('change', () => { for (const k in charts) { charts[k].dispose(); delete charts[k]; } render(); });
  let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { for (const k in charts) charts[k].resize(); }, 120); });
  render();
}
init();
</script>
</body></html>
'''

if __name__ == '__main__': main()
