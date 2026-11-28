#!/usr/bin/env python3
"""Mobile README screenshots: the `dusk` wallpaper for the phone, and the framed images in docs/screenshots/mobile/.

Same visual language as the desktop shots made by scripts/capture-readme-screenshots.mjs: the `dusk` wallpaper
(identical radial gradients, ported from that script's CSS), a real capture inside a rounded device, and the same
two-layer soft shadow (0 40px 100px -30px rgba(0,0,0,.9), 0 12px 30px -10px rgba(0,0,0,.5)).

Usage (needs Pillow + numpy, e.g. in a venv):

  python scripts/mobile-screenshots.py wallpaper OUT.png [--size 1080x2400]
      Render the dusk wallpaper at the phone's resolution (set it as the emulator's home screen wallpaper).

  python scripts/mobile-screenshots.py frame RAW_DIR [OUT_DIR]
      Frame every capture listed in SHOTS (raw `adb exec-out screencap -p` PNGs, 1080x2400) into
      OUT_DIR (default docs/screenshots/mobile) as optimized JPEGs.

See docs/screenshots/README.md ("Mobile app screenshots") for the capture steps.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Raw capture name -> output file. The order is the README order.
SHOTS = [
    ("widgets-light", "01-home-widgets.jpg"),
    ("widgets-dark", "02-home-widgets-dark.jpg"),
    ("dashboard", "03-dashboard.jpg"),
    ("rich-chat", "04-rich-chat.jpg"),
    ("review", "05-review-diff.jpg"),
    ("terminal", "06-terminal.jpg"),
]

# Output canvas (px) and the phone's on-canvas screen width. All shots share these, so the set lines up.
CANVAS = (720, 1380)
SCREEN_W = 540
BEZEL = 13          # dark device edge around the screen
SCREEN_RADIUS = 46  # screen corner radius on the canvas
JPEG_QUALITY = 86

# `dusk` from scripts/capture-readme-screenshots.mjs, designed for a 1440x860 canvas:
# (ellipse rx, ry, centre x%, y%, colour); each fades to transparent at 60-62%.
DUSK_LAYERS = [
    (1000, 700, 0.12, 0.08, "#34415f", 0.62),
    (900, 700, 0.92, 0.18, "#3b3360", 0.62),
    (1000, 800, 0.78, 1.00, "#1f4a52", 0.60),
    (900, 700, 0.00, 1.00, "#2a3a55", 0.60),
]
DUSK_BASE = [(0.0, "#161a26"), (0.5, "#1b2033"), (1.0, "#131d26")]  # linear-gradient(135deg, ...)
DUSK_DESIGN = (1440, 860)


def _rgb(h: str) -> np.ndarray:
    return np.array([int(h[i : i + 2], 16) for i in (1, 3, 5)], dtype=np.float64)


def dusk(w: int, h: int) -> Image.Image:
    """The dusk wallpaper at w x h. Ellipse radii scale with the canvas (by its larger side vs the design)."""
    scale = max(w / DUSK_DESIGN[0], h / DUSK_DESIGN[1])
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    # 135deg linear gradient: along (1, 1), normalised so the corners are 0 and 1 (CSS gradient-line length).
    t = ((xs - w / 2) + (ys - h / 2)) / (w + h) + 0.5
    img = np.zeros((h, w, 3))
    (t0, c0), (t1, c1), (t2, c2) = [(p, _rgb(c)) for p, c in DUSK_BASE]
    a = np.clip((t - t0) / (t1 - t0), 0, 1)[..., None]
    b = np.clip((t - t1) / (t2 - t1), 0, 1)[..., None]
    img = np.where((t < t1)[..., None], c0 * (1 - a) + c1 * a, c1 * (1 - b) + c2 * b)
    # Radial layers, painted bottom-up (CSS paints the first background on top).
    for rx, ry, cx, cy, col, stop in reversed(DUSK_LAYERS):
        d = np.sqrt(((xs - cx * w) / (rx * scale)) ** 2 + ((ys - cy * h) / (ry * scale)) ** 2)
        alpha = np.clip(1 - d / stop, 0, 1)[..., None]
        img = img * (1 - alpha) + _rgb(col) * alpha
    # A touch of noise against banding in 8-bit/JPEG output.
    img += np.random.default_rng(7).normal(0, 0.6, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


def _shadow(size, box, radius, offset_y, blur, spread, opacity):
    """One CSS-like box-shadow layer as an RGBA image."""
    layer = Image.new("L", size, 0)
    x0, y0, x1, y1 = box
    ImageDraw.Draw(layer).rounded_rectangle(
        (x0 - spread, y0 - spread + offset_y, x1 + spread, y1 + spread + offset_y), radius, fill=int(255 * opacity)
    )
    layer = layer.filter(ImageFilter.GaussianBlur(blur / 2))
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    out.putalpha(layer)
    return out


def frame_one(raw: Image.Image, bg: Image.Image) -> Image.Image:
    ss = 2  # draw at 2x, downsample once at the end for clean edges
    cw, ch = CANVAS[0] * ss, CANVAS[1] * ss
    canvas = bg.resize((cw, ch), Image.LANCZOS).convert("RGBA")
    sw = SCREEN_W * ss
    sh = round(sw * raw.height / raw.width)
    bz, r = BEZEL * ss, SCREEN_RADIUS * ss
    dw, dh = sw + 2 * bz, sh + 2 * bz
    x0, y0 = (cw - dw) // 2, (ch - dh) // 2
    box = (x0, y0, x0 + dw, y0 + dh)
    # Desktop shadow values, scaled from the 1440px canvas to this one.
    k = ss * 0.75
    for oy, blur, spread, op in ((40, 100, -30, 0.9), (12, 30, -10, 0.5)):
        canvas = Image.alpha_composite(canvas, _shadow((cw, ch), box, r + bz, oy * k, blur * k, spread * k, op))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle(box, r + bz, fill=(12, 12, 14, 255))
    # Hairline like the desktop window's 1px rgba(255,255,255,.08) border.
    d.rounded_rectangle(box, r + bz, outline=(255, 255, 255, 20), width=ss)
    screen = raw.convert("RGB").resize((sw, sh), Image.LANCZOS)
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), r, fill=255)
    canvas.paste(screen, (x0 + bz, y0 + bz), mask)
    return canvas.convert("RGB").resize(CANVAS, Image.LANCZOS)


def main(argv: list[str]) -> None:
    if len(argv) >= 2 and argv[0] == "wallpaper":
        size = argv[argv.index("--size") + 1] if "--size" in argv else "1080x2400"
        w, h = (int(v) for v in size.split("x"))
        dusk(w, h).save(argv[1], optimize=True)
        print(f"wrote {argv[1]} ({w}x{h})")
        return
    if len(argv) >= 2 and argv[0] == "frame":
        raw_dir = Path(argv[1])
        out_dir = Path(argv[2]) if len(argv) > 2 else Path(__file__).resolve().parent.parent / "docs/screenshots/mobile"
        out_dir.mkdir(parents=True, exist_ok=True)
        bg = dusk(*CANVAS)
        for name, out in SHOTS:
            src = raw_dir / f"{name}.png"
            if not src.exists():
                print(f"skip {out}: no {src}")
                continue
            img = frame_one(Image.open(src), bg)
            dst = out_dir / out
            img.save(dst, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True, subsampling=0)
            print(f"framed {dst.name} {dst.stat().st_size // 1024} KB")
        return
    sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
