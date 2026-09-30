import { describe, expect, it } from 'vitest';
import { countTweet } from './tweet-count';

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
    // "see " (4) + link (23) + " " (1) + "please" (6)
    expect(r.weightedLength).toBe(34);
  });

  it('counts scheme-less domains as links', () => {
    expect(countTweet('open x.com/tools now').urlCount).toBe(1);
  });

  it('accepts 280 Latin chars and 140 CJK chars, rejects 141 CJK chars', () => {
    expect(countTweet('a'.repeat(280)).valid).toBe(true);
    expect(countTweet('一'.repeat(140)).valid).toBe(true); // 140 x 2 = 280 exactly
    expect(countTweet('一'.repeat(141)).valid).toBe(false); // 282 > 280
  });
});
