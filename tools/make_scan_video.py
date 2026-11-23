"""Make the MEEGO AI "scanning" video the Telegram bot plays before showing signals.

Run:  python tools/make_scan_video.py
Out:  public/media/meego-scan.mp4 (640x640, silent, ~4.5 s) + a preview frame PNG.
Needs: pillow, numpy, imageio-ffmpeg (for the ffmpeg binary).
"""
import math
import os
import random
import subprocess

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "media")
OUT = os.path.join(OUT_DIR, "meego-scan.mp4")
ICON = os.path.join(ROOT, "public", "icons", "icon-512.png")

S = 2                    # supersample factor for smooth edges
W = H = 640
FPS = 30
SECONDS = 4.5
N = int(FPS * SECONDS)

NAVY_TOP = (8, 19, 44)
NAVY_BOT = (17, 36, 78)
GOLD = (226, 184, 92)
GOLD_HI = (250, 222, 150)
WHITE = (232, 238, 250)
MUTED = (130, 150, 190)
GREEN = (46, 204, 140)
RED = (235, 87, 87)
GRID = (40, 62, 110)

FONTS = "C:/Windows/Fonts"
def font(name, size):
    try:
        return ImageFont.truetype(os.path.join(FONTS, name), size * S)
    except OSError:
        return ImageFont.load_default()

F_BRAND = font("bahnschrift.ttf", 40)
F_SUB = font("bahnschrift.ttf", 15)
F_STATUS = font("bahnschrift.ttf", 22)
F_PCT = font("consola.ttf", 20)
F_TAG = font("bahnschrift.ttf", 14)

