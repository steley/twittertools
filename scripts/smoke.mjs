/**
 * Page smoke tests: load every built page against the local mock stack and
 * exercise one signature interaction per key tool.
 *
 * Catches the class of bug `astro check` cannot see — module-level runtime
 * crashes (e.g. a TDZ error) that kill a page's script while the HTML still
 * renders fine.
 *
 * Prerequisites (see .github/workflows/ci.yml, "smoke" job — or start the
 * three processes by hand for a local run):
 *   server/dev_mocks.py            mock syndication :8898 + media :8899
 *   server/downloader_server.py    real API :8787, pointed at the mocks
 *   server/dev_proxy.py            dist/ on :8080 with /api passthrough
 * then: node scripts/smoke.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8080';

// every page must render its key element (plus one tool-specific interaction below)
const PAGES = [
  ['/', '#home-form'],
  ['/twitter-video-downloader/', '#vd-form'],
  ['/twitter-image-downloader/', '#id-form'],
  ['/twitter-thread-reader/', '#tr-form'],
  ['/tweet-character-counter/', '#tweet-text'],
  ['/tweet-url-parser/', '#parser-input'],
  ['/twitter-advanced-search-builder/', '#s-from'],
  ['/tweet-screenshot-generator/', '#ss-form'],
  ['/bookmark-manager/', '#bm-form'],
  ['/tweet-splitter/', '#sp-input'],
  ['/twitter-font-generator/', '#ff-input'],
  ['/privacy/', 'main'],
  ['/terms/', 'main'],
];

const failures = [];
const pageErrors = [];

const browser = await chromium.launch();
// the browser lifecycle must survive a failing step — without try/finally a
// rejected await leaves a headless Chromium running and skips the summary
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => pageErrors.push(`${page.url()} -> ${err.message}`));

  async function expectVisible(locator, label, timeout = 8000) {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      console.log(`  ok  ${label}`);
    } catch {
      failures.push(label);
      console.log(`FAIL  ${label}`);
    }
  }

  // 1. all pages render
  for (const [path, selector] of PAGES) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await expectVisible(page.locator(selector), `${path} renders ${selector}`);
  }

  // 1b. PWA assets for the bookmark app shell
  {
    await page.goto(BASE + '/bookmark-manager/', { waitUntil: 'domcontentloaded' });
    const pwa = await page.evaluate(async () => {
      const m = await fetch('/manifest.webmanifest');
      const sw = await fetch('/bookmark-manager/sw.js');
      const i192 = await fetch('/bookmark-manager/icons/bm-192.png');
      return { m: m.status, sw: sw.status, i192: i192.status };
    });
    if (pwa.m === 200 && pwa.sw === 200 && pwa.i192 === 200) console.log('  ok  pwa assets served (manifest, sw, icon)');
    else {
      failures.push('pwa assets');
      console.log(`FAIL  pwa assets ${JSON.stringify(pwa)}`);
    }
  }

  // 2. video downloader fetches the mock video (API round-trip)
  await page.goto(BASE + '/twitter-video-downloader/', { waitUntil: 'domcontentloaded' });
  await page.fill('#vd-url', 'https://x.com/mockuser/status/111111111111111111');
  await page.click('#vd-btn');
  await expectVisible(page.locator('text=kbps').first(), 'video fetch shows variants');

  // 3. thread reader paste mode stitches text
  await page.goto(BASE + '/twitter-thread-reader/', { waitUntil: 'domcontentloaded' });
  await page.click('#tr-tab-paste');
  await page.fill('#tr-text', 'First post\n---\nSecond post');
  await page.click('#tr-parse');
  await expectVisible(page.locator('#tr-tweets article').first(), 'paste mode renders posts');

  // 4. character counter reacts to input
  await page.goto(BASE + '/tweet-character-counter/', { waitUntil: 'domcontentloaded' });
  await page.fill('#tweet-text', 'hello world');
  await expectVisible(page.locator('#cc-big:has-text("11")'), 'counter shows 11 chars');

  // 5. url parser decodes a snowflake
  await page.goto(BASE + '/tweet-url-parser/', { waitUntil: 'domcontentloaded' });
  await page.fill('#parser-input', 'https://x.com/user/status/1500000000000000000');
  await expectVisible(page.locator('#p-id:has-text("1500000000000000000")'), 'parser shows tweet id');

  // 6. download proxy streams the mock media with an attachment header (exercises
  // the media-host allowlist and the streaming path end to end)
  const dl = await page.evaluate(async () => {
    const res = await fetch(
      '/api/download?url=http%3A%2F%2F127.0.0.1%3A8899%2Fvideo-832.mp4&name=smoke.mp4'
    );
    return { ok: res.ok, status: res.status, disposition: res.headers.get('content-disposition') ?? '' };
  });
  if (dl.ok && dl.disposition.includes('attachment')) {
    console.log('  ok  download proxy streams with attachment header');
  } else {
    failures.push('download proxy');
    console.log(`FAIL  download proxy (status ${dl.status}, disposition "${dl.disposition}")`);
  }
} finally {
  await browser.close();
}

if (pageErrors.length) {
  console.log('\nUncaught page errors (kills the page script in the browser):');
  for (const e of pageErrors) console.log('  ' + e);
  failures.push('uncaught page errors');
}
if (failures.length) {
  console.log(`\nSMOKE FAILED (${failures.length})`);
  process.exit(1);
}
console.log('\nSMOKE PASSED');
