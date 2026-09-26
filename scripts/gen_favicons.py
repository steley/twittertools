#!/usr/bin/env python3
"""Generate standalone favicon files from the TwitterTools mark.

Outputs (into public/):
  favicon.ico            16/32/48 multi-resolution, for legacy tabs/bookmarks
  apple-touch-icon.png   180x180 full-bleed square (iOS adds its own mask)
  icon-192.png / icon-512.png   Android/PWA sizes (handy if a manifest is added later)

The mark: #1d9bf0 rounded square + white rounded "T". Original geometry,
not derived from X Corp. brand assets. Edit the geometry below and re-run to
update every size consistently.
"""

from PIL import Image, ImageDraw

BLUE = (29, 155, 240, 255)   # #1d9bf0
WHITE = (255, 255, 255, 255)

MASTER = 256  # supersample, downscale per size


def draw_mark(size: int, corner_ratio: float = 14 / 64) -> Image.Image:
    """Draw the mark on a size x size canvas. corner_ratio: SVG rx/64."""
    s = size / 64  # scale from the 64-unit design grid
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=corner_ratio * size, fill=BLUE)

    def capsule(x0, y0, x1, y1, fill=WHITE):
        d.rounded_rectangle([x0 * s, y0 * s, x1 * s, y1 * s], radius=4.5 * s, fill=fill)

    # "T" on the 64-unit grid: bar 18..46 wide at y 18..27, stem x 27.5..36.5 down to y 46
    capsule(18, 18, 46, 27)
    capsule(27.5, 18, 36.5, 46)
    return img


def main():
    master = draw_mark(MASTER)

    # favicon.ico: PIL embeds the given sizes as separate images
    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    ico_frames = [master.resize(sz, Image.LANCZOS) for sz in ico_sizes]
    ico_frames[-1].save("public/favicon.ico", format="ICO", sizes=ico_sizes)
    # PIL's ICO writer resizes from the single source image; feed it the master
    master.save("public/favicon.ico", format="ICO", sizes=ico_sizes)

    # apple-touch-icon: full-bleed square, no transparency (iOS masks corners itself)
    touch = Image.new("RGB", (180, 180), BLUE[:3])
    touch.paste(master.resize((180, 180), Image.LANCZOS), (0, 0), master.resize((180, 180), Image.LANCZOS))
    touch.save("public/apple-touch-icon.png")

    for px in (192, 512):
        master.resize((px, px), Image.LANCZOS).save(f"public/icon-{px}.png")

    print("wrote public/favicon.ico, public/apple-touch-icon.png, public/icon-192.png, public/icon-512.png")


if __name__ == "__main__":
    main()
