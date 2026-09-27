/**
 * Local bookmark library, kept in the browser's IndexedDB — nothing ever
 * touches the server. Each entry snapshots a public post (text, thumb,
 * author) so the library stays useful even after the post is deleted.
 */

import type { TweetData } from './api';

export type BookmarkType = 'video' | 'photo' | 'thread' | 'text';

export interface BookmarkItem {
  id: string; // tweet id (first tweet's id for threads)
  url: string;
  author: string;
  handle: string;
  text: string; // full snapshot (whole thread for type 'thread')
  mediaType: BookmarkType;
  thumb: string; // first media CDN url or ''
  savedAt: number; // epoch ms
  tags: string[];
  note: string;
}

export function tweetToBookmark(t: TweetData): BookmarkItem {
  const types = t.media.map((m) => m.type);
  const mediaType: BookmarkType =
    types.includes('video') || types.includes('animated_gif')
      ? 'video'
      : types.includes('photo')
        ? 'photo'
        : 'text';
  return {
    id: t.id,
    url: t.url,
    author: t.user?.name ?? '',
    handle: t.user?.screenName ?? '',
    text: t.text,
    mediaType,
    thumb: t.media[0]?.url ?? '',
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
  return {
    id,
    url: str(r.url) || `https://x.com/i/status/${id}`,
    author: str(r.author),
    handle: str(r.handle).replace(/^@/, ''),
    text: str(r.text),
    mediaType: (['video', 'photo', 'thread', 'text'] as BookmarkType[]).includes(r.mediaType as BookmarkType)
      ? (r.mediaType as BookmarkType)
      : 'text',
    thumb: str(r.thumb),
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
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
