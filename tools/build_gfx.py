# 按卡牌表把要用的角色帧图从 design/all-units/strips 拷到 assets/units，并生成 chess-gfx.js（帧格、脚底、身高、放大倍数）。
# 用法（项目根目录）：node tools/list_sprites.mjs | python3 -P -E tools/build_gfx.py
import json, shutil, sys
from pathlib import Path
from PIL import Image
SRC, OUT = Path('design/all-units/strips'), Path('assets/units')
ok = json.load(open('design/all-units/manifest.json'))['ok']
want = json.load(sys.stdin)            # { 卡牌 id: 图集名 }
ANIMS = ['idle', 'run', 'attack', 'hit', 'death']; gfx = {}; missing = []
for cid, uid in want.items():
    if uid not in ok: missing.append(uid); continue
    m = ok[uid]; cell = m['cell'][0]
    for a in ANIMS:
        src = SRC / f'{uid}_{a}.png'
        shutil.copyfile(src if src.exists() else SRC / f'{uid}_idle.png', OUT / f'{uid}_{a}.png')   # 缺的动作用待机顶上
    im = Image.open(SRC / f'{uid}_idle.png').convert('RGBA'); n = im.width // cell
    boxes = [im.crop((k * cell, 0, (k + 1) * cell, cell)).getchannel('A').point(lambda v: 255 if v > 40 else 0).getbbox() for k in range(n)]
    boxes = [b for b in boxes if b]; feet = max(b[3] for b in boxes); tops = sorted(b[1] for b in boxes); h = feet - tops[len(tops) // 2]
    gfx[cid] = {'file': uid, 'cell': cell, 'feet': feet, 'h': h, 'scale': round(min(1.6, max(1.0, 58 / h)) * 20) / 20}
js = '// 由 tools/build_gfx.py 生成，不要手改。每张牌的角色图：图集名、帧格边长、脚底 y、站立身高、放大倍数（放大到站立约 58 像素）。\nexport const MORE_GFX = ' + json.dumps(gfx, ensure_ascii=False, indent=1) + ';\n'
for k in ['file', 'cell', 'feet', 'h', 'scale']: js = js.replace(f'"{k}"', k)
Path('chess-gfx.js').write_text(js, encoding='utf-8')
print(f'{len(gfx)} 张牌的角色图就绪；找不到图集的：{missing or "无"}', file=sys.stderr)
