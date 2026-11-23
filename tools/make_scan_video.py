"""Make the MEEGO AI videos the Telegram bot plays (welcome, scans, direction, history).

Run:  python tools/make_scan_video.py            (all videos)
      python tools/make_scan_video.py welcome    (just one)
Out:  public/media/meego-<name>.mp4  (640x640, silent, H.264)
Needs: pillow, numpy, imageio-ffmpeg (for the ffmpeg binary).
"""
import math
import os
import random
import subprocess
import sys

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "media")
ICON = os.path.join(ROOT, "public", "icons", "icon-512.png")
PREVIEW = "--preview" in sys.argv

S = 2                    # supersample factor for smooth edges
W = H = 640
FPS = 30

NAVY_TOP = (8, 19, 44)
NAVY_BOT = (17, 36, 78)
GOLD = (226, 184, 92)
GOLD_HI = (250, 222, 150)
WHITE = (232, 238, 250)
MUTED = (130, 150, 190)
GREEN = (46, 204, 140)
RED = (235, 87, 87)
GRID = (40, 62, 110)
PANEL = (12, 26, 58, 255)
PANEL_EDGE = (52, 78, 130, 255)

FONTS = "C:/Windows/Fonts"
def font(name, size):
    try:
        return ImageFont.truetype(os.path.join(FONTS, name), int(size * S))
    except OSError:
        return ImageFont.load_default()

F_BRAND = font("bahnschrift.ttf", 40)
F_SUB = font("bahnschrift.ttf", 15)
F_STATUS = font("bahnschrift.ttf", 22)
F_PCT = font("consola.ttf", 20)
F_TAG = font("bahnschrift.ttf", 14)
F_ROW = font("bahnschrift.ttf", 24)
F_HUGE = font("bahnschrift.ttf", 76)
F_WELCOME = font("bahnschrift.ttf", 24)

def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3

def clamp01(t):
    return max(0.0, min(1.0, t))

