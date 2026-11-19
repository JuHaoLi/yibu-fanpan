#!/bin/sh
# 换了电脑以后重调牌值（不训练网络）：每轮 普查式自我对打（随机卡组为主 + 战力抖动）→ 组合拟合 + 预设互打 → 调牌（写 chess-tune.js 的 TUNE）。
# 沿用旧循环工作目录里的 state.json（每张牌的改动历史、防震荡）、config.json（局数、范围 bands、锁定的牌）；步骤和参数同 loop.mjs 的第 1、5、6、7 步。
# 用法（5090，实验目录根上）：sh tools/lab/v2/tune_rounds.sh <电脑 spec> <工作目录> <起始轮次> <轮数>
#   例：sh tools/lab/v2/tune_rounds.sh mix:assets/ai/net-g5.json@20 out/tune5 4 2
#   工作目录要先有 state.json、config.json（从 out/loop 复制）；每轮输出在 <工作目录>/rNN/，摘要追加到 <工作目录>/summary.txt
set -e
AI=$1; DIR=$2; R0=$3; N=$4; W=${W:-20}
cd "$(dirname "$0")/../../.."
cfg() { node -p "require('./$DIR/config.json').$1"; }
log() { echo "[$(date +%H:%M:%S) r$r] $*" | tee -a $DIR/summary.txt; }
r=$R0
while [ $r -lt $((R0 + N)) ]; do
  d=$DIR/r$(printf %02d $r); mkdir -p $d
  [ -f $d/selfplay/meta.json ] || { log "普查自我对打 $(cfg selfplayGames) 局，$AI";
    nice -n 10 node tools/lab/selfplay.mjs "$AI" $(cfg selfplayGames) $W $d/selfplay --jitter 1 --pos-games 0 --presets $(cfg presets) --seed-base $((70000000 + r * 10000000)) > $d/selfplay.log 2>&1; }
  log "拟合 + 预设互打"
  nice -n 10 node tools/lab/combo_fit.mjs $d/fit $d/selfplay > $d/fit.log 2>&1 &
  nice -n 10 node tools/lab/preset_tune.mjs "$AI" $(cfg presetsPer) $((W - 1)) $(cfg presetLo) $(cfg presetHi) $d/presets.json > $d/presets.log 2>&1
  wait $!
  log "调牌"
  node tools/lab/tune_step.mjs $d/fit $d/presets.json $DIR/state.json $r --apply --config $DIR/config.json > $d/tune.log 2>&1
  tail -5 $d/tune.log | tee -a $DIR/summary.txt
  r=$((r + 1))
done
log 完成