# ---------- static pieces ----------
def background():
    img = Image.new("RGB", (W * S, H * S))
    d = ImageDraw.Draw(img)
    for y in range(H * S):
        t = y / (H * S)
        d.line([(0, y), (W * S, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(NAVY_TOP, NAVY_BOT)))
    return img

BG = background()
icon = Image.open(ICON).convert("RGBA").resize((64 * S, 64 * S), Image.LANCZOS)

# Chart area
CX0, CY0, CX1, CY1 = 40, 150, 600, 470

random.seed(19)
candles = []
price = 100.0
for i in range(44):
    drift = 0.55 * math.sin(i / 6.0) + (0.35 if i > 26 else -0.1)
    o = price
    c = o + drift + random.uniform(-1.4, 1.4)
    hi = max(o, c) + random.uniform(0.2, 1.2)
    lo = min(o, c) - random.uniform(0.2, 1.2)
    candles.append((o, hi, lo, c))
    price = c
pmin = min(c[2] for c in candles) - 1
pmax = max(c[1] for c in candles) + 1
def py(p):
    return CY1 - (p - pmin) / (pmax - pmin) * (CY1 - CY0)
step = (CX1 - CX0) / len(candles)

# simple EMA of closes for the gold line
ema, e = [], candles[0][3]
for c in candles:
    e = c[3] * 0.18 + e * 0.82
    ema.append(e)

STATUSES = [
    (0.00, "Connecting to live market data"),
    (0.18, "Scanning XAUUSD · EURUSD · GBPUSD"),
    (0.40, "Reading trend and market structure"),
    (0.62, "Checking momentum and key levels"),
    (0.82, "Matching high-probability setups"),
]

def ease(t):
    return 1 - (1 - t) ** 3

def frame(i):
    t = i / (N - 1)
    scan_t = min(1.0, t / 0.86)            # scan finishes at 86 %, then hold
    img = BG.copy()
    d = ImageDraw.Draw(img, "RGBA")

    # header: icon + brand
    hx, hy = 40, 44
    img.paste(icon, (hx * S, hy * S), icon)
    d.text(((hx + 80) * S, (hy + 2) * S), "MEEGO AI", font=F_BRAND, fill=GOLD)
    d.text(((hx + 82) * S, (hy + 48) * S), "SIGNAL SCANNER", font=F_SUB, fill=MUTED)
    # live dot (blinking)
    blink = 0.5 + 0.5 * math.sin(i / FPS * 2 * math.pi * 1.5)
    lx, ly = 560, 70
    d.ellipse([(lx - 6) * S, (ly - 6) * S, (lx + 6) * S, (ly + 6) * S], fill=GREEN + (int(120 + 135 * blink),))
    d.text(((lx - 48) * S, (ly - 9) * S), "LIVE", font=F_TAG, fill=WHITE)

    # chart frame + grid
    d.rounded_rectangle([(CX0 - 14) * S, (CY0 - 14) * S, (CX1 + 14) * S, (CY1 + 14) * S], radius=14 * S,
                        fill=(12, 26, 58, 255), outline=(52, 78, 130, 255), width=S)
    for k in range(1, 5):
        y = CY0 + (CY1 - CY0) * k / 5
        d.line([(CX0 * S, y * S), (CX1 * S, y * S)], fill=GRID + (140,), width=S)
    for k in range(1, 8):
        x = CX0 + (CX1 - CX0) * k / 8
        d.line([(x * S, CY0 * S), (x * S, CY1 * S)], fill=GRID + (90,), width=S)

    # candles revealed behind the scan line
    scan_x = CX0 + (CX1 - CX0) * ease(scan_t)
    shown = 0
    for k, (o, hi, lo, c) in enumerate(candles):
        x = CX0 + step * (k + 0.5)
        if x > scan_x:
            break
        shown = k + 1
        col = GREEN if c >= o else RED
        d.line([(x * S, py(hi) * S), (x * S, py(lo) * S)], fill=col, width=2 * S)
        top, bot = py(max(o, c)), py(min(o, c))
        if bot - top < 2:
            bot = top + 2
        d.rectangle([(x - step * 0.32) * S, top * S, (x + step * 0.32) * S, bot * S], fill=col)
    if shown > 1:
        pts = [((CX0 + step * (k + 0.5)) * S, py(ema[k]) * S) for k in range(shown)]
        d.line(pts, fill=GOLD + (230,), width=3 * S, joint="curve")

    # key level boxes appear late in the scan
    if scan_t > 0.55:
        a = min(1.0, (scan_t - 0.55) / 0.15)
        y1 = py(max(c[1] for c in candles[:20]))
        d.line([(CX0 * S, y1 * S), (CX1 * S, y1 * S)], fill=GOLD + (int(170 * a),), width=S)
        d.text(((CX0 + 4) * S, (y1 - 20) * S), "RESISTANCE", font=F_TAG, fill=GOLD + (int(220 * a),))
        y2 = py(min(c[2] for c in candles[10:30]))
        d.line([(CX0 * S, y2 * S), (CX1 * S, y2 * S)], fill=MUTED + (int(160 * a),), width=S)
        d.text(((CX0 + 4) * S, (y2 + 4) * S), "SUPPORT", font=F_TAG, fill=MUTED + (int(220 * a),))

    # scan line with glow
    if scan_t < 1.0:
        glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
        g = ImageDraw.Draw(glow)
        g.rectangle([(scan_x - 26) * S, CY0 * S, (scan_x + 2) * S, CY1 * S], fill=GOLD + (60,))
        glow = glow.filter(ImageFilter.GaussianBlur(10 * S))
        img.paste(glow, (0, 0), glow)
        d = ImageDraw.Draw(img, "RGBA")
        d.line([(scan_x * S, (CY0 - 6) * S), (scan_x * S, (CY1 + 6) * S)], fill=GOLD_HI, width=2 * S)

    # status text + progress
    pct = int(round(100 * scan_t))
    if scan_t >= 1.0:
        label, col = "Scan complete", GREEN
    else:
        label, col = [s for s in STATUSES if scan_t >= s[0]][-1][1], WHITE
        label += "." * (1 + (i // 8) % 3)
    d.text((40 * S, 506 * S), label, font=F_STATUS, fill=col)
    d.text((556 * S, 508 * S), f"{pct:3d}%", font=F_PCT, fill=GOLD)
    bx0, by0, bx1, by1 = 40, 548, 600, 560
    d.rounded_rectangle([bx0 * S, by0 * S, bx1 * S, by1 * S], radius=6 * S, fill=(30, 48, 90, 255))
    fill_to = bx0 + (bx1 - bx0) * scan_t
    if fill_to > bx0 + 6:
        d.rounded_rectangle([bx0 * S, by0 * S, fill_to * S, by1 * S], radius=6 * S, fill=GREEN if scan_t >= 1 else GOLD)
    d.text((40 * S, 582 * S), "AI market analysis  ·  Not financial advice", font=F_TAG, fill=MUTED)

    return img.resize((W, H), Image.LANCZOS)

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.Popen([ff, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                             "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "22",
                             "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT], stdin=subprocess.PIPE)
    for i in range(N):
        f = frame(i)
        if i in (int(N * 0.5), N - 1):
            f.save(os.path.join(OUT_DIR, f"preview-{i}.png"))
        proc.stdin.write(f.tobytes())
    proc.stdin.close()
    proc.wait()
    print("wrote", OUT, os.path.getsize(OUT), "bytes")

if __name__ == "__main__":
    main()
