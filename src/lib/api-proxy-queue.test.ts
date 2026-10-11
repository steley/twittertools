import { describe, expect, it, vi, beforeEach } from 'vitest';

type FakeImg = {
  isConnected: boolean;
  src: string;
  listeners: Map<string, () => void>;
  addEventListener(ev: string, fn: () => void): void;
};

function fakeImg(connected = true): FakeImg {
  return {
    isConnected: connected,
    src: '',
    listeners: new Map(),
    addEventListener(ev: string, fn: () => void) {
      this.listeners.set(ev, fn);
    },
  };
}

async function loadQueue() {
  // fresh module state per test
  vi.resetModules();
  return await import('./api');
}

describe('loadProxyImg concurrency queue', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts at most 3 loads and queues the rest', async () => {
    const api = await loadQueue();
    const imgs = Array.from({ length: 6 }, () => fakeImg());
    imgs.forEach((img, i) => api.loadProxyImg(img as unknown as HTMLImageElement, `u${i}`));
    const started = imgs.filter((i) => i.src !== '');
    expect(started.length).toBe(3);
    expect(imgs.slice(3).every((i) => i.src === '')).toBe(true);
  });

  it('starts the next queued load when one settles', async () => {
    const api = await loadQueue();
    const imgs = Array.from({ length: 4 }, () => fakeImg());
    imgs.forEach((img, i) => api.loadProxyImg(img as unknown as HTMLImageElement, `u${i}`));
    imgs[0].listeners.get('load')!(); // first finishes → u3 starts
    expect(imgs[3].src).toBe('u3');
    expect(imgs[1].src).toBe('u1');
  });

  it('releases the slot of an image removed from the page without loading it', async () => {
    const api = await loadQueue();
    const gone = fakeImg(false);
    const held = fakeImg();
    api.loadProxyImg(gone as unknown as HTMLImageElement, 'gone');
    expect(gone.src).toBe('');
    const imgs = [held, ...Array.from({ length: 3 }, () => fakeImg())];
    imgs.forEach((img) => api.loadProxyImg(img as unknown as HTMLImageElement, 'u'));
    expect(imgs.filter((i) => i.src === 'u').length).toBe(3);
  });

  it('a double settle (load then stray error) releases the slot only once', async () => {
    const api = await loadQueue();
    const imgs = Array.from({ length: 5 }, () => fakeImg());
    imgs.forEach((img) => api.loadProxyImg(img as unknown as HTMLImageElement, 'u'));
    imgs[0].listeners.get('load')!();
    imgs[0].listeners.get('error')!(); // stray second event
    expect(imgs.filter((i) => i.src === 'u').length).toBe(4); // 3 + 1, not 3 + 2
  });
});
