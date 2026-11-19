// 给 Python 实验脚本导出牌表：每张牌的固定特征（chess-net.js 的 SF）、games.bin 里的牌序号 → 网络里的牌编号、编码长度等常数。
// 用法：node tools/lab/v2/dump_cards.mjs <输出 cards.json>
import { writeFileSync } from 'node:fs';
import { SF, CS, D, CIDS, CIX, L } from '../net.mjs';
import { N } from '../../../chess.js';
import { IDS, REC } from '../census.mjs';

const out = process.argv[2];
if (!out) { console.error('用法：node tools/lab/v2/dump_cards.mjs <输出 cards.json>'); process.exit(2); }
writeFileSync(out, JSON.stringify({ N, L, CS, D, NC: CIDS.length + 1, REC, SF: Array.from(SF), ids2cix: IDS.map(k => CIX[k]), cids: CIDS }));
console.log(`${CIDS.length} 张牌、${IDS.length} 张可进卡组，固定特征 ${CS} 维 → ${out}`);
