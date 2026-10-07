import { describe, expect, it } from 'vitest';
import { countTweet, splitThread, parseTweetInput, permalinkFor, snowflakeToDate } from '../xrules.js';

// Same cases as src/lib/tweet-count.test.ts etc. — this pins the standalone
// JS port against the originals' behavior.

describe('countTweet', () => {
  it('weighs plain Latin text 1:1', () => {
    expect(countTweet('hello world').weightedLength).toBe(11);
  });

  it('weighs CJK characters double', () => {
    expect(countTweet('你好').weightedLength).toBe(4);
    expect(countTweet('你好').heavyCodePoints).toBe(2);
  });

  it('weighs emoji double', () => {
    expect(countTweet('👍').weightedLength).toBe(2);
  });

  it('counts every URL as exactly 23 characters', () => {
    const r = countTweet('see https://x.com/someone/status/1234567890123456789 please');
    expect(r.urlCount).toBe(1);
    expect(r.weightedLength).toBe(34);
  });

  it('counts scheme-less domains as links', () => {
    expect(countTweet('open x.com/tools now').urlCount).toBe(1);
  });

  it('accepts 280 Latin chars and 140 CJK chars, rejects 141 CJK chars', () => {
    expect(countTweet('a'.repeat(280)).valid).toBe(true);
    expect(countTweet('一'.repeat(140)).valid).toBe(true);
    expect(countTweet('一'.repeat(141)).valid).toBe(false);
  });
});

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
});

describe('parseTweetInput / snowflakeToDate', () => {
  it('parses standard URLs', () => {
    expect(parseTweetInput('https://x.com/user/status/1500000000000000000')).toEqual({
      id: '1500000000000000000',
      screenName: 'user',
    });
  });

  it('parses /i/web/status/ permalinks, statuses, and mobile.twitter.com', () => {
    expect(parseTweetInput('https://x.com/i/web/status/1500000000000000000')?.id).toBe('1500000000000000000');
    expect(parseTweetInput('https://x.com/user/statuses/1500000000000000000')?.id).toBe('1500000000000000000');
    expect(parseTweetInput('https://mobile.twitter.com/user/status/1500000000000000000')?.id).toBe(
      '1500000000000000000'
    );
  });

  it('parses bare ids and ids inside longer text', () => {
    expect(parseTweetInput('1500000000000000000')?.id).toBe('1500000000000000000');
    expect(parseTweetInput('look at this one 1500000000000000000!')?.id).toBe('1500000000000000000');
  });

  it('treats the literal i as no screen name and rejects text without an id', () => {
    expect(parseTweetInput('https://x.com/i/status/1500000000000000000')?.screenName).toBeNull();
    expect(parseTweetInput('hello world')).toBeNull();
  });

  it('decodes a known snowflake and round-trips through permalinkFor', () => {
    expect(snowflakeToDate('1500000000000000000').toISOString()).toBe('2022-03-05T06:47:23.309Z');
    expect(parseTweetInput(permalinkFor('1500000000000000000', 'user'))?.id).toBe('1500000000000000000');
  });
});
