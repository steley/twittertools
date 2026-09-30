import { describe, expect, it } from 'vitest';
import { parseTweetInput, permalinkFor, snowflakeToDate } from './snowflake';

describe('parseTweetInput', () => {
  it('parses standard URLs', () => {
    expect(parseTweetInput('https://x.com/user/status/1500000000000000000')).toEqual({
      id: '1500000000000000000',
      screenName: 'user',
    });
  });

  it('parses /i/web/status/ permalinks (as our own URL parser generates)', () => {
    expect(parseTweetInput('https://x.com/i/web/status/1500000000000000000')?.id).toBe(
      '1500000000000000000'
    );
  });

  it('parses statuses and mobile.twitter.com', () => {
    expect(parseTweetInput('https://x.com/user/statuses/1500000000000000000')?.id).toBe(
      '1500000000000000000'
    );
    expect(
      parseTweetInput('https://mobile.twitter.com/user/status/1500000000000000000')?.id
    ).toBe('1500000000000000000');
  });

  it('parses bare ids and ids inside longer text', () => {
    expect(parseTweetInput('1500000000000000000')?.id).toBe('1500000000000000000');
    expect(parseTweetInput('look at this one 1500000000000000000!')?.id).toBe('1500000000000000000');
  });

  it('treats the literal i as no screen name', () => {
    expect(parseTweetInput('https://x.com/i/status/1500000000000000000')?.screenName).toBeNull();
  });

  it('rejects text without an id', () => {
    expect(parseTweetInput('hello world')).toBeNull();
  });
});

describe('snowflakeToDate', () => {
  it('decodes a known snowflake', () => {
    expect(snowflakeToDate('1500000000000000000').toISOString()).toBe('2022-03-05T06:47:23.309Z');
  });

  it('round-trips through permalinkFor', () => {
    const id = '1500000000000000000';
    expect(parseTweetInput(permalinkFor(id, 'user'))?.id).toBe(id);
  });
});
