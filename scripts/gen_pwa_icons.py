#!/usr/bin/env python3
"""Generate the Bookmark Manager PWA icons into public/icons/: a white
bookmark ribbon on the brand-blue rounded square, plus a maskable variant
with the glyph inside the 80% safe zone."""

from pathlib import Path

from PIL import Image, ImageDraw

BRAND = (29, 155, 240, 255)   # #1d9bf0
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"


def ribbon(size: int, scale: float) -> Image.Image:
    """White bookmark ribbon centered in a size×size canvas, scaled so it fits
    the maskable safe zone when scale < 1."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = size * 0.34 * scale          # ribbon width
    h = size * 0.52 * scale          # ribbon height
    notch = h * 0.22                 # depth of the bottom notch
    x0 = (size - w) / 2
    y0 = (size - h) / 2
    x1, y1 = x0 + w, y0 + h
    mid = size / 2
    d.polygon([(x0, y0), (x1, y0), (x1, y1), (mid, y1 - notch), (x0, y1)], fill=WHITE)
    return layer


def icon(size: int, maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        # full-bleed square (the launcher applies its own mask)
        d.rectangle([0, 0, size - 1, size - 1], fill=BRAND)
        img.alpha_composite(ribbon(size, scale=0.62))
    else:
        radius = size * 0.18
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BRAND)
        img.alpha_composite(ribbon(size, scale=0.78))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192, False).save(OUT / "bm-192.png")
    icon(512, False).save(OUT / "bm-512.png")
    icon(512, True).save(OUT / "bm-maskable-512.png")
    print(f"icons written to {OUT}")


if __name__ == "__main__":
    main()
