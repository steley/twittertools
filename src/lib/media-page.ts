/**
 * Shared wiring for the media-fetch tool pages (video/image downloaders):
 * DOM helper, tweet header card and form/limit/error handling.
 */
import { extractTweetId, fetchTweet, wireMediaImg, type TweetData } from './api';

export function el(tag: string, cls?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

/** Avatar + display name + @handle · date, shown above every fetch result. */
export function renderTweetHeader(t: TweetData): HTMLElement {
  const head = el('div', 'flex items-center gap-3');
  if (t.user?.avatar) {
    const img = document.createElement('img');
    img.alt = '';
    img.className = 'h-10 w-10 rounded-full';
    wireMediaImg(img, t.user.avatar, 'avatar');
    head.appendChild(img);
  }
  const who = el('div');
  who.appendChild(Object.assign(el('p', 'font-semibold text-sm'), { textContent: t.user?.name || 'Unknown' }));
  who.appendChild(
    Object.assign(el('p', 'text-xs text-slate-500'), {
      textContent: '@' + (t.user?.screenName || 'unknown') + (t.createdAt ? ' · ' + t.createdAt.slice(0, 10) : ''),
    }),
  );
  head.appendChild(who);
  return head;
}

export interface FetcherOptions {
  form: HTMLFormElement;
  input: HTMLInputElement;
  button: HTMLButtonElement;
  errorBox: HTMLElement;
  busyLabel: string;
  render: (t: TweetData) => void;
}

/** Standard submit flow: validate the URL, show errors, manage button state. */
export function wireFetcher(o: FetcherOptions): void {
  const idle = o.button.textContent ?? 'Fetch';
  const showError = (msg: string) => {
    o.errorBox.textContent = msg;
    o.errorBox.classList.remove('hidden');
  };
  o.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    o.errorBox.classList.add('hidden');
    const id = extractTweetId(o.input.value);
    if (!id) {
      showError("That doesn't look like a post link. Paste something like https://x.com/user/status/123…");
      return;
    }
    o.button.disabled = true;
    o.button.textContent = o.busyLabel;
    o.form.setAttribute('aria-busy', 'true');
    try {
      o.render(await fetchTweet(id));
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      o.button.disabled = false;
      o.button.textContent = idle;
      o.form.removeAttribute('aria-busy');
    }
  });

  // Deep link support (e.g. from the homepage router): /tool?url=<post url>
  wireDeepLink(o.form, o.input);
}

/** Auto-submit the tool's form when opened as /tool?url=<post url>
 * (the homepage router links tools that way). */
export function wireDeepLink(form: HTMLFormElement, input: HTMLInputElement | HTMLTextAreaElement): void {
  const deepLink = new URLSearchParams(window.location.search).get('url');
  if (deepLink && extractTweetId(deepLink)) {
    input.value = deepLink;
    form.requestSubmit();
  }
}
