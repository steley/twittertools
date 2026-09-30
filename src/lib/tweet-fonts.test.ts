import { describe, expect, it } from 'vitest';
import { convertWithStyle, fontStyleNames } from './tweet-fonts';

describe('convertWithStyle', () => {
  it('maps bold letters and digits', () => {
    expect(convertWithStyle('Hi 42', 0)).toBe('𝐇𝐢 𝟒𝟐');
  });

  it('maps monospace', () => {
    expect(convertWithStyle('Hi', 12)).toBe('𝙷𝚒');
  });

  it('applies the legacy italic h (ℎ) exception', () => {
    expect(convertWithStyle('h', 1)).toBe('\u210E');
    expect(convertWithStyle('o', 1)).toBe('\u2134');
  });

  it('passes through CJK, emoji and punctuation untouched', () => {
    expect(convertWithStyle('你好！🙂', 0)).toBe('你好！🙂');
  });

  it('maps a-z of every style to assigned (non-replacement) code points', () => {
    for (let i = 0; i < fontStyleNames.length; i++) {
      const styled = convertWithStyle('abcdefghijklmnopqrstuvwxyz', i);
      for (const ch of Array.from(styled)) {
        expect(ch.codePointAt(0)!).not.toBe(0xfffd);
      }
    }
  });
});
