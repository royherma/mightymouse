"""Derive the Debug app icon from the shipping one: the same art + a DEV ribbon.

Kept as a script rather than a hand-drawn second PNG so the dev icon can never
drift from the real artwork -- rerun it after any AppIcon-1024.png change.

    python3 scripts/gen-ios-dev-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "ios/MightyMouse/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
OUT = ROOT / "ios/MightyMouse/Assets.xcassets/AppIcon-Dev.appiconset/AppIcon-Dev-1024.png"

S = 1024
RIBBON = (15, 23, 42)

canvas = Image.open(SRC).convert("RGBA")
if canvas.size != (S, S):
    canvas = canvas.resize((S, S), Image.LANCZOS)

# Ribbon top stays below y=900: the muzzle bottoms out around y=895.
band = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(band)
d.rectangle([(-S, 904), (S * 2, S)], fill=RIBBON + (255,))

font = None
for path in (
    "/System/Library/Fonts/SFNSDisplay-Bold.otf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
):
    try:
        font = ImageFont.truetype(path, 96)
        break
    except OSError:
        continue
if font is None:
    raise SystemExit("no bold system font found -- check /System/Library/Fonts")

text = "DEV"
box = d.textbbox((0, 0), text, font=font, stroke_width=0)
tw, th = box[2] - box[0], box[3] - box[1]
d.text(
    ((S - tw) / 2 - box[0], 958 - th / 2 - box[1]),
    text,
    font=font,
    fill=(255, 255, 255, 255),
)

canvas = Image.alpha_composite(canvas, band)
Image.alpha_composite(Image.new("RGBA", (S, S), (255, 255, 255, 255)), canvas).convert(
    "RGB"
).save(OUT)
print("wrote", OUT)
