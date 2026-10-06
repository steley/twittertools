import { describe, expect, it } from 'vitest';
import { wrapText } from './tweet-card';

/** Deterministic measure stub: every code point is 10px wide. */
const ctx = {
  measureText: (s: string) => ({ width: [...s].length * 10 }),
} as unknown as CanvasRenderingContext2D;

const wrap = (text: string, maxWidth: number) => wrapText(ctx, text, maxWidth);

describe('wrapText (CJK-aware card wrapping)', () => {
  it('never splits a glued Latin phrase across lines', () => {
    // "AB和CPU time" = 11 code points; at width 8 the phrase moves down whole
    expect(wrap('AB和CPU time，下一句', 80)).toEqual(['AB和', 'CPU time，', '下一句']);
  });

  it('breaks between CJK chars to fill lines tightly', () => {
    expect(wrap('一二三四五六七', 40)).toEqual(['一二三四', '五六七']);
  });

  it('keeps Latin words whole (no mid-word breaks)', () => {
    expect(wrap('abcdefghij klm', 100)).toEqual(['abcdefghij', 'klm']);
  });

  it('keeps closing punctuation off the line start', () => {
    const lines = wrap('一二三，四五', 40);
    expect(lines[0]).toBe('一二三，');
    expect(lines.every((l) => !/^[，。、！？]/.test(l))).toBe(true);
  });

  it('keeps @handles and amounts atomic mid-sentence', () => {
    const text = '比如@keking99最近的1000刀账单';
    const lines = wrap(text, 100);
    expect(lines.join('')).toBe(text);
    expect(lines.some((l) => l.includes('@keking99'))).toBe(true);
  });

  it('falls back to per-word breaks when a glued run exceeds the line', () => {
    expect(wrap('the quick brown fox jumps', 100)).toEqual(['the quick', 'brown fox', 'jumps']);
  });

  it('hard-slices an oversized URL and preserves every character', () => {
    const url = 'https://x.com/very/long/path';
    const lines = wrap(url, 50);
    expect(lines.join('')).toBe(url);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(5);
  });

  it('keeps blank lines and preserves paragraph structure', () => {
    expect(wrap('第一段\n\n第二段', 30)).toEqual(['第一段', '', '第二段']);
  });
});
