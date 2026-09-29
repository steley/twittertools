# TwitterTools.com

**The independent toolkit for X (Twitter).** Static Astro site + one tiny Python API.

Eight free, no-login tools:

| Path | Tool | Backend? |
| --- | --- | --- |
| `/twitter-video-downloader` | Video/GIF → MP4 in available qualities, with file-size estimates | yes (`/api/tweet`, `/api/download`) |
| `/twitter-image-downloader` | Photos in original resolution, one or all | yes (`/api/tweet`, `/api/download`) |
| `/twitter-thread-reader` | Unroll threads; export Markdown/TXT/HTML/PDF; paste mode takes thread text or post links | yes (`/api/thread`, best-effort) |
| `/bookmark-manager` | Private local bookmark library (IndexedDB), tags/notes, JSON & Markdown export | no |
| `/tweet-screenshot-generator` | Post → polished PNG card, light/dark, rendered on canvas | no |
| `/tweet-character-counter` | X weighted counting (CJK ×2, links = 23) | no |
| `/tweet-url-parser` | URL ↔ ID ↔ Snowflake timestamp | no |
| `/twitter-advanced-search-builder` | GUI → search operators → open on X | no |

```
├── src/pages/          tool pages + home + privacy + terms (Astro + Tailwind v4)
├── src/lib/            shared modules: api client, tweet card renderer, bookmark
│                       store, tweet-count, snowflake, tool registry
├── server/             downloader_server.py (aiohttp) + systemd unit + mock/dev tooling
├── deploy/             Apache vhost + nginx config (alternative)
├── scripts/            gen_og.py (social card), smoke.mjs (page smoke tests)
└── public/             robots.txt, favicon.svg, og.png
```

## How the data tools work (no paid X API)

`downloader_server.py` resolves public posts through X's **free syndication endpoint**
(`cdn.syndication.twimg.com/tweet-result`) — the same one that powers embeds on publisher
sites. No developer account, no OAuth, no per-read billing. It:

- computes the endpoint's token locally (react-tweet's algorithm; several candidates are
  tried and the working one is remembered),
- normalizes tweets to `{id, text, user, media[], replyToId, quoted}` with **MP4-only**
  video variants sorted by bitrate,
- proxies media downloads straight from `pbs.twimg.com` / `video.twimg.com` with
  `Content-Disposition: attachment` — **nothing is stored on disk**,
- caches responses for 10 min in memory **and** on disk (production:
  `/var/lib/twittertools/tweet_cache.json` via `TT_CACHE_FILE`; `TT_CACHE_FILE=""`
  disables persistence) so a restart doesn't aim the request flood at the upstream,
- dedupes concurrent lookups, rate-limits per IP (60 lookups/min, 40 downloads/min)
  **and** globally (300/120 per min — `TT_GLOBAL_TWEET_RATE` / `TT_GLOBAL_DOWNLOAD_RATE`,
  format `limit/window`),
- never answers HTTP 502: Cloudflare replaces origin 502 bodies with its own terse
  error page, so upstream failures map to 503 (passes through) with specific messages,
- exposes aggregate, anonymous counters at `GET /api/healthz` (response statuses,
  upstream status distribution + latency, cache hits).

Honest limitations (also stated in the UI):

- The syndication endpoint is undocumented and has no SLA. If X changes it, only
  `fetch_syndication()` / `candidate_tokens()` in `downloader_server.py` need updating.
- The endpoint does **not** expose reply chains, so thread unrolling is best-effort: a
  thread root returns that single post and the UI directs users to the paste mode, whose
  exports work identically.
- Protected/deleted posts can't be fetched; restricted (sensitive/age-limited) posts are
  withheld by X as a 200 + empty body — all mapped to friendly 4xx errors.

## Local development

CI (`.github/workflows/ci.yml`) runs the same checks on every push:
`astro check` + production build for the frontend, pyflakes + the offline
integration suite for the backend, and Playwright page smoke tests (every page
renders and one signature interaction per tool — catches runtime crashes that
`astro check` cannot see).

```bash
npm install
npm run dev                 # site at http://localhost:4321

# API for the downloader/thread tools (Python 3.9+; the backend stays
# 3.8-compatible for older distros):
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python downloader_server.py          # 127.0.0.1:8787
```

`astro dev` automatically points the browser at the locally running API
(`127.0.0.1:8787`) — no environment files needed. Production builds always call
same-origin `/api/` (reverse proxy), so there is nothing to switch and no dev
configuration leaks into `dist/`.

### Offline development (mock endpoints)

The full backend can be developed and verified without touching X — the
integration suite and the dev mocks run against local fakes:

```bash
cd server && .venv/bin/python mock_test.py     # ALL CHECKS PASSED
.venv/bin/python dev_mocks.py                  # long-running mocks for the frontend
```

With `dev_mocks.py` + the API running (both take `TT_*` env overrides, as
`mock_test.py` sets automatically), mock tweet `111111111111111111` returns video
variants, `222222222222222222` photos, `333333333333333333` a reply-chain sample.

## Production build

```bash
npm run build               # -> dist/  (11 pages, sitemap-index.xml included)
```

Verify `dist/` contains no dev references: `grep -r "127.0.0.1" dist/` should be empty.

## Deploy to the VPS

Two server configs are provided — **Apache** (`deploy/apache-twittertools.conf`) and
**nginx** (`deploy/nginx-twittertools.conf`, alternative). Steps 1–2 are identical;
pick **3A or 3B**.

