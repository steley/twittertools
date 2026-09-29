/**
 * Browser-side helpers for talking to the TwitterTools API.
 * In dev (`astro dev`) the site automatically talks to the locally running
 * backend on 127.0.0.1:8787. Production builds always use same-origin /api/
 * (the Apache vhost reverse-proxies it) — no build-time configuration.
 */
export const API_BASE: string = import.meta.env.DEV ? 'http://127.0.0.1:8787' : '';

export interface MediaVariant {
  bitrate: number | null;
  contentType: string;
  url: string;
}

export interface MediaItem {
  type: 'photo' | 'video' | 'animated_gif';
  /** Thumbnail / full image URL (pbs.twimg.com) */
  url: string;
  /** Width/height when known */
  width?: number;
  height?: number;
  /** Video/GIF length in milliseconds (for deriving variant file sizes) */
  durationMs?: number | null;
  /** Video/GIF variants (mp4 + m3u8) */
  variants?: MediaVariant[];
}

export interface TweetUser {
  name: string;
  screenName: string;
  avatar: string;
}

export interface TweetData {
  id: string;
  url: string;
  text: string;
  createdAt: string | null;
  user: TweetUser | null;
  media: MediaItem[];
  replyToId: string | null;
  quoted: TweetData | null;
  /** Engagement counts when the embed endpoint exposes them */
  likes?: number | null;
  replies?: number | null;
  /** X Article (long-form): text is title + preview, media is the cover */
  article?: boolean;
}

export interface TweetResponse {
  tweet: TweetData;
  cached?: boolean;
}

export interface ThreadResponse {
  tweets: TweetData[];
  partial: boolean;
  reason?: string;
}

export function extractTweetId(input: string): string | null {
  // Matches /status/<id>, /<user>/status(es)/<id> and /i/web/status/<id>
  const m = input.match(/(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/)?(?:web\/)?status(?:es)?\/(\d{5,25})/i);
  if (m) return m[1];
  const bare = input.trim().match(/^(\d{5,25})$/);
  return bare ? bare[1] : null;
}

/** fetch with a hard timeout: the upstream endpoints have no SLA, and a
 * stalled request must not leave the user's button spinning forever. Abort
 * surfaces as a friendly error the pages display verbatim. */
