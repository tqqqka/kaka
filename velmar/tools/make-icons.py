"""Процедурная иконка приложения: ночной горизонт и неоновая «V». Без внешних ассетов."""
import math, os, random, sys
from PIL import Image, ImageDraw, ImageFilter

RES = sys.argv[1] if len(sys.argv) > 1 else 'android/app/src/main/res'

def art(size, pad=0.0, round_mask=False, bg=True):
    S = size * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if bg:
        for y in range(S):
            t = y / S
            c = (int(14 + 40 * t), int(10 + 12 * t), int(30 + 20 * (1 - t)), 255)
            d.line([(0, y), (S, y)], fill=c)
        # Небоскрёбы.
        rnd = random.Random(7)
        x = 0
        while x < S:
            w = rnd.randint(S // 16, S // 8)
            h = rnd.randint(S // 6, S // 2)
            d.rectangle([x, S - h, x + w, S], fill=(18, 20, 34, 255))
            for wy in range(S - h + S // 40, S - S // 30, S // 22):
                for wx in range(x + S // 60, x + w - S // 60, S // 30):
                    if rnd.random() < 0.45:
                        d.rectangle([wx, wy, wx + S // 90, wy + S // 70], fill=(255, 196, 120, 255))
            x += w + rnd.randint(2, S // 40)
    # Неоновая V.
    m = pad * S
    pts = [(S * 0.22 + m * 0.3, S * 0.2 + m * 0.3), (S * 0.5, S * 0.8 - m * 0.3), (S * 0.78 - m * 0.3, S * 0.2 + m * 0.3)]
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.line(pts, fill=(255, 70, 110, 255), width=int(S * 0.14), joint='curve')
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.04))
    im = Image.alpha_composite(im, glow)
    d = ImageDraw.Draw(im)
    d.line(pts, fill=(255, 150, 60, 255), width=int(S * 0.09), joint='curve')
    d.line(pts, fill=(255, 235, 200, 255), width=int(S * 0.035), joint='curve')
    im = im.resize((size, size), Image.LANCZOS)
    if round_mask:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
        im.putalpha(mask)
    return im

dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, k in dens.items():
    folder = os.path.join(RES, f'mipmap-{name}')
    os.makedirs(folder, exist_ok=True)
    art(int(48 * k)).save(os.path.join(folder, 'ic_launcher.png'))
    art(int(48 * k), round_mask=True).save(os.path.join(folder, 'ic_launcher_round.png'))
    art(int(108 * k), pad=0.18).save(os.path.join(folder, 'ic_launcher_foreground.png'))
art(512).save('icon-512.png')
print('icons ok')
