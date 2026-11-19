#!/bin/sh
# DeepSeek agent（DeepSeek Harness，模型走 5090 本机 magpie）在无头浏览器里和大师电脑对打若干局，每局一个独立会话、各写一段复盘进 out/agent/notes.md。
# 用法（5090 上，仓库根目录）：sh tools/lab/v2/agent_run.sh <局数> [大师网络.json] [起始局号=1]
#   卡组轮着用预设，对面卡组错开一位；board_cli serve 会自动起（换网络时重启）。每局的 agent 输出在 out/agent/runs/<局号>.log，对局记录在 out/agent/games/
set -e
N=$1; NET=${2:-}; K0=${3:-1}
cd "$(dirname "$0")/../../.."
mkdir -p out/agent/runs
pkill -f '^node tools/lab/v2/board_cli' 2>/dev/null || true; sleep 1
nohup node tools/lab/v2/board_cli.mjs serve ${NET:+--net "$NET"} > out/agent/serve.log 2>&1 &
sleep 6; grep -q 就绪 out/agent/serve.log || { cat out/agent/serve.log; exit 1; }
DECKS=$(node -e "import('./chess.js').then(m => console.log(m.DECKS.map(d => d.name).join('\n')))")
ND=$(echo "$DECKS" | wc -l)
k=$K0; end=$((K0 + N - 1))
while [ $k -le $end ]; do
  MINE=$(echo "$DECKS" | sed -n "$(( (k - 1) % ND + 1 ))p"); THEIRS=$(echo "$DECKS" | sed -n "$(( k % ND + 1 ))p")
  T=$(sed -e "s/{MINE}/$MINE/g" -e "s/{THEIRS}/$THEIRS/g" -e "s/{GAME}/第 $k 局/g" tools/lab/v2/agent_task.md)
  t0=$(date +%s)
  MAGPIE_GATEWAY_KEY=local nice -n 10 timeout 3600 dsh headless --patch out/agent/magpie.patch.yml --permission-mode workspace-write --approval-policy never "$T" > out/agent/runs/$k.log 2>&1 || echo "第 $k 局 agent 退出码 $?" >> out/agent/runs/$k.log
  echo "第 $k 局（$MINE 对 $THEIRS）$(( $(date +%s) - t0 )) 秒：$(tail -1 out/agent/runs/$k.log)"
  k=$((k + 1))
done
