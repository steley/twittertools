/**
 * Snowflake ID helpers. X post IDs are Snowflakes: the top 41 bits are
 * milliseconds since the custom X epoch (1288834974657 = 2010-11-04T01:42:54.657Z).
 */
export const X_EPOCH = 1288834974657;

export function snowflakeToDate(id: string | bigint): Date {
  const n = typeof id === 'bigint' ? id : BigInt(id);
  return new Date(Number(n >> 22n) + X_EPOCH);
}

export interface ParsedTweetUrl {
  id: string;
  screenName: string | null;
}

const STATUS_RE = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i;
const BARE_ID_RE = /^\d{5,25}$/;

/** Extract a status id (and screen name when present) from a URL, bare ID, or free text. */
export function parseTweetInput(input: string): ParsedTweetUrl | null {
  const text = input.trim();
  if (!text) return null;

  const m = text.match(STATUS_RE);
  if (m) return { id: m[2], screenName: m[1].toLowerCase() === 'i' ? null : m[1] };

  if (BARE_ID_RE.test(text)) return { id: text, screenName: null };

  // A bare ID hidden inside longer text
  const idMatch = text.match(/(\d{15,25})/);
  if (idMatch) return { id: idMatch[1], screenName: null };

  return null;
}

export function permalinkFor(id: string, screenName?: string | null): string {
  return screenName
    ? `https://x.com/${screenName}/status/${id}`
    : `https://x.com/i/web/status/${id}`;
}
