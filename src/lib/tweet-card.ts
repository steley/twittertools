/**
 * Client-side tweet screenshot renderer: draws a TweetData as a polished
 * card on a canvas (2x PNG export). Pure Canvas 2D — no dependencies.
 *
 * Images try a CORS-clean direct load first (pbs.twimg.com sends
 * Access-Control-Allow-Origin: *) and fall back to our own media proxy,
 * so the canvas never taints and toBlob() always succeeds.
 */
import { proxiedDownloadUrl, type MediaItem, type TweetData } from './api';

export type CardThemeName = 'light' | 'dark';

interface Palette {
  card: string;
  border: string;
  text: string;
  muted: string;
  divider: string;
  placeholder: string;
  badgeBg: string;
  badgeText: string;
}

const PALETTES: Record<CardThemeName, Palette> = {
  light: {
    card: '#ffffff',
    border: '#eff3f4',
    text: '#0f1419',
    muted: '#536471',
    divider: '#eff3f4',
    placeholder: '#f0f3f5',
    badgeBg: 'rgba(0,0,0,0.65)',
    badgeText: '#ffffff',
  },
  dark: {
    card: '#15202b',
    border: '#38444d',
    text: '#e7e9ea',
    muted: '#8b98a5',
    divider: '#38444d',
    placeholder: '#202e3a',
    badgeBg: 'rgba(255,255,255,0.2)',
    badgeText: '#ffffff',
  },
};

const BRAND = '#1d9bf0';
const SCALE = 2; // PNG export scale
const W = 600; // logical card width
const PAD = 28;
const AVATAR = 48;
const TEXT_SIZE = 19;
const LINE_H = 26;
const FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

// --- helpers -----------------------------------------------------------------

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const ratio = Math.max(dw / iw, dh / ih);
  ctx.drawImage(img, (iw - dw / ratio) / 2, (ih - dh / ratio) / 2, dw / ratio, dh / ratio, dx, dy, dw, dh);
}

function drawContain(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const ratio = Math.min(dw / iw, dh / ih);
  const w = iw * ratio;
  const h = ih * ratio;
  ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

/** X appends the media's own t.co link to the post text — drop that one
 * trailing link (and only that one) when the card already shows the media. */
function stripTrailingMediaLink(text: string, hasMedia: boolean): string {
  if (!hasMedia) return text;
  return text.replace(/\s*https?:\/\/t\.co\/[A-Za-z0-9]+\s*$/i, '');
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' });
  return `${day} · ${time} UTC`;
}

/** Compact header date for replies: "Sep 29". */
function fmtShortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function heart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 12, s / 12);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(6, 11);
  ctx.bezierCurveTo(0.4, 7, 0.6, 2.5, 3.6, 2.5);
  ctx.bezierCurveTo(5, 2.5, 6, 3.9, 6, 3.9);
  ctx.bezierCurveTo(6, 3.9, 7, 2.5, 8.4, 2.5);
  ctx.bezierCurveTo(11.4, 2.5, 11.6, 7, 6, 11);
  ctx.fill();
  ctx.restore();
}

function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 12, s / 12);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  rr(ctx, 1, 1.5, 10, 7, 3);
  ctx.moveTo(4, 8.5);
  ctx.lineTo(3.2, 11);
  ctx.lineTo(6.5, 8.5);
  ctx.stroke();
  ctx.restore();
}

// --- image loading -------------------------------------------------------------

const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
const directFailedHosts = new Set<string>();

function raceTimeout(p: Promise<HTMLImageElement | null>, ms: number): Promise<HTMLImageElement | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  if (!url) return null;
  let entry = imgCache.get(url);
  if (!entry) {
    entry = (async () => {
      const img = (src: string, cors = false) =>
        new Promise<HTMLImageElement | null>((resolve) => {
          const el = new Image();
          if (cors) el.crossOrigin = 'anonymous';
          el.onload = () => resolve(el);
          el.onerror = () => resolve(null);
          el.src = src;
        });
      // try a CORS-clean direct load first (works where the CDN sends ACAO)
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        return null;
      }
      if (!directFailedHosts.has(host)) {
        const direct = await raceTimeout(img(url, true), 2500);
        if (direct) return direct;
        directFailedHosts.add(host); // host unreachable/blocked — stop paying the timeout
      }
      // fall back to our same-origin media proxy (never taints the canvas —
      // the proxy always answers with Access-Control-Allow-Origin, so load
      // it in CORS mode or the canvas gets tainted and export fails).
      // Inline disposition: iOS Safari refuses attachment-served images.
      return raceTimeout(img(proxiedDownloadUrl(url, 'card-media', true), true), 12000);
    })();
    imgCache.set(url, entry);
  }
  return entry;
}

