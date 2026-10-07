/**
 * X/Twitter text rules, ported 1:1 from the repo's TypeScript originals
 * (src/lib/tweet-count.ts, tweet-split.ts, snowflake.ts) so this package can
 * ship standalone. The repo vitest suite pins the originals; the mcp tests
 * re-run the same cases against this port — keep the two in sync.
 */

// --------------------------------------------------------------------------- //
// Weighted counting (twitter-text confit.json v3): most Latin/ASCII code
// points weigh 1, everything else (CJK, emoji, most non-Latin scripts)
// weighs 2, and any URL counts as exactly 23 (t.co wrapping). Limit 280.
// --------------------------------------------------------------------------- //

const WEIGHT_100_RANGES = [
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

function isWeight100(cp) {
  return WEIGHT_100_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function extractUrls(text) {
  const primary = text.match(URL_REGEX) ?? [];
  // mask the unambiguous matches, then count scheme-less domains in what's
  // left so no URL is counted twice
  const masked = text.replace(URL_REGEX, (m) => '\u0000'.repeat(m.length));
  const bare = masked.match(BARE_DOMAIN_REGEX) ?? [];
  return [...primary, ...bare].map((u) => u.replace(TRAILING_PUNCT, '')).filter(Boolean);
}

export function countTweet(text) {
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

// --------------------------------------------------------------------------- //
// Thread splitting at the weighted limit, preferring sentence boundaries
// over line breaks over word breaks. Links are atomic.
// --------------------------------------------------------------------------- //

const LIMIT = 280;
/** Reserved for the "12/ " prefix when numbering is on (covers up to 999 parts). */
const NUMBERING_RESERVE = 5;

const SENTENCE_END = new Set(['.', '!', '?', '…', '。', '！', '？']);
const CLOSERS = new Set(['.', '!', '?', '…', '。', '！', '？', ',', ';', ':', '"', "'", ')', ']', '」', '』', '”', '’']);

/** Break a line into sentences; decimals ("3.5") and abbreviations without a
 * following space don't count as boundaries. */
function sentencesOf(line) {
  const out = [];
  const chars = Array.from(line);
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!SENTENCE_END.has(chars[i])) continue;
    let j = i + 1;
    while (j < chars.length && CLOSERS.has(chars[j])) j++;
    if (j >= chars.length || chars[j] === ' ') {
      const s = chars.slice(start, j).join('').trim();
      if (s) out.push(s);
      while (j < chars.length && chars[j] === ' ') j++;
      start = j;
      i = j - 1;
    } else {
      i = j - 1; // "3.5", "x.com" — resume scanning after the punctuation run
    }
  }
  const rest = chars.slice(start).join('').trim();
  if (rest) out.push(rest);
  return out;
}

/** Split an oversized piece on whitespace; a single unbreakable word longer
 * than the limit gets cut by code points (URLs keep working — they carry no
 * spaces, and their 23-char weight is what counts, not their raw length). */
function hardSplit(s, eff) {
  const out = [];
  let cur = '';
  for (const word of s.split(/\s+/)) {
    const pieces =
      countTweet(word).weightedLength > eff
        ? chunkCodePoints(word, eff)
        : [word];
    for (const piece of pieces) {
      const cand = cur ? cur + ' ' + piece : piece;
      if (countTweet(cand).weightedLength <= eff) cur = cand;
      else {
        if (cur) out.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

function chunkCodePoints(s, eff) {
  const out = [];
  let cur = '';
  for (const ch of Array.from(s)) {
    const cand = cur + ch;
    if (countTweet(cand).weightedLength <= eff) cur = cand;
    else {
      out.push(cur);
      cur = ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function segment(text, eff) {
  const segs = [];
  let pendingGlue = '';
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      pendingGlue = '\n\n'; // paragraph break
      continue;
    }
    for (const sentence of sentencesOf(line)) {
      const pieces =
        countTweet(sentence).weightedLength > eff ? hardSplit(sentence, eff) : [sentence];
      pieces.forEach((piece, i) => {
        segs.push({ text: piece, glue: segs.length === 0 ? '' : i === 0 ? pendingGlue || ' ' : ' ' });
      });
      pendingGlue = '';
    }
    pendingGlue = pendingGlue || '\n'; // next line joins with a line break
  }
  return segs;
}

/** Split `text` into posts that each fit X's 280-character weighted limit.
 * With `numbering`, every post gets an "n/ " prefix and the usable budget is
 * reserved for it. Returns the ready-to-post texts. */
export function splitThread(text, numbering = true) {
  const input = text.trim();
  if (!input) return [];
  const eff = LIMIT - (numbering ? NUMBERING_RESERVE : 0);
  const parts = [];
  let cur = '';
  for (const seg of segment(input, eff)) {
    const cand = cur ? cur + seg.glue + seg.text : seg.text;
    if (countTweet(cand).weightedLength <= eff) cur = cand;
    else {
      if (cur.trim()) parts.push(cur.trim());
      cur = seg.text;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  if (!numbering) return parts;
  return parts.map((p, i) => `${i + 1}/ ${p}`);
}

// --------------------------------------------------------------------------- //
// Snowflake IDs: the top 41 bits are milliseconds since X's custom epoch.
// --------------------------------------------------------------------------- //

export const X_EPOCH = 1288834974657;

export function snowflakeToDate(id) {
  const n = typeof id === 'bigint' ? id : BigInt(id);
  const ms = Number(n >> 22n) + X_EPOCH;
  // IDs past X's real range decode beyond the max JS Date (±8.64e15 ms) —
  // surface them as Invalid Date instead of a silently-wrong value
  return new Date(ms > 8.64e15 || ms < -8.64e15 ? NaN : ms);
}

// The (?:^|[^A-Za-z0-9-]) boundary keeps lookalike hosts (notx.com, foo-x.com)
// from matching as x.com — the host must start at a word boundary.
const STATUS_RE =
  /(?:^|[^A-Za-z0-9-])(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i;
const BARE_ID_RE = /^\d{5,25}$/;

/** Extract a status id (and screen name when present) from a URL, bare ID, or free
 * text. `source` records which form matched — the one field the standalone port
 * adds beyond the TypeScript original. */
export function parseTweetInput(input) {
  const text = (input ?? '').trim();
  if (!text) return null;

  const m = text.match(STATUS_RE);
  if (m) return { id: m[2], screenName: m[1].toLowerCase() === 'i' ? null : m[1], source: 'url' };

  if (BARE_ID_RE.test(text)) return { id: text, screenName: null, source: 'bare_id' };

  // A bare ID hidden inside longer text. Both edges are digit-guarded so a
  // longer digit run (order number, hash) yields nothing instead of a
  // silently clipped pseudo-ID.
  const idMatch = text.match(/(?<!\d)(\d{15,25})(?!\d)/);
  if (idMatch) return { id: idMatch[1], screenName: null, source: 'text' };

  return null;
}

export function permalinkFor(id, screenName) {
  return screenName
    ? `https://x.com/${screenName}/status/${id}`
    : `https://x.com/i/web/status/${id}`;
}
