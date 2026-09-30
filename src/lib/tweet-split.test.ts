import { describe, expect, it } from 'vitest';
import { countTweet } from './tweet-count';
import { joinForReader, splitThread } from './tweet-split';

describe('splitThread', () => {
  it('numbers a short text as a single post', () => {
    expect(splitThread('Hello world', true)).toEqual(['1/ Hello world']);
  });

  it('omits numbering when disabled', () => {
    expect(splitThread('Hello world', false)).toEqual(['Hello world']);
  });

  it('returns nothing for empty input', () => {
    expect(splitThread('   ', true)).toEqual([]);
  });

  it('keeps every part within the weighted limit (CJK heavy)', () => {
    const parts = splitThread('这是一个用来测试拆分器的中文长文本。'.repeat(40), true);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(countTweet(p).weightedLength).toBeLessThanOrEqual(280);
    }
  });

  it('never breaks a URL across parts', () => {
    const url = 'https://x.com/someone/status/1234567890123456789';
    const filler = 'Words to push the link past the first post boundary. '.repeat(12);
    expect(splitThread(filler + url, true).join('\n')).toContain(url);
  });

  it('cuts at sentence ends rather than mid-sentence', () => {
    const parts = splitThread('First sentence. Second sentence. Third sentence. '.repeat(10), true);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.trimEnd().endsWith('.')).toBe(true);
    }
  });

  it('joinForReader produces the paste-mode format', () => {
    expect(joinForReader(['a', 'b'])).toBe('a\n\n---\n\nb');
  });
});
