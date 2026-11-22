"""Собирает кадры транспорта в одну таблицу с названиями и характеристиками."""
import json, sys
from PIL import Image, ImageDraw, ImageFont

data = json.load(open('shots/garage/specs.json'))
order, specs = data['order'], data['specs']
BOLD = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
REG = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
TYPES = {'car': 'Автомобиль', 'moto': 'Мотоцикл', 'boat': 'Катер', 'heli': 'Вертолёт'}
DRIVE = {'fwd': 'передний', 'rwd': 'задний', 'awd': 'полный'}
TW, TH, BAR, COLS, PAD = 600, 338, 74, 3, 14
rows = (len(order) + COLS - 1) // COLS
W = COLS * TW + (COLS + 1) * PAD
H = 96 + rows * (TH + BAR) + (rows + 1) * PAD
sheet = Image.new('RGB', (W, H), (10, 11, 16))
d = ImageDraw.Draw(sheet)
d.text((PAD + 4, 22), 'Транспорт Порт-Вельмара', font=ImageFont.truetype(BOLD, 40), fill=(255, 177, 59))
d.text((PAD + 6, 68), 'VELMAR: Ночной прилив · все модели в игре', font=ImageFont.truetype(REG, 20), fill=(190, 190, 200))
fn, fs = ImageFont.truetype(BOLD, 28), ImageFont.truetype(REG, 17)
for i, k in enumerate(order):
    s = specs[k]
    x = PAD + (i % COLS) * (TW + PAD)
    y = 96 + PAD + (i // COLS) * (TH + BAR + PAD)
    im = Image.open(f'shots/garage/{k}.png').convert('RGB')
    w, h = im.size
    cw, ch = int(w * 0.62), int(w * 0.62 * TH / TW)
    im = im.crop(((w - cw) // 2, (h - ch) // 2 + 20, (w + cw) // 2, (h + ch) // 2 + 20)).resize((TW, TH), Image.LANCZOS)
    sheet.paste(im, (x, y))
    d.rectangle([x, y + TH, x + TW, y + TH + BAR], fill=(20, 22, 30))
    d.text((x + 14, y + TH + 8), s['name'], font=fn, fill=(255, 255, 255))
    t = TYPES[s['type']]
    d.text((x + TW - 14 - d.textlength(t, font=fs), y + TH + 14), t, font=fs, fill=(255, 177, 59))
    line = f"до {s['speed']} км/ч · прочность {s['hp']} · {s['mass']} кг"
    if s['type'] in ('car', 'moto'):
        line += f" · привод {DRIVE[s['drive']]}"
    d.text((x + 14, y + TH + 46), line, font=fs, fill=(175, 178, 190))
sheet.save(sys.argv[1] if len(sys.argv) > 1 else 'docs/vehicles.png', optimize=True)
print('ok', sheet.size)
