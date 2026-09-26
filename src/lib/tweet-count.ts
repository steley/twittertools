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

/** Simplified twitter-text URL regex: http(s) links and www. links. */
const URL_REGEX = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

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
  return text.match(URL_REGEX) ?? [];
}

export function countTweet(text: string): CountResult {
  const urls = extractUrls(text);
  const withoutUrls = text.replace(URL_REGEX, '');

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