def background():
    img = Image.new("RGB", (W * S, H * S))
    d = ImageDraw.Draw(img)
    for y in range(H * S):
        t = y / (H * S)
        d.line([(0, y), (W * S, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(NAVY_TOP, NAVY_BOT)))
    return img

BG = background()
ICON_IMG = Image.open(ICON).convert("RGBA")
ICON_64 = ICON_IMG.resize((64 * S, 64 * S), Image.LANCZOS)

# ---------- shared pieces ----------
def header(img, d, i, subtitle):
    hx, hy = 40, 44
    img.paste(ICON_64, (hx * S, hy * S), ICON_64)
    d.text(((hx + 80) * S, (hy + 2) * S), "MEEGO AI", font=F_BRAND, fill=GOLD)
    d.text(((hx + 82) * S, (hy + 48) * S), subtitle, font=F_SUB, fill=MUTED)
    blink = 0.5 + 0.5 * math.sin(i / FPS * 2 * math.pi * 1.5)
    lx, ly = 560, 70
    d.ellipse([(lx - 6) * S, (ly - 6) * S, (lx + 6) * S, (ly + 6) * S], fill=GREEN + (int(120 + 135 * blink),))
    d.text(((lx - 48) * S, (ly - 9) * S), "LIVE", font=F_TAG, fill=WHITE)

def panel(d, x0, y0, x1, y1):
    d.rounded_rectangle([x0 * S, y0 * S, x1 * S, y1 * S], radius=14 * S, fill=PANEL, outline=PANEL_EDGE, width=S)

def footer(d, i, prog, statuses, done_text):
    pct = int(round(100 * prog))
    if prog >= 1.0:
        label, col = done_text, GREEN
    else:
        label, col = [s for s in statuses if prog >= s[0]][-1][1], WHITE
        label += "." * (1 + (i // 8) % 3)
    d.text((40 * S, 506 * S), label, font=F_STATUS, fill=col)
    d.text((556 * S, 508 * S), f"{pct:3d}%", font=F_PCT, fill=GOLD)
    bx0, by0, bx1, by1 = 40, 548, 600, 560
    d.rounded_rectangle([bx0 * S, by0 * S, bx1 * S, by1 * S], radius=6 * S, fill=(30, 48, 90, 255))
    fill_to = bx0 + (bx1 - bx0) * prog
    if fill_to > bx0 + 6:
        d.rounded_rectangle([bx0 * S, by0 * S, fill_to * S, by1 * S], radius=6 * S, fill=GREEN if prog >= 1 else GOLD)
    d.text((40 * S, 582 * S), "AI market analysis  ·  Not financial advice", font=F_TAG, fill=MUTED)

def glow_line(img, x, y0, y1):
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.rectangle([(x - 26) * S, y0 * S, (x + 2) * S, y1 * S], fill=GOLD + (60,))
    glow = glow.filter(ImageFilter.GaussianBlur(10 * S))
    img.paste(glow, (0, 0), glow)
    d = ImageDraw.Draw(img, "RGBA")
    d.line([(x * S, (y0 - 6) * S), (x * S, (y1 + 6) * S)], fill=GOLD_HI, width=2 * S)
    return d

def checkmark(d, cx, cy, r, col):
    d.line([((cx - r * 0.55) * S, cy * S), ((cx - r * 0.1) * S, (cy + r * 0.45) * S), ((cx + r * 0.6) * S, (cy - r * 0.5) * S)],
           fill=col, width=3 * S, joint="curve")

def spinner(d, cx, cy, r, i):
    a = (i * 18) % 360
    d.arc([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], start=a, end=a + 270, fill=GOLD, width=3 * S)

# ---------- 1) welcome ----------
def welcome_frame(i, n):
    t = i / (n - 1)
    img = BG.copy()
    # soft centre glow
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    rr = (170 + 40 * ease(t / 0.4)) * S
    cx, cy = 320 * S, 230 * S
    g.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=GOLD + (int(46 * ease(t / 0.4)),))
    glow = glow.filter(ImageFilter.GaussianBlur(60 * S))
    img.paste(glow, (0, 0), glow)
    d = ImageDraw.Draw(img, "RGBA")

    # rising gold particles
    rnd = random.Random(7)
    for _ in range(46):
        px0, speed, size, phase = rnd.uniform(20, 620), rnd.uniform(40, 110), rnd.uniform(1.2, 3.2), rnd.uniform(0, 1)
        y = (680 - ((t * 4.5 * speed) + phase * 700) % 720)
        a = int(150 * clamp01(t / 0.2) * (0.4 + 0.6 * math.sin(phase * 6 + t * 8) ** 2))
        d.ellipse([(px0 - size) * S, (y - size) * S, (px0 + size) * S, (y + size) * S], fill=GOLD_HI + (a,))

    # icon pop-in + ring
    k = ease(t / 0.28)
    size = int((96 + 64 * k) * S)
    ic = ICON_IMG.resize((size, size), Image.LANCZOS)
    alpha = ic.split()[3].point(lambda v: int(v * k))
    ic.putalpha(alpha)
    img.paste(ic, (cx - size // 2, cy - size // 2), ic)
    ring_r = 104 * S
    sweep = 360 * ease((t - 0.08) / 0.4)
    if sweep > 1:
        d.arc([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r], start=-90, end=-90 + sweep, fill=GOLD, width=3 * S)
        d.arc([cx - ring_r - 10 * S, cy - ring_r - 10 * S, cx + ring_r + 10 * S, cy + ring_r + 10 * S],
              start=90, end=90 + sweep * 0.6, fill=GOLD + (110,), width=S)

    # "WELCOME TO"
    a1 = clamp01((t - 0.24) / 0.14)
    txt = "W E L C O M E   T O"
    w1 = d.textlength(txt, font=F_WELCOME)
    d.text(((W * S - w1) / 2, (360 + 8 * (1 - a1)) * S), txt, font=F_WELCOME, fill=WHITE + (int(230 * a1),))

    # "MEEGO AI" letter by letter
    word = "MEEGO AI"
    total = d.textlength(word, font=F_HUGE)
    x = (W * S - total) / 2
    base_y = 392
    for j, ch in enumerate(word):
        lt = clamp01((t - 0.34 - j * 0.035) / 0.12)
        if lt > 0:
            d.text((x, (base_y + 18 * (1 - ease(lt))) * S), ch, font=F_HUGE, fill=GOLD + (int(255 * lt),))
        x += d.textlength(ch, font=F_HUGE)

    # shimmer across the brand
    sh = (t - 0.72) / 0.18
    if 0 < sh < 1:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        sx = ((W * S - total) / 2) + total * sh
        ld.polygon([(sx - 30 * S, (base_y + 6) * S), (sx + 10 * S, (base_y + 6) * S), (sx - 10 * S, (base_y + 92) * S), (sx - 50 * S, (base_y + 92) * S)],
                   fill=(255, 255, 255, 90))
        mask = Image.new("L", img.size, 0)
        md = ImageDraw.Draw(mask)
        md.text((((W * S - total) / 2), base_y * S), word, font=F_HUGE, fill=255)
        layer.putalpha(Image.composite(layer.split()[3], Image.new("L", img.size, 0), mask))
        img.paste(layer, (0, 0), layer)
        d = ImageDraw.Draw(img, "RGBA")

    # gold rule + tagline
    lt = ease((t - 0.58) / 0.16)
    half = 150 * lt
    d.line([((320 - half) * S, 500 * S), ((320 + half) * S, 500 * S)], fill=GOLD, width=2 * S)
    a2 = clamp01((t - 0.66) / 0.14)
    tag = "Signals  ·  Hit TP / SL  ·  AI chart analysis"
    w2 = d.textlength(tag, font=F_TAG)
    d.text(((W * S - w2) / 2, 520 * S), tag, font=F_TAG, fill=MUTED + (int(255 * a2),))
    tag2 = "SCALPING  ·  INTRADAY  ·  SWING"
    w3 = d.textlength(tag2, font=F_SUB)
    d.text(((W * S - w3) / 2, 548 * S), tag2, font=F_SUB, fill=GOLD + (int(220 * a2),))
    return img.resize((W, H), Image.LANCZOS)

# ---------- 2) scans per signal type ----------
SCANS = {
    "scalping": dict(sub="SCALPING SCANNER", candles=64, vol=0.9, seed=3, statuses=[
        (0.00, "Connecting to live market data"),
        (0.18, "Reading M1 · M5 price action"),
        (0.40, "Tracking momentum bursts"),
        (0.62, "Spotting quick breakout levels"),
        (0.82, "Matching scalping setups"),
    ]),
    "intraday": dict(sub="INTRADAY SCANNER", candles=44, vol=1.4, seed=19, statuses=[
        (0.00, "Connecting to live market data"),
        (0.18, "Scanning XAUUSD · EURUSD · GBPUSD"),
        (0.40, "Reading M15 · H1 structure"),
        (0.62, "Checking momentum and key levels"),
        (0.82, "Matching intraday setups"),
    ]),
    "swing": dict(sub="PRIORITY SWING SCANNER", candles=30, vol=2.2, seed=41, statuses=[
        (0.00, "Connecting to live market data"),
        (0.18, "Reading H4 · D1 trend"),
        (0.40, "Mapping major supply and demand"),
        (0.62, "Confirming higher-timeframe bias"),
        (0.82, "Matching high-quality swing setups"),
    ]),
}
CX0, CY0, CX1, CY1 = 40, 150, 600, 470

def make_candles(n, vol, seed):
    rnd = random.Random(seed)
    out, price = [], 100.0
    for k in range(n):
        drift = 0.55 * math.sin(k / (n / 7.0)) + (0.35 if k > n * 0.6 else -0.1)
        o = price
        c = o + drift * vol / 1.4 + rnd.uniform(-vol, vol)
        hi = max(o, c) + rnd.uniform(0.15, 0.85) * vol
        lo = min(o, c) - rnd.uniform(0.15, 0.85) * vol
        out.append((o, hi, lo, c))
        price = c
    return out

def scan_frame_factory(cfg):
    candles = make_candles(cfg["candles"], cfg["vol"], cfg["seed"])
    pmin = min(c[2] for c in candles) - 1
    pmax = max(c[1] for c in candles) + 1
    py = lambda p: CY1 - (p - pmin) / (pmax - pmin) * (CY1 - CY0)
    step = (CX1 - CX0) / len(candles)
    ema, e = [], candles[0][3]
    for c in candles:
        e = c[3] * 0.18 + e * 0.82
        ema.append(e)
    third = len(candles) // 3

    def frame(i, n):
        t = i / (n - 1)
        prog = min(1.0, t / 0.86)
        img = BG.copy()
        d = ImageDraw.Draw(img, "RGBA")
        header(img, d, i, cfg["sub"])
        panel(d, CX0 - 14, CY0 - 14, CX1 + 14, CY1 + 14)
        for k in range(1, 5):
            y = CY0 + (CY1 - CY0) * k / 5
            d.line([(CX0 * S, y * S), (CX1 * S, y * S)], fill=GRID + (140,), width=S)
        for k in range(1, 8):
            x = CX0 + (CX1 - CX0) * k / 8
            d.line([(x * S, CY0 * S), (x * S, CY1 * S)], fill=GRID + (90,), width=S)
        scan_x = CX0 + (CX1 - CX0) * ease(prog)
        shown = 0
        for k, (o, hi, lo, c) in enumerate(candles):
            x = CX0 + step * (k + 0.5)
            if x > scan_x:
                break
            shown = k + 1
            col = GREEN if c >= o else RED
            d.line([(x * S, py(hi) * S), (x * S, py(lo) * S)], fill=col, width=max(1, int(1.6 * S)))
            top, bot = py(max(o, c)), py(min(o, c))
            if bot - top < 2:
                bot = top + 2
            d.rectangle([(x - step * 0.32) * S, top * S, (x + step * 0.32) * S, bot * S], fill=col)
        if shown > 1:
            pts = [((CX0 + step * (k + 0.5)) * S, py(ema[k]) * S) for k in range(shown)]
            d.line(pts, fill=GOLD + (230,), width=3 * S, joint="curve")
        if prog > 0.55:
            a = min(1.0, (prog - 0.55) / 0.15)
            y1 = py(max(c[1] for c in candles[:2 * third]))
            d.line([(CX0 * S, y1 * S), (CX1 * S, y1 * S)], fill=GOLD + (int(170 * a),), width=S)
            d.text(((CX0 + 4) * S, (y1 - 20) * S), "RESISTANCE", font=F_TAG, fill=GOLD + (int(220 * a),))
            y2 = py(min(c[2] for c in candles[third // 2:2 * third]))
            d.line([(CX0 * S, y2 * S), (CX1 * S, y2 * S)], fill=MUTED + (int(160 * a),), width=S)
            d.text(((CX0 + 4) * S, (y2 + 4) * S), "SUPPORT", font=F_TAG, fill=MUTED + (int(220 * a),))
        if prog < 1.0:
            d = glow_line(img, scan_x, CY0, CY1)
        footer(d, i, prog, cfg["statuses"], "Scan complete")
        return img.resize((W, H), Image.LANCZOS)
    return frame

# ---------- 3) direction ----------
PAIRS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"]
def direction_frame_factory():
    rnd = random.Random(5)
    lines = []
    for _ in PAIRS:
        v, pts = 0.0, []
        for _k in range(40):
            v += rnd.uniform(-1, 1)
            pts.append(v)
        lo, hi = min(pts), max(pts)
        lines.append([(p - lo) / (hi - lo or 1) for p in pts])
    statuses = [(0.00, "Connecting to live market data"), (0.20, "Reading H1 and H4 trend"),
                (0.50, "Comparing moving averages"), (0.78, "Building today's direction")]

    def frame(i, n):
        t = i / (n - 1)
        prog = min(1.0, t / 0.86)
        img = BG.copy()
        d = ImageDraw.Draw(img, "RGBA")
        header(img, d, i, "MARKET DIRECTION")
        panel(d, 26, 136, 614, 484)
        for r, pair in enumerate(PAIRS):
            y = 170 + r * 64
            appear = clamp01((t - r * 0.06) / 0.12)
            if appear <= 0:
                continue
            d.text((50 * S, (y - 14) * S), pair, font=F_ROW, fill=WHITE + (int(255 * appear),))
            done_at = 0.30 + r * 0.12
            draw_to = clamp01((prog - r * 0.05) / (done_at - r * 0.05))
            pts = lines[r]
            cnt = max(2, int(len(pts) * draw_to))
            xs = [190 + k * (330 / (len(pts) - 1)) for k in range(cnt)]
            d.line([(x * S, (y + 14 - pts[k] * 30) * S) for k, x in enumerate(xs)], fill=GOLD + (int(230 * appear),), width=2 * S, joint="curve")
            if prog >= done_at:
                checkmark(d, 566, y, 14, GREEN)
            else:
                spinner(d, 566, y, 12, i + r * 3)
            if r < len(PAIRS) - 1:
                d.line([(46 * S, (y + 32) * S), (594 * S, (y + 32) * S)], fill=GRID + (120,), width=S)
        footer(d, i, prog, statuses, "Direction ready")
        return img.resize((W, H), Image.LANCZOS)
    return frame

# ---------- 4) history ----------
def history_frame_factory():
    rnd = random.Random(11)
    bars = [(rnd.uniform(0.35, 1.0), rnd.random() < 0.7) for _ in range(16)]
    statuses = [(0.00, "Opening signal history"), (0.30, "Counting Hit TP and Hit SL"),
                (0.62, "Adding up pips"), (0.84, "Preparing your summary")]

    def frame(i, n):
        t = i / (n - 1)
        prog = min(1.0, t / 0.86)
        img = BG.copy()
        d = ImageDraw.Draw(img, "RGBA")
        header(img, d, i, "SIGNAL HISTORY")
        panel(d, 26, 136, 614, 484)
        mid = 330
        d.line([(46 * S, mid * S), (594 * S, mid * S)], fill=MUTED + (160,), width=S)
        d.text((50 * S, 150 * S), "HIT TP", font=F_TAG, fill=GREEN)
        d.text((50 * S, 456 * S), "HIT SL", font=F_TAG, fill=RED)
        bw = 548 / len(bars)
        for k, (h, win) in enumerate(bars):
            g = ease((prog - k * 0.04) / 0.25)
            if g <= 0:
                continue
            x0 = 46 + k * bw + bw * 0.18
            x1 = 46 + (k + 1) * bw - bw * 0.18
            hh = max(2.0, (140 if win else 110) * h * g)
            if win:
                d.rounded_rectangle([x0 * S, (mid - hh) * S, x1 * S, (mid - 1) * S], radius=4 * S, fill=GREEN + (230,))
            else:
                d.rounded_rectangle([x0 * S, (mid + 1) * S, x1 * S, (mid + hh) * S], radius=4 * S, fill=RED + (230,))
        if prog < 1.0:
            d = glow_line(img, 46 + 548 * ease(prog), 150, 470)
        footer(d, i, prog, statuses, "Results ready")
        return img.resize((W, H), Image.LANCZOS)
    return frame

# ---------- render ----------
VIDEOS = {
    "welcome": (welcome_frame, 4.5),
    "scan-scalping": (scan_frame_factory(SCANS["scalping"]), 4.5),
    "scan-intraday": (scan_frame_factory(SCANS["intraday"]), 4.5),
    "scan-swing": (scan_frame_factory(SCANS["swing"]), 4.5),
    "direction": (direction_frame_factory(), 4.5),
    "history": (history_frame_factory(), 4.0),
}

def render(name):
    frame, seconds = VIDEOS[name]
    n = int(FPS * seconds)
    out = os.path.join(OUT_DIR, f"meego-{name}.mp4")
    if PREVIEW:
        for i in (int(n * 0.45), n - 1):
            frame(i, n).save(os.path.join(OUT_DIR, f"preview-{name}-{i}.png"))
        return
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.Popen([ff, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                             "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "22",
                             "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    for i in range(n):
        proc.stdin.write(frame(i, n).tobytes())
    proc.stdin.close()
    proc.wait()
    print("wrote", out, os.path.getsize(out), "bytes")

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    names = [a for a in sys.argv[1:] if not a.startswith("--")] or list(VIDEOS)
    for name in names:
        render(name)
