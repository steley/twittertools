#!/usr/bin/env python3
"""Generate public/og.png (1200x630) social card for twittertools.com."""

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
BG = (15, 20, 25)        # slate-950-ish
ACCENT = (29, 155, 240)  # #1d9bf0
MUTED = (148, 163, 184)  # slate-400


def load_font(size: int, bold: bool = False):
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def text_width(draw, text, font):
    left, _, right, _ = draw.textbbox((0, 0), text, font=font)
    return right - left


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # top accent bar
    d.rectangle([0, 0, W, 12], fill=ACCENT)

    # wordmark with two-tone "Tools"
    title_font = load_font(110, bold=True)
    x, y = 90, 200
    d.text((x, y), "Twitter", font=title_font, fill=(255, 255, 255))
    x += text_width(d, "Twitter", title_font)
    d.text((x, y), "Tools", font=title_font, fill=ACCENT)

    sub_font = load_font(44)
    d.text((90, 350), "The independent toolkit for X (Twitter)", font=sub_font, fill=MUTED)

    # feature lines: all ten tools, two rows, auto-fitted to the card width
    feat_lines = [
        "Video Downloader  ·  Thread Reader  ·  Bookmark Manager  ·  Screenshot Generator",
        "Character Counter  ·  Tweet Splitter  ·  Font Generator  ·  Advanced Search  ·  URL Parser",
    ]
    size = 30
    while size > 20:
        f = load_font(size)
        if all(text_width(d, t, f) <= W - 180 for t in feat_lines):
            break
        size -= 2
    feat_font = load_font(size)

    y = 425
    for line in feat_lines:
        d.text((90, y), line, font=feat_font, fill=(100, 116, 139))
        y += size + 26

    # domain pill at bottom
    pill_font = load_font(34, bold=True)
    pill_text = "twittertools.com"
    pw = text_width(d, pill_text, pill_font) + 60
    pill_y = y + 10
    d.rounded_rectangle([90, pill_y, 90 + pw, pill_y + 68], radius=34, fill=(30, 41, 59))
    d.text((90 + 30, pill_y + 14), pill_text, font=pill_font, fill=(255, 255, 255))

    # small TwitterTools "T" mark top right (original geometry, not X brand assets)
    m = 96  # mark box
    mx, my = W - 90 - m, 56
    d.rounded_rectangle([mx, my, mx + m, my + m], radius=22, fill=ACCENT)
    d.rounded_rectangle([mx + 22, my + 24, mx + m - 22, my + 40], radius=8, fill=(255, 255, 255))
    d.rounded_rectangle([mx + m / 2 - 8, my + 24, mx + m / 2 + 8, my + m - 22], radius=8, fill=(255, 255, 255))

    img.save("public/og.png", optimize=True)
    print("wrote public/og.png")


if __name__ == "__main__":
    main()
