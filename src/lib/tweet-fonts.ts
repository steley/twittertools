/**
 * Unicode text styling for posts and bios: maps A-Z / a-z / 0-9 into the
 * Mathematical Alphanumeric Symbols block (plus a few legacy glyphs), the
 * same trick every "Twitter font" generator uses. Everything outside those
 * ranges passes through untouched, so emoji, CJK and punctuation survive.
 *
 * Note: styled characters are display-only — screen readers announce them
 * letter by letter, so use them for emphasis, not for whole sentences.
 */

interface AlphaStyle {
  name: string;
  upper: number;
  lower: number;
  digits?: number;
  /** Legacy glyph overrides for letters the block skips. */
  upperX?: Record<string, number>;
  lowerX?: Record<string, number>;
}

const STYLES: AlphaStyle[] = [
  { name: 'Bold', upper: 0x1d400, lower: 0x1d41a, digits: 0x1d7ce },
  { name: 'Italic', upper: 0x1d434, lower: 0x1d44e, lowerX: { h: 0x210e } },
  { name: 'Bold italic', upper: 0x1d468, lower: 0x1d482 },
  {
    name: 'Script',
    upper: 0x1d49c,
    lower: 0x1d4b6,
    upperX: { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b },
    lowerX: { e: 0x212f, g: 0x210a, o: 0x2134 },
  },
  { name: 'Bold script', upper: 0x1d4d0, lower: 0x1d4ea },
  {
    name: 'Fraktur',
    upper: 0x1d504,
    lower: 0x1d51e,
    upperX: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 },
  },
  { name: 'Bold Fraktur', upper: 0x1d56c, lower: 0x1d586 },
  {
    name: 'Double-struck',
    upper: 0x1d538,
    lower: 0x1d552,
    digits: 0x1d7d8,
    upperX: { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 },
  },
  { name: 'Sans', upper: 0x1d5a0, lower: 0x1d5ba, digits: 0x1d7e2 },
  { name: 'Sans bold', upper: 0x1d5d4, lower: 0x1d5ee, digits: 0x1d7ec },
  { name: 'Sans italic', upper: 0x1d608, lower: 0x1d622 },
  { name: 'Sans bold italic', upper: 0x1d63c, lower: 0x1d656 },
  { name: 'Monospace', upper: 0x1d670, lower: 0x1d68a, digits: 0x1d7f6 },
  { name: 'Circled', upper: 0x24b6, lower: 0x24d0 },
  { name: 'Negative circled', upper: 0x1f150, lower: 0x1f150 },
  { name: 'Fullwidth', upper: 0xff21, lower: 0xff41, digits: 0xff10 },
];

export const fontStyleNames = STYLES.map((s) => s.name);

export function convertWithStyle(text: string, styleIndex: number): string {
  const s = STYLES[styleIndex];
  if (!s) return text;
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 65 && cp <= 90) {
      out.push(String.fromCodePoint(s.upperX?.[ch] ?? s.upper + (cp - 65)));
    } else if (cp >= 97 && cp <= 122) {
      out.push(String.fromCodePoint(s.lowerX?.[ch] ?? s.lower + (cp - 97)));
    } else if (s.digits !== undefined && cp >= 48 && cp <= 57) {
      out.push(String.fromCodePoint(s.digits + (cp - 48)));
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}
