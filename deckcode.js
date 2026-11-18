// 卡组代码：把一副 12 张牌压成一行字，复制给别人就能照着重现。YF1- 是格式版本，以后改格式好认。
// 只做“这串代码是不是一副能带的牌”的检查；首领牌有没有赢到手，留给组牌界面保存时再拦（这里先按已拥有算）。
import { CARDS, deckError } from './chess.js';

export const PREFIX = 'YF1-';
export const encode = cards => PREFIX + cards.join('.');

export function decode(text) {
  const raw = String(text || '').trim().replace(/^(?:yf1|YF1)\s*[-:：]\s*/, '').trim();
  if (!raw) return { error: '先粘贴一串卡组代码。' };
  const cards = raw.split(/[.\s,，、+]+/).filter(Boolean);
  if (cards.length !== 12) return { error: `卡组代码要正好 12 张牌，这串是 ${cards.length} 张。` };
  const unknown = cards.find(c => !CARDS[c] || CARDS[c].token);
  if (unknown) return { error: `代码里的「${unknown}」不是能带的牌，可能不是这个版本的代码。` };
  if (new Set(cards).size !== 12) return { error: '代码里有重复的牌。' };
  const err = deckError(cards, cards.filter(c => CARDS[c].boss)); // 阵营、首领张数这些规则照查
  return err ? { error: err } : { cards };
}
