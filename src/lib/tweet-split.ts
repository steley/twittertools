/**
 * Split long text into X-ready numbered posts (1/ 2/ …) at the weighted
 * 280-character limit, preferring sentence boundaries over line breaks over
 * word breaks. Links are atomic — a URL always stays whole and counts as its
 * 23-character t.co weight (all measuring via tweet-count).
 */
import { countTweet } from './tweet-count';

const LIMIT = 280;
/** Reserved for the "12/ " prefix when numbering is on (covers up to 999 parts). */
const NUMBERING_RESERVE = 5;

interface Seg {
  text: string;
  glue: string; // '' | ' ' | '\n' | '\n\n' — how this segment joins the previous one
}

const SENTENCE_END = new Set(['.', '!', '?', '…', '。', '！', '？']);
const CLOSERS = new Set(['.', '!', '?', '…', '。', '！', '？', ',', ';', ':', '"', "'", ')', ']', '」', '』', '”', '’']);

/** Break a line into sentences; decimals ("3.5") and abbreviations without a
 * following space don't count as boundaries. */
function sentencesOf(line: string): string[] {
  const out: string[] = [];
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
function hardSplit(s: string, eff: number): string[] {
  const out: string[] = [];
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

function chunkCodePoints(s: string, eff: number): string[] {
  const out: string[] = [];
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

function segment(text: string, eff: number): Seg[] {
  const segs: Seg[] = [];
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
export function splitThread(text: string, numbering = true): string[] {
  const input = text.trim();
  if (!input) return [];
  const eff = LIMIT - (numbering ? NUMBERING_RESERVE : 0);
  const parts: string[] = [];
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

/** Convenience for the UI: the paste format the Thread Reader understands. */
export function joinForReader(parts: string[]): string {
  return parts.join('\n\n---\n\n');
}
