# 把 meow-ai-arena（MIT）的 AI 角色表情立绘做成像素头像：取上半身的头部方块 → 缩到 48×48 → 压成 24 色 → 透明边缘硬切 → 外面描一圈墨色。
# 原图在 raw/arena-art/<角色目录>/<表情>.png（raw/ 不进仓库），产物在 assets/avatars/<键>_<表情>.png，游戏里按整数倍放大显示。
# 用法：python3 -P tools/pixel_avatars.py
import os
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC, OUT = os.path.join(ROOT, 'raw/arena-art'), os.path.join(ROOT, 'assets/avatars')
CHARS = {  # 游戏里的键 → 原图目录。名字在 cup.js 里
    'claude': 'Claude_大_Opus', 'gptsol': 'GPT_小_Sol', 'deepseek': 'DeepSeek_大', 'glm': 'GLM_大', 'gemini': 'Gemini_大',
    'grok': 'Grok_大', 'kimi': 'Kimi_大', 'mimo': 'MiMo_大', 'qwen': '千问_大', 'ernie': '文心_大',
}
FACES = {'常态': 'idle', '得意': 'smug', '伤心': 'sad', '震惊': 'shock'}
SIZE, COLORS, INK = 48, 24, (8, 8, 24, 255)


def crop(im):  # 头部方块：以人像的上沿为顶，宽度取图宽的六成，左右对准上半部分人像的中线
    a = im.getchannel('A'); x0, y0, x1, y1 = a.getbbox()
    side = int(im.width * .6); top = max(0, y0 - side // 20)
    band = a.crop((0, top, im.width, min(im.height, top + side))).getbbox()
    cx = (band[0] + band[2]) // 2 if band else (x0 + x1) // 2
    left = max(0, min(im.width - side, cx - side // 2))
    return im.crop((left, top, left + side, top + side))


def pixel(im):
    small = im.resize((SIZE, SIZE), Image.BOX)
    alpha = small.getchannel('A').point(lambda v: 255 if v >= 110 else 0)
    rgb = Image.new('RGB', small.size, (0, 0, 0)); rgb.paste(small.convert('RGB'), mask=alpha)
    q = rgb.quantize(COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGBA'); q.putalpha(alpha)
    out = Image.new('RGBA', (SIZE + 2, SIZE + 2), (0, 0, 0, 0)); px = out.load(); src = q.load()
    for y in range(SIZE):  # 墨色描边：透明格子挨着人像就涂墨（四向）
        for x in range(SIZE):
            if src[x, y][3]: continue
            if any(0 <= x + dx < SIZE and 0 <= y + dy < SIZE and src[x + dx, y + dy][3] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))): px[x + 1, y + 1] = INK
    out.alpha_composite(q, (1, 1))
    return out


def main():
    os.makedirs(OUT, exist_ok=True); n = 0
    for key, d in CHARS.items():
        for cn, en in FACES.items():
            f = os.path.join(SRC, d, cn + '.png')
            if not os.path.exists(f): print('缺', f); continue
            pixel(crop(Image.open(f).convert('RGBA'))).save(os.path.join(OUT, f'{key}_{en}.png'), optimize=True); n += 1
    print(f'做了 {n} 张，在 {os.path.relpath(OUT, ROOT)}')


if __name__ == '__main__':
    main()