### 1. Upload (from the local machine)

```bash
# One rsync per directory: each --delete is scoped to its own destination
# and cannot touch the others (a combined `rsync --delete server/ deploy/
# .../twittertools/` MERGES both into the top level and deletes dist/ —
# do not do that).  .venv MUST be excluded on server/: the venv is created
# on the VPS, and without --exclude the --delete pass would wipe it on
# every re-deploy.
rsync -av --delete dist/   root@VPS_IP:/var/www/twittertools/dist/
rsync -av --delete --exclude .venv --exclude __pycache__ \
     server/ root@VPS_IP:/var/www/twittertools/server/
rsync -av --delete deploy/ root@VPS_IP:/var/www/twittertools/deploy/
```

### 2. API service (on the VPS — the venv is created here, not uploaded)

```bash
apt update && apt install -y python3-venv   # fresh Ubuntu: python3 -m venv fails without it
cd /var/www/twittertools/server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
install -d -o www-data -g www-data /var/lib/twittertools   # tweet cache state dir (service-writable)
cp twittertools-api.service /etc/systemd/system/   # paths inside match this layout
systemctl daemon-reload && systemctl enable --now twittertools-api
curl http://127.0.0.1:8787/health          # -> ok
curl http://127.0.0.1:8787/api/healthz     # -> aggregate stats
```

The tweet cache persists to `/var/lib/twittertools/tweet_cache.json` (created on
first write, flushed on SIGTERM) — entries survive deploys and warm the next boot.
The state dir lives outside the code tree on purpose: the service runs as
`www-data` while the code tree is owned by the deploy user, so a state file next
to the script would be unwritable. If persistence fails, the backend logs a
one-time "staying memory-only" warning to the journal and keeps working without it.

### 3A. Apache (static + /api/ reverse proxy)

```bash
# Replace the contents of the certbot-generated SSL vhost with our config
# (backup first). DocumentRoot is .../dist — do NOT point it at
# /var/www/twittertools, that exposes server/ and deploy/ to the web.
sudo cp /etc/apache2/sites-enabled/twittertools-le-ssl.conf \
        /etc/apache2/sites-enabled/twittertools-le-ssl.conf.bak
sudo cp /var/www/twittertools/deploy/apache-twittertools.conf \
        /etc/apache2/sites-enabled/twittertools-le-ssl.conf
sudo a2enmod proxy proxy_http headers      # mod_ssl is already enabled
sudo apache2ctl configtest                 # -> Syntax OK
sudo systemctl reload apache2
```

### 3B. nginx (alternative — static + /api/ reverse proxy)

```bash
# If Apache currently holds :80/:443, stop it first — the two servers conflict.
sudo systemctl disable --now apache2
sudo cp /var/www/twittertools/deploy/nginx-twittertools.conf /etc/nginx/sites-available/twittertools
sudo ln -sf /etc/nginx/sites-available/twittertools /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 4. HTTPS

- **Apache (3A): nothing to do.** The vhost includes the certbot-managed certificates,
  which renew automatically.
- **nginx (3B):** `sudo certbot --nginx -d twittertools.com -d www.twittertools.com`
  (installs the cert and auto-renews), or issue with acme.sh and wire the cert paths
  as described in the header comment of `deploy/nginx-twittertools.conf`.

> The VPS must be able to reach `cdn.syndication.twimg.com`, `pbs.twimg.com` and
> `video.twimg.com` — verify with `curl -I https://cdn.syndication.twimg.com/tweet-result?id=20`.

## Gotchas

- **twimg hotlink protection:** requests carrying a non-X `Referer` get 403 from
  `video.twimg.com`. The backend therefore sends no Referer header at all — don't add
  one back.
- **Older distros ship Python 3.8 (EOL).** Fine today — pip resolves aiohttp 3.10.x and
  the backend is 3.8-compatible — but plan a distro/Python upgrade.
- **Media fetch failing en masse?** Check `fetch_syndication()` and the token algorithm
  in `server/downloader_server.py` first; `GET /api/healthz` shows the upstream status
  distribution.

## Updating content

- Tool copy/FAQ lives directly in `src/pages/*.astro`; the homepage grid is generated
  from `src/lib/tools.ts`. Edit → `npm run build` → rsync `dist/`.
- Ad slots are placeholder `<AdSlot />` components — paste an AdSense snippet inside
  `src/components/AdSlot.astro` when approved and rebuild.
- Contact addresses `hello@` / `dmca@twittertools.com` (in `privacy.astro` /
  `terms.astro`) are live mailboxes — keep them monitored.
- Social card: edit `scripts/gen_og.py`, run `python3 scripts/gen_og.py`.

## Operations

- **Weekly:** unroll one known thread and download one known video end to end — the
  syndication endpoint is undocumented and X can change it without notice.
- **On-call:** `systemctl status twittertools-api`, journal for the "tweet cache"
  warning, `GET /api/healthz` for upstream health.
- **Search Console:** sitemap `https://twittertools.com/sitemap-index.xml` is submitted;
  review query/CTR data periodically to pick the next SEO expansion page.

## Trademark note

The site brands as **TwitterTools — tools for X (Twitter)** and everywhere states it is
*not affiliated with X Corp.* Keep that disclaimer intact, keep WHOIS current and the
site a genuine, functioning tool — that bona-fide use is the main defense in any
potential UDRP dispute over the domain.