// --- layout ---------------------------------------------------------------------

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (para.trim() === '') {
      lines.push('');
      continue;
    }
    let cur = '';
    for (let word of para.split(' ')) {
      // hard-break tokens that alone exceed the line (long URLs, CJK runs)
      while (ctx.measureText(word).width > maxWidth) {
        if (cur) {
          lines.push(cur);
          cur = '';
        }
        let cut = word.length;
        while (cut > 1 && ctx.measureText(word.slice(0, cut)).width > maxWidth) cut--;
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      if (!word) continue;
      const cand = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(cand).width <= maxWidth || !cur) cur = cand;
      else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

interface MediaRect { x: number; y: number; w: number; h: number }

/**
 * Tile images edge-to-edge like a justified photo collage: images in a row
 * share one height and each width follows its own aspect ratio, so nothing
 * is cropped and no letterbox margins appear. 1-3 images form a single row,
 * 4 images a 2x2 grid with per-row heights.
 */
function tileImages(count: number, cardW: number, aspects: number[]): { rects: MediaRect[]; height: number } {
  const inner = cardW - PAD * 2;
  const gap = 6;
  const MAX_H = 620; // keep extreme portrait singles from making the card endless
  const rows: number[][] =
    count === 4 ? [aspects.slice(0, 2), aspects.slice(2, 4)] : [aspects.slice(0, Math.max(1, count))];
  const rects: MediaRect[] = [];
  let y = 0;
  for (const row of rows) {
    const sum = row.reduce((a, b) => a + b, 0) || 16 / 9;
    const natural = (inner - (row.length - 1) * gap) / sum;
    const h = Math.min(natural, MAX_H);
    if (row.length === 1) {
      const w = Math.min(inner, h * row[0]);
      rects.push({ x: (inner - w) / 2, y, w, h });
    } else {
      let widths = row.map((a) => h * a);
      if (Math.min(...widths) < 64) {
        // an extreme aspect mix would tile into slivers — equal cells instead
        widths = row.map(() => (inner - (row.length - 1) * gap) / row.length);
      }
      const total = widths.reduce((a, b) => a + b, 0);
      const step =
        total + (row.length - 1) * gap < inner - 0.5
          ? (inner - total) / (row.length - 1) // clamped height: spread the slack
          : gap;
      let x = 0;
      widths.forEach((w) => {
        rects.push({ x, y, w, h });
        x += w + step;
      });
    }
    y += h + gap;
  }
  return { rects, height: y - gap };
}

// --- main entry -------------------------------------------------------------------

export async function renderTweetCard(canvas: HTMLCanvasElement, t: TweetData, theme: CardThemeName): Promise<void> {
  const p = PALETTES[theme];
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported in this browser.');

  // gather images: try the 400x400 avatar first, fall back to the small one
  const avatarUrl = t.user?.avatar ?? '';
  const avatar = avatarUrl
    ? (await loadImage(avatarUrl.replace(/_normal(\.\w+)$/, '_400x400$1'))) ??
      (await loadImage(avatarUrl))
    : null;
  const mediaItems = t.media.slice(0, 4);
  const mediaImgs = await Promise.all(mediaItems.map((m) => loadImage(m.url)));

  // measure
  const bodyText = stripTrailingMediaLink(t.text, mediaItems.length > 0);
  ctx.font = `${TEXT_SIZE}px ${FAMILY}`;
  const lines = bodyText ? wrapText(ctx, bodyText, W - PAD * 2) : [''];
  const aspects = mediaItems.map((m, i) => {
    const im = mediaImgs[i];
    // width/height (landscape = 1) — the tiling math below works in w/h terms
    return im && im.naturalWidth ? im.naturalWidth / im.naturalHeight : 16 / 9;
  });
  const media = tileImages(mediaItems.length, W, aspects);
  const hasMedia = mediaItems.length > 0;
  const headH = Math.max(AVATAR, 24);
  const textH = lines.length * LINE_H;
  const contentBottom = PAD + headH + 14 + textH + (hasMedia ? 14 + media.height : 0);
  const urlBase = contentBottom + 20; // permalink line below the media / text
  const footY = urlBase + 13;
  const baseY = footY + 24;
  const H = Math.round(baseY + PAD);

  canvas.width = W * SCALE;
  canvas.height = Math.round(H * SCALE);

  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // card
  rr(ctx, 0.5, 0.5, W - 1, H - 1, 20);
  ctx.fillStyle = p.card;
  ctx.fill();
  ctx.strokeStyle = p.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.save();
  rr(ctx, 0, 0, W, H, 20);
  ctx.clip();

  // header: avatar + name + handle
  const avX = PAD;
  const avY = PAD;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avX + AVATAR / 2, avY + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) {
    drawCover(ctx, avatar, avX, avY, AVATAR, AVATAR);
  } else {
    ctx.fillStyle = p.placeholder;
    ctx.fillRect(avX, avY, AVATAR, AVATAR);
    ctx.fillStyle = p.muted;
    ctx.font = `600 20px ${FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((t.user?.name || '?').trim().charAt(0).toUpperCase(), avX + AVATAR / 2, avY + AVATAR / 2 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  const nameX = avX + AVATAR + 12;
  ctx.fillStyle = p.text;
  ctx.font = `600 15px ${FAMILY}`;
  ctx.fillText(t.user?.name || 'Unknown', nameX, avY + 18);
  ctx.fillStyle = p.muted;
  ctx.font = `400 14px ${FAMILY}`;
  ctx.fillText('@' + (t.user?.screenName || 'unknown'), nameX, avY + 37);

  // body text
  let y = PAD + headH + 14 + TEXT_SIZE - 4;
  ctx.fillStyle = p.text;
  ctx.font = `${TEXT_SIZE}px ${FAMILY}`;
  for (const line of lines) {
    ctx.fillText(line, PAD, y);
    y += LINE_H;
  }

  // media grid
  if (hasMedia) {
    const top = y - LINE_H + 14 + 6;
    media.rects.forEach((r, i) => {
      const x = PAD + r.x;
      const cy = top + r.y;
      const img = mediaImgs[i];
      ctx.save();
      rr(ctx, x, cy, r.w, r.h, 14);
      ctx.clip();
      ctx.fillStyle = p.placeholder;
      ctx.fillRect(x, cy, r.w, r.h);
      if (img) drawContain(ctx, img, x, cy, r.w, r.h);
      ctx.restore();
      if (i === 0 && mediaItems[0].type !== 'photo') badge(ctx, x + 10, cy + 10, mediaItems[0], p);
    });
  }

  // permalink: the original post's URL, below the media / text
  const permalink = t.url || `https://x.com/i/status/${t.id}`;
  ctx.fillStyle = p.muted;
  ctx.font = `400 13px ${FAMILY}`;
  ctx.fillText(permalink, PAD, urlBase);

  // divider
  ctx.strokeStyle = p.divider;
  ctx.beginPath();
  ctx.moveTo(PAD, footY + 0.5);
  ctx.lineTo(W - PAD, footY + 0.5);
  ctx.stroke();

  // footer: date · engagement, watermark right
  ctx.fillStyle = p.muted;
  ctx.font = `400 13px ${FAMILY}`;
  let fx = PAD;
  const date = fmtDate(t.createdAt);
  if (date) {
    ctx.fillText(date, fx, baseY);
    fx += ctx.measureText(date).width + 14;
  }
  ctx.lineWidth = 1.4;
  if (t.likes != null) {
    heart(ctx, fx + 5, baseY - 10, 13, p.muted);
    const s = String(t.likes);
    ctx.fillStyle = p.muted;
    ctx.fillText(s, fx + 22, baseY);
    fx += 22 + ctx.measureText(s).width + 14;
  }
  if (t.replies != null) {
    bubble(ctx, fx + 5, baseY - 10, 13, p.muted);
    const s = String(t.replies);
    ctx.fillStyle = p.muted;
    ctx.fillText(s, fx + 22, baseY);
  }

  const wmA = 'made with ';
  const wmB = 'twittertools.com';
  ctx.font = `600 13px ${FAMILY}`;
  const bWidth = ctx.measureText(wmB).width;
  const bX = W - PAD - bWidth;
  ctx.fillStyle = BRAND;
  ctx.fillText(wmB, bX, baseY);
  ctx.font = `400 13px ${FAMILY}`;
  ctx.fillStyle = p.muted;
  ctx.fillText(wmA, bX - ctx.measureText(wmA).width, baseY);

  ctx.restore();
}

function badge(ctx: CanvasRenderingContext2D, x: number, y: number, item: MediaItem, p: Palette) {
  const label = item.type === 'animated_gif' ? 'GIF' : 'Video';
  ctx.font = `600 12px ${FAMILY}`;
  const w = ctx.measureText(label).width + 18;
  rr(ctx, x, y, w, 22, 11);
  ctx.fillStyle = p.badgeBg;
  ctx.fill();
  ctx.fillStyle = p.badgeText;
  ctx.fillText(label, x + 9, y + 15);
}

// --- thread variant -------------------------------------------------------------
// Screenshot thread mode: the main card exactly as above, then selected
// replies appended on the same card with a smaller header and their own
// media. Dividers separate posts; the footer stays the main post's.

interface PostBlock {
  post: TweetData;
  avatar: HTMLImageElement | null;
  mediaImgs: (HTMLImageElement | null)[];
  lines: string[];
  media: { rects: MediaRect[]; height: number };
  hasMedia: boolean;
  /** set when the reply opens with the parent author's @mention: the mention
   * is stripped from the text and shown as a muted "Replying to" line */
  replyingTo: string | null;
  dateShort: string;
}

async function measurePost(ctx: CanvasRenderingContext2D, post: TweetData, parent?: TweetData): Promise<PostBlock> {
  const avatarUrl = post.user?.avatar ?? '';
  const avatar = avatarUrl
    ? (await loadImage(avatarUrl.replace(/_normal(\.\w+)$/, '_400x400$1'))) ?? (await loadImage(avatarUrl))
    : null;
  const mediaItems = post.media.slice(0, 4);
  const mediaImgs = await Promise.all(mediaItems.map((m) => loadImage(m.url)));
  // X-style reply treatment: a reply aimed at the parent author drops the
  // leading @mention from the text and surfaces it as a muted label instead
  let replyingTo: string | null = null;
  let body = post.text ?? '';
  const parentHandle = parent?.user?.screenName;
  const selfReply =
    !parentHandle ||
    !post.user?.screenName ||
    post.user.screenName.toLowerCase() === parentHandle.toLowerCase();
  if (!selfReply) {
    const m = body.match(/^@([A-Za-z0-9_]+)\s+/);
    if (m && m[1].toLowerCase() === parentHandle!.toLowerCase()) {
      replyingTo = '@' + parentHandle;
      body = body.slice(m[0].length);
    }
  }
  const bodyText = stripTrailingMediaLink(body, mediaItems.length > 0);
  ctx.font = `${TEXT_SIZE}px ${FAMILY}`;
  const lines = bodyText ? wrapText(ctx, bodyText, W - PAD * 2) : [];
  const aspects = mediaItems.map((m, i) => {
    const im = mediaImgs[i];
    return im && im.naturalWidth ? im.naturalWidth / im.naturalHeight : 16 / 9;
  });
  return {
    post,
    avatar,
    mediaImgs,
    lines,
    media: tileImages(mediaItems.length, W, aspects),
    hasMedia: mediaItems.length > 0,
    replyingTo,
    dateShort: fmtShortDate(post.createdAt),
  };
}

/** Header + text + media of one post from block-top y, returning the block's
 * bottom edge. Geometry mirrors blockHeight() exactly. */
function drawPostBody(ctx: CanvasRenderingContext2D, b: PostBlock, y: number, p: Palette, avatarSize: number): number {
  const headH = Math.max(avatarSize, 24);
  ctx.save();
  ctx.beginPath();
  ctx.arc(PAD + avatarSize / 2, y + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.clip();
  if (b.avatar) {
    drawCover(ctx, b.avatar, PAD, y, avatarSize, avatarSize);
  } else {
    ctx.fillStyle = p.placeholder;
    ctx.fillRect(PAD, y, avatarSize, avatarSize);
    ctx.fillStyle = p.muted;
    ctx.font = `600 ${Math.round(avatarSize * 0.42)}px ${FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((b.post.user?.name || '?').trim().charAt(0).toUpperCase(), PAD + avatarSize / 2, y + avatarSize / 2 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  const nameX = PAD + avatarSize + 12;
  ctx.fillStyle = p.text;
  ctx.font = `600 15px ${FAMILY}`;
  ctx.fillText(b.post.user?.name || 'Unknown', nameX, y + 18);
  ctx.fillStyle = p.muted;
  ctx.font = `400 14px ${FAMILY}`;
  ctx.fillText('@' + (b.post.user?.screenName || 'unknown') + (b.dateShort ? ' · ' + b.dateShort : ''), nameX, y + 37);
  if (b.replyingTo) {
    ctx.font = `400 13px ${FAMILY}`;
    ctx.fillText('Replying to ' + b.replyingTo, nameX, y + 55);
  }

  let cy = y + headH + 14 + (b.replyingTo ? 16 : 0); // content top
  if (b.lines.length) {
    ctx.fillStyle = p.text;
    ctx.font = `${TEXT_SIZE}px ${FAMILY}`;
    let ty = cy + TEXT_SIZE - 4;
    for (const line of b.lines) {
      ctx.fillText(line, PAD, ty);
      ty += LINE_H;
    }
    cy += b.lines.length * LINE_H;
  }
  if (b.hasMedia) {
    const top = cy + 18;
    b.media.rects.forEach((r, i) => {
      const x = PAD + r.x;
      ctx.save();
      rr(ctx, x, top + r.y, r.w, r.h, 14);
      ctx.clip();
      ctx.fillStyle = p.placeholder;
      ctx.fillRect(x, top + r.y, r.w, r.h);
      const img = b.mediaImgs[i];
      if (img) drawContain(ctx, img, x, top + r.y, r.w, r.h);
      ctx.restore();
      if (i === 0 && b.post.media[0].type !== 'photo') badge(ctx, x + 10, top + r.y + 10, b.post.media[0], p);
    });
    cy = top + b.media.height;
  }
  return y + blockHeight(b, avatarSize);
}

function blockHeight(b: PostBlock, avatarSize: number): number {
  const headH = Math.max(avatarSize, 24);
  let h = headH + 14 + (b.replyingTo ? 16 : 0);
  if (b.lines.length) h += b.lines.length * LINE_H;
  if (b.hasMedia) h += 18 + b.media.height;
  return h;
}

/** Main post + replies on one tall card. `replies` is the already-selected
 * list (the page unticks excluded ones before calling). */
export async function renderThreadCard(
  canvas: HTMLCanvasElement,
  main: TweetData,
  replies: TweetData[],
  theme: CardThemeName,
): Promise<void> {
  const p = PALETTES[theme];
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported in this browser.');

  const mainBlock = await measurePost(ctx, main);
  // each reply's parent is the PREVIOUS post in the card, not the main post —
  // a reply-to-a-reply mentions the reply above it, and that mention is the
  // one turned into the muted "Replying to" line
  const replyBlocks: PostBlock[] = [];
  let prev = mainBlock.post;
  for (const r of replies) {
    replyBlocks.push(await measurePost(ctx, r, prev));
    prev = r;
  }

  // layout: main block + permalink + divider, then per reply (gap + block +
  // divider), then the footer
  const mainBottom = PAD + blockHeight(mainBlock, AVATAR);
  // replies share the main post's avatar size — X renders them identically
  const REPLY_AVATAR = AVATAR;
  let h = mainBottom + 20 + 13; // permalink line + divider
  for (const b of replyBlocks) h += 18 + blockHeight(b, REPLY_AVATAR) + 18;
  const footY = h;
  const baseY = footY + 24;
  const H = Math.round(baseY + PAD);

  // iOS Safari caps total canvas area (~16.7M px): a very long thread at 2x
  // would blow past it and toBlob() would fail — drop to 1x export instead
  const scale = W * H * SCALE * SCALE > 16_500_000 ? 1 : SCALE;
  canvas.width = W * scale;
  canvas.height = H * scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, W, H);

  rr(ctx, 0.5, 0.5, W - 1, H - 1, 20);
  ctx.fillStyle = p.card;
  ctx.fill();
  ctx.strokeStyle = p.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.save();
  rr(ctx, 0, 0, W, H, 20);
  ctx.clip();

  const mainDrawn = drawPostBody(ctx, mainBlock, PAD, p, AVATAR);

  // main post permalink, then divider (protocol stripped for a cleaner look)
  ctx.fillStyle = p.muted;
  ctx.font = `400 13px ${FAMILY}`;
  const permalink = (mainBlock.post.url || `https://x.com/i/status/${mainBlock.post.id}`).replace(/^https:\/\//, '');
  ctx.fillText(permalink, PAD, mainDrawn + 20);
  let divider = mainDrawn + 33;

  for (const b of replyBlocks) {
    ctx.strokeStyle = p.divider;
    ctx.beginPath();
    ctx.moveTo(PAD, divider + 0.5);
    ctx.lineTo(W - PAD, divider + 0.5);
    ctx.stroke();
    const bottom = drawPostBody(ctx, b, divider + 18, p, REPLY_AVATAR);
    divider = bottom + 18;
  }

  // footer divider (footY matches the measure pass) + date/engagement/watermark
  // of the main post
  ctx.strokeStyle = p.divider;
  ctx.beginPath();
  ctx.moveTo(PAD, footY + 0.5);
  ctx.lineTo(W - PAD, footY + 0.5);
  ctx.stroke();

  ctx.fillStyle = p.muted;
  ctx.font = `400 13px ${FAMILY}`;
  let fx = PAD;
  const date = fmtDate(mainBlock.post.createdAt);
  if (date) {
    ctx.fillText(date, fx, baseY);
    fx += ctx.measureText(date).width + 14;
  }
  ctx.lineWidth = 1.4;
  if (mainBlock.post.likes != null) {
    heart(ctx, fx + 5, baseY - 10, 13, p.muted);
    const s = String(mainBlock.post.likes);
    ctx.fillStyle = p.muted;
    ctx.fillText(s, fx + 22, baseY);
    fx += 22 + ctx.measureText(s).width + 14;
  }
  if (mainBlock.post.replies != null) {
    bubble(ctx, fx + 5, baseY - 10, 13, p.muted);
    const s = String(mainBlock.post.replies);
    ctx.fillStyle = p.muted;
    ctx.fillText(s, fx + 22, baseY);
  }

  const wmA = 'made with ';
  const wmB = 'twittertools.com';
  ctx.font = `600 13px ${FAMILY}`;
  const bWidth = ctx.measureText(wmB).width;
  const bX = W - PAD - bWidth;
  ctx.fillStyle = BRAND;
  ctx.fillText(wmB, bX, baseY);
  ctx.font = `400 13px ${FAMILY}`;
  ctx.fillStyle = p.muted;
  ctx.fillText(wmA, bX - ctx.measureText(wmA).width, baseY);

  ctx.restore();
}

/** Export the rendered card as a PNG download. Resolves false if the browser
 * refuses (tainted canvas) — callers should surface that to the user. */
export function downloadCard(canvas: HTMLCanvasElement, filename: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve(false);
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        resolve(true);
      }, 'image/png');
    } catch {
      resolve(false);
    }
  });
}
