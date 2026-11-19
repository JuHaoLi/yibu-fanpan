#!/bin/sh
# 第 2 代网络的一版：自我对打（成型卡组、记卡组信息）→ 显卡训练 v2 → 导出给游戏 → JS/torch 一致性核对 → 过关赛（对上一版冠军、对满强度）。
# 用法（5090，实验目录根上）：sh tools/lab/v2/round.sh <版本名> <陪练电脑 spec> <上一版冠军.json> [局数=300000] [额外训练数据目录…]
#   例：sh tools/lab/v2/round.sh v21 mix:assets/ai/net-g4.json@20 assets/ai/net-g4.json
#   环境变量：DECKFILE=卡组.json（混进 agent 组的卡组）、W=线程数（默认 20）、EPOCHS（默认 4）、GATE=过关赛局数（默认 4000）、LEAGUE=联赛陪练名单（逗号分隔，占一半局）、PREV=再多比一场的上一版网络、INIT=从这个第 1 代网络起步训练
# 输出全在 out/v2/<版本名>/：selfplay/、train.json、net.json（v2 网络）、gate_champ.json、gate_strong.json、summary.txt
set -e
V=$1; AI=$2; CHAMP=$3; G=${4:-300000}; shift 4 2>/dev/null || shift $#
W=${W:-20}; EPOCHS=${EPOCHS:-4}; GATE=${GATE:-4000}; PY=${PY:-$HOME/ai/ComfyUI/.venv/bin/python}
cd "$(dirname "$0")/../../.."
D=out/v2/$V; mkdir -p $D
log() { echo "[$(date +%H:%M:%S) $V] $*" | tee -a $D/summary.txt; }
[ -f $D/selfplay/meta.json ] && grep -q "\"games\":$G," $D/selfplay/meta.json || {
  log "自我对打 $G 局，陪练 $AI"
  nice -n 10 node tools/lab/selfplay.mjs "$AI" $G $W $D/selfplay --jitter 1 --v2 1 --decks shaped ${DECKFILE:+--deck-file $DECKFILE} ${LEAGUE:+--league $LEAGUE} --seed-base $(( $(date +%s) % 100000 * 1000 )) > $D/selfplay.log 2>&1; }
node tools/lab/v2/dump_cards.mjs $D/cards.json > /dev/null
log "显卡训练（$EPOCHS 轮）：$D/selfplay $*"
$PY -I tools/lab/v2/deck_probe.py $D/cards.json $D/train.json $D/selfplay "$@" --models v2 --epochs $EPOCHS --export $D/net.json ${INIT:+--init $INIT} > $D/train.log 2>&1
grep "第 $EPOCHS 轮" $D/train.log | tee -a $D/summary.txt
node tools/lab/v2/parity.mjs $D/net.json | tee -a $D/summary.txt
log "过关赛 $GATE 局：对上一版冠军 $CHAMP"
nice -n 10 node tools/lab/arena.mjs mix:$D/net.json@20 mix:$CHAMP@20 $GATE $W 910001 $D/gate_champ.json | tee -a $D/summary.txt
nice -n 10 node tools/lab/arena.mjs mix:$D/net.json@20 strong $GATE $W 920001 $D/gate_strong.json | tee -a $D/summary.txt
[ -n "$PREV" ] && nice -n 10 node tools/lab/arena.mjs mix:$D/net.json@20 mix:$PREV@20 $GATE $W 930001 $D/gate_prev.json | tee -a $D/summary.txt
log 完成
