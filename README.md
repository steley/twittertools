# TwitterTools.com

**The independent toolkit for X (Twitter).** Static Astro site + one tiny Python API.

V1 ships six free, no-login tools:

| Path | Tool | Backend? |
| --- | --- | --- |
| `/twitter-video-downloader` | Video/GIF → MP4 in available qualities | yes (`/api/tweet`, `/api/download`) |
| `/twitter-image-downloader` | Photos in original resolution, one or all | yes (`/api/tweet`, `/api/download`) |
| `/twitter-thread-reader` | Unroll threads, export Markdown/TXT/HTML, paste-mode fallback | yes (`/api/thread`, best-effort) |
| `/tweet-character-counter` | X weighted counting (CJK ×2, links = 23) | no |
| `/tweet-url-parser` | URL ↔ ID ↔ Snowflake timestamp | no |
| `/twitter-advanced-search-builder` | GUI → search operators → open on X | no |

```
├── src/pages/          6 tool pages + home + privacy + terms (Astro + Tailwind v4)
├── src/lib/            shared modules: tweet-count, snowflake, api client, tool registry
├── server/             downloader_server.py (aiohttp) + systemd unit + mock/dev tooling
├── deploy/             nginx site config
├── scripts/gen_og.py   regenerates public/og.png (social card)
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
- caches responses for 10 min, dedupes concurrent lookups, rate-limits per IP
  (60 lookups/min, 40 downloads/min).

Honest limitations (also stated in the UI):

- The syndication endpoint is undocumented and has no SLA. If X changes it, only
  `fetch_syndication()` / `candidate_tokens()` in `downloader_server.py` need updating.
- The endpoint does **not** expose reply chains, so thread unrolling is best-effort: a
  thread root returns that single post and the UI directs users to the paste mode, whose
  exports work identically.
- Protected/deleted posts can't be fetched (mapped to friendly 404/403 errors).

## Local development

CI (`.github/workflows/ci.yml`) runs the same checks on every push:
`astro check` + production build for the frontend, pyflakes + the offline
integration suite for the backend.

```bash
npm install
npm run dev                 # site at http://localhost:4321

# API for the downloader/thread tools (Python 3.9+):
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python downloader_server.py          # 127.0.0.1:8787

# If your machine can't reach X directly (e.g. censored network), route the
# backend through a local proxy — socks5h resolves DNS on the proxy side:
TT_PROXY=socks5h://127.0.0.1:1089 .venv/bin/python downloader_server.py
```

`astro dev` automatically points the browser at the locally running API
(`127.0.0.1:8787`) — no environment files needed. Production builds always call
same-origin `/api/` (nginx reverse proxy), so there is nothing to switch and no
dev configuration to leak into `dist/`.

### Local development without X access

`server/mock_test.py` runs 16 integration checks against local mocks — the full backend
can be developed and verified offline:

```bash
cd server && .venv/bin/python mock_test.py     # ALL CHECKS PASSED
.venv/bin/python dev_mocks.py                  # long-running mocks for the frontend
```

With `dev_mocks.py` + the API running (both with `TT_*` env overrides, as `mock_test.py`
does automatically), mock tweet `111111111111111111` returns video variants,
`222222222222222222` photos, `333333333333333333` a reply-chain sample.

## Production build

```bash
npm run build               # -> dist/  (9 pages, sitemap-index.xml included)
```

Verify `dist/` contains no dev references: `grep -r "127.0.0.1" dist/` should be empty.

## Deploy to the VPS

Same pattern as the domain4sale project: static files + nginx + a systemd service.

```bash
# 1. upload (site + server code) — one rsync per directory: each --delete
#    is scoped to its own destination dir and cannot touch the others
#    (a combined `rsync --delete server/ deploy/ .../twittertools/` would
#    MERGE both into the top level and delete dist/ — do not do that).
#    .venv MUST be excluded on server/: it doesn't exist locally (and would
#    carry macOS binaries), and without --exclude the --delete pass would
#    wipe the Linux venv created in step 2 on every re-deploy.
rsync -av --delete dist/   root@VPS_IP:/var/www/twittertools/dist/
rsync -av --delete --exclude .venv --exclude __pycache__ \
     server/ root@VPS_IP:/var/www/twittertools/server/
