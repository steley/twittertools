/**
 * Browser-side helpers for talking to the TwitterTools API.
 * In dev (`astro dev`) the site automatically talks to the locally running
 * backend on 127.0.0.1:8787. Production builds always use same-origin /api/
 * (nginx reverse proxy) — no build-time configuration, nothing to leak.
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
  const m = input.match(/(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/)?(\d{5,25})/i);
  if (m) return m[1];
  const bare = input.trim().match(/^(\d{5,25})$/);
  return bare ? bare[1] : null;
}

export async function fetchTweet(id: string): Promise<TweetData> {
  const res = await fetch(`${API_BASE}/api/tweet?id=${encodeURIComponent(id)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  const data: TweetResponse = await res.json();
  return data.tweet;
}

export async function fetchThread(id: string): Promise<ThreadResponse> {
  const res = await fetch(`${API_BASE}/api/thread?url=${encodeURIComponent(id)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as ThreadResponse;
}

/** Build a proxied download URL that forces a file download with a nice name. */
export function proxiedDownloadUrl(mediaUrl: string, filename: string): string {
  const params = new URLSearchParams({ url: mediaUrl, name: filename });
  return `${API_BASE}/api/download?${params.toString()}`;
}
