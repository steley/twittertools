/**
 * X/Twitter weighted character counting, mirroring twitter-text confit.json v3:
 *  - Most Latin/ASCII code points (U+0000–U+10FF and a few punctuation blocks) weigh 100 (1 char).
 *  - Everything else (CJK, emoji, most non-Latin scripts) weighs 200 (2 chars).
 *  - A URL counts as exactly 23 characters (t.co wrapping), however long it is.
 *  - The limit is a weighted length of 280 (= 28,000 weighted units).
 */

const WEIGHT_100_RANGES: Array<[number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

/** http(s) and www. links — unambiguous. */
const URL_REGEX = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
/**
 * Scheme-less domains (X counts "x.com/foo" as a link too). The real
 * twitter-text regex validates every IANA TLD; this approximation covers the
 * common ones, which is accurate for virtually all real posts.
 */
const BARE_DOMAIN_REGEX =
  /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|co|dev|app|xyz|me|gov|edu|info|cn|jp|uk|de|fr|ru|br|in|nl|it|es|se|no|fi|ca|au|us)(?:\/[^\s<>"']*)?/gi;
/** X never includes trailing punctuation in a link. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"。，！？）、》…]+$/;

const MAX_WEIGHTED = 28_000; // 280 chars x 100

export interface CountResult {
  /** Weighted length in characters (units / 100) */
  weightedLength: number;
  /** How many raw Unicode code points the text has */
  codePoints: number;
  /** Code points that weigh double (CJK, emoji, …) */
  heavyCodePoints: number;
  /** Number of detected links (each counts as 23) */
  urlCount: number;
  limit: number;
  remaining: number;
  valid: boolean;
}

function isWeight100(cp: number): boolean {
  return WEIGHT_100_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function extractUrls(text: string): string[] {
  const primary = text.match(URL_REGEX) ?? [];
  // mask the unambiguous matches, then count scheme-less domains in what's
  // left so no URL is counted twice
  const masked = text.replace(URL_REGEX, (m) => '\u0000'.repeat(m.length));
  const bare = masked.match(BARE_DOMAIN_REGEX) ?? [];
  return [...primary, ...bare].map((u) => u.replace(TRAILING_PUNCT, '')).filter(Boolean);
}

export function countTweet(text: string): CountResult {
  const urls = extractUrls(text);
  let withoutUrls = text;
  for (const u of urls) withoutUrls = withoutUrls.replace(u, '');

  let units = urls.length * 2_300; // each link counts as 23 chars
  let codePoints = 0;
  let heavyCodePoints = 0;

  for (const ch of withoutUrls) {
    codePoints++;
    const cp = ch.codePointAt(0) ?? 0;
    if (isWeight100(cp)) {
      units += 100;
    } else {
      units += 200;
      heavyCodePoints++;
    }
  }

  const weightedLength = Math.round(units / 100);
  return {
    weightedLength,
    codePoints,
    heavyCodePoints,
    urlCount: urls.length,
    limit: 280,
    remaining: 280 - weightedLength,
    valid: units <= MAX_WEIGHTED,
  };
}