rsync -av --delete deploy/ root@VPS_IP:/var/www/twittertools/deploy/

# 2. on the VPS — API service (create the venv here, ON the VPS)
apt update && apt install -y python3-venv   # fresh Ubuntu: python3 -m venv fails without it
cd /var/www/twittertools/server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp twittertools-api.service /etc/systemd/system/   # paths inside match this layout
systemctl daemon-reload && systemctl enable --now twittertools-api
curl http://127.0.0.1:8787/health          # -> ok

# 3. nginx site (static + /api/ reverse proxy)
cp /var/www/twittertools/deploy/nginx-twittertools.conf /etc/nginx/sites-available/twittertools
ln -sf /etc/nginx/sites-available/twittertools /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 4. HTTPS — one acme.sh cert for apex + www, webroot = the dist dir
#    (don't reuse domain4sale's issue_certs.sh: it reads that project's
#    own domains.json)
sudo mkdir -p /etc/nginx/ssl   # must exist before install-cert
sudo acme.sh --issue -d twittertools.com -d www.twittertools.com \
     -w /var/www/twittertools/dist
sudo acme.sh --install-cert -d twittertools.com \
     --key-file       /etc/nginx/ssl/twittertools.com.key \
     --fullchain-file /etc/nginx/ssl/twittertools.com.crt \
     --reloadcmd      "systemctl reload nginx"
# then edit nginx-twittertools.conf: add `listen 443 ssl;` + the two
# ssl_certificate lines to the server block, and turn the :80 block into a
# redirect: return 301 https://twittertools.com$request_uri;
nginx -t && systemctl reload nginx
```

> **The VPS must be able to reach `cdn.syndication.twimg.com`, `pbs.twimg.com` and
> `video.twimg.com`.** Any standard overseas VPS can; verify with
> `curl -I https://cdn.syndication.twimg.com/tweet-result?id=20`.
> Do **not** set `TT_PROXY` in the systemd unit — that's a local-dev aid only.

## Updating content

- Tool copy/FAQ lives directly in `src/pages/*.astro`; the homepage grid is generated
  from `src/lib/tools.ts`. Edit → `npm run build` → rsync `dist/`.
- Ad slots are placeholder `<AdSlot />` components — paste an AdSense snippet inside
  `src/components/AdSlot.astro` when approved and rebuild.
- Contact addresses `contact@` / `dmca@twittertools.com` (in `privacy.astro` / `terms.astro`)
  are live mailboxes — keep them monitored once the site is public.
- Social card: edit `scripts/gen_og.py`, run `python3 scripts/gen_og.py`.

## Launch checklist

1. **DNS** — point `twittertools.com` (+ `www`) A records at the VPS.
2. **Deploy** — follow "Deploy to the VPS" above; verify `systemctl status twittertools-api`
   and `curl http://127.0.0.1:8787/health` → `ok`.
3. **HTTPS** — acme.sh cert for apex + www, switch nginx to the TLS server block.
4. **Smoke test from an outside network** — site loads over HTTPS; paste a known video post
   into the downloader and download the smallest variant; unroll one thread.
5. **Search Console** — submit `https://twittertools.com/sitemap-index.xml` (and Bing
   Webmaster Tools). Request indexing for the homepage.
6. **Ads** — apply for AdSense once indexed; paste the snippet into `AdSlot.astro`, rebuild.
7. **Ongoing** — check the downloader against a known video tweet weekly; the syndication
   endpoint is undocumented and X can change it without notice.

## Roadmap

- **V2 — accounts & saving** (needs OAuth + paid X API; costed before building):
  Bookmark Manager/Exporter, profile & tweet analytics, Thread → Markdown pipeline.
- **V3 — monetization**: Free / Pro $9 (unlimited exports, advanced search, analytics) /
  Power $19 (AI bookmark search, bulk processing), `api.twittertools.com` for developers —
  same "site acquires, API monetizes" split as Opus.
- Quick wins: more thin SEO pages off the existing backend (GIF downloader, bulk tweet
  text extractor), hreflang when going multi-language.

## Trademark note

The site brands as **TwitterTools — tools for X (Twitter)** and everywhere states it is
*not affiliated with X Corp.* Keep that disclaimer intact, keep WHOIS current and the
site a genuine, functioning tool — that bona-fide use is the main defense in any
potential UDRP dispute over the domain.
