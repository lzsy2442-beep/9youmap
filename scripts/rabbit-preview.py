"""兔子图标预览 v4：直接用与 canvas 相同的本地坐标（x -7..7，y -23..3）"""
import os
from PIL import Image, ImageDraw

GOLD = (222, 179, 105, 255)
GOLD_LT = (246, 217, 160, 255)
GOLD_DK = (168, 122, 58, 255)
INK = (44, 36, 25, 240)

BOX_X = (-7.0, 7.0)
BOX_Y = (-23.0, 3.0)


def make(size, scale=8):
    W = size * scale
    H = size * scale
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    kx = W / (BOX_X[1] - BOX_X[0])
    ky = H / (BOX_Y[1] - BOX_Y[0])
    k = min(kx, ky)

    def P(x, y):
        return ((x - BOX_X[0]) * k, (y - BOX_Y[0]) * k)

    def capsule(p1, p2, r, fill, outline=None, ow=0):
        a, b = P(*p1), P(*p2)
        rr = r * k
        if outline:
            d.line([a, b], fill=outline, width=int((r + ow) * 2 * k))
            for c in (a, b):
                d.ellipse([c[0] - rr - ow * k, c[1] - rr - ow * k,
                           c[0] + rr + ow * k, c[1] + rr + ow * k], fill=outline)
        d.line([a, b], fill=fill, width=int(rr * 2))
        for c in (a, b):
            d.ellipse([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr], fill=fill)

    # 地面投影
    d.ellipse([P(-4.8, 0.1)[0], P(0, -0.4)[1], P(4.8, 1.9)[0], P(0, 2.4)[1]], fill=(44, 36, 25, 34))

    # 耳朵
    capsule((-2.3, -9.2), (-2.9, -18.4), 1.75, GOLD, INK, 0.72)
    capsule((2.3, -9.2), (2.9, -18.4), 1.75, GOLD, INK, 0.72)
    capsule((-2.3, -10.0), (-2.8, -17.2), 0.75, GOLD_LT)
    capsule((2.3, -10.0), (2.8, -17.2), 0.75, GOLD_LT)

    # 脸
    d.ellipse([P(-5.9, -12.4)[0], P(0, -12.4)[1], P(5.9, -0.6)[0], P(0, -0.6)[1]],
              fill=GOLD, outline=INK, width=max(1, int(0.75 * k)))

    # 眼睛
    for ex in (-2.05, 2.05):
        d.ellipse([P(ex - 0.8, -8.1)[0], P(0, -8.1)[1],
                   P(ex + 0.8, -6.3)[0], P(0, -6.3)[1]], fill=INK)

    # 鼻子 + 嘴
    d.polygon([P(0, -5.3), P(-0.7, -4.4), P(0.7, -4.4)], fill=(140, 59, 43, 235))
    d.line([P(0, -4.3), P(0, -3.8)], fill=INK, width=max(1, int(0.4 * k)))
    d.arc([P(-1.6, -4.1)[0], P(0, -4.1)[1], P(1.6, -2.3)[0], P(0, -2.3)[1]],
          20, 160, fill=INK, width=max(1, int(0.4 * k)))

    return img


canvas = Image.new('RGBA', (900, 470), (239, 228, 204, 255))
canvas.alpha_composite(make(26, 12), (40, 40))
d = ImageDraw.Draw(canvas)
for i, s in enumerate((16, 20, 24, 30, 40)):
    small = make(s, 6)
    x = 400 + i * 100
    canvas.alpha_composite(small, (x, 150))
    d.rectangle([x, 150, x + s * 6, 150 + s * 6], outline=(186, 166, 136, 140))

os.makedirs('out', exist_ok=True)
canvas.save('out/rabbit-preview.png')
print('saved')
