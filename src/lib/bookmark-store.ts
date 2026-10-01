/**
 * Local bookmark library, kept in the browser's IndexedDB — nothing ever
 * touches the server. Each entry snapshots a public post (text, thumb,
 * author) so the library stays useful even after the post is deleted.
 */

import type { TweetData } from './api';

export type BookmarkType = 'video' | 'photo' | 'thread' | 'text' | 'article';

/** One media item as stored with the snapshot: photos carry the full image,
 * videos/GIFs carry the poster thumbnail (postUrl links back to the post) and
 * their best MP4 variant so the viewer can play them inline. */
export interface BookmarkMedia {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
  width?: number | null;
  height?: number | null;
  postUrl?: string;
  videoUrl?: string;
}

export interface BookmarkItem {
  id: string; // tweet id (first tweet's id for threads)
  url: string;
  author: string;
  handle: string;
  text: string; // full snapshot (whole thread for type 'thread')
  mediaType: BookmarkType;
  thumb: string; // first media CDN url or '' (pre-media-array data)
  /** All media of the post, inline. Older entries only have `thumb`. */
  media?: BookmarkMedia[];
  /** Thread bookmarks: every post's text (`text` stays the joined blob for
   * search and legacy display). Older entries don't have it. */
  posts?: string[];
  savedAt: number; // epoch ms
  tags: string[];
  note: string;
}

export function tweetToBookmark(t: TweetData): BookmarkItem {
  const types = t.media.map((m) => m.type);
  const mediaType: BookmarkType = t.article
    ? 'article'
    : types.includes('video') || types.includes('animated_gif')
      ? 'video'
      : types.includes('photo')
        ? 'photo'
        : 'text';
  const media: BookmarkMedia[] = t.media.map((m) => ({
    type: m.type,
    url: m.url,
    width: m.width,
    height: m.height,
    postUrl: t.url,
    videoUrl:
      m.type === 'video' || m.type === 'animated_gif'
        ? (m.variants ?? [])
            .filter((v) => v.contentType === 'video/mp4')
            .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url
        : undefined,
  }));
  return {
    id: t.id,
    url: t.url,
    author: t.user?.name ?? '',
    handle: t.user?.screenName ?? '',
    text: t.text,
    mediaType,
    thumb: t.media[0]?.url ?? '',
    media,
    savedAt: Date.now(),
    tags: [],
    note: '',
  };
}

const DB_NAME = 'twittertools-bookmarks';
const STORE = 'bookmarks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

function requestAs<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB error'));
  });
}

export async function listBookmarks(): Promise<BookmarkItem[]> {
  const db = await openDb();
  try {
    const all = await requestAs<BookmarkItem[]>(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } finally {
    db.close();
  }
}

export async function getBookmark(id: string): Promise<BookmarkItem | undefined> {
  const db = await openDb();
  try {
    return await requestAs<BookmarkItem | undefined>(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
    );
  } finally {
    db.close();
  }
}

export async function putBookmark(item: BookmarkItem): Promise<void> {
  const db = await openDb();
  try {
    await requestAs(db.transaction(STORE, 'readwrite').objectStore(STORE).put(item));
  } finally {
    db.close();
  }
}

export async function deleteBookmark(id: string): Promise<void> {
  const db = await openDb();
  try {
    await requestAs(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}

export async function clearBookmarks(): Promise<void> {
  const db = await openDb();
  try {
    await requestAs(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
  } finally {
    db.close();
  }
}

/** Coerce untrusted import payloads into a well-formed BookmarkItem. */
export function normalizeItem(raw: unknown): BookmarkItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const id = str(r.id).replace(/\D/g, '') || String(Date.now());
  const thumb = str(r.thumb);
  const mediaType: BookmarkType = (
    ['video', 'photo', 'thread', 'text', 'article'] as BookmarkType[]
  ).includes(r.mediaType as BookmarkType)
    ? (r.mediaType as BookmarkType)
    : 'text';
  const media = Array.isArray(r.media)
    ? (r.media as Record<string, unknown>[])
        .map((m) => ({
          type: (['photo', 'video', 'animated_gif'] as BookmarkMedia['type'][]).includes(
            m?.type as BookmarkMedia['type']
          )
            ? (m.type as BookmarkMedia['type'])
            : 'photo',
          url: str(m?.url),
          width: typeof m?.width === 'number' ? m.width : null,
          height: typeof m?.height === 'number' ? m.height : null,
          // https-only like url: these feed <video> src and link hrefs, so a
          // javascript:/data: URL in a malicious import must not survive
          postUrl: str(m?.postUrl).startsWith('https://') ? str(m?.postUrl) : undefined,
          videoUrl: str(m?.videoUrl).startsWith('https://') ? str(m?.videoUrl) : undefined,
        }))
        .filter((m) => m.url.startsWith('https://'))
    : // legacy entries (and old exports) only carry the thumbnail
      thumb.startsWith('https://')
      ? [{ type: 'photo' as const, url: thumb, width: null, height: null }]
      : [];
  return {
    id,
    url: str(r.url) || `https://x.com/i/status/${id}`,
    author: str(r.author),
    handle: str(r.handle).replace(/^@/, ''),
    text: str(r.text),
    mediaType,
    thumb,
    media,
    posts: Array.isArray(r.posts)
      ? (r.posts as unknown[]).filter((p): p is string => typeof p === 'string')
      : undefined,
    savedAt: typeof r.savedAt === 'number' && r.savedAt > 0 ? r.savedAt : Date.now(),
    tags: Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
      : [],
    note: str(r.note),
  };
}

/** Merge imported entries without clobbering what the user already has
 * (existing items keep their tags and notes). Returns how many were added. */
export async function importBookmarks(items: unknown[]): Promise<number> {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const existing = new Set((await requestAs<BookmarkItem[]>(store.getAll())).map((b) => b.id));
    let added = 0;
    for (const raw of items) {
      const item = normalizeItem(raw);
      if (existing.has(item.id)) continue;
      await requestAs(store.put(item));
      existing.add(item.id);
      added++;
    }
    return added;
  } finally {
    db.close();
  }
}

/** Toggle-style button for tool result cards: saves / unsaves the snapshot. */
export function bookmarkToggleButton(item: BookmarkItem): HTMLButtonElement {
  const b = document.createElement('button');
  b.className =
    'rounded-full border border-slate-300 px-4 py-2 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand';
  const paint = (saved: boolean) => {
    b.dataset.saved = String(saved);
    b.textContent = saved ? '✓ Saved' : 'Save';
  };
  getBookmark(item.id)
    .then((hit) => paint(!!hit))
    .catch(() => paint(false));
  b.type = 'button'; // never submit an enclosing form
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (b.dataset.saved === 'true') {
        await deleteBookmark(item.id);
        paint(false);
      } else {
        await putBookmark(item);
        paint(true);
      }
    } catch {
      // storage failure (private mode, quota): keep the stored state and hint
      b.textContent = 'Error — try again';
      setTimeout(() => paint(b.dataset.saved === 'true'), 1500);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
