import { describe, expect, it } from 'vitest';
import { splitReplyMention, stripReplyMention } from './thread-text';

describe('stripReplyMention', () => {
  it('drops the reply prefill mention', () => {
    expect(stripReplyMention('@keking99 Workers CPU time计费超出…', 'mcwangcn', true)).toBe(
      'Workers CPU time计费超出…',
    );
  });

  it('matches the handle case-insensitively', () => {
    expect(stripReplyMention('@KeKing99 hi', 'mcwangcn', true)).toBe('hi');
  });

  it('keeps a mention that addresses the post itself', () => {
    expect(stripReplyMention('@mcwangcn thanks!', 'mcwangcn', true)).toBe('@mcwangcn thanks!');
  });

  it('keeps the opening post of a standalone thread', () => {
    expect(stripReplyMention('@nasa great shot, a thread 🧵', 'mcwangcn', false)).toBe(
      '@nasa great shot, a thread 🧵',
    );
  });

  it('strips the opening post when it is itself a reply', () => {
    expect(stripReplyMention('@keking99 1/ Cloudflare services that can blow up your bill', 'mcwangcn', true)).toBe(
      '1/ Cloudflare services that can blow up your bill',
    );
  });

  it('leaves text without a leading mention untouched', () => {
    expect(stripReplyMention('plain text @keking99 mid-sentence', 'mcwangcn', true)).toBe(
      'plain text @keking99 mid-sentence',
    );
    expect(stripReplyMention('@keking99,no space', 'mcwangcn', true)).toBe('@keking99,no space');
  });

  it('splits out the stripped mention for the Replying-to label', () => {
    expect(splitReplyMention('@keking99 5. Containers（完）\nbody…', 'mcwangcn', true)).toEqual({
      text: '5. Containers（完）\nbody…',
      mention: 'keking99',
    });
    expect(splitReplyMention('no mention here', 'mcwangcn', true)).toEqual({
      text: 'no mention here',
      mention: null,
    });
  });
});
