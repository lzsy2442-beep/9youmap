"""生成 PWA / 主屏图标（192 / 512 / 180）"""
import os
from PIL import Image, ImageDraw

PAPER = (239, 228, 204, 255)
INK = (44, 36, 25, 255)
BRASS = (176, 138, 79, 255)
BRASS_LT = (216, 183, 122, 255)


def icon(size):
    S = size * 4
    img = Image.new('RGBA', (S, S), PAPER)
    d = ImageDraw.Draw(img)
    k = S / 32.0

    # 伞面
    d.pieslice([8 * k, 4 * k, 24 * k, 20 * k], 180, 360, fill=BRASS, outline=INK, width=int(0.7 * k))
    # 伞面分片线
    for x in (12, 16, 20):
        d.line([(16 * k, 4 * k), (x * k, 12 * k)], fill=INK, width=max(1, int(0.35 * k)))
    # 波浪下沿
    for i, x in enumerate((9.6, 13.2, 16, 18.8, 22.4)):
        d.arc([(x - 1.6) * k, 10.4 * k, (x + 1.6) * k, 13.6 * k], 0, 180, fill=INK, width=max(1, int(0.45 * k)))
    # 伞杆
    d.line([(16 * k, 12 * k), (16 * k, 24 * k)], fill=INK, width=max(2, int(0.9 * k)))
    d.arc([12.4 * k, 20.4 * k, 16.8 * k, 26 * k], 0, 180, fill=INK, width=max(2, int(0.9 * k)))
    # 高光
    d.pieslice([10 * k, 6 * k, 17 * k, 13 * k], 180, 270, fill=BRASS_LT)
    return img.resize((size, size), Image.LANCZOS)


os.makedirs('public/icons', exist_ok=True)
for s in (180, 192, 512):
    icon(s).save(f'public/icons/icon-{s}.png')
    print('saved', s)

svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#EFE4CC"/>
  <path d="M8 12a8 8 0 0 1 16 0q-2-1.6-4 0-2-1.6-4 0-2-1.6-4 0-2-1.6-4 0z" fill="#B08A4F" stroke="#2C2419" stroke-width="1"/>
  <path d="M16 12v12q0 3 3 3" fill="none" stroke="#2C2419" stroke-width="1.6" stroke-linecap="round"/>
</svg>'''
with open('public/icons/icon.svg', 'w', encoding='utf-8') as f:
    f.write(svg)
print('saved svg')
