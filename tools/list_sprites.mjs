// 列出卡牌表里每张牌用的角色图：{ 卡牌 id: 图集名 }，给 tools/build_gfx.py 用
import { CARDS } from '../chess.js';
console.log(JSON.stringify(Object.fromEntries(Object.entries(CARDS).filter(([, c]) => c.sp).map(([k, c]) => [k, c.sp]))));