async function fetchWithTimeout(url: string, timeoutMs = 30_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error("X didn't respond in time — please try again in a moment.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTweet(id: string): Promise<TweetData> {
  const res = await fetchWithTimeout(`${API_BASE}/api/tweet?id=${encodeURIComponent(id)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  const data: TweetResponse = await res.json();
  return data.tweet;
}

export async function fetchThread(id: string): Promise<ThreadResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/api/thread?url=${encodeURIComponent(id)}`, 90_000);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as ThreadResponse;
}

/** Build a proxied download URL that forces a file download with a nice name.
 * `inline` switches to Content-Disposition: inline + Range passthrough —
 * what <video>-element playback needs (Safari refuses attachment media). */
export function proxiedDownloadUrl(mediaUrl: string, filename: string, inline = false): string {
  const params = new URLSearchParams({ url: mediaUrl, name: filename });
  if (inline) params.set('play', '1');
  return `${API_BASE}/api/download?${params.toString()}`;
}

/** A resized variant of a twimg media URL for on-page display: the CDN serves
 * WebP thumbnails via ?format=webp&name=… (small≈680w, medium≈1200w, large≈
 * 2048w), cutting image traffic ~10-30x versus the stored original. The
 * original URL stays untouched everywhere data is stored or exported. Any
 * format/name already present is replaced, and non-twimg URLs (tests, odd
 * imports) come back unchanged. */
export function cdnDisplayUrl(url: string, name: 'small' | 'medium' | 'large' = 'medium'): string {
  if (!/^https:\/\/(pbs|video)\.twimg\.com\//.test(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('format', 'webp');
    u.searchParams.set('name', name);
    return u.toString();
  } catch {
    return url;
  }
}

/** Networks that can't reach X's CDN exist (and are common for part of the
 * audience): remember a failed direct attempt for 12h so those visitors stop
 * paying the per-image probe delay on every page load. Session-level memory
 * covers re-renders; the localStorage timestamp covers new visits. */
const DIRECT_BLOCKED_KEY = 'twittertools:cdn-direct-blocked';
const DIRECT_BLOCKED_TTL = 12 * 3600 * 1000;
const directFailedHosts = new Set<string>();

export function cdnDirectBlocked(host?: string): boolean {
  if (host && directFailedHosts.has(host)) return true;
  try {
    const ts = Number(localStorage.getItem(DIRECT_BLOCKED_KEY) || 0);
    return !!ts && Date.now() - ts < DIRECT_BLOCKED_TTL;
  } catch {
    return false;
  }
}

export function markCdnDirectBlocked(host?: string): void {
  if (host) directFailedHosts.add(host);
  try {
    localStorage.setItem(DIRECT_BLOCKED_KEY, String(Date.now()));
  } catch {
    /* private mode */
  }
}

export function clearCdnDirectBlocked(): void {
  directFailedHosts.clear();
  try {
    localStorage.removeItem(DIRECT_BLOCKED_KEY);
  } catch {
    /* private mode */
  }
}

/** Load a media CDN image into an <img>: try the CDN directly (fastest where
 * it is reachable), then fall back to the same-origin proxy when the direct
 * load errors out or stalls past timeoutMs (censored networks blackhole the
 * CDN instead of erroring), so previews still display. The fallback is
 * inline-disposition: iOS Safari refuses to render attachment-served media.
 * Once a direct failure is on record, subsequent images skip the probe and
 * load through the proxy immediately. */
export function wireMediaImg(img: HTMLImageElement, mediaUrl: string, filename: string, timeoutMs = 2500): void {
  img.referrerPolicy = 'no-referrer';
  let host = '';
  try {
    host = new URL(mediaUrl).host;
  } catch {
    /* keep host '' — treated as unknown, probe still happens */
  }
  let swapped = false;
  // `stall` marks the 12h blocked-CDN memory: only a hang means the CDN is
  // unreachable. A fast error (404 on a deleted post, say) swaps instantly
  // and costs nothing — it must not poison the flag for healthy networks.
  const swap = (stall: boolean) => {
    if (swapped) return;
    swapped = true;
    if (stall) markCdnDirectBlocked(host);
    // srcset (direct CDN variants) MUST be dropped: while present, the
    // browser picks candidates from it and ignores src — the proxied swap
    // would never display on networks where the CDN is blocked
    img.srcset = '';
    img.sizes = '';
    img.src = proxiedDownloadUrl(mediaUrl, filename, true);
  };
  img.onerror = () => swap(false);
  // a direct success proves the CDN is reachable again — back to direct
  img.addEventListener(
    'load',
    () => {
      if (!swapped) clearCdnDirectBlocked();
    },
    { once: true }
  );
  if (cdnDirectBlocked(host)) {
    swap();
    return;
  }
  img.src = mediaUrl;
  // lazy images far below the fold haven't started loading — a blind swap
  // here would needlessly pull them through the proxy. Re-check every window
  // until the image nears the viewport, then give the CDN one last window.
  const stalled = () => {
    if (swapped || (img.complete && img.naturalWidth)) return; // done either way
    const rect = img.getBoundingClientRect();
    const near = rect.top < window.innerHeight * 2 && rect.bottom > -window.innerHeight;
    if (!near) {
      setTimeout(stalled, timeoutMs);
      return;
    }
    if (!img.complete || !img.naturalWidth) swap(true);
  };
  setTimeout(stalled, timeoutMs);
}

/** Try to save a media file straight from X's CDN via a CORS fetch (fast for
 * the user, no origin bandwidth). Resolves false when the CDN is unreachable
 * or blocked — callers should then fall back to the same-origin proxy. The
 * abort timer only covers connection+headers; once the CDN starts streaming
 * the body runs to completion without a timeout. */
export async function downloadViaCdn(directUrl: string, filename: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(directUrl, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch {
    return false;
  }
}
